# Connect a zero-trust-mcp server to an iterate project

Shared by the [Monzo](monzo/README.md) and [Yoto](yoto/README.md) recipes. You are a coding agent
with iterate's MCP server (`run({ script })`, `async (itx) => …` at the project's root; read
<https://os.iterate.com/connect-a-service.md> first if that is new to you, and never take a secret
in chat).

[zero-trust-mcp](https://github.com/iterate/zero-trust-mcp) is a small Cloudflare Worker that puts
one third party's API behind an MCP server (`/monzo/mcp`, `/yoto/mcp`, `/waitrose/mcp`) and stores
nothing: the person's upstream credentials live encrypted *inside the OAuth tokens the MCP client
holds*, and iterate is that client. So the project ends up holding one secret,
`/secrets/<integration>`, which iterate's platform keeps refreshed, and the Worker holds no copy of
anything that can call the third party.

Prefer this to giving the project the third party's own OAuth app and tokens: the third party's
client id and secret are typed into the Worker's setup page, never into iterate or a chat.

## Which server

`<base>` below is the Worker's origin.

- **The person's own deployment** (recommended): `bunx wrangler deploy` in a checkout of
  github.com/iterate/zero-trust-mcp, after `openssl rand -base64 32 | bunx wrangler secret put SEAL_KEY`.
  Its README has the details.
- **Jonas's**, `https://zero-trust-mcp.templestein.workers.dev`, if the person says to use it. Say
  what that means first: a running Worker necessarily sees the tokens of each request it serves
  (its README says so), so its operator has to be someone the person trusts.

Check it serves the integration (`<integration>` is `monzo` or `yoto`), and that it speaks OAuth
with open client registration:

```js
async (itx) => {
  const base = "<base>";
  const metadata = await (await itx.fetch(new Request(`${base}/.well-known/oauth-authorization-server/<integration>`))).json();
  return { authorize: metadata.authorization_endpoint, token: metadata.token_endpoint, register: metadata.registration_endpoint };
};
```

## 1. Register iterate as a client of it

No secret is involved: the server's clients are public (PKCE, no client secret).

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("<base>/<integration>/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "iterate",
        redirect_uris: ["https://os.iterate.com/.secrets/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  return { status: response.status, clientId: (await response.json()).client_id };
};
```

(On a self-hosted iterate the callback is `/.secrets/oauth/callback` on that platform's origin.)
Keep the `clientId`.

## 2. The person signs in

```js
async (itx) =>
  itx.secrets.beginOAuth("/secrets/<integration>", {
    authorizationEndpoint: "<base>/<integration>/authorize",
    tokenEndpoint: "<base>/<integration>/token",
    clientId: "<the clientId from step 1>",
    clientAuth: "none",
    urls: ["<base>"],
  });
```

It returns `{ authorizationUrl }`. Send the person this, with the link on a line of its own:

> Open this link. The page asks for your <Monzo|Yoto> developer client's ID and secret (from the
> setup in the recipe), then sends you to <Monzo|Yoto> to sign in and approve. Press **Return to your
> MCP client** at the end, and the page here should say **Done**. If it says anything else, send me
> what it says.
>
> <authorizationUrl>

Then wait for the tokens. This returns `"saved"` when the sign-in lands:

```js
async (itx) => {
  const path = "/secrets/<integration>";
  return itx
    .cd(path)
    .waitForEvent({ type: "events.iterate.com/secret/set", timeoutMs: 100_000 })
    .then(() => "saved", () => "not saved yet");
};
```

`"not saved yet"`: run it again a few times, then end your turn and ask the person to reply "done".
The link works for an hour; if it lapsed, run step 2 again for a new one.

## 3. Use it

```js
async (itx) => {
  const mcp = await itx.connectToMcp("<base>/<integration>/mcp", {
    headers: { authorization: 'Bearer getSecret("/secrets/<integration>", { field: "accessToken" })' },
  });
  const tools = (await mcp.listTools()).map((tool) => tool.name);
  await mcp.close();
  return tools;
};
```

The platform sends the sealed access token and refreshes it with the sealed refresh token when it
expires. If a call answers `invalid_grant` or the sign-in has lapsed (Monzo, for one, wants the person
to reconfirm access every 90 days), run step 2 again.

Write the connection down for the project's agents (`AGENTS.md` in `/repos/config`): the MCP URL,
the secret path, and the two lines of `connectToMcp` above.
