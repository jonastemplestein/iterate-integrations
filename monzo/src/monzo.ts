import type { IterateContextApi } from "iterate/api";

/** An account's name in a URL, a secret path and a stream path: `joint-account`, `jonas-personal`. */
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Monzo's webhook: it POSTs `{ type: "transaction.created", data: <the transaction> }` to the URL
 *  registered for an account, and retries a delivery that does not answer 200 (up to five times).
 *  Monzo does not sign anything, so each account's URL is `/<account name>/<secret>`, the secret
 *  being `/secrets/monzo-webhook-<account name>`, checked with `itx.secrets.verifyEquals`. Each
 *  transaction becomes one `monzo/transaction-created` event on the stream `/monzo/<account name>`,
 *  the transaction as Monzo sent it in `payload.transaction`. */
export async function receiveMonzoTransaction(
  request: Request,
  withItx: <T>(call: (itx: IterateContextApi) => T) => Promise<Awaited<T>>,
): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
  const [, account = "", presented = ""] = new URL(request.url).pathname
    .split("/")
    .map(decodeURIComponent);
  const known =
    ACCOUNT_NAME.test(account) &&
    presented !== "" &&
    (await withItx((itx) =>
      itx.secrets.verifyEquals(`/secrets/monzo-webhook-${account}`, { value: presented }),
    ));
  // an unknown account, or a wrong or missing secret, looks like any other path
  if (!known) return new Response("Not found\n", { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    type?: unknown;
    data?: { id?: unknown };
  } | null; // Monzo's documented shape; each field is checked below
  if (body?.type !== "transaction.created")
    return Response.json({
      ok: true,
      ignored: typeof body?.type === "string" ? body.type : body ? "no type" : "not JSON",
    });
  const transactionId = body.data?.id;
  if (typeof transactionId !== "string" || !transactionId)
    return new Response("no transaction id\n", { status: 400 });

  await withItx((itx) =>
    itx.cd(`/monzo/${account}`).append({
      type: "monzo/transaction-created",
      // Monzo's retry of a delivery is the same event
      idempotencyKey: "monzo:" + transactionId,
      payload: { transactionId, transaction: body.data },
    }),
  );
  return Response.json({ ok: true });
}
