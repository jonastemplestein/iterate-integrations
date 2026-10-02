// calls.test.ts — the lend over a pretend `jeeves-call serve` (fake-bridge.mjs) and a pretend
// project: a call from a number the lend does not answer is left ringing; a call from one it
// answers gets its voice call first and is picked up only then, the voice saying that caller's
// greeting; a placed call rings once its voice is on the line and reports to the agent that asked;
// a call that is accepted and carries no audio is rung again, once, with its opening said once.
// A real call needs a phone: the README's walkthrough.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

type Appended = { path: string; type: string; payload: Record<string, any> };

const dir = mkdtempSync(join(tmpdir(), "whatsapp-calls-"));
const control = join(dir, "control.jsonl");
const log = join(dir, "log.jsonl");
process.env.JEEVES_CALL_BIN = join(import.meta.dirname, "fake-bridge.mjs");
process.env.FAKE_BRIDGE_CONTROL = control;
process.env.FAKE_BRIDGE_LOG = log;
process.env.WHATSAPP_CALLS_ALLOWED = "447700900001,+44 7700 900002";
process.env.WHATSAPP_CALLS_SETTLE_MS = "0";
process.env.WHATSAPP_CALLS_ANSWER_WITH = JSON.stringify({
  "447700900001": "At your service, sir.",
  "447700900002": "At your service, ma'am.",
});

const whatsappSays = (event: Record<string, unknown>) =>
  appendFileSync(control, `${JSON.stringify(event)}\n`);
const bridgeHeard = (): Record<string, any>[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>)
    : [];
async function until<T>(what: string, look: () => T | undefined | false): Promise<T> {
  for (let waited = 0; waited < 5000; waited += 10) {
    const found = look();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A project whose voice app accepts every call a moment after the press, and whose appends and
 *  agent messages are kept. */
function pretendProject() {
  const listeners = new Map<string, (events: unknown[]) => void>();
  const project = {
    events: [] as Appended[],
    messages: [] as { to: string; text: string }[],
    notes: new Map<string, string>(),
    itx: {
      kv: { get: async (key: string) => project.notes.get(key) ?? null },
      voice: {
        setupVoiceAgent: async ({ streamPath }: { streamPath: string; activation: string }) => {
          setTimeout(
            () =>
              listeners.get(streamPath)?.([
                {
                  type: "events.iterate.com/voice-agent/conversation-accepted",
                  payload: { handshakeTookMs: 1, upgradeTookMs: 1 },
                },
              ]),
            30,
          );
          return { streamPath };
        },
      },
      cd: (path: string) => ({
        append: async (event: { type: string; payload: Record<string, any> }) => {
          project.events.push({ path, type: event.type, payload: event.payload });
          // a call's end comes back through its subscription, as the platform delivers it
          if (event.type === "events.iterate.com/voice-agent/call-ended")
            listeners.get(path)?.([event]);
          return {};
        },
        subscribe: async ({ target }: { target: (events: unknown[]) => void }) => {
          listeners.set(path, target);
          return { [Symbol.dispose]() {} };
        },
      }),
      agents: {
        get: (to: string) => ({
          message: async (text: string) => void project.messages.push({ to, text }),
        }),
      },
    },
  };
  return project;
}

test("calls in and out: an unknown caller is left ringing, a known one is picked up once the voice is on the line, a placed call rings after it", async () => {
  const project = pretendProject();
  const { default: provide } = await import("../calls.ts");
  const lent = await provide({ itx: project.itx as never });
  const recorded = (type: string) =>
    project.events.filter((event) => event.type === `whatsapp-calls/${type}`);
  const spoken = () =>
    project.events
      .filter((event) => event.type === "events.iterate.com/agent/web-message-sent")
      .map((event) => [event.path.split("/").slice(0, 4).join("/"), event.payload.message]);

  // a stranger rings: recorded, and not picked up
  whatsappSays({ event: "incoming", callId: "in-0", number: "447700900009", from: "9@lid" });
  const left = await until("the stranger's call", () => recorded("call-received")[0]);
  assert.deepEqual(left.payload, {
    callId: "in-0",
    from: "+447700900009",
    answering: false,
    reason: "not a number this lend answers",
  });

  // a known caller rings: the voice call first, then the pick-up, then the greeting
  whatsappSays({ event: "incoming", callId: "in-1", number: "447700900001", from: "1@lid" });
  await until("the pick-up", () => bridgeHeard().find((line) => line.answer === "in-1"));
  assert.equal(bridgeHeard().length, 1, "nothing was said to the bridge before the pick-up");
  await until("the greeting", () => spoken().length === 1);
  assert.deepEqual(spoken(), [["/agents/voice/whatsapp-447700900001", "At your service, sir."]]);
  assert.equal(lent.status()?.direction, "in");
  whatsappSays({ event: "ended", callId: "in-1", reason: "the person hung up", answered: true });
  const ended = await until("the call's end", () => recorded("call-ended")[0]);
  assert.equal(ended.payload.direction, "in");
  assert.equal(ended.payload.from, "+447700900001");
  assert.equal(ended.payload.answered, true);
  assert.match(ended.payload.streamPath, /^\/agents\/voice\/whatsapp-447700900001\//);
  assert.equal(lent.status(), null);

  // a caller the project left a note for: the note's opening is said, its brief is the agent's
  project.notes.set(
    "whatsapp-calls/answer/447700900002",
    JSON.stringify({
      opening: "At your service, ma'am. It is German school today.",
      brief: "The form is at /documents/form.pdf.",
      until: "2999-01-01T00:00:00Z",
    }),
  );
  project.notes.set(
    "whatsapp-calls/answer/447700900001",
    JSON.stringify({ opening: "A stale note.", until: "2000-01-01T00:00:00Z" }),
  );
  whatsappSays({ event: "incoming", callId: "in-2", number: "447700900002", from: "2@lid" });
  await until("the noted greeting", () => spoken().length === 2);
  assert.deepEqual(spoken()[1], [
    "/agents/voice/whatsapp-447700900002",
    "At your service, ma'am. It is German school today.",
  ]);
  const briefed = project.events.find(
    (event) =>
      event.type === "events.iterate.com/agent/context-added" &&
      event.path.startsWith("/agents/voice/whatsapp-447700900002/"),
  );
  assert.match(
    briefed!.payload.content,
    /rang you on WhatsApp and you picked up.*The form is at \/documents\/form\.pdf\./,
  );
  whatsappSays({ event: "ended", callId: "in-2", reason: "the person hung up", answered: true });
  await until("the noted call's end", () => recorded("call-ended").length === 2);
  // a stale note changes nothing
  whatsappSays({ event: "incoming", callId: "in-3", number: "447700900001", from: "1@lid" });
  await until("the usual greeting", () => spoken().length === 3);
  assert.equal(spoken()[2]![1], "At your service, sir.");
  whatsappSays({ event: "ended", callId: "in-3", reason: "the person hung up", answered: true });
  await until("the third call's end", () => recorded("call-ended").length === 3);

  // a call placed by the project: rung once its voice is on the line, reported to who asked
  await assert.rejects(lent.call({ to: "+44 7700 900009" }), /not a number this lend may ring/);
  const placed = await lent.call({
    to: "+44 7700 900002",
    opening: "Good evening, ma'am.",
    reportTo: "/agents/family-chief-of-staff",
  });
  assert.equal(placed.callId, "out-1");
  assert.match(placed.streamPath, /^\/agents\/voice\/whatsapp-447700900002\//);
  await until("the opening", () => spoken().length === 4);
  assert.deepEqual(spoken()[3], ["/agents/voice/whatsapp-447700900002", "Good evening, ma'am."]);
  assert.deepEqual(lent.hangup(), { hungUp: true, callId: "out-1" });
  await until("the report", () => project.messages[0]);
  assert.equal(project.messages[0]!.to, "/agents/family-chief-of-staff");
  assert.match(
    project.messages[0]!.text,
    /^\[whatsapp call to \+447700900002 ended after \d+ s: hung up\]/,
  );
  assert.deepEqual(
    recorded("call-ended").map((event) => [event.payload.direction, event.payload.reason]),
    [
      ["in", "the person hung up"],
      ["in", "the person hung up"],
      ["in", "the person hung up"],
      ["out", "hung up"],
    ],
  );

  // a call that is accepted and carries no audio: rung again by a fresh device, said to once
  whatsappSays({ fake: "no-audio" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const again = await lent.call({ to: "+44 7700 900001", opening: "Good evening, sir." });
  assert.equal(again.callId, "out-2");
  await until("the second ring's answer", () => spoken().length === 5);
  assert.deepEqual(spoken()[4], ["/agents/voice/whatsapp-447700900001", "Good evening, sir."]);
  assert.equal(recorded("call-retried").length, 1);
  assert.equal(lent.status()?.callId, "out-3");
  assert.equal(bridgeHeard().filter((line) => line.call === "+447700900001").length, 2);
  lent.hangup();
  const last = await until("the retried call's end", () => recorded("call-ended")[4]);
  assert.equal(last.payload.redialled, true);
  assert.equal(last.payload.answered, true);
});
