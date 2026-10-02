# WhatsApp voice calls

Real WhatsApp voice calls between a person and an iterate project's voice agent, both ways, from
the project's own WhatsApp account:

- **Out**: an agent calls `itx.whatsappCalls.call({ to, opening, brief, reportTo })` and the
  person's phone rings on WhatsApp.
- **In**: a person the lend answers rings the account, and the call is picked up.

Either way the call is one of the project's voice calls, the same as its voice app's: a context of
its own at `/agents/voice/whatsapp-<the other person's digits>/<time>-<id>` with a fresh agent and
the voice relay beside it. **The voice is on the line first**: a placed call only rings once the
live model has answered, and an incoming call is only picked up then, so the person is spoken to
at once.

[Baileys](../whatsapp) cannot carry a call, so the WhatsApp side is
[meowcaller](https://github.com/purpshell/meowcaller) (WhatsApp's call stack in Go, on a
[whatsmeow](https://github.com/tulir/whatsmeow) fork): `jeeves-call`, a second linked device of
the same account. `calls.ts` is what `iterate provide` lends: it keeps `jeeves-call serve` running
and carries each call's audio between it and the project (16 kHz mono PCM16 both ways, the voice
processor's own format).

This is not an official WhatsApp API. An account that calls people who did not ask for it can be
restricted: lend it for the few people it was set up for.

## Run it

You need Go 1.25 or later, Node 22.18 or later, an `iterate` CLI with `provide`, a project with the
voice app installed (`itx.voice.setupVoiceAgent`), and this repository.

```sh
pnpm install
cd whatsapp-calls && pnpm bridge                  # go build -o jeeves-call .
export WHATSAPP_CALLS_DIR=~/.config/iterate-whatsapp-calls   # the linked device's keys: never commit or copy them

# link this computer to the account, once: an 8-character code to type into the phone
# (WhatsApp > Linked devices > Link a device > Link with phone number instead)
./jeeves-call link 447700900000

export WHATSAPP_CALLS_ALLOWED=447700900001,447700900002      # who may be rung, and whose calls are picked up
export WHATSAPP_CALLS_ANSWER_WITH='{"447700900001":"At your service, sir.","default":"Hello."}'
iterate provide whatsapp-calls/calls.ts --name whatsappCalls --project <your project>
```

Without a number, `jeeves-call link` pairs by QR code instead: each code's text is written to
`$WHATSAPP_CALLS_DIR/qr.txt`. Keep it running with a loop, as for [WhatsApp](../whatsapp#run-it).
`jeeves-call play <number> <file.mp3> [seconds]` rings a number and plays a file: a test of the
link with no project. `link`, `play` and `serve` connect as the same device, so run one at a time.

## What the project gets

```js
const { callId, streamPath } = await itx.whatsappCalls.call({
  to: "+44 7700 900001",
  opening: "Good evening, sir. The school has moved tomorrow's trip to nine o'clock.", // said when they answer
  brief:
    "Why you are calling and the facts the call's agent needs: it cannot see your conversation.",
  reportTo: "/agents/chief-of-staff", // messaged what was said once the call ends
}); // answers once the phone rings; the ring gives up after 45 s
await itx.whatsappCalls.status(); // the call in progress ({ direction, with, answered, streamPath }) or null
await itx.whatsappCalls.hangup();
```

**A note for a caller's next call.** To have the voice say something particular when a person next
rings, the project leaves a note in its kv first; it replaces the usual greeting, and its `brief`
is what the call's agent is told:

```js
await itx.kv.put(
  "whatsapp-calls/answer/447700900002", // the caller's digits
  JSON.stringify({
    opening:
      "At your service, ma'am. The plumber has moved to Thursday at ten. Shall I put it in the calendar?",
    brief:
      "The plumber (Mr Hale, 07700 900123) moved from Wednesday to Thursday 10:00. The family calendar is not updated yet.",
    until: "2026-10-03T12:00:00Z", // ignored after this
  }),
);
```

One call at a time. Every call leaves its facts on `/integrations/whatsapp-calls`:

| Event                          | When                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp-calls/call-placed`   | A call the project placed is ringing: `callId`, `to`, `reportTo`, `streamPath`.                                                                                                                   |
| `whatsapp-calls/call-received` | Someone rang the account: `callId`, `from`, `answering`, and the `reason` when it is left alone (not a number the lend answers, a group or video call, another call in progress).                 |
| `whatsapp-calls/call-answered` | Audio flows: `callId`, `direction`, `to` or `from`, `streamPath`.                                                                                                                                 |
| `whatsapp-calls/call-ended`    | `callId`, `direction` (`"out"` or `"in"`), `to` or `from`, `answered`, `reason`, `seconds`, `transcript` (every `Person:` and `Voice:` line), `streamPath`, `streamPaths`, `reportTo`, `metrics`. |

`metrics` is where a call that sounded wrong went wrong: how long the voice took to come on the
line, the ring, microphone frames sent and dropped, and the bridge's own count of frames played,
gaps in an answer and the deepest queue.

## Things to know

- **Every device of the account rings.** WhatsApp offers an incoming call to all of the account's
  devices, the phone included, and stops the others ringing once one picks up. This lend picks up
  when the voice is on the line, a few seconds in; the phone rings until then. A call from anyone
  the lend does not answer is left ringing on the other devices.
- **A fresh device for every call.** `jeeves-call serve` is started again after each call, so a
  call is always carried by a process that has carried none: the one call that carried no audio in
  either direction was the third call of a long-running one.
- **A silent call is rung again.** A call that was accepted and carries no audio within six
  seconds is ended and the person is rung again, once (`whatsapp-calls/call-retried`); a call they
  placed becomes a call back that opens with an apology. `LOG_LEVEL=debug` logs the media in detail.
- **A voice connection that drops mid-call is replaced** (twice at most): the new one is told what
  was said and apologises. The call ends when the voice's agent hangs up, the person does, or
  nobody has spoken for a minute.
- **The call's agent knows only `brief`** (and whatever the project gives an agent at that path).
  On an incoming call the brief says who rang and nothing more.
- Group calls and video calls are not picked up.

## Test

```sh
pnpm test   # calls.ts over a pretend jeeves-call and a pretend project
```
