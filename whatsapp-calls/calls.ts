// calls.ts — WhatsApp VOICE CALLS for an iterate project, from its own WhatsApp account, both ways:
//
//   iterate provide whatsapp-calls/calls.ts --name whatsappCalls --project <slug>
//
// OUT: the project calls `itx.whatsappCalls.call({ to, opening, brief, reportTo })` and the
// person's phone rings on WhatsApp. IN: a person this lend answers (WHATSAPP_CALLS_ALLOWED) rings
// the account and the call is picked up. Either way the call is a voice call like any other the
// project has: this file is its client (voice-call-client.ts, the voice app's own), so the call
// gets a fresh agent at `/agents/voice/whatsapp-<the other person's digits>/<time>-<id>` with the
// voice relay beside it (the number in the path: a project can tell whose phone a call's agent is
// on), the person's words go up as microphone frames and the voice's answer comes back as speaker
// frames. The voice is on the line BEFORE the phone rings or the call is picked up, so the person
// is spoken to at once.
//
// The WhatsApp side is `jeeves-call serve` (serve.go: meowcaller, WhatsApp's call stack, on a
// linked device of its own beside the Baileys one), one process kept running with the calls'
// audio on its stdin and stdout: 16 kHz mono PCM16 both ways, the voice processor's own format.
//
// Each call's facts land on /integrations/whatsapp-calls: `whatsapp-calls/call-placed` or
// `call-received`, `call-answered` (with the voice call's path) and `call-ended` (with what was
// said).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { startVoiceCall, type VoiceCall } from "./voice-call-client.ts";

export const description =
  "WhatsApp voice calls from the agents' own number: call({ to, opening, brief, reportTo }) rings the person on WhatsApp and connects them to a voice agent that says `opening` and knows `brief`; a call from a known number to the agents' number is answered the same way; hangup(), status(). Call __describe() first.";

const LOG_PATH = "/integrations/whatsapp-calls";
const BRIDGE = process.env.JEEVES_CALL_BIN || join(import.meta.dirname, "jeeves-call");
/** How long the phone rings before the call is given up. */
const RING_SECONDS = 45;
/** The numbers a call may be placed to, and whose calls are answered (digits with country code,
 *  comma-separated): a call rings a real phone and an answered one reaches the project's agent, so
 *  the lend only talks to the people it was started for. */
const ALLOWED = new Set(
  (process.env.WHATSAPP_CALLS_ALLOWED || "")
    .split(",")
    .map((number) => number.replace(/\D/g, ""))
    .filter(Boolean),
);
/** What the voice says when it picks up, by the caller's digits (JSON, with `default` for anyone
 *  else): `{"447700900001":"At your service, sir.","default":"Hello."}`. */
const ANSWER_WITH: Record<string, string> = (() => {
  try {
    const parsed: unknown = JSON.parse(process.env.WHATSAPP_CALLS_ANSWER_WITH || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    console.error("whatsapp-calls: WHATSAPP_CALLS_ANSWER_WITH is not JSON; answering with Hello");
    return {};
  }
})();

/** The project, as `iterate provide` hands it over: the parts this file uses. */
type Project = Parameters<typeof startVoiceCall>[0] & {
  cd(path: string): {
    append(event: { type: string; payload: Record<string, unknown> }): Promise<unknown>;
  };
  agents: { get(path: string): { message(text: string): Promise<unknown> } };
};

type CallInput = {
  /** The person's number, with country code: "+44 7477 472160". */
  to: string;
  /** The first thing the voice says when they answer. */
  opening?: string;
  /** What the call is for and what the voice agent should know: it cannot see your conversation. */
  brief?: string;
  /** An agent's path: it is messaged what was said once the call ends. */
  reportTo?: string;
};

/** What one call measured, recorded with its end: where a call that sounded wrong went wrong. */
type CallMetrics = {
  /** From the press to the live model being on the line, each time the voice was connected. */
  voiceReadyMs: number[];
  /** Out: from the first ring to the answer. In: from the caller's ring to this side's pick-up. */
  ringMs: number | null;
  /** Microphone frames (60 ms each) handed to the voice call, and the ones a slow link dropped or failed. */
  micFramesSent: number;
  micFramesDropped: number;
  micFramesFailed: number;
  /** The voice's audio: chunks received, and their length. */
  speakerChunks: number;
  speakerMs: number;
  /** Why each voice connection of the call ended (more than one: the voice was reconnected). */
  voiceEnds: string[];
  /** The bridge's own count: frames played and heard, gaps in an answer, the deepest queue. */
  bridge: Record<string, number> | null;
};

type Placed = { callId: string; ringing: true; streamPath: string };

type ActiveCall = {
  /** "out": the project rang the person. "in": the person rang the account. */
  direction: "out" | "in";
  callId: string;
  /** The other person's number, digits with country code. */
  number: string;
  startedAt: number;
  ringingAt: number | null;
  answeredAt: number | null;
  opening: string | undefined;
  brief: string | undefined;
  reportTo: string | undefined;
  /** Every voice call the WhatsApp call was carried by: one, unless the voice was reconnected. */
  streamPaths: string[];
  voice: VoiceCall<unknown> | null;
  said: string[];
  metrics: CallMetrics;
  /** The WhatsApp call is over: a voice call that ends now is not reconnected. */
  over: boolean;
  /** Out only: settled when the phone rings, or when it cannot. */
  placed: PromiseWithResolvers<Placed> | null;
};

/** A line of `jeeves-call serve`'s stdout (serve.go). */
type BridgeEvent = {
  event?: string;
  callId?: string;
  pcm?: string;
  reason?: string;
  answered?: boolean;
  stats?: Record<string, number>;
  number?: string;
  from?: string;
  video?: boolean;
  group?: boolean;
};

let itx: Project | undefined;
let active: ActiveCall | null = null;
let bridge: ChildProcessWithoutNullStreams | null = null;
/** `jeeves-call serve` is kept running from the first connection on. */
let bridgeStarted = false;
/** The linked device is connected: calls can be placed. */
let bridgeReady = false;

/** The voice ended the call itself (its agent hung up, or nobody spoke for a minute): the WhatsApp
 *  call ends too. Any other end is the voice's connection failing, and the call gets a new one. */
const VOICE_ENDED_ON_PURPOSE = /the Agent hung up|no input|idle|whatsapp/i;
const MAX_VOICE_RECONNECTS = 2;
/** How long the live model may take to come on the line before the call is given up. */
const VOICE_READY_TIMEOUT_MS = 12_000;
/** How long a picked-up call may take to carry audio before it is given up. */
const PICK_UP_TIMEOUT_MS = 20_000;

const record = (type: string, payload: Record<string, unknown>) =>
  itx
    ?.cd(LOG_PATH)
    .append({ type: `whatsapp-calls/${type}`, payload })
    .catch((error: unknown) =>
      console.error(`whatsapp-calls: could not record ${type}: ${String(error)}`),
    );

const tell = (line: Record<string, unknown>) => {
  if (bridge?.stdin.writable) bridge.stdin.write(`${JSON.stringify(line)}\n`);
};

const newCall = (direction: "out" | "in", number: string): ActiveCall => ({
  direction,
  callId: "",
  number,
  startedAt: Date.now(),
  ringingAt: null,
  answeredAt: null,
  opening: undefined,
  brief: undefined,
  reportTo: undefined,
  streamPaths: [],
  voice: null,
  said: [],
  metrics: {
    voiceReadyMs: [],
    ringMs: null,
    micFramesSent: 0,
    micFramesDropped: 0,
    micFramesFailed: 0,
    speakerChunks: 0,
    speakerMs: 0,
    voiceEnds: [],
    bridge: null,
  },
  over: false,
  placed: null,
});

const addStats = (current: ActiveCall, ended: VoiceCall<unknown>) => {
  current.metrics.micFramesSent += ended.stats.micFramesSent;
  current.metrics.micFramesDropped += ended.stats.micFramesDropped;
  current.metrics.micFramesFailed += ended.stats.micFramesFailed;
  current.metrics.speakerChunks += ended.stats.spkChunksReceived;
  current.metrics.speakerMs += Math.round(ended.stats.spkMsReceived);
};

/** A voice call of the project's for this WhatsApp call, answered once the live model is on the
 *  line. `resumed`: the one before it failed mid-call, and this one is told what was said. */
async function connectVoice(
  project: Project,
  current: ActiveCall,
  resumed: boolean,
): Promise<void> {
  const pressedAt = Date.now();
  const accepted = Promise.withResolvers<void>();
  let mine: VoiceCall<unknown> | null = null;
  mine = await startVoiceCall(project, {
    client: `whatsapp-${current.number}`,
    onSpeakerFrame: (frame) => {
      if (current.voice !== mine) return;
      // nobody is listening until the call is answered: what the voice says before is dropped
      if (current.answeredAt === null) return;
      // the person spoke over the voice: what was queued for them is dropped
      if (frame.clearSpeakerBufferBeforeFrame) tell({ clear: true });
      if (frame.pcm) tell({ pcm: frame.pcm, ...(frame.lastFrameOfAnswer && { last: true }) });
      else if (frame.lastFrameOfAnswer) tell({ last: true });
    },
    onFact: (fact) => {
      if (fact.type === "events.iterate.com/voice-agent/conversation-accepted") accepted.resolve();
      if (fact.type === "events.iterate.com/voice-agent/provider-error-reported")
        console.error(
          `whatsapp-calls: the live model reported: ${fact.payload.message.slice(0, 300)}`,
        );
      if (fact.type === "events.iterate.com/voice-agent/utterance-transcribed")
        current.said.push(`Person: ${fact.payload.text}`);
      if (fact.type === "events.iterate.com/voice-agent/answer-transcribed")
        current.said.push(`Voice: ${fact.payload.text}`);
      if (
        fact.type !== "events.iterate.com/voice-agent/call-ended" ||
        current.voice !== mine ||
        current.over
      )
        return;
      // this voice call is over, and not because the WhatsApp call ended
      const reason = fact.payload.reason;
      current.metrics.voiceEnds.push(reason);
      addStats(current, mine!);
      current.voice = null;
      const reconnects = current.streamPaths.length - 1;
      if (
        VOICE_ENDED_ON_PURPOSE.test(reason) ||
        current.answeredAt === null ||
        reconnects >= MAX_VOICE_RECONNECTS
      ) {
        tell({ hangup: true });
        return;
      }
      // the voice's connection failed while the person is on the line: a new one, told what was said
      console.error(`whatsapp-calls: the voice ended (${reason}); reconnecting it`);
      connectVoice(project, current, true).catch((error: unknown) => {
        console.error(`whatsapp-calls: the voice could not be reconnected: ${String(error)}`);
        tell({ hangup: true });
      });
    },
  });
  current.streamPaths.push(mine.streamPath);
  const callContext = project.cd(mine.streamPath);
  const brief = [
    current.direction === "out"
      ? `[call brief] You are on a WhatsApp voice call to +${current.number}, which you placed yourself${current.reportTo ? ` from your conversation at ${current.reportTo}` : ""}: to the person you are the same assistant they know, not someone calling on its behalf.`
      : `[call brief] +${current.number} rang you on WhatsApp and you picked up: to the person you are the same assistant they know. You do not know yet why they are calling.`,
    current.brief ?? "",
    resumed
      ? `The voice connection failed during this call and you are its replacement: the person is still on the line. What was said so far:\n${current.said.join("\n") || "(nothing yet)"}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  await callContext.append({
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "user",
      actor: { type: "user" },
      content: brief,
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    accepted.promise.then(() => true),
    new Promise<boolean>(
      (resolve) => (timer = setTimeout(() => resolve(false), VOICE_READY_TIMEOUT_MS)),
    ),
  ]);
  clearTimeout(timer);
  if (!ready || current.over) {
    await mine
      .hangUp(
        ready
          ? "whatsapp: the call ended before the voice was on the line"
          : "whatsapp: the live model did not come on the line",
      )
      .catch(() => undefined);
    throw new Error(
      ready
        ? "The call ended before the voice was on the line."
        : `The voice did not come on the line within ${String(VOICE_READY_TIMEOUT_MS / 1000)} s.`,
    );
  }
  current.metrics.voiceReadyMs.push(Date.now() - pressedAt);
  current.voice = mine;
  if (resumed)
    await callContext.append({
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "I do apologise, the line dropped for a moment. Where were we?" },
    });
}

/** The WhatsApp call is over: its voice call ends, its end is recorded, and whoever asked for the
 *  report is told. Once per call. */
async function finished(current: ActiveCall, reason: string, answered: boolean): Promise<void> {
  if (current.over) return;
  current.over = true;
  if (active === current) active = null;
  current.placed?.reject(new Error(`The call could not be placed (${reason}).`));
  const seconds = current.answeredAt ? Math.round((Date.now() - current.answeredAt) / 1000) : 0;
  if (current.voice) {
    const last = current.voice;
    current.voice = null;
    await last.hangUp(`whatsapp: the call ended (${reason})`).catch(() => undefined);
    addStats(current, last);
  }
  const transcript = current.said.join("\n");
  const number = `+${current.number}`;
  await record("call-ended", {
    callId: current.callId,
    direction: current.direction,
    ...(current.direction === "out" ? { to: number } : { from: number }),
    answered,
    reason,
    seconds,
    streamPath: current.streamPaths.at(-1) ?? null,
    streamPaths: current.streamPaths,
    reportTo: current.reportTo ?? null,
    transcript,
    metrics: current.metrics,
  });
  if (current.reportTo && itx)
    await itx.agents
      .get(current.reportTo)
      .message(
        answered
          ? `[whatsapp call to ${number} ended after ${String(seconds)} s: ${reason}] What was said:\n${transcript || "(nothing was transcribed)"}\n(the call's own agent, with everything it did: ${current.streamPaths.join(", ")})`
          : `[whatsapp call to ${number} was not answered: ${reason}]`,
      )
      .catch((error: unknown) =>
        console.error(
          `whatsapp-calls: could not report to ${String(current.reportTo)}: ${String(error)}`,
        ),
      );
}

/** Ring `input.to`. The voice is connected FIRST (a voice call of the project's, its own context,
 *  the live model on the line), and only then does the phone ring: the person who answers is
 *  spoken to at once. Answers once the phone is ringing; everything after (the answer, the end)
 *  is recorded on LOG_PATH and, with `reportTo`, told to that agent at the end. */
async function call(input: CallInput): Promise<Placed> {
  const project = itx;
  if (!project) throw new Error("WhatsApp calls are not connected to the project yet.");
  const digits = String(input?.to ?? "").replace(/\D/g, "");
  if (digits.length < 8)
    throw new Error(
      `call({ to }) needs a phone number with its country code, got ${JSON.stringify(input?.to)}`,
    );
  if (!ALLOWED.has(digits))
    throw new Error(
      `+${digits} is not a number this lend may ring (it rings ${
        [...ALLOWED].map((n) => `+${n}`).join(", ") || "nobody"
      }).`,
    );
  if (active)
    throw new Error(`A call is already in progress (with +${active.number}): one call at a time.`);
  if (!bridgeReady) throw new Error("The WhatsApp call device is not connected yet: try again.");

  const current = newCall("out", digits);
  current.opening = input.opening;
  current.brief = input.brief;
  current.reportTo = input.reportTo;
  active = current;
  // 1. the voice, before anyone is rung
  try {
    await connectVoice(project, current, false);
  } catch (error) {
    await finished(
      current,
      `the voice could not be connected: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
    throw error;
  }
  // 2. the phone
  current.placed = Promise.withResolvers<Placed>();
  tell({ call: `+${digits}`, ring: RING_SECONDS });
  return await current.placed.promise;
}

/** Someone is ringing the account. A call from a number this lend answers gets a voice call of
 *  the project's first, and is picked up once the live model is on the line; any other call is
 *  left ringing on the account's other devices. */
async function incoming(event: BridgeEvent): Promise<void> {
  const project = itx;
  const callId = event.callId ?? "";
  const digits = event.number ?? "";
  const from = digits ? `+${digits}` : (event.from ?? "unknown");
  const leave = (reason: string) =>
    record("call-received", { callId, from, answering: false, reason });
  if (!project) return;
  if (event.group || event.video) return void leave("a group or video call");
  if (!ALLOWED.has(digits)) return void leave("not a number this lend answers");
  if (active) return void leave(`another call is in progress (with +${active.number})`);

  const current = newCall("in", digits);
  current.callId = callId;
  current.ringingAt = Date.now();
  current.opening = ANSWER_WITH[digits] ?? ANSWER_WITH.default ?? "Hello.";
  active = current;
  void record("call-received", { callId, from, answering: true });
  try {
    await connectVoice(project, current, false);
  } catch (error) {
    await finished(
      current,
      `the voice could not be connected: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
    return;
  }
  tell({ answer: callId });
  setTimeout(() => {
    if (current.over || current.answeredAt !== null) return;
    tell({ hangup: true });
    void finished(current, "picked up, but the call never carried audio", false);
  }, PICK_UP_TIMEOUT_MS);
}

function onBridgeEvent(event: BridgeEvent): void {
  const current = active;
  if (event.event === "mic") {
    if (event.pcm) current?.voice?.sendMicFrame(event.pcm);
    return;
  }
  if (event.event === "ready") {
    bridgeReady = true;
    console.error("whatsapp-calls: the call device is connected");
    return;
  }
  if (event.event === "incoming") {
    void incoming(event);
    return;
  }
  if (!current) return;
  if (event.event === "ringing") {
    current.callId = event.callId ?? "";
    current.ringingAt = Date.now();
    const streamPath = current.streamPaths[0]!;
    void record("call-placed", {
      callId: current.callId,
      to: `+${current.number}`,
      reportTo: current.reportTo ?? null,
      streamPath,
    });
    current.placed?.resolve({ callId: current.callId, ringing: true, streamPath });
    current.placed = null;
    return;
  }
  if (event.event === "failed") {
    if (current.direction === "out" && current.ringingAt === null)
      void finished(current, event.reason ?? "the call could not be placed", false);
    return;
  }
  // an announced call this lend left alone ends too: only the call being carried is acted on
  if (event.callId !== current.callId) return;
  if (event.event === "answered") {
    current.answeredAt = Date.now();
    current.metrics.ringMs = current.ringingAt ? current.answeredAt - current.ringingAt : null;
    void record("call-answered", {
      callId: current.callId,
      direction: current.direction,
      ...(current.direction === "out"
        ? { to: `+${current.number}` }
        : { from: `+${current.number}` }),
      streamPath: current.streamPaths[0],
    });
    // the voice is already on the line: it speaks first
    if (current.opening && current.voice && itx)
      void itx
        .cd(current.voice.streamPath)
        .append({
          type: "events.iterate.com/agent/web-message-sent",
          payload: { message: current.opening },
        })
        .catch((error: unknown) =>
          console.error(`whatsapp-calls: the opening was not said: ${String(error)}`),
        );
    return;
  }
  if (event.event === "ended") {
    current.metrics.bridge = event.stats ?? null;
    void finished(current, event.reason ?? "ended", Boolean(event.answered));
  }
}

/** `jeeves-call serve`, kept running: started again a few seconds after it exits. */
function startBridge(): void {
  const child = spawn(BRIDGE, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
  bridge = child;
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event: BridgeEvent;
    try {
      event = JSON.parse(line) as BridgeEvent;
    } catch {
      return;
    }
    onBridgeEvent(event);
  });
  child.on("exit", (code) => {
    if (bridge === child) bridge = null;
    bridgeReady = false;
    console.error(`whatsapp-calls: jeeves-call exited (${String(code)}); starting it again in 5 s`);
    if (active)
      void finished(active, `the call process ended (${String(code)})`, active.answeredAt !== null);
    setTimeout(startBridge, 5000);
  });
}

export default async function provide(connection: { itx: Project }) {
  itx = connection.itx;
  // `iterate provide` calls this again on each reconnection: the device stays as it is
  if (!bridgeStarted) startBridge();
  bridgeStarted = true;
  const numbers = [...ALLOWED].map((n) => `+${n}`).join(", ") || "nobody";
  return {
    call,
    /** End the call in progress, if any. */
    hangup() {
      if (!active) return { hungUp: false };
      tell({ hangup: true });
      return { hungUp: true, callId: active.callId };
    },
    /** The call in progress, or null. */
    status() {
      return active
        ? {
            callId: active.callId,
            direction: active.direction,
            with: `+${active.number}`,
            answered: active.answeredAt !== null,
            streamPath: active.streamPaths.at(-1) ?? null,
          }
        : null;
    },
    __describe: () => ({
      instructions: `WhatsApp voice calls from the agents' own number. call({ to, opening, brief, reportTo }) rings a person on WhatsApp: the voice is connected first, then the phone rings (it answers { callId, ringing, streamPath } once it does; the ring gives up after ${String(RING_SECONDS)} s). When they answer they are talking to a voice agent of this project, as in the voice app, in a context of its own (streamPath, under /agents/voice/whatsapp-<their digits>/): it says \`opening\` first, and \`brief\` is all it knows about why you called, so put everything in it. A call FROM one of the same numbers to the agents' number is picked up the same way, once the voice is on the line. One call at a time. hangup() ends it, status() answers the call in progress. Facts land on ${LOG_PATH} (whatsapp-calls/call-placed or call-received, call-answered, call-ended with direction, the transcript and the call's metrics); with reportTo (your own agent path) you are messaged what was said when a call you placed ends. It rings and answers only: ${numbers}.`,
      functions: ["call", "hangup", "status"],
    }),
  };
}
