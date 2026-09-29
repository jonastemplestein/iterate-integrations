import type { IterateContextApi } from "iterate/api";

const WEBHOOK_SECRET = "/secrets/monzo-webhook";

/** Monzo's webhook: it POSTs `{ type: "transaction.created", data: <the transaction> }` to the URL
 *  registered for an account, and retries a delivery that does not answer 200 (up to five times).
 *  Monzo does not sign anything, so the URL's first path segment is a secret, checked with
 *  `itx.secrets.verifyEquals`. Each transaction becomes one `monzo/transaction-created` event on
 *  the project's /monzo stream, the transaction as Monzo sent it in `payload.transaction`. */
export async function receiveMonzoTransaction(
  request: Request,
  withItx: <T>(call: (itx: IterateContextApi) => T) => Promise<Awaited<T>>,
): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
  const presented = decodeURIComponent(new URL(request.url).pathname.split("/")[1] ?? "");
  const known =
    presented !== "" &&
    (await withItx((itx) => itx.secrets.verifyEquals(WEBHOOK_SECRET, { value: presented })));
  // a wrong or missing secret looks like any other path
  if (!known) return new Response("Not found\n", { status: 404 });

  const body = (await request.json().catch(() => null)) as { type?: unknown; data?: { id?: unknown } } | null; // Monzo's documented shape; each field is checked below
  if (body?.type !== "transaction.created")
    return Response.json({ ok: true, ignored: String(body?.type ?? "not JSON") });
  const transactionId = body.data?.id;
  if (typeof transactionId !== "string" || !transactionId)
    return new Response("no transaction id\n", { status: 400 });

  await withItx((itx) =>
    itx.cd("/monzo").append({
      type: "monzo/transaction-created",
      // Monzo's retry of a delivery is the same event
      idempotencyKey: "monzo:" + transactionId,
      payload: { transactionId, transaction: body.data },
    }),
  );
  return Response.json({ ok: true });
}
