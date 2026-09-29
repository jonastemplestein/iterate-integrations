# Pebble Index 01

Every recording you make with the ring lands in an iterate project: the transcript as a
`pebble/recording-created` event on the `/pebble` stream, the audio as the file
`/pebble/<recordingId>.m4a`.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 1. The signing secret

Tell the person to run `openssl rand -hex 32` and keep the output: they paste it here and into the
Pebble app in step 4.

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/pebble-webhook",
    egress: { urls: ["https://pebble.invalid"] }, // only ever compared, never sent anywhere
    description: "The signing secret for your Pebble Index webhook (also typed into the Pebble app).",
  });
```

Send them the returned `url` and wait until they say it is saved.

## 2. Add the receiver to the project's config repo

Two ways to get the code into `/repos/config`. Either way you also add one branch to `worker.ts`
(below). Commit everything in one commit with
`itx.repos.get("/repos/config").commitFiles({ message, changes: [{ path, content }, …] })`: a commit
to `main` publishes.

### Plan A: depend on the package (recommended)

The code is the package `iterate-pebble`, built by this repo's CI and served by pkg.pr.new (it is
never on npm). The loader only takes a pkg.pr.new package at a full commit, so pin one:

```sh
curl -sI https://pkg.pr.new/jonastemplestein/iterategrations/iterate-pebble@main | grep -i x-commit-key
# x-commit-key: jonastemplestein:iterategrations:<40-hex sha>
```

Add the dependency to the config repo's `package.json` (keep what is there):

```json
"dependencies": {
  "iterate-pebble": "https://pkg.pr.new/jonastemplestein/iterategrations/iterate-pebble@<40-hex sha>"
}
```

and one new file, `pebble.ts`, that only re-exports it:

```ts
export { receivePebbleRecording } from "iterate-pebble";
```

To update later, pin a newer commit the same way.

### Plan B: copy the source

Read [`src/pebble.ts`](src/pebble.ts) (71 lines, no dependencies) and commit it to `/repos/config` as
`pebble.ts`. Nothing else to add. You own the copy, so you can change it.

### The branch in `worker.ts`

In `worker.ts`, import it and add this inside `fetch`, after the fetch-routes block and before
`if (!routingSlug)` (the project's worker already has `this.withItx`, from `ConfigWorker`):

```ts
import { receivePebbleRecording } from "./pebble.ts";

if (request.headers.get("x-iterate-routing-slug") === "pebble")
  return receivePebbleRecording(request, (call) => this.withItx(call));
```

## 3. Get the webhook URL

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "pebble" });
  const res = await itx.fetch(new Request(url, { method: "POST" }));
  return { url, status: res.status }; // 400: the receiver refused an unsigned request. 404: not published yet
};
```

## 4. Set up the Pebble app

The app has no link to these settings. Tell the person: **Index** tab → **Settings** → **Webhook**,
then per gesture (**Hold & talk**, **Double click & hold**): paste the URL, turn on **Sign
requests** and paste the secret, set **Send** to **Both**, tap **Send test event**, **Save**. Don't
add an `Authorization` header: a project's host answers bearers itself.

## 5. Prove it

Ask for a recording, then:

```js
async (itx) => {
  const { payload } = await itx.cd("/pebble").waitForEvent({
    type: "pebble/recording-created",
    timeoutMs: 110_000,
  });
  return { payload, download: payload.audioPath && (await itx.files.get(payload.audioPath).url()).url };
};
```

## The event

`{ deliveryId, trigger, recordedAt, transcript, audioPath }`, idempotent per delivery.
`transcript` and `audioPath` are `null` when the app's mode leaves that part out. The transcript is
Pebble's; iterate transcribes nothing. Requests are verified with the app's signature
(`itx.secrets.verifyHmac`, 5-minute window); the contract is Pebble's
[INDEX_WEBHOOK_API.md](https://github.com/coredevices/mobileapp/blob/main/experimental/src/commonMain/kotlin/coredevices/ring/external/indexwebhook/INDEX_WEBHOOK_API.md).
The whole request is held in memory to verify it: fine for spoken notes.
