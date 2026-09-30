/** WAITROSE'S LOGIN, as a secret's exchange code (`refresh: { kind: "worker", source: EXCHANGE_SOURCE }`):
 *  iterate's secret facet calls it on first use and on a 401 with the secret's material
 *  `{ username, password }` and a `fetch` that reaches the secret's pinned origins only, and keeps
 *  the object it returns. Waitrose has no refresh grant in use: logging in again is the refresh.
 *  The login carries no `Authorization` header on purpose: Waitrose answers a login that carries
 *  any JWT, expired or not, with a 401.
 *
 *  Self-contained on purpose (no imports, every constant inside): `EXCHANGE_SOURCE` is this
 *  function's own text, run in a jail that has nothing else. */
export async function exchange(
  material: { username?: string; password?: string; [field: string]: unknown },
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<Record<string, unknown>> {
  const graphqlUrl = "https://www.waitrose.com/api/graphql-prod/graph/live";
  const newSession =
    "mutation NewSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }";
  const { username, password } = material;
  if (typeof username !== "string" || !username || typeof password !== "string" || !password)
    throw new Error('waitrose: the secret\'s material has no "username" and "password"');
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      // Waitrose's edge answers a request with no user agent with HTTP 520
      "user-agent": "Waitrose/3.9.1 (Android)",
    },
    body: JSON.stringify({
      query: newSession,
      variables: { input: { clientId: "ANDROID_APP", password, username } },
    }),
  });
  if (response.status === 401)
    throw new Error("waitrose: login refused (HTTP 401): check the secret's username and password");
  if (!response.ok) throw new Error(`waitrose: login answered HTTP ${response.status}`);
  const answer = (await response.json().catch(() => null)) as {
    data?: {
      generateSession?: { accessToken?: string | null; failures?: { type: string }[] | null } | null;
    } | null;
  } | null;
  const session = answer?.data?.generateSession;
  const failure = session?.failures?.[0]?.type;
  if (failure) throw new Error(`waitrose: login refused (${failure})`);
  if (!session?.accessToken) throw new Error("waitrose: login returned no accessToken");
  return { ...material, accessToken: session.accessToken };
}

/** The exchange as the module text a secret's `refresh.source` takes. */
export const EXCHANGE_SOURCE: string = `export ${exchange.toString()}`;
