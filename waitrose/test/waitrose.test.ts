// Runs against dist (the package as shipped): `pnpm test` builds first. The Waitrose class itself
// extends workerd's RpcTarget, so it is exercised in an iterate project, not here.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { WaitroseApi } from "../dist/client.js";
import { EXCHANGE_SOURCE, exchange } from "../dist/exchange.js";

const AUTHORIZATION = 'Bearer getSecret("/secrets/waitrose", { field: "accessToken" })';
const CONTEXT = { customerId: "c-1", customerOrderId: "o-1", customerOrderState: "TROLLEY", defaultBranchId: "b-1" };

/** A fetch that answers by URL and records every request. */
function fakeWaitrose(answers: Record<string, (body: any) => unknown> = {}) {
  const seen: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ url: input, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body });
    if (body?.query?.includes("shoppingContext")) return Response.json({ data: { shoppingContext: CONTEXT } });
    for (const [prefix, answer] of Object.entries(answers))
      if (input.startsWith(prefix) || body?.query?.includes(prefix)) return Response.json(answer(body));
    return new Response("no answer", { status: 500 });
  };
  return { fetch, seen };
}

test("every request carries the secret placeholder, never a token, and the shopping context is read once, first", async () => {
  const { fetch, seen } = fakeWaitrose({
    getTrolley: () => ({ data: { getTrolley: { products: [], trolley: { orderId: "o-1", trolleyItems: [], trolleyTotals: {} }, failures: null } } }),
    "https://www.waitrose.com/api/content-prod": () => ({ totalMatches: 1, componentsAndProducts: [{ searchProduct: { id: "p1", name: "Oat milk" } }] }),
  });
  const api = new WaitroseApi({ fetch, authorization: AUTHORIZATION });

  await api.getTrolley();
  const found = await api.searchProducts("oat milk");
  await api.getTrolley();

  assert.deepEqual(found.products, [{ id: "p1", name: "Oat milk" }]);
  assert.equal(seen.filter((request) => request.body?.query?.includes("shoppingContext")).length, 1);
  assert.match(seen[0]!.body.query, /shoppingContext/);
  assert.ok(seen.every((request) => request.headers.Authorization === AUTHORIZATION));
  // the trolley is the context's order, and the search is the context's customer at its branch
  assert.equal(seen[1]!.body.variables.orderId, "o-1");
  const search = seen.find((request) => request.url.includes("/productcontent/search/"))!;
  assert.match(search.url, /\/search\/c-1\?clientType=WEB_APP$/);
  assert.equal(search.body.customerSearchRequest.queryParams.branchId, "b-1");
});

test("a failed context read is not remembered: the next call tries again", async () => {
  let calls = 0;
  const api = new WaitroseApi({
    authorization: AUTHORIZATION,
    fetch: async () => (++calls === 1 ? new Response("down", { status: 503 }) : Response.json({ data: { shoppingContext: CONTEXT } })),
  });
  await assert.rejects(api.getShoppingContext(), /HTTP 503/);
  assert.deepEqual(await api.getShoppingContext(), CONTEXT);
});

test("exchange logs in without any Authorization header and returns the material with the accessToken", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const material = { username: "ada@example.com", password: "hunter2" };
  const result = await exchange(material, async (url, init = {}) => {
    seen.push({ url, init });
    return Response.json({ data: { generateSession: { accessToken: "jwt-1", failures: null } } });
  });
  assert.deepEqual(result, { ...material, accessToken: "jwt-1" });
  const [{ url, init }] = seen;
  assert.equal(url, "https://www.waitrose.com/api/graphql-prod/graph/live");
  const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(headers.authorization, undefined);
  assert.match(headers["user-agent"]!, /^Waitrose\//);
  assert.deepEqual(JSON.parse(init.body as string).variables.input, { clientId: "ANDROID_APP", password: "hunter2", username: "ada@example.com" });
});

test("exchange refusals name the fix and never the credential", async () => {
  const material = { username: "ada@example.com", password: "hunter2" };
  const answering = (response: Response) => async () => response;
  await assert.rejects(exchange(material, answering(new Response("", { status: 401 }))), /HTTP 401.*username and password/);
  await assert.rejects(exchange(material, answering(new Response("", { status: 520 }))), /HTTP 520/);
  await assert.rejects(exchange(material, answering(Response.json({ data: { generateSession: { failures: [{ type: "BAD_LOGIN" }] } } }))), /BAD_LOGIN/);
  await assert.rejects(exchange(material, answering(Response.json({ data: null }))), /no accessToken/);
  await assert.rejects(exchange({ username: "ada@example.com" }, answering(Response.json({}))), /no "username" and "password"/);
  for (const attempt of [
    exchange(material, answering(new Response("", { status: 401 }))),
    exchange(material, answering(Response.json({ data: { generateSession: { failures: [{ type: "BAD_LOGIN" }] } } }))),
  ])
    await attempt.catch((error: Error) => assert.doesNotMatch(error.message, /hunter2|ada@example/));
});

test("EXCHANGE_SOURCE is a module exporting the same exchange", async () => {
  const shipped = await import(`data:text/javascript,${encodeURIComponent(EXCHANGE_SOURCE)}`);
  const result = await shipped.exchange({ username: "u", password: "p" }, async () =>
    Response.json({ data: { generateSession: { accessToken: "jwt-2" } } }),
  );
  assert.deepEqual(result, { username: "u", password: "p", accessToken: "jwt-2" });
});

test("the README's exchange block is the shipped EXCHANGE_SOURCE, less its export", async () => {
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(EXCHANGE_SOURCE.replace(/^export /, "export ")), "README is out of date: paste EXCHANGE_SOURCE");
});
