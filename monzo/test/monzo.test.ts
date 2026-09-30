// Runs against dist, the package as shipped. `withItx` is a fake project: a secret, and streams
// that keep what is appended to them.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { receiveMonzoTransaction } from "../dist/monzo.js";

// each account has its own secret, at /secrets/monzo-webhook-<account>
const SECRETS: Record<string, string> = {
  "/secrets/monzo-webhook-joint-account": "joint-secret",
  "/secrets/monzo-webhook-jonas-personal": "personal-secret",
};

function fakeProject() {
  const appended: { path: string; event: any }[] = [];
  const itx: any = {
    secrets: { verifyEquals: async (path: string, { value }: { value: string }) => SECRETS[path] === value },
    cd: (path: string) => ({ append: async (event: unknown) => void appended.push({ path, event }) }),
  };
  return { appended, withItx: async (call: (itx: any) => unknown) => call(itx) };
}

const transaction = { id: "tx_0001", account_id: "acc_1", amount: -510, currency: "GBP", description: "Flat white", merchant: { name: "Coffee" } };
const post = (path: string, body: unknown) =>
  new Request(`https://monzo--iterate.example${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("a transaction.created for an account becomes one event on that account's stream, the transaction untouched", async () => {
  const { appended, withItx } = fakeProject();
  const res = await receiveMonzoTransaction(post("/joint-account/joint-secret", { type: "transaction.created", data: transaction }), withItx as any);
  assert.equal(res.status, 200);
  assert.deepEqual(appended, [
    { path: "/monzo/joint-account", event: { type: "monzo/transaction-created", idempotencyKey: "monzo:tx_0001", payload: { transactionId: "tx_0001", transaction } } },
  ]);
  await receiveMonzoTransaction(post("/jonas-personal/personal-secret", { type: "transaction.created", data: { ...transaction, id: "tx_0002" } }), withItx as any);
  assert.deepEqual(appended.map((a) => a.path), ["/monzo/joint-account", "/monzo/jonas-personal"]);
});

test("an account's secret opens only that account: the other's, a wrong one, an unknown or malformed account, or nothing is a 404 that stores nothing", async () => {
  const { appended, withItx } = fakeProject();
  for (const path of ["/joint-account/personal-secret", "/jonas-personal/joint-secret", "/joint-account/joint-secretx", "/elsewhere/joint-secret", "/joint-account", "/joint-account/", "/", "", "/../joint-secret", "/Joint-Account/joint-secret"]) {
    const res = await receiveMonzoTransaction(post(path, { type: "transaction.created", data: transaction }), withItx as any);
    assert.equal(res.status, 404, path);
  }
  assert.deepEqual(appended, []);
});

test("a trailing path after the secret is fine; other event types are answered 200 and ignored; garbage is not stored", async () => {
  const { appended, withItx } = fakeProject();
  const url = "/joint-account/joint-secret";
  assert.equal((await receiveMonzoTransaction(post(`${url}/anything`, { type: "transaction.created", data: transaction }), withItx as any)).status, 200);
  assert.equal(appended.length, 1);
  const other = await receiveMonzoTransaction(post(url, { type: "balance.changed", data: {} }), withItx as any);
  assert.deepEqual(await other.json(), { ok: true, ignored: "balance.changed" });
  assert.equal((await receiveMonzoTransaction(post(url, "not json"), withItx as any)).status, 200);
  assert.equal((await receiveMonzoTransaction(post(url, { type: "transaction.created", data: {} }), withItx as any)).status, 400);
  assert.equal(appended.length, 1);
});

test("only POST is accepted", async () => {
  const { withItx } = fakeProject();
  const res = await receiveMonzoTransaction(new Request("https://monzo--iterate.example/joint-account/joint-secret"), withItx as any);
  assert.equal(res.status, 405);
});
