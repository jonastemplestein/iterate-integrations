// whatsapp.test.ts — the lend over the pretend WhatsApp (dummy.ts), with a pretend project: what the
// project calls reaches the socket and comes back as JSON, every event of the socket lands as
// whatsapp/<Baileys' name> (a message as one whatsapp/messages.upsert of its own) on the account's
// stream and again on its chat's, media round-trips through downloadMedia, a url that would read
// this computer is refused, and events that could not reach the project wait for its next connection.
// The same lend through a real deployment is the README's walkthrough.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vite-plus/test";
import provideDummy from "../src/dummy.ts";
import provideWhatsApp, { description, provideWhatsApp as lendOver } from "../src/whatsapp.ts";
import { chatParts, eventPayloads } from "../src/whatsapp.ts";
import type { Itx, WhatsAppEvent } from "../src/whatsapp.ts";

type Lent = Record<string, (...args: any[]) => Promise<any>>;

test("the real lend imports without connecting: a default export and a description", () => {
  assert.equal(typeof provideWhatsApp, "function");
  assert.match(description, /Baileys/);
});

test("the pretend WhatsApp, lent: calls, events, media, refused urls, and messages that wait for the next connection", async () => {
  const project = pretendProject();
  const lent = (await provideDummy({ itx: project.itx })) as Lent;
  assert.ok(lent.sendMessage && lent.groupMetadata && lent.downloadMedia && lent.__describe);

  // a send comes back as Baileys' message, as JSON, and lands as an `append`
  const sent = await lent.sendMessage("447700900002@s.whatsapp.net", { text: "hi" });
  assert.deepEqual(sent.key, {
    remoteJid: "447700900002@s.whatsapp.net",
    fromMe: true,
    id: sent.key.id,
  });
  await project.settled();
  const landed = {
    type: "whatsapp/messages.upsert",
    payload: { event: "messages.upsert", data: { type: "append", messages: [sent] } },
    idempotencyKey: `whatsapp/messages.upsert:447700900002@s.whatsapp.net:${sent.key.id}`,
  };
  assert.deepEqual(project.events.at(-1), landed);
  // and again on the chat's own stream
  assert.deepEqual(
    project.streams.get("/integrations/whatsapp-dummy/chats/447700900002@s.whatsapp.net"),
    [landed],
  );

  // a contact's image: the event carries the key as { type: "Buffer" } JSON, downloadMedia the bytes
  await lent.simulateIncomingMessage({
    from: "447700900003@s.whatsapp.net",
    image: { data: new Uint8Array([7, 8, 9]), mimetype: "image/png", caption: "look" },
  });
  await project.settled();
  const received = project.events.at(-1)!.payload.data as { type: string; messages: any[] };
  assert.equal(received.type, "notify");
  assert.equal(received.messages[0].message.imageMessage.mediaKey.type, "Buffer");
  assert.deepEqual([...(await lent.downloadMedia(received.messages[0]))], [7, 8, 9]);

  // media by url: data: goes through; a path or file: would be read from this computer
  const withImage = await lent.sendMessage("447700900002@s.whatsapp.net", {
    image: { url: "data:image/png;base64,AQID" },
  });
  assert.deepEqual([...(await lent.downloadMedia(withImage))], [1, 2, 3]);
  for (const url of ["/etc/passwd", "file:///etc/passwd", "http://192.168.1.1/"])
    await assert.rejects(
      lent.sendMessage("447700900002@s.whatsapp.net", { document: { url } }),
      /must be https: or data:/,
    );

  // the project unreachable: messages wait, then arrive once over the next connection
  project.failing = true;
  await lent.simulateIncomingMessage({
    from: "447700900003@s.whatsapp.net",
    text: "while you were away",
  });
  await project.settled();
  const before = project.events.length;
  project.failing = false;
  await provideDummy({ itx: project.itx }); // what `iterate provide` does on its next connection
  await project.settled();
  assert.equal(project.events.length, before + 1);
  assert.equal(
    (project.events.at(-1)!.payload.data as any).messages[0].message.conversation,
    "while you were away",
  );
});

test("a message WhatsApp delivers again with a different body stays one event, and never holds up the next", async () => {
  const project = pretendProject();
  const ev = new EventEmitter();
  const lend = lendOver({
    logPath: "/integrations/whatsapp",
    connect: async (onSocket) => onSocket({ ev } as unknown as Parameters<typeof onSocket>[0]),
    downloadMedia: async () => new Uint8Array(),
  });
  await lend({ itx: project.itx });
  const message = (id: string, text: string) => ({
    key: { remoteJid: "447700900003@s.whatsapp.net", fromMe: false, id },
    message: { conversation: text },
  });
  ev.emit("messages.upsert", { type: "notify", messages: [message("A", "first")] });
  await project.settled();
  // the same message as an `append`, in one batch with a new one: the platform refuses the batch
  ev.emit("messages.upsert", {
    type: "append",
    messages: [message("A", "first"), message("B", "second")],
  });
  await project.settled();
  ev.emit("messages.upsert", { type: "notify", messages: [message("C", "third")] });
  await project.settled();
  const messages = (events: WhatsAppEvent[]) =>
    events
      .map((event) => event.payload.data as any)
      .map((data) => [data.type, data.messages[0].key.id]);
  assert.deepEqual(messages(project.events), [
    ["notify", "A"],
    ["append", "B"],
    ["notify", "C"],
  ]);
  assert.deepEqual(
    messages(project.streams.get("/integrations/whatsapp/chats/447700900003@s.whatsapp.net")!),
    [
      ["notify", "A"],
      ["append", "B"],
      ["notify", "C"],
    ],
  );
});

test("every other event of the socket lands as whatsapp/<its Baileys name>, and user() and the LID mapping are lent", async () => {
  const project = pretendProject();
  const ev = new EventEmitter();
  let emitAll: (events: Record<string, unknown>) => void = () => {};
  const socket = {
    ev: Object.assign(ev, { process: (handler: typeof emitAll) => void (emitAll = handler) }),
    user: { id: "447700900001:1@s.whatsapp.net", lid: "111:1@lid", name: "Me" },
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid: string) =>
          lid === "222@lid" ? "447700900002@s.whatsapp.net" : null,
        getLIDForPN: async () => "222@lid",
      },
    },
  };
  const lend = lendOver({
    logPath: "/integrations/whatsapp",
    connect: async (onSocket) => onSocket(socket as unknown as Parameters<typeof onSocket>[0]),
    downloadMedia: async () => new Uint8Array(),
  });
  const lent = (await lend({ itx: project.itx })) as Lent;
  const key = { remoteJid: "447700900002@s.whatsapp.net", fromMe: true, id: "A" };
  // one batch, as Baileys emits them: a receipt, a group change, the keys, and a message
  emitAll({
    "messages.update": [
      { key, update: { status: 3 } },
      { key: { ...key, remoteJid: "222@lid", id: "B" }, update: { status: 4 } },
    ],
    "group-participants.update": {
      id: "1@g.us",
      author: "447700900002@s.whatsapp.net",
      participants: ["3@lid"],
      action: "add",
    },
    "creds.update": { noiseKey: "secret" },
    "messages.upsert": { type: "notify", messages: [] },
  });
  await project.settled();
  assert.deepEqual(
    project.events.map(({ type, payload }) => [type, payload]),
    [
      [
        "whatsapp/messages.update",
        {
          event: "messages.update",
          data: [
            { key, update: { status: 3 } },
            { key: { ...key, remoteJid: "222@lid", id: "B" }, update: { status: 4 } },
          ],
        },
      ],
      [
        "whatsapp/group-participants.update",
        {
          event: "group-participants.update",
          data: {
            id: "1@g.us",
            author: "447700900002@s.whatsapp.net",
            participants: ["3@lid"],
            action: "add",
          },
        },
      ],
    ],
  );
  // each chat's own stream holds its part, in the event's own shape; a chat known by its `@lid`
  // goes by the phone number WhatsApp told this account
  assert.deepEqual(
    [...project.streams]
      .filter(([path]) => path.includes("/chats/"))
      .map(([path, events]) => [path, events.map((event) => event.payload)]),
    [
      [
        "/integrations/whatsapp/chats/447700900002@s.whatsapp.net",
        [
          { event: "messages.update", data: [{ key, update: { status: 3 } }] },
          {
            event: "messages.update",
            data: [{ key: { ...key, remoteJid: "222@lid", id: "B" }, update: { status: 4 } }],
          },
        ],
      ],
      [
        "/integrations/whatsapp/chats/1@g.us",
        [
          {
            event: "group-participants.update",
            data: {
              id: "1@g.us",
              author: "447700900002@s.whatsapp.net",
              participants: ["3@lid"],
              action: "add",
            },
          },
        ],
      ],
    ],
  );
  assert.deepEqual(await lent.user(), socket.user);
  assert.equal(await lent.getPNForLID("222@lid"), "447700900002@s.whatsapp.net");
  assert.ok((await lent.__describe()).functions.includes("user"));
});

test("what must stay on this computer is held back from an event: the QR code, a history sync's rows; a long list is appended in parts", () => {
  assert.deepEqual(
    eventPayloads("connection.update", { qr: "2@secret", connection: "connecting" }),
    [
      {
        event: "connection.update",
        data: { connection: "connecting", qr: "(shown on the computer lending WhatsApp)" },
      },
    ],
  );
  assert.deepEqual(
    eventPayloads("messaging-history.set", {
      chats: [{}, {}],
      contacts: [{}],
      messages: [{}, {}, {}],
      isLatest: true,
    }),
    [
      {
        event: "messaging-history.set",
        data: { isLatest: true, chats: 2, contacts: 1, messages: 3 },
      },
    ],
  );
  const contacts = Array.from({ length: 120 }, (_, index) => ({ id: `${index}@lid` }));
  assert.deepEqual(
    eventPayloads("contacts.upsert", contacts).map(({ part, data }) => [
      part,
      (data as unknown[]).length,
    ]),
    [
      [{ from: 0, of: 120 }, 50],
      [{ from: 50, of: 120 }, 50],
      [{ from: 100, of: 120 }, 20],
    ],
  );
  assert.deepEqual(eventPayloads("creds.update", { noiseKey: "secret" }), []);
});

test("an event's part for each chat keeps the event's own shape, and the account's own events have none", () => {
  const key = (remoteJid: string, id: string) => ({ remoteJid, id, fromMe: false });
  assert.deepEqual(
    [
      ...chatParts("message-receipt.update", [
        { key: key("1@g.us", "A"), receipt: {} },
        { key: key("2@g.us", "B"), receipt: {} },
        { key: key("1@g.us", "C"), receipt: {} },
      ]),
    ],
    [
      [
        "1@g.us",
        [
          { key: key("1@g.us", "A"), receipt: {} },
          { key: key("1@g.us", "C"), receipt: {} },
        ],
      ],
      ["2@g.us", [{ key: key("2@g.us", "B"), receipt: {} }]],
    ],
  );
  assert.deepEqual(
    [...chatParts("presence.update", { id: "1@g.us", presences: {} })],
    [["1@g.us", { id: "1@g.us", presences: {} }]],
  );
  assert.deepEqual(
    [...chatParts("messages.delete", { keys: [key("1@g.us", "A")] })],
    [["1@g.us", { keys: [key("1@g.us", "A")] }]],
  );
  assert.deepEqual(
    [...chatParts("call", [{ chatId: "9@s.whatsapp.net", id: "c", status: "offer" }])],
    [["9@s.whatsapp.net", [{ chatId: "9@s.whatsapp.net", id: "c", status: "offer" }]]],
  );
  for (const [name, data] of [
    ["connection.update", { connection: "open" }],
    ["contacts.update", [{ id: "5@lid", notify: "Sam" }]],
    ["blocklist.set", { blocklist: [] }],
  ] as const)
    assert.deepEqual([...chatParts(name, data)], []);
});

/** A project whose `cd(path).append` keeps the events, or fails while `failing`. As the platform
 *  does, a key it holds dedupes the same body and refuses a different one, the whole call with it,
 *  by message alone (what reaches `iterate provide`). */
function pretendProject() {
  const project: {
    /** every stream appended to, by its path */
    streams: Map<string, WhatsAppEvent[]>;
    /** the account's stream: the one that is no chat's */
    readonly events: WhatsAppEvent[];
    failing: boolean;
    calls: Promise<unknown>[];
    itx: Itx;
    settled: () => Promise<void>;
  } = {
    streams: new Map<string, WhatsAppEvent[]>(),
    get events() {
      return [...project.streams].find(([path]) => !path.includes("/chats/"))?.[1] ?? [];
    },
    failing: false,
    calls: [] as Promise<unknown>[],
    itx: {
      cd: (path: string) => ({
        append: (...events: WhatsAppEvent[]) => {
          const stream = project.streams.get(path) ?? [];
          const held = (event: WhatsAppEvent) =>
            stream.findIndex((kept) => kept.idempotencyKey === event.idempotencyKey);
          const conflict = events.find(
            (event) =>
              held(event) >= 0 && JSON.stringify(stream[held(event)]) !== JSON.stringify(event),
          );
          const call: Promise<unknown> = project.failing
            ? Promise.reject(new Error("the project is unreachable"))
            : conflict
              ? Promise.reject(
                  new Error(
                    `idempotency key "${conflict.idempotencyKey}" already names a different event at offset ${held(conflict)}`,
                  ),
                )
              : Promise.resolve(
                  project.streams.set(path, [
                    ...stream,
                    ...events.filter((event) => held(event) < 0),
                  ]),
                );
          project.calls.push(call.catch(() => {}));
          return call;
        },
      }),
    } as Itx,
    /** every append made so far has answered */
    settled: async () => {
      for (let round = 0; round < 5; round++) {
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.all(project.calls);
      }
    },
  };
  return project;
}
