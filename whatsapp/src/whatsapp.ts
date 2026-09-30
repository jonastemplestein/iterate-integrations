// whatsapp.ts — your WhatsApp, lent to an iterate project from your own computer:
//
//   iterate provide whatsapp/src/whatsapp.ts --project <slug>
//
// Baileys (https://baileys.wiki) links this computer to your WhatsApp as a linked device, the way
// WhatsApp Web does, from your own IP. Every message in your chats lands on the project's
// `/integrations/whatsapp` as a `whatsapp/message-added` event, and the project calls Baileys'
// own socket API as `itx.whatsapp`: `sendMessage(jid, content, options)`, `groupMetadata(jid)`,
// `onWhatsApp(...phones)`, and the rest, plus `downloadMedia(message)`.
import { join } from "node:path";
import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  type BaileysEventMap,
  type WAMessage,
  type WASocket,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

export const description =
  "My WhatsApp, as Baileys' socket (https://baileys.wiki): sendMessage(jid, content, options), groupMetadata(jid), onWhatsApp(...phones), downloadMedia(message) and the rest; call __describe() first. Messages land on /integrations/whatsapp.";

/** The project, as `iterate provide` hands it over: the part this file uses. */
export type Itx = {
  cd(path: string): { append(...events: MessageAdded[]): Promise<unknown> };
};

/** One message of a chat, either way (`message.key.fromMe`): Baileys' `messages.upsert`, one event
 *  per message. `type` is Baileys' too: `notify` for a message as it arrives, `append` for one
 *  delivered late (sent while this computer was offline, or sent from here). */
export type MessageAdded = {
  type: "whatsapp/message-added";
  payload: { type: BaileysEventMap["messages.upsert"]["type"]; message: unknown };
  idempotencyKey: string;
};

/** A WhatsApp socket as the lend reads it: Baileys' own, or the dummy's, with the same functions. */
export type WhatsAppSocket = {
  ev: {
    on(
      event: "messages.upsert",
      listener: (upsert: BaileysEventMap["messages.upsert"]) => void,
    ): unknown;
  };
};

/** Messages that could not reach the project yet wait here for its next connection, at most this
 *  many, the oldest dropped first (and said so). */
const PENDING_LIMIT = 1_000;

/** The platform's refusal of a key that already names a different event (iterate's
 *  IDEMPOTENCY_CONFLICT): by its code where the error kept it, else by the platform's one message
 *  for it (iterate/stream/processor `idempotencyConflictMessage`). */
const isIdempotencyConflict = (error: unknown): boolean =>
  (typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "IDEMPOTENCY_CONFLICT") ||
  /already names a different event at offset/.test(
    error instanceof Error ? error.message : String(error),
  );

/** THE LEND. `connect` opens the WhatsApp socket once for the whole process, and a new one each time
 *  Baileys closes one, handing each to `onSocket`. The answer is `iterate provide`'s default export:
 *  called on every connection to the project with that connection's `itx`, it answers the
 *  functions to lend — every function of the current socket, unchanged except that arguments and
 *  answers cross as JSON (Baileys' own `BufferJSON`: bytes as `{ type: "Buffer", data: <base64> }`),
 *  plus `downloadMedia` and `__describe`. */
export function provideWhatsApp(input: {
  logPath: string;
  connect: (onSocket: (socket: WhatsAppSocket) => void) => Promise<void>;
  downloadMedia: (message: WAMessage, socket: WhatsAppSocket) => Promise<Uint8Array>;
}) {
  let itx: Itx | undefined;
  let socket: WhatsAppSocket | undefined;
  let connected: Promise<void> | undefined;
  const pending: MessageAdded[] = [];
  let flushing: Promise<void> | undefined;
  /** Append what waits, in order, over the newest connection, one flush at a time; a failure leaves
   *  it waiting for the next connection. */
  const flush = (): Promise<void> =>
    (flushing ??= (async () => {
      try {
        while (itx && pending.length > 0) {
          const batch = pending.slice(0, 50);
          const log = itx.cd(input.logPath);
          await log.append(...batch).catch(async (error: unknown) => {
            if (!isIdempotencyConflict(error)) throw error;
            // A redelivery whose body differs from the event its key already names (an `append`
            // after a `notify`, or fields WhatsApp filled in later): that message is recorded, and
            // the refusal takes the whole batch, so the batch goes again one message at a time.
            for (const event of batch)
              await log.append(event).catch((single: unknown) => {
                if (!isIdempotencyConflict(single)) throw single;
              });
          });
          pending.splice(0, batch.length);
        }
        return true;
      } catch (error) {
        console.error(
          `WhatsApp: ${pending.length} message(s) wait for the project's next connection (${error instanceof Error ? error.message : String(error)})`,
        );
        return false;
      }
    })().then((appended) => {
      flushing = undefined;
      if (appended && pending.length > 0) void flush(); // arrived as it finished
    }));
  const onSocket = (next: WhatsAppSocket) => {
    socket = next;
    next.ev.on("messages.upsert", ({ type, messages }) => {
      for (const message of messages)
        pending.push({
          type: "whatsapp/message-added",
          payload: { type, message: json(message) },
          // the same message delivered twice (a reconnect, an `append` after a `notify`) is one event
          idempotencyKey: `whatsapp/message-added:${message.key.remoteJid}:${message.key.id}`,
        });
      if (pending.length > PENDING_LIMIT) {
        const dropped = pending.splice(0, pending.length - PENDING_LIMIT);
        console.error(`WhatsApp: dropped ${dropped.length} message(s) the project never took`);
      }
      void flush();
    });
  };
  const current = () => {
    if (!socket) throw new Error("WhatsApp is not connected yet.");
    return socket as unknown as Record<string, (...args: unknown[]) => unknown>;
  };
  return async function provide(connection: { itx: Itx }) {
    itx = connection.itx;
    await (connected ??= input.connect(onSocket));
    void flush();
    const lent: Record<string, (...args: never[]) => unknown> = {};
    for (const [name, value] of Object.entries(current()))
      if (typeof value === "function")
        lent[name] = async (...args: unknown[]) => {
          refuseLocalUrls(args);
          const socket = current();
          try {
            return json(await socket[name]!(...(revive(args) as unknown[])));
          } catch (error) {
            // Baileys' `user` is the linked account: none yet, and every call fails obscurely
            if (!(socket as { user?: unknown }).user)
              throw new Error(
                `WhatsApp is not linked yet: scan the QR code the computer lending it printed (WhatsApp → Settings → Linked devices → Link a device). ${error instanceof Error ? error.message : String(error)}`,
              );
            throw error;
          }
        };
    lent.downloadMedia = async (message: unknown) =>
      await input.downloadMedia(revive(message) as WAMessage, socket!);
    lent.__describe = () => ({
      instructions:
        "My WhatsApp through Baileys (https://baileys.wiki), a linked device on my own computer. Every function is Baileys' socket function of the same name, e.g. sendMessage(jid, { text }), sendMessage(jid, { image: { url }, caption }), sendMessage(jid, { react: { text, key } }), groupMetadata(jid), onWhatsApp(...phones). A jid is <digits>@s.whatsapp.net (a person), …@g.us (a group) or …@lid. Bytes cross as { type: 'Buffer', data: <base64> }. Media: pass { url } — an https: URL (an itx.files URL works) or a data: URL; nothing else. downloadMedia(message) answers the bytes of a received message's media (store them with itx.files). Messages land on " +
        input.logPath +
        " as whatsapp/message-added. Only write to chats that already exist unless told otherwise: WhatsApp restricts accounts that start many new chats.",
      functions: Object.keys(lent).sort(),
    });
    return lent;
  };
}

/** Baileys' objects as plain JSON: protobuf classes and bytes (`BufferJSON`) turned into data. */
function json(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

/** The JSON back into what Baileys takes: `{ type: "Buffer", data }` into bytes. */
function revive(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, BufferJSON.replacer), BufferJSON.reviver);
}

/** Baileys reads a media `{ url }` that is not http(s) or data: as a path on THIS computer, and
 *  fetches an http one from this computer's network: from the project, only https: and data:. */
function refuseLocalUrls(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if ("url" in value && value.url != null) {
    // Baileys takes a string or a URL; anything else is refused with them
    const url =
      value.url instanceof URL ? value.url.href : typeof value.url === "string" ? value.url : "";
    if (!/^(https|data):/i.test(url))
      throw new Error(
        `A url must be https: or data: (got ${JSON.stringify(url.slice(0, 60))}): anything else would be read from the computer lending WhatsApp.`,
      );
  }
  for (const inner of Object.values(value)) refuseLocalUrls(inner);
}

/** Where this computer's link to WhatsApp lives: its session keys, never appended anywhere. Back it
 *  up never — a restored copy rolls the encryption back and WhatsApp unlinks the device. */
const AUTH_FOLDER = process.env.WHATSAPP_AUTH_FOLDER || join(import.meta.dirname, "..", ".auth");

// Baileys logs to stdout by default; `iterate provide` keeps stdout for its own line
const logger = pino({ level: process.env.WHATSAPP_LOG_LEVEL || "warn" }, pino.destination(2));

/** Baileys' socket, opened again a second after each close. Not after a logout (the phone unlinked
 *  this computer: link it again) or a replaced connection (another process holds this session, and
 *  two would take turns throwing each other off): either ends the process, and the lend with it. */
async function connectBaileys(onSocket: (socket: WASocket) => void): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  // WhatsApp refuses to link a client whose WhatsApp Web version it considers old ("check your
  // connection" on the phone): the current one, from web.whatsapp.com, over Baileys' bundled one
  const { version } = await fetchLatestWaWebVersion();
  console.error(`WhatsApp Web version ${version.join(".")}`);
  // resend retries and poll votes read a message back by id: the recent ones, from memory
  const recent = new Map<string, NonNullable<WAMessage["message"]>>();
  const open = () => {
    const socket = makeWASocket({
      auth: state,
      version,
      logger,
      getMessage: async (key) => (key.id ? recent.get(key.id) : undefined),
    });
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("messages.upsert", ({ messages }) => {
      for (const message of messages)
        if (message.key.id && message.message) recent.set(message.key.id, message.message);
      while (recent.size > 1_000) recent.delete(recent.keys().next().value!);
    });
    socket.ev.on("connection.update", ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        console.error("Link this computer: WhatsApp → Settings → Linked devices → Link a device");
        qrcode.generate(qr, { small: true }, (code) => console.error(code));
      }
      if (connection === "open") console.error(`WhatsApp: connected as ${socket.user?.id}`);
      if (connection !== "close") return;
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
        ?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error(
          `WhatsApp logged this computer out: delete ${AUTH_FOLDER} and run again to link it anew.`,
        );
        process.exit(1);
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.error("Another process opened this WhatsApp session: this one stops.");
        process.exit(1);
      }
      console.error(`WhatsApp: the connection closed (${code}); opening a new one`);
      setTimeout(open, 1_000);
    });
    onSocket(socket);
  };
  open();
}

export default provideWhatsApp({
  logPath: "/integrations/whatsapp",
  connect: connectBaileys as (onSocket: (socket: WhatsAppSocket) => void) => Promise<void>,
  downloadMedia: async (message, socket) =>
    await downloadMediaMessage(
      message,
      "buffer",
      {},
      { logger, reuploadRequest: (socket as unknown as WASocket).updateMediaMessage },
    ),
});
