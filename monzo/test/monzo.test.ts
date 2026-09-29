// Runs against dist, the package as shipped. `withItx` is a fake project: a secret, and streams
// that keep what is appended to them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { receiveMonzoTransaction } from "../dist/monzo.js";

const SECRET = "s3cret-path-segment";

function fakeProject() {
  const appended: { path: string; event: any }[] = [];
  const itx: any = {
    secrets: { verifyEquals: async (_path: string, { value }: { value: string }) => value === SECRET },
    cd: (path: string) => ({ append: async (event: unknown) => void appended.push({ path, event }) }),
  };
  return { appended, withItx: async (call: (itx: any) => unknown) => call(itx) };
}

const transaction = { id: "tx_0001", account_id: "acc_1", amount: -510, currency: "GBP", description: "Flat white", merchant: { name: "Coffee" } };
const post = (path: string, body: unknown) =>
  new Request(`https://monzo--iterate.example${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("a transaction.created on the secret path becomes one event on /monzo, the transaction untouched", async () => {
  const { appended, withItx } = fakeProject();
  const res = await receiveMonzoTransaction(post(`/${SECRET}`, { type: "transaction.created", data: transaction }), withItx as any);
  assert.equal(res.status, 200);
  assert.deepEqual(appended, [
    { path: "/monzo", event: { type: "monzo/transaction-created", idempotencyKey: "monzo:tx_0001", payload: { transactionId: "tx_0001", transaction } } },
  ]);
});

test("a wrong, missing or empty secret is a 404 that stores nothing", async () => {
  const { appended, withItx } = fakeProject();
  for (const path of [`/${SECRET}x`, "/", "", "/wrong/" + SECRET]) {
    const res = await receiveMonzoTransaction(post(path, { type: "transaction.created", data: transaction }), withItx as any);
    assert.equal(res.status, 404, path);
  }
  assert.deepEqual(appended, []);
});

test("a trailing path after the secret is fine; other event types are answered 200 and ignored; garbage is not stored", async () => {
  const { appended, withItx } = fakeProject();
  assert.equal((await receiveMonzoTransaction(post(`/${SECRET}/anything`, { type: "transaction.created", data: transaction }), withItx as any)).status, 200);
  assert.equal(appended.length, 1);
  const other = await receiveMonzoTransaction(post(`/${SECRET}`, { type: "balance.changed", data: {} }), withItx as any);
  assert.deepEqual(await other.json(), { ok: true, ignored: "balance.changed" });
  assert.equal((await receiveMonzoTransaction(post(`/${SECRET}`, "not json"), withItx as any)).status, 200);
  assert.equal((await receiveMonzoTransaction(post(`/${SECRET}`, { type: "transaction.created", data: {} }), withItx as any)).status, 400);
  assert.equal(appended.length, 1);
});

test("only POST is accepted", async () => {
  const { withItx } = fakeProject();
  const res = await receiveMonzoTransaction(new Request(`https://monzo--iterate.example/${SECRET}`), withItx as any);
  assert.equal(res.status, 405);
});
