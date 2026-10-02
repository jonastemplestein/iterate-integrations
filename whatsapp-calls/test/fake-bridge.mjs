#!/usr/bin/env node
// A pretend `jeeves-call serve` for calls.test.ts: it speaks serve.go's lines with no WhatsApp
// behind it. What calls.ts writes to it is logged to $FAKE_BRIDGE_LOG (one JSON line each), and
// each line the test appends to $FAKE_BRIDGE_CONTROL is said as an event of WhatsApp's side (an
// incoming call, the other person hanging up). A placed call rings and is answered at once; a
// picked-up call carries audio at once; a hang-up ends the call.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const say = (event) => console.log(JSON.stringify(event));
let callId = "";
let placed = 0;
say({ event: "ready", self: "pretend" });

let said = 0;
setInterval(() => {
  if (!existsSync(process.env.FAKE_BRIDGE_CONTROL)) return;
  const lines = readFileSync(process.env.FAKE_BRIDGE_CONTROL, "utf8").split("\n").filter(Boolean);
  for (const line of lines.slice(said)) say(JSON.parse(line));
  said = lines.length;
}, 10);

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const input = JSON.parse(line);
  appendFileSync(process.env.FAKE_BRIDGE_LOG, `${line}\n`);
  if (input.call) {
    callId = `out-${String(++placed)}`;
    say({ event: "ringing", callId });
    say({ event: "answered", callId });
  }
  if (input.answer) {
    callId = input.answer;
    say({ event: "answered", callId });
  }
  if (input.hangup)
    say({ event: "ended", callId, reason: "hung up", answered: true, stats: { framesPlayed: 0 } });
});
lines.on("close", () => process.exit(0));
