// whatsapp.ts — your WhatsApp, lent to an iterate project from your own computer:
//
//   iterate provide whatsapp/src/whatsapp.ts --project <slug>
//
// Baileys (https://baileys.wiki) links this computer to your WhatsApp as a linked device, the way
// WhatsApp Web does, from your own IP. The lend is as thin as it can be, so Baileys' own
// documentation is the lend's:
//   - CALLS: every function of Baileys' socket, under its own name, as `itx.whatsapp.<name>(…)`:
//     `sendMessage(jid, content, options)`, `groupMetadata(jid)`, `updateProfilePicture(jid, { url })`
//     and the rest. Three are added for what is not a socket function: `downloadMedia(message)`,
//     `user()` (the linked account, Baileys' `sock.user`), and `getPNForLID(lid)` / `getLIDForPN(pn)`
//     (Baileys' `sock.signalRepository.lidMapping`).
//   - EVENTS: every event the socket emits lands on the project as `whatsapp/<Baileys' event name>`
//     (`whatsapp/messages.upsert`, `whatsapp/messages.update`, `whatsapp/group-participants.update`,
//     `whatsapp/presence.update`, `whatsapp/call`, …) with `payload.data` Baileys' own data. A
//     `messages.upsert` of several messages lands as one event a message (`data.messages` holds
//     the one), so a message has an event, and an offset, of its own. Only what must stay on this
//     computer is held back (`eventPayloads`): credentials, the QR code that links a device, and
//     the bulk of a history sync.
//   - TWO COPIES: every event lands on the account's stream, `/integrations/whatsapp`, the whole
//     account in order; and what belongs to one chat lands again on that chat's own stream,
//     `/integrations/whatsapp/chats/<jid>` (`chatParts`), the conversation alone.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
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
  "My WhatsApp, as Baileys' socket (https://baileys.wiki): every function of it under its own name (sendMessage(jid, content, options), groupMetadata(jid), onWhatsApp(...phones), …) plus downloadMedia(message), user() and getPNForLID(lid); call __describe() first. Every event of the socket lands on the account's stream (/integrations/whatsapp).";

/** The project, as `iterate provide` hands it over: the part this file uses. */
export type Itx = {
  cd(path: string): { append(...events: WhatsAppEvent[]): Promise<unknown> };
};

/** An event of Baileys' socket as it lands: `whatsapp/<Baileys' event name>`, Baileys' data under
 *  `data` (a long list in parts). A message's key is the message's, so one WhatsApp delivers twice
 *  (a reconnect, an `append` after a `notify`) is one event; any other event's key is its own, so
 *  one that waited and is appended again lands once. */
export type WhatsAppEvent = {
  type: `whatsapp/${string}`;
  payload: { event: string; data: unknown; part?: { from: number; of: number } };
  idempotencyKey: string;
};

/** A WhatsApp socket as the lend reads it: Baileys' own, or the dummy's, with the same functions. */
export type WhatsAppSocket = {
  ev: {
    on(
      event: "messages.upsert",
      listener: (upsert: BaileysEventMap["messages.upsert"]) => void,
    ): unknown;
    /** Baileys' one hook for every event, in the batches it emits them (absent on a pretend socket). */
    process?(handler: (events: Partial<BaileysEventMap>) => void | Promise<void>): unknown;
  };
};

/** Events never appended, by Baileys' name: WHATSAPP_SKIP_EVENTS, comma-separated
 *  (`presence.update,chats.update`), for an account whose volume of one kind is not worth having. */
const SKIPPED_EVENTS = new Set(
  (process.env.WHATSAPP_SKIP_EVENTS || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);
/** An event's list is appended this many items at a time: a first link's contacts and chats are
 *  thousands of rows. */
const EVENT_CHUNK = 50;

/** What of a Baileys event leaves this computer, as the payloads to append (a long list is several):
 *  everything, except
 *   - `creds.update`: the account's keys;
 *   - `connection.update`'s `qr`: whoever holds it links a device to the account;
 *   - `messaging-history.set`'s rows: a first link's whole history (its counts are kept), which
 *     would also land every old message as if it had just arrived. */
export function eventPayloads(name: string, data: unknown): WhatsAppEvent["payload"][] {
  if (name === "creds.update" || SKIPPED_EVENTS.has(name)) return [];
  if (name === "connection.update") {
    const { qr, lastDisconnect, ...rest } = data as BaileysEventMap["connection.update"];
    const error = lastDisconnect?.error as
      | { message?: string; output?: { statusCode?: number } }
      | undefined;
    return [
      {
        event: name,
        data: json({
          ...rest,
          ...(qr && { qr: "(shown on the computer lending WhatsApp)" }),
          ...(lastDisconnect && {
            lastDisconnect: {
              date: lastDisconnect.date,
              statusCode: error?.output?.statusCode,
              message: error?.message,
            },
          }),
        }),
      },
    ];
  }
  if (name === "messaging-history.set") {
    const { chats, contacts, messages, ...rest } = data as BaileysEventMap["messaging-history.set"];
    return [
      {
        event: name,
        data: json({
          ...rest,
          chats: chats?.length ?? 0,
          contacts: contacts?.length ?? 0,
          messages: messages?.length ?? 0,
        }),
      },
    ];
  }
  if (!Array.isArray(data) || data.length <= EVENT_CHUNK)
    return [{ event: name, data: json(data) }];
  const payloads: WhatsAppEvent["payload"][] = [];
  for (let start = 0; start < data.length; start += EVENT_CHUNK)
    payloads.push({
      event: name,
      data: json(data.slice(start, start + EVENT_CHUNK)),
      part: { from: start, of: data.length },
    });
  return payloads;
}

/** The events whose rows each name a message by its key, a chat or group by its id. */
const ROWS_BY_KEY = new Set([
  "messages.update",
  "messages.reaction",
  "message-receipt.update",
  "messages.media-update",
]);
const ROWS_BY_ID = new Set(["chats.upsert", "chats.update", "groups.upsert", "groups.update"]);
const ONE_BY_ID = new Set([
  "presence.update",
  "group-participants.update",
  "group.join-request",
  "group.member-tag.update",
]);

/** The part of a Baileys event that belongs to each chat, by the chat's jid, in the event's own
 *  shape (a list stays a list): what lands again on the chat's own stream. Empty for an event
 *  that is the account's alone (the connection, contacts, the blocklist, settings). */
export function chatParts(name: string, data: unknown): Map<string, unknown> {
  const rows = new Map<string, unknown[]>();
  const add = (chat: unknown, row: unknown) => {
    if (typeof chat !== "string" || !chat.includes("@")) return;
    rows.set(chat, [...(rows.get(chat) ?? []), row]);
  };
  if (Array.isArray(data)) {
    for (const row of data as Record<string, any>[]) {
      if (ROWS_BY_KEY.has(name)) add(row?.key?.remoteJid, row);
      else if (ROWS_BY_ID.has(name)) add(row?.id, row);
      else if (name === "call") add(row?.chatId ?? row?.from, row);
      else if (name === "chats.delete") add(row, row);
    }
    return rows;
  }
  const one = (data ?? {}) as Record<string, any>;
  if (ONE_BY_ID.has(name) && typeof one.id === "string") return new Map([[one.id, one]]);
  if (name !== "messages.delete") return new Map();
  // `{ keys }`: the deleted messages; `{ jid, all: true }`: a chat cleared
  if (typeof one.jid === "string") return new Map([[one.jid, one]]);
  for (const key of (one.keys ?? []) as { remoteJid?: string }[]) add(key?.remoteJid, key);
  return new Map([...rows].map(([chat, keys]) => [chat, { keys }]));
}

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
  /** What waits to be appended, by the stream it is for, each in its own order. */
  const pending = new Map<string, WhatsAppEvent[]>();
  const waiting = () => [...pending.values()].reduce((count, events) => count + events.length, 0);
  const queue = (path: string, event: WhatsAppEvent) => {
    const events = pending.get(path) ?? [];
    events.push(event);
    if (events.length > PENDING_LIMIT) {
      const dropped = events.splice(0, events.length - PENDING_LIMIT);
      console.error(
        `WhatsApp: dropped ${dropped.length} event(s) of ${path} the project never took`,
      );
    }
    pending.set(path, events);
  };
  let flushing: Promise<void> | undefined;
  /** Append what waits, each stream's in order, over the newest connection, one flush at a time; a
   *  failure leaves it waiting for the next connection. */
  const flush = (): Promise<void> =>
    (flushing ??= (async () => {
      try {
        while (itx && waiting() > 0) {
          for (const [path, events] of pending) {
            const batch = events.slice(0, 50);
            const log = itx.cd(path);
            await log.append(...batch).catch(async (error: unknown) => {
              if (!isIdempotencyConflict(error)) throw error;
              // A redelivery whose body differs from the event its key already names (an `append`
              // after a `notify`, or fields WhatsApp filled in later): that message is recorded, and
              // the refusal takes the whole batch, so the batch goes again one event at a time.
              for (const event of batch)
                await log.append(event).catch((single: unknown) => {
                  if (!isIdempotencyConflict(single)) throw single;
                });
            });
            events.splice(0, batch.length);
            if (events.length === 0) pending.delete(path);
          }
        }
        return true;
      } catch (error) {
        console.error(
          `WhatsApp: ${waiting()} event(s) wait for the project's next connection (${error instanceof Error ? error.message : String(error)})`,
        );
        return false;
      }
    })().then((appended) => {
      flushing = undefined;
      if (appended && waiting() > 0) void flush(); // arrived as it finished
    }));
  /** A chat's own stream. A person's chat goes by their phone number's jid wherever WhatsApp has
   *  told this account the number behind a `…@lid` (the message's own `remoteJidAlt`, or Baileys'
   *  LID mapping), so the conversation is one stream under either id; else by the jid as it came. */
  const numbers = new Map<string, string>();
  const chatStream = async (jid: string, alt?: string | null): Promise<string> => {
    const bare = (id: string) => id.replace(/:\d+@/, "@");
    let chat = bare(jid);
    if (chat.endsWith("@lid")) {
      const known =
        (alt?.endsWith("@s.whatsapp.net") ? alt : undefined) ??
        numbers.get(chat) ??
        (await (
          socket as unknown as {
            signalRepository?: {
              lidMapping?: { getPNForLID(lid: string): Promise<string | null> };
            };
          }
        ).signalRepository?.lidMapping
          ?.getPNForLID(chat)
          .catch(() => null));
      if (known) numbers.set(chat, (chat = bare(known)));
    }
    return `${input.logPath}/chats/${chat}`;
  };
  const onSocket = (next: WhatsAppSocket) => {
    socket = next;
    // a message: one event of its own, on the account's stream and on its chat's
    next.ev.on("messages.upsert", async ({ type, messages }) => {
      for (const message of messages) {
        const event: WhatsAppEvent = {
          type: "whatsapp/messages.upsert",
          payload: { event: "messages.upsert", data: { type, messages: [json(message)] } },
          idempotencyKey: `whatsapp/messages.upsert:${message.key.remoteJid}:${message.key.id}`,
        };
        queue(input.logPath, event);
        if (message.key.remoteJid)
          queue(
            await chatStream(
              message.key.remoteJid,
              (message.key as { remoteJidAlt?: string }).remoteJidAlt,
            ),
            event,
          );
      }
      void flush();
    });
    // every other event of the socket, as Baileys names it
    next.ev.process?.(async (events) => {
      for (const [name, data] of Object.entries(events)) {
        if (name === "messages.upsert") continue;
        for (const payload of eventPayloads(name, data))
          queue(input.logPath, {
            type: `whatsapp/${name}`,
            payload,
            idempotencyKey: `whatsapp/${name}:${randomUUID()}`,
          });
        if (eventPayloads(name, data).length === 0) continue; // held back, or skipped
        for (const [chat, part] of chatParts(name, data))
          for (const payload of eventPayloads(name, part))
            queue(await chatStream(chat), {
              type: `whatsapp/${name}`,
              payload,
              idempotencyKey: `whatsapp/${name}:${randomUUID()}`,
            });
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
    // what Baileys keeps as a property of the socket, not a function of it
    lent.user = async () => json((current() as unknown as { user?: unknown }).user ?? null);
    const lidMapping = () => {
      const mapping = (
        current() as unknown as {
          signalRepository?: {
            lidMapping?: Record<
              "getPNForLID" | "getLIDForPN",
              (id: string) => Promise<string | null>
            >;
          };
        }
      ).signalRepository?.lidMapping;
      if (!mapping) throw new Error("This WhatsApp socket has no LID mapping.");
      return mapping;
    };
    lent.getPNForLID = async (lid: string) => await lidMapping().getPNForLID(lid);
    lent.getLIDForPN = async (pn: string) => await lidMapping().getLIDForPN(pn);
    lent.__describe = () => ({
      instructions:
        "My WhatsApp through Baileys (https://baileys.wiki), a linked device on my own computer. Every function is Baileys' socket function of the same name, so Baileys' documentation is this API's, e.g. sendMessage(jid, { text }), sendMessage(jid, { image: { url }, caption }), sendMessage(jid, { react: { text, key } }), groupMetadata(jid), onWhatsApp(...phones), updateProfilePicture(jid, { url }). A jid is <digits>@s.whatsapp.net (a person), …@g.us (a group) or …@lid. Bytes cross as { type: 'Buffer', data: <base64> }. Media: pass { url } — an https: URL (an itx.files URL works) or a data: URL; nothing else. Added to the socket's own: downloadMedia(message) answers the bytes of a received message's media (store them with itx.files); user() answers the linked account (Baileys' sock.user); getPNForLID(lid) and getLIDForPN(pn) translate between a …@lid and a phone number's jid. Every event of the socket lands on " +
        input.logPath +
        " as whatsapp/<Baileys' event name> with Baileys' data in payload.data: whatsapp/messages.upsert (one event a message: payload.data.messages[0], payload.data.type), whatsapp/messages.update (delivery, read, edits), whatsapp/message-receipt.update, whatsapp/group-participants.update, whatsapp/presence.update, whatsapp/call, …; and what belongs to one chat lands again on " +
        input.logPath +
        "/chats/<the chat's jid>, the conversation alone. Only write to chats that already exist unless told otherwise: WhatsApp restricts accounts that start many new chats.",
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
    // With WHATSAPP_PAIRING_NUMBER (the account's number, digits with country code), the link is an
    // 8-character code typed into the phone, not a QR code scanned off this screen: once per socket,
    // when WhatsApp is ready to link (its first QR).
    const pairingNumber = (process.env.WHATSAPP_PAIRING_NUMBER || "").replace(/\D/g, "");
    let pairingRequested = false;
    socket.ev.on("connection.update", ({ qr, connection, lastDisconnect }) => {
      if (qr && pairingNumber) {
        if (!pairingRequested) {
          pairingRequested = true;
          void socket.requestPairingCode(pairingNumber).then(
            (code) =>
              console.error(
                `PAIRING CODE ${code.slice(0, 4)}-${code.slice(4)} for +${pairingNumber}: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead`,
              ),
            (error: unknown) =>
              console.error(`WhatsApp: the pairing code request failed: ${String(error)}`),
          );
        }
      } else if (qr) {
        console.error("Link this computer: WhatsApp → Settings → Linked devices → Link a device");
        qrcode.generate(qr, { small: true }, (code) => console.error(code));
        // WHATSAPP_QR_FILE: the QR's own text, written each time WhatsApp issues a new one, for
        // something that renders it better than a terminal does
        if (process.env.WHATSAPP_QR_FILE) writeFileSync(process.env.WHATSAPP_QR_FILE, qr);
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

/** Where this account's messages land in the project: WHATSAPP_LOG_PATH for a second account lent
 *  beside the first (`iterate provide whatsapp.ts --name whatsappPersonal` with its own
 *  WHATSAPP_AUTH_FOLDER), each on a stream of its own. */
const LOG_PATH = process.env.WHATSAPP_LOG_PATH || "/integrations/whatsapp";

export default provideWhatsApp({
  logPath: LOG_PATH,
  connect: connectBaileys as (onSocket: (socket: WhatsAppSocket) => void) => Promise<void>,
  downloadMedia: async (message, socket) =>
    await downloadMediaMessage(
      message,
      "buffer",
      {},
      { logger, reuploadRequest: (socket as unknown as WASocket).updateMediaMessage },
    ),
});
