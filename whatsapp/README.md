# WhatsApp

Your own WhatsApp in an iterate project, lent from your own computer: [Baileys](https://baileys.wiki)
links this computer to your account as a linked device, as WhatsApp Web does, and
[`iterate provide`](https://github.com/iterate/iterate/tree/main/packages/cli#provide) lends it to
the project as `itx.whatsapp`. Nothing runs on iterate that is not already there
([why your own computer](#why-your-own-computer)).

- **Every message** in your chats, either way, lands on the project's `/integrations/whatsapp` as a
  `whatsapp/message-added` event: `{ type: "notify" | "append", message }`, `message` Baileys' own
  (`key.remoteJid`, `key.fromMe`, `message.conversation`, `message.imageMessage`, …), bytes as
  `{ type: "Buffer", data: <base64> }`. The same message twice is one event.
- **Baileys' own socket API** is `itx.whatsapp`: `sendMessage(jid, content, options)`,
  `groupMetadata(jid)`, `onWhatsApp(...phones)`, `readMessages(keys)` and the rest, as documented at
  [baileys.wiki](https://baileys.wiki), plus `downloadMedia(message)` for a received message's
  media and `__describe()` for an agent. The whole socket, `logout()` included: share only with a
  project you trust.
- **Files**: send one with its URL, `sendMessage(jid, { image: { url: await itx.files.get(path).url() } })`
  (only `https:` and `data:` URLs: Baileys would read anything else from this computer), and keep a
  received one with `itx.files.get(path).put({ contentType, data: await itx.whatsapp.downloadMedia(message) })`.

## Run it

You need Node 22.18 or later, an `iterate` CLI with `provide`
(`npm install -g https://pkg.pr.new/iterate/iterate/@iterate-com/cli@4af48cea5` or later, then
`iterate login`) and this repository.

```sh
git clone https://github.com/jonastemplestein/iterategrations && cd iterategrations
pnpm install                                       # Baileys, into whatsapp/node_modules
iterate provide whatsapp/src/whatsapp.ts --project <your project>
```

It prints `itx.whatsapp` and a QR code: on your phone, WhatsApp → Settings → Linked devices → Link
a device, and scan it. The link is kept in `whatsapp/.auth` (`WHATSAPP_AUTH_FOLDER` to move it):
the next run needs no QR. Never restore that folder from a backup: an old copy rolls the encryption
back and WhatsApp unlinks the device. Stop with Ctrl-C.

Try it from the project:

```js
async (itx) => {
  const [me] = await itx.whatsapp.onWhatsApp("+44 7700 900123");
  return await itx.whatsapp.sendMessage(me.jid, { text: "hello from iterate" });
};
```

To keep it running unattended, give it a key of its own instead of `iterate login` (whose grant
lasts 30 days at most): mint one with `iterate tokens create --name whatsapp --project <your project> --never-expires`,
then run `ITERATE_BEARER_TOKEN=itk_… iterate provide whatsapp/src/whatsapp.ts --project <your project>`.
`iterate provide` reconnects on its own, but gives up after about five minutes without the project (a
deploy that erases it, a long outage). To ride those out, run it in a loop:

```sh
while true; do iterate provide whatsapp/src/whatsapp.ts --project <your project>; sleep 15; done
```

## Without an account: the dummy

`whatsapp/src/dummy.ts` is the same lend over a pretend WhatsApp that talks to nobody: Baileys'
shapes for `sendMessage` (text, media by `{ url }` or bytes, reactions), `onWhatsApp`,
`groupMetadata`, `readMessages` and `sendPresenceUpdate`, plus `simulateIncomingMessage({ from,
text?, image? })`, a contact writing to you, and `sentMessages()`. Its messages land on
`/integrations/whatsapp-dummy`.

```sh
iterate provide whatsapp/src/dummy.ts --name whatsappDummy --project <your project>
```

## Why your own computer

- **Your IP, not a datacenter's.** WhatsApp Web is made for a person's own device, and WhatsApp scores
  every linked device for abuse. Nobody documents a rule against datacenter IPs, but reports of
  Baileys sessions logged out or refused from cloud hosts are common, and a shared Cloudflare or AWS
  address carries everyone else's reputation. A home connection sending at a person's pace is the
  least suspicious place a linked device can be. It is a lower risk, not a guarantee: what you send
  (volume, new chats) matters more.
- **It holds a connection open, always.** A linked device keeps one WebSocket to WhatsApp open,
  pinged every 30 seconds. A Durable Object holding an outbound WebSocket stays up only 15 minutes at a
  time and is billed for all of it; a process on a computer that is on anyway costs nothing.
- **Baileys runs in Node.** It is written for Node's `ws` and compiles WebAssembly when imported, which
  Workers do not allow; a Rust port with a Workers example exists (`oxidezap/baileyrs`) but its own
  README says reconnecting was never tested against a real account.
- **Its keys change with every message.** The session's encryption keys (`whatsapp/.auth`) are rewritten
  as messages arrive; a local folder is the simplest place for them.

Any always-on computer on a home connection does: a Mac mini or a Raspberry Pi rather than a laptop
that sleeps.

## Good to know

- **The phone.** Baileys is a linked device, never the account's primary one. WhatsApp logs every
  linked device out when the primary goes 14 days without connecting, and allows four linked
  devices.
- **Offline.** While this computer sleeps, the project's calls answer `NO_ITX_EXPRESSION_MATCH`.
  WhatsApp keeps what arrives meanwhile and delivers it on reconnect (`type: "append"`). Messages
  that reach this computer while the project is unreachable wait here, up to 1,000, and land on its
  next connection.
- **Ban risk.** Baileys is not WhatsApp's; using it is against WhatsApp's terms. WhatsApp's own
  limits (a cap on new chats, a timelock on reaching out) target starting conversations: an agent
  that answers chats you already have, at a person's pace, is the gentle end. Gate who it answers
  before it answers anyone.
- **Logged out** (you unlinked it on the phone): the process says so and exits; delete
  `whatsapp/.auth` and run it again. **Another process** with the same `.auth` makes this one exit.
