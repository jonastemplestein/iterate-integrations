// calls.ts — WhatsApp VOICE CALLS for an iterate project, from its own WhatsApp account:
//
//   iterate provide whatsapp-calls/calls.ts --name whatsappCalls --project <slug>
//
// The project calls `itx.whatsappCalls.call({ to, opening, brief, reportTo })` and the person's
// phone rings on WhatsApp. When they answer, the call is a voice call like any other the project
// has: this file is its client (voice-call-client.ts, the voice app's own), so the call gets a
// fresh agent at `/agents/voice/whatsapp-<the number's digits>/<time>-<id>` with the voice relay
// beside it (the number in the path: a project can tell whose phone a call's agent is on), the
// person's words go up as microphone frames and the voice's answer comes back as speaker frames.
//
// The WhatsApp side is `jeeves-call bridge` (bridge.go: meowcaller, WhatsApp's call stack, on a
// linked device of its own beside the Baileys one), a child process per call with the audio on its
// stdin and stdout: 16 kHz mono PCM16 both ways, the voice processor's own format.
//
// Each call's facts land on /integrations/whatsapp-calls: `whatsapp-calls/call-placed`,
// `call-answered` (with the voice call's path) and `call-ended` (with what was said).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { startVoiceCall, type VoiceCall } from "./voice-call-client.ts";

export const description =
  "WhatsApp voice calls from the agents' own number: call({ to, opening, brief, reportTo }) rings the person on WhatsApp and connects them to a voice agent that says `opening` and knows `brief`; hangup(), status(). Call __describe() first.";

const LOG_PATH = "/integrations/whatsapp-calls";
const BRIDGE = process.env.JEEVES_CALL_BIN || join(import.meta.dirname, "jeeves-call");
/** How long the phone rings before the call is given up. */
const RING_SECONDS = 45;
/** The numbers a call may be placed to (digits with country code, comma-separated): a call rings
 *  a real phone, so the lend only rings the people it was started for. */
const ALLOWED = new Set(
  (process.env.WHATSAPP_CALLS_ALLOWED || "")
    .split(",")
    .map((number) => number.replace(/\D/g, ""))
    .filter(Boolean),
);

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
  /** From the first ring to the answer. */
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

type ActiveCall = {
  callId: string;
  to: string;
  startedAt: number;
  ringingAt: number | null;
  answeredAt: number | null;
  /** Every voice call the WhatsApp call was carried by: one, unless the voice was reconnected. */
  streamPaths: string[];
  bridge: ChildProcessWithoutNullStreams | null;
  said: string[];
  metrics: CallMetrics;
};

let itx: Project | undefined;
let active: ActiveCall | null = null;

/** The voice ended the call itself (its agent hung up, or nobody spoke for a minute): the WhatsApp
 *  call ends too. Any other end is the voice's connection failing, and the call gets a new one. */
const VOICE_ENDED_ON_PURPOSE = /the Agent hung up|no input|idle|whatsapp/i;
const MAX_VOICE_RECONNECTS = 2;
/** How long the live model may take to come on the line before the call is given up unrung. */
const VOICE_READY_TIMEOUT_MS = 12_000;

const record = (type: string, payload: Record<string, unknown>) =>
  itx
    ?.cd(LOG_PATH)
    .append({ type: `whatsapp-calls/${type}`, payload })
    .catch((error: unknown) =>
      console.error(`whatsapp-calls: could not record ${type}: ${String(error)}`),
    );

/** Ring `input.to`. The voice is connected FIRST (a voice call of the project's, its own context,
 *  the live model on the line), and only then does the phone ring: the person who answers is
 *  spoken to at once. Answers once the phone is ringing; everything after (the answer, the end)
 *  is recorded on LOG_PATH and, with `reportTo`, told to that agent at the end. */
async function call(
  input: CallInput,
): Promise<{ callId: string; ringing: true; streamPath: string }> {
  const project = itx;
  if (!project) throw new Error("WhatsApp calls are not connected to the project yet.");
  const digits = String(input?.to ?? "").replace(/\D/g, "");
  if (digits.length < 8)
    throw new Error(
      `call({ to }) needs a phone number with its country code, got ${JSON.stringify(input?.to)}`,
    );
  if (!ALLOWED.has(digits))
    throw new Error(
      `+${digits} is not a number this lend may ring (it rings ${[...ALLOWED].map((n) => `+${n}`).join(", ") || "nobody"}).`,
    );
  if (active)
    throw new Error(`A call is already in progress (to +${active.to}): one call at a time.`);

  const current: ActiveCall = {
    callId: "",
    to: digits,
    startedAt: Date.now(),
    ringingAt: null,
    answeredAt: null,
    streamPaths: [],
    bridge: null,
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
  };
  active = current;
  let voice: VoiceCall<unknown> | null = null;
  let over = false;
  const say = (line: Record<string, unknown>) => {
    if (current.bridge?.stdin.writable) current.bridge.stdin.write(`${JSON.stringify(line)}\n`);
  };
  const addStats = (ended: VoiceCall<unknown>) => {
    current.metrics.micFramesSent += ended.stats.micFramesSent;
    current.metrics.micFramesDropped += ended.stats.micFramesDropped;
    current.metrics.micFramesFailed += ended.stats.micFramesFailed;
    current.metrics.speakerChunks += ended.stats.spkChunksReceived;
    current.metrics.speakerMs += Math.round(ended.stats.spkMsReceived);
  };

  /** A voice call of the project's for this WhatsApp call, answered once the live model is on the
   *  line. `resumed`: the one before it failed mid-call, and this one is told what was said. */
  const connectVoice = async (resumed: boolean): Promise<void> => {
    const pressedAt = Date.now();
    const accepted = Promise.withResolvers<void>();
    let mine: VoiceCall<unknown> | null = null;
    mine = await startVoiceCall(project, {
      client: `whatsapp-${digits}`,
      onSpeakerFrame: (frame) => {
        if (voice !== mine) return;
        // nobody is listening until the person answers: what the voice says to a ringing phone is dropped
        if (current.answeredAt === null) return;
        // the person spoke over the voice: what was queued for them is dropped
        if (frame.clearSpeakerBufferBeforeFrame) say({ clear: true });
        if (frame.pcm) say({ pcm: frame.pcm, ...(frame.lastFrameOfAnswer && { last: true }) });
        else if (frame.lastFrameOfAnswer) say({ last: true });
      },
      onFact: (fact) => {
        if (fact.type === "events.iterate.com/voice-agent/conversation-accepted")
          accepted.resolve();
        if (fact.type === "events.iterate.com/voice-agent/provider-error-reported")
          console.error(
            `whatsapp-calls: the live model reported: ${fact.payload.message.slice(0, 300)}`,
          );
        if (fact.type === "events.iterate.com/voice-agent/utterance-transcribed")
          current.said.push(`Person: ${fact.payload.text}`);
        if (fact.type === "events.iterate.com/voice-agent/answer-transcribed")
          current.said.push(`Voice: ${fact.payload.text}`);
        if (fact.type !== "events.iterate.com/voice-agent/call-ended" || voice !== mine || over)
          return;
        // this voice call is over, and not because the WhatsApp call ended
        const reason = fact.payload.reason;
        current.metrics.voiceEnds.push(reason);
        addStats(mine!);
        voice = null;
        const reconnects = current.streamPaths.length - 1;
        if (
          VOICE_ENDED_ON_PURPOSE.test(reason) ||
          current.answeredAt === null ||
          reconnects >= MAX_VOICE_RECONNECTS
        ) {
          say({ hangup: true });
          return;
        }
        // the voice's connection failed while the person is on the line: a new one, told what was said
        console.error(`whatsapp-calls: the voice ended (${reason}); reconnecting it`);
        connectVoice(true).catch((error: unknown) => {
          console.error(`whatsapp-calls: the voice could not be reconnected: ${String(error)}`);
          say({ hangup: true });
        });
      },
    });
    current.streamPaths.push(mine.streamPath);
    const callContext = project.cd(mine.streamPath);
    const brief = [
      `[call brief] You are on a WhatsApp voice call to +${digits}, which you placed yourself${input.reportTo ? ` from your conversation at ${input.reportTo}` : ""}: to the person you are the same assistant they know, not someone calling on its behalf.`,
      input.brief ?? "",
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
    if (!ready) {
      await mine.hangUp("whatsapp: the live model did not come on the line").catch(() => undefined);
      throw new Error(
        `The voice did not come on the line within ${String(VOICE_READY_TIMEOUT_MS / 1000)} s.`,
      );
    }
    current.metrics.voiceReadyMs.push(Date.now() - pressedAt);
    voice = mine;
    if (resumed)
      await callContext.append({
        type: "events.iterate.com/agent/web-message-sent",
        payload: { message: "I do apologise, the line dropped for a moment. Where were we?" },
      });
  };

  let done = false;
  const finished = async (reason: string, answered: boolean) => {
    if (done) return;
    done = true;
    over = true;
    if (active === current) active = null;
    const seconds = current.answeredAt ? Math.round((Date.now() - current.answeredAt) / 1000) : 0;
    if (voice) {
      const last = voice;
      voice = null;
      await last.hangUp(`whatsapp: the call ended (${reason})`).catch(() => undefined);
      addStats(last);
    }
    const transcript = current.said.join("\n");
    await record("call-ended", {
      callId: current.callId,
      to: `+${digits}`,
      answered,
      reason,
      seconds,
      streamPath: current.streamPaths.at(-1) ?? null,
      streamPaths: current.streamPaths,
      reportTo: input.reportTo ?? null,
      transcript,
      metrics: current.metrics,
    });
    if (input.reportTo)
      await project.agents
        .get(input.reportTo)
        .message(
          answered
            ? `[whatsapp call to +${digits} ended after ${String(seconds)} s: ${reason}] What was said:\n${transcript || "(nothing was transcribed)"}\n(the call's own agent, with everything it did: ${current.streamPaths.join(", ")})`
            : `[whatsapp call to +${digits} was not answered: ${reason}]`,
        )
        .catch((error: unknown) =>
          console.error(`whatsapp-calls: could not report to ${input.reportTo}: ${String(error)}`),
        );
  };

  // 1. the voice, before anyone is rung
  try {
    await connectVoice(false);
  } catch (error) {
    await finished(
      `the voice could not be connected: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
    throw error;
  }

  // 2. the phone
  const bridge = spawn(BRIDGE, ["bridge", `+${digits}`, String(RING_SECONDS)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  current.bridge = bridge;
  bridge.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  const ringing = Promise.withResolvers<{ callId: string; ringing: true; streamPath: string }>();
  createInterface({ input: bridge.stdout }).on("line", (line) => {
    let event: {
      event?: string;
      callId?: string;
      pcm?: string;
      reason?: string;
      answered?: boolean;
      stats?: Record<string, number>;
    };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.event === "mic") {
      if (event.pcm) voice?.sendMicFrame(event.pcm);
      return;
    }
    if (event.event === "ringing") {
      current.callId = event.callId ?? "";
      current.ringingAt = Date.now();
      void record("call-placed", {
        callId: current.callId,
        to: `+${digits}`,
        reportTo: input.reportTo ?? null,
        streamPath: current.streamPaths[0],
      });
      ringing.resolve({
        callId: current.callId,
        ringing: true,
        streamPath: current.streamPaths[0]!,
      });
    }
    if (event.event === "answered") {
      current.answeredAt = Date.now();
      current.metrics.ringMs = current.ringingAt ? current.answeredAt - current.ringingAt : null;
      void record("call-answered", {
        callId: current.callId,
        to: `+${digits}`,
        streamPath: current.streamPaths[0],
      });
      // the voice is already on the line: it speaks first
      if (input.opening && voice)
        void project
          .cd(voice.streamPath)
          .append({
            type: "events.iterate.com/agent/web-message-sent",
            payload: { message: input.opening },
          })
          .catch((error: unknown) =>
            console.error(`whatsapp-calls: the opening was not said: ${String(error)}`),
          );
    }
    if (event.event === "ended") {
      current.metrics.bridge = event.stats ?? null;
      void finished(event.reason ?? "ended", Boolean(event.answered));
    }
  });
  bridge.on("exit", (code) => {
    ringing.reject(new Error(`The call could not be placed (jeeves-call exited ${String(code)}).`));
    void finished(`the call process ended (${String(code)})`, current.answeredAt !== null);
  });
  return await ringing.promise;
}

export default async function provide(connection: { itx: Project }) {
  itx = connection.itx;
  return {
    call,
    /** End the call in progress, if any. */
    hangup() {
      if (!active) return { hungUp: false };
      if (active.bridge?.stdin.writable) active.bridge.stdin.write('{"hangup":true}\n');
      return { hungUp: true, callId: active.callId };
    },
    /** The call in progress, or null. */
    status() {
      return active
        ? {
            callId: active.callId,
            to: `+${active.to}`,
            answered: active.answeredAt !== null,
            streamPath: active.streamPaths.at(-1) ?? null,
          }
        : null;
    },
    __describe: () => ({
      instructions: `WhatsApp voice calls from the agents' own number. call({ to, opening, brief, reportTo }) rings a person on WhatsApp: the voice is connected first, then the phone rings (it answers { callId, ringing, streamPath } once it does; the ring gives up after ${String(RING_SECONDS)} s). When they answer they are talking to a voice agent of this project, as in the voice app, in a context of its own (streamPath): it says \`opening\` first, and \`brief\` is all it knows about why you called, so put everything in it. One call at a time. hangup() ends it, status() answers the call in progress. Facts land on ${LOG_PATH} (whatsapp-calls/call-placed, call-answered, call-ended with the transcript and the call's metrics); with reportTo (your own agent path) you are messaged what was said when the call ends. It may ring only: ${[...ALLOWED].map((n) => `+${n}`).join(", ") || "nobody"}.`,
      functions: ["call", "hangup", "status"],
    }),
  };
}
