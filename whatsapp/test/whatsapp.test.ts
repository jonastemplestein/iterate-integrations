// whatsapp.test.ts — the lend over the pretend WhatsApp (dummy.ts), with a pretend project: what the
// project calls reaches the socket and comes back as JSON, every message lands as one
// whatsapp/message-added event, media round-trips through downloadMedia, a url that would read this
// computer is refused, and messages that could not reach the project wait for its next connection.
// The same lend through a real deployment is the README's walkthrough.
import assert from "node:assert/strict";
import test from "node:test";
import provideDummy from "../src/dummy.ts";
import provideWhatsApp, { description } from "../src/whatsapp.ts";
import type { Itx, MessageAdded } from "../src/whatsapp.ts";

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
  assert.deepEqual(sent.key, { remoteJid: "447700900002@s.whatsapp.net", fromMe: true, id: sent.key.id });
  await project.settled();
  assert.deepEqual(project.events.at(-1), {
    type: "whatsapp/message-added",
    payload: { type: "append", message: sent },
    idempotencyKey: `whatsapp/message-added:447700900002@s.whatsapp.net:${sent.key.id}`,
  });

  // a contact's image: the event carries the key as { type: "Buffer" } JSON, downloadMedia the bytes
  await lent.simulateIncomingMessage({
    from: "447700900003@s.whatsapp.net",
    image: { data: new Uint8Array([7, 8, 9]), mimetype: "image/png", caption: "look" },
  });
  await project.settled();
  const received = project.events.at(-1)!.payload;
  assert.equal(received.type, "notify");
  assert.equal((received.message as any).message.imageMessage.mediaKey.type, "Buffer");
  assert.deepEqual([...(await lent.downloadMedia(received.message))], [7, 8, 9]);

  // media by url: data: goes through; a path or file: would be read from this computer
  const withImage = await lent.sendMessage("447700900002@s.whatsapp.net", {
    image: { url: "data:image/png;base64,AQID" },
  });
  assert.deepEqual([...(await lent.downloadMedia(withImage))], [1, 2, 3]);
  for (const url of ["/etc/passwd", "file:///etc/passwd", "http://192.168.1.1/"])
    await assert.rejects(lent.sendMessage("447700900002@s.whatsapp.net", { document: { url } }), /must be https: or data:/);

  // the project unreachable: messages wait, then arrive once over the next connection
  project.failing = true;
  await lent.simulateIncomingMessage({ from: "447700900003@s.whatsapp.net", text: "while you were away" });
  await project.settled();
  const before = project.events.length;
  project.failing = false;
  await provideDummy({ itx: project.itx }); // what `iterate provide` does on its next connection
  await project.settled();
  assert.equal(project.events.length, before + 1);
  assert.equal((project.events.at(-1)!.payload.message as any).message.conversation, "while you were away");
});

/** A project whose `cd(path).append` keeps the events, or fails while `failing`. */
function pretendProject() {
  const project: {
    events: MessageAdded[];
    failing: boolean;
    paths: Set<string>;
    calls: Promise<unknown>[];
    itx: Itx;
    settled: () => Promise<void>;
  } = {
    events: [] as MessageAdded[],
    failing: false,
    paths: new Set<string>(),
    calls: [] as Promise<unknown>[],
    itx: {
      cd: (path: string) => ({
        append: (...events: MessageAdded[]) => {
          project.paths.add(path);
          const call: Promise<unknown> = project.failing
            ? Promise.reject(new Error("the project is unreachable"))
            : Promise.resolve(project.events.push(...events));
          project.calls.push(call.catch(() => {}));
          return call;
        },
      }),
    } as Itx,
    /** every append made so far has answered */
    settled: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.all(project.calls);
    },
  };
  return project;
}
