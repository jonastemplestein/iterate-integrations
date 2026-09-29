// dummy.ts — whatsapp.ts's lend over a pretend WhatsApp that talks to nobody, to try the lend without
// a WhatsApp account or a phone:
//
//   iterate provide whatsapp/src/dummy.ts --name whatsappDummy --project <slug>
//
// The socket answers Baileys' shapes for the functions a first script uses (sendMessage with text,
// media by { url } or bytes, reactions; onWhatsApp; groupMetadata; readMessages;
// sendPresenceUpdate), and adds one of its own: `simulateIncomingMessage`, a contact writing to
// you. Sent and received messages land on `/integrations/whatsapp-dummy` exactly as whatsapp.ts's
// land on `/integrations/whatsapp`; `sentMessages()` answers what the pretend WhatsApp was sent.
import { EventEmitter } from "node:events";
import type { AnyMessageContent, BaileysEventMap, MiscMessageGenerationOptions, WAMessage } from "baileys";
import { provideWhatsApp, type WhatsAppSocket } from "./whatsapp.ts";

export const description =
  "A PRETEND WhatsApp (whatsapp.ts's lend over a socket that talks to nobody): Baileys' sendMessage, onWhatsApp, groupMetadata and friends, plus simulateIncomingMessage({ from, text?, image?, afterMs? }) and sentMessages(); call __describe() first.";

const ME = "447700900001@s.whatsapp.net";

function makeDummySocket() {
  const ev = new EventEmitter();
  const sent: WAMessage[] = [];
  const media = new Map<string, Uint8Array>();
  let nextId = 0;
  const upsert = (upsert: BaileysEventMap["messages.upsert"]) => ev.emit("messages.upsert", upsert);
  /** Baileys' media input: bytes, or { url } fetched (https: or data:, all the lend lets through). */
  const bytesOf = async (upload: unknown): Promise<Uint8Array> => {
    if (upload instanceof Uint8Array) return upload;
    const { url } = upload as { url: string | URL };
    const response = await fetch(url);
    if (!response.ok) throw new Error(`dummy WhatsApp: ${url} answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  /** A media message as Baileys receives it: a CDN url, a key and a length, the bytes kept here. */
  const mediaMessage = (id: string, bytes: Uint8Array, mimetype: string, caption?: string) => {
    media.set(id, bytes);
    return {
      url: `https://mmg.whatsapp.net/dummy/${id}`,
      mimetype,
      caption,
      mediaKey: crypto.getRandomValues(new Uint8Array(32)),
      fileLength: bytes.byteLength,
    };
  };
  return {
    ev: ev as unknown as WhatsAppSocket["ev"],
    user: { id: ME, name: "Dummy" },
    async sendMessage(jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) {
      const id = options?.messageId || `DUMMY${Date.now()}${nextId++}`;
      const c = content as Record<string, any>;
      const message =
        "text" in c
          ? { conversation: c.text as string }
          : "image" in c
            ? { imageMessage: mediaMessage(id, await bytesOf(c.image), c.mimetype || "image/jpeg", c.caption) }
            : "document" in c
              ? { documentMessage: { ...mediaMessage(id, await bytesOf(c.document), c.mimetype), fileName: c.fileName } }
              : "audio" in c
                ? { audioMessage: { ...mediaMessage(id, await bytesOf(c.audio), c.mimetype || "audio/ogg; codecs=opus"), ptt: !!c.ptt } }
                : "react" in c
                  ? { reactionMessage: { key: c.react.key, text: c.react.text } }
                  : null;
      if (!message) throw new Error(`dummy WhatsApp: no pretend for ${Object.keys(c).join(", ")}`);
      const sentMessage: WAMessage = {
        key: { remoteJid: jid, fromMe: true, id },
        message,
        messageTimestamp: Math.floor(Date.now() / 1000),
        status: 2,
      };
      sent.push(sentMessage);
      upsert({ type: "append", messages: [sentMessage] }); // Baileys' own send comes back as an append
      return sentMessage;
    },
    async onWhatsApp(...phones: string[]) {
      return phones.map((phone) => ({ jid: `${phone.replace(/\D/g, "")}@s.whatsapp.net`, exists: true }));
    },
    async groupMetadata(jid: string) {
      return { id: jid, subject: "Dummy group", owner: ME, participants: [{ id: ME, admin: "superadmin" }] };
    },
    async readMessages(_keys: unknown[]) {},
    async sendPresenceUpdate(_type: string, _jid?: string) {},
    /** The pretend WhatsApp's own: a contact writes to you, as Baileys would hand it over —
     *  `afterMs` later, to have it arrive while the project is out of reach. */
    async simulateIncomingMessage(input: {
      from: string;
      pushName?: string;
      text?: string;
      image?: { data: Uint8Array; mimetype: string; caption?: string };
      afterMs?: number;
    }) {
      const id = `DUMMYIN${Date.now()}${nextId++}`;
      const received: WAMessage = {
        key: { remoteJid: input.from, fromMe: false, id },
        message: input.image
          ? { imageMessage: mediaMessage(id, input.image.data, input.image.mimetype, input.image.caption) }
          : { conversation: input.text ?? "" },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: input.pushName ?? "Dummy contact",
      };
      if (input.afterMs) setTimeout(() => upsert({ type: "notify", messages: [received] }), input.afterMs);
      else upsert({ type: "notify", messages: [received] });
      return received;
    },
    /** What the pretend WhatsApp was sent, oldest first. */
    async sentMessages() {
      return sent;
    },
    downloadMedia(message: WAMessage) {
      const bytes = message.key.id ? media.get(message.key.id) : undefined;
      if (!bytes) throw new Error(`dummy WhatsApp: no media for message ${message.key.id}`);
      return bytes;
    },
  };
}

export default provideWhatsApp({
  logPath: "/integrations/whatsapp-dummy",
  connect: async (onSocket) => onSocket(makeDummySocket()),
  downloadMedia: async (message, socket) =>
    (socket as ReturnType<typeof makeDummySocket>).downloadMedia(message),
});
