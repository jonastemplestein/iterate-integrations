# Monzo

Every Monzo transaction lands in an iterate project as a `monzo/transaction-created` event, the
transaction (amount, merchant, category, …) exactly as Monzo sends it, on a stream per account:
`/monzo/<account name>`, with names the person picks (`joint-account`, `jonas-personal`). One
sign-in covers all of a person's accounts, each has its own webhook, and every MCP tool
(`get_balance`, `list_transactions`, …) works on any of them.

Two halves, both through [zero-trust-mcp](https://github.com/iterate/zero-trust-mcp), the small
Worker that keeps no credentials: **sign in to Monzo** (iterate holds only a token the Worker can
read but not keep), and **register a webhook** with its `register_webhook` tool. Monzo doesn't sign
its webhooks, so the recipe puts an unguessable secret in each webhook's URL and generates it for
the person: they never see or type it.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 0. Before you start: a Monzo developer client

The person needs a Monzo OAuth client of their own, and it takes a few minutes in Monzo's app:

1. Open <https://developers.monzo.com/>, sign in with the email Monzo sends, and approve it in the
   Monzo app.
2. **Clients → New OAuth Client:**
   - **Name:** `iterate`
   - **Redirect URL:** `<base>/monzo/callback`, where `<base>` is the zero-trust-mcp Worker's origin
     (see [which server](../zero-trust-mcp.md#which-server); its setup page shows this URL with a copy button)
   - **Confidentiality: Confidential.** Monzo gives only confidential clients a refresh token.
3. Save. Keep the **Client ID** and **Client secret** handy: the Worker's setup page asks for them
   in step 1. They never go into a chat or into iterate.

Make it a client used only for this. Monzo allows one active access token per client per person, so
a second app sharing the client would keep signing this one out.

## 1. Connect the Monzo MCP server

Follow [zero-trust-mcp.md](../zero-trust-mcp.md) with `<integration>` = `monzo`. When it's done,
`/secrets/monzo` holds the sign-in and the tool list in its step 3 includes `register_webhook`,
`list_webhooks`, `delete_webhook`, `list_accounts`, `list_transactions` and `get_transaction`.
(If `register_webhook` is missing, that Worker predates the webhook tools: it needs a redeploy from
zero-trust-mcp's `main`.)

Monzo approves API access in the Monzo app. Until the person taps **Approve** there, calls fail with
a permissions error; ask them to open the app and approve, then try again.

## 2. Add the receiver to the project's config repo

Two ways to get the code into `/repos/config`; commit everything in one commit with
`itx.repos.get("/repos/config").commitFiles({ message, parent, changes: [{ path, content }, …] })`,
`parent` being the tip you read. A commit to `main` publishes.

### Plan A: depend on the package (recommended)

The code is the package `iterate-monzo`, built by this repo's CI and served by pkg.pr.new (never
npm). The loader only takes a pkg.pr.new package at a full commit, so pin one:

```sh
curl -sI https://pkg.pr.new/jonastemplestein/iterategrations/iterate-monzo@main | grep -i x-commit-key
# x-commit-key: jonastemplestein:iterategrations:<40-hex sha>
```

Add it under `dependencies` in the config repo's `package.json` (keep what is there):

```json
"dependencies": {
  "iterate-monzo": "https://pkg.pr.new/jonastemplestein/iterategrations/iterate-monzo@<40-hex sha>"
}
```

and one new file, `monzo.ts`, that only re-exports it:

```ts
export { receiveMonzoTransaction } from "iterate-monzo";
```

### Plan B: copy the source

Read [`src/monzo.ts`](src/monzo.ts) (about 40 lines, one type import) and commit it to
`/repos/config` as `monzo.ts`. You own the copy.

### The branch in `worker.ts`

In `worker.ts`, import it and add this at the top of `fetch`, before anything else that answers the
project's hosts:

```ts
import { receiveMonzoTransaction } from "./monzo.ts";

if (request.headers.get("x-iterate-routing-slug") === "monzo")
  return receiveMonzoTransaction(request, (call) => this.withItx(call));
```

Check it's live. The receiver answers a path it doesn't know with `404`, and that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "monzo", path: "/nope/nope" });
  const res = await itx.fetch(new Request(url, { method: "POST" }));
  return { url, status: res.status }; // 404 = the receiver is there and refused. Anything else: not published yet
};
```

## 3. Name the accounts

```js
async (itx) => {
  const mcp = await itx.connectToMcp("<base>/monzo/mcp", {
    headers: { authorization: 'Bearer getSecret("/secrets/monzo", { field: "accessToken" })' },
  });
  const { accounts } = await mcp.callTool("list_accounts");
  await mcp.close();
  return accounts.map((a) => ({ id: a.id, type: a.type, description: a.description, owners: a.owners?.map((o) => o.preferred_name) }));
};
```

Show the person the list and have them pick a **name** for each account they want events from:
lowercase letters, digits and hyphens (`joint-account`, `jonas-personal`). The name is the URL's
first segment and the stream's last: `/monzo/<name>`. A joint account shows up beside the personal
one (`uk_retail_joint`); a business account is `uk_business`.

## 4. Register a webhook per account, with a generated secret in its URL

One script per account does it all: it makes the secret, stores it as
`/secrets/monzo-webhook-<name>` (which the receiver checks with `itx.secrets.verifyEquals`), puts
it in the URL `…/<name>/<secret>`, and registers that URL with Monzo. The secret is never returned,
so it never reaches the chat. Run it once per account, and again to rotate: it deletes this
project's earlier webhook for that account first, so the old URL stops.

```js
async (itx) => {
  const name = "<the account's name, e.g. joint-account>";
  const accountId = "<its account id from step 3>";
  const secret = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const mine = await itx.url({ routingSlug: "monzo", path: `/${name}/` });
  const url = await itx.url({ routingSlug: "monzo", path: `/${name}/${secret}` });
  const mcp = await itx.connectToMcp("<base>/monzo/mcp", {
    headers: { authorization: 'Bearer getSecret("/secrets/monzo", { field: "accessToken" })' },
  });
  try {
    const { webhooks } = await mcp.callTool("list_webhooks", { account_id: accountId });
    for (const old of webhooks.filter((hook) => hook.url.startsWith(mine)))
      await mcp.callTool("delete_webhook", { webhook_id: old.id });
    await itx.secrets.set(`/secrets/monzo-webhook-${name}`, secret, { urls: ["https://monzo.invalid"] });
    const registered = await mcp.callTool("register_webhook", { account_id: accountId, url });
    return { name, webhook: JSON.parse(JSON.stringify(registered).replaceAll(secret, "<secret>")) };
  } finally {
    await mcp.close();
  }
};
```

Each URL is now a password: anyone who has it can post fake transactions to that account's stream.
It is held by the project's secret store and by Monzo, and it is in the request log of this one
script. Keep it out of chat. One account's URL cannot write to another's stream: each name has its
own secret.

## 5. Prove it

Ask the person to make a small transaction on one account (a card payment, or have someone send
them £1), then:

```js
async (itx) => {
  const name = "<the account's name>";
  const { payload } = await itx.cd(`/monzo/${name}`).waitForEvent({
    type: "monzo/transaction-created",
    timeoutMs: 110_000,
  });
  const t = payload.transaction;
  return { name, id: t.id, amount: t.amount, currency: t.currency, description: t.description, merchant: t.merchant?.name };
};
```

If it gives up, end your turn and wait for the person to say they've paid. Monzo shows the
transaction in the app a moment before the webhook fires. Then write the accounts, their names and
how to reach the API into the project's `AGENTS.md`.

## The event

On the stream `/monzo/<account name>`:

```json
{
  "type": "monzo/transaction-created",
  "idempotencyKey": "monzo:tx_0000…",
  "payload": { "transactionId": "tx_0000…", "transaction": { "id": "tx_0000…", "account_id": "acc_0000…", "amount": -510, "currency": "GBP", "description": "COFFEE", "merchant": { }, "created": "…" } }
}
```

- `transaction` is Monzo's `data`, untouched. **`amount` is in the currency's minor unit** (pence),
  negative for money out. Merchant details come as sent; `get_transaction` (an MCP tool) fetches
  the full record with notes and tags.
- Monzo retries a delivery that doesn't answer `200`, up to five times. A retry is the same event:
  the key is the transaction id.
- Only transactions made after the webhook is registered arrive: nothing is backfilled, and the
  webhook covers the one account it was registered for.
- Monzo asks the person to reconfirm API access about every 90 days. That affects the MCP tools
  (run step 2 of zero-trust-mcp.md again), not a webhook that is already registered.
- To stop an account: call `delete_webhook` through the same connection, then `itx.secrets.delete("/secrets/monzo-webhook-<name>")`.
