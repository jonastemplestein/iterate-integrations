#!/usr/bin/env node
// A pretend `jeeves-call serve` for calls.test.ts: it speaks serve.go's lines with no WhatsApp
// behind it. What calls.ts writes to it is logged to $FAKE_BRIDGE_LOG (one JSON line each), and
// each line the test appends to $FAKE_BRIDGE_CONTROL is said as an event of WhatsApp's side (an
// incoming call, the other person hanging up). A placed call rings and is answered at once; a
// picked-up call carries audio at once; a hang-up ends the call. It is started again after every
// call, so what it has said and placed is kept in $FAKE_BRIDGE_CONTROL.state. A control line
// {"fake":"no-audio"} makes the next placed call end as one that carried no audio.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const say = (event) => console.log(JSON.stringify(event));
const stateFile = `${process.env.FAKE_BRIDGE_CONTROL}.state`;
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : { said: 0, placed: 0, noAudio: false };
const keep = () => writeFileSync(stateFile, JSON.stringify(state));
let callId = "";
say({ event: "ready", self: "pretend" });

setInterval(() => {
  if (!existsSync(process.env.FAKE_BRIDGE_CONTROL)) return;
  const lines = readFileSync(process.env.FAKE_BRIDGE_CONTROL, "utf8").split("\n").filter(Boolean);
  for (const line of lines.slice(state.said)) {
    const event = JSON.parse(line);
    if (event.fake === "no-audio") state.noAudio = true;
    else say(event);
  }
  state.said = lines.length;
  keep();
}, 10);

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const input = JSON.parse(line);
  appendFileSync(process.env.FAKE_BRIDGE_LOG, `${line}\n`);
  if (input.call) {
    callId = `out-${String(++state.placed)}`;
    say({ event: "ringing", callId });
    if (state.noAudio) {
      state.noAudio = false;
      say({ event: "ended", callId, reason: "answered, but no audio flowed", answered: false });
    } else say({ event: "answered", callId });
    keep();
  }
  if (input.answer) {
    callId = input.answer;
    say({ event: "answered", callId });
  }
  if (input.hangup)
    say({ event: "ended", callId, reason: "hung up", answered: true, stats: { framesPlayed: 0 } });
});
lines.on("close", () => process.exit(0));
