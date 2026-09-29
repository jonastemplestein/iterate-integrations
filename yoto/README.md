# Yoto

Give an iterate project's agents the person's [Yoto](https://yoto.com) players and library: list
players, play a card, set the volume and its limit, build a playlist from audio files, upload
cover art. Nothing to receive and no package: Yoto has no webhooks (live player status is MQTT, which
[zero-trust-mcp](https://github.com/iterate/zero-trust-mcp) doesn't do), so this recipe is only the
connection. Yoto is reached through zero-trust-mcp, the small Worker that keeps no credentials.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 0. Before you start: a Yoto developer app

The person needs a Yoto developer application of their own:

1. Open <https://dashboard.yoto.dev/> and sign in with their Yoto account.
2. Create a **confidential** application, named `iterate`, with the allowed callback
   `<base>/yoto/callback`, where `<base>` is the zero-trust-mcp Worker's origin (see
   [which server](../zero-trust-mcp.md#which-server); its setup page shows the callback with a copy button).
3. Enable these scopes: `family:library:view user:content:manage family:devices:view
   family:devices:control family:devices:manage offline_access`. (Drop the `devices:control` and
   `devices:manage` ones for a read-only connection; playback and volume then fail.)
4. Keep the **Client ID** and **Client secret** handy: the Worker's setup page asks for them in
   step 1. They never go into a chat or into iterate.

## 1. Connect the Yoto MCP server

Follow [zero-trust-mcp.md](../zero-trust-mcp.md) with `<integration>` = `yoto`. When it's done,
`/secrets/yoto` holds the sign-in.

## 2. Prove it

Read-only, and it shows the person's real players:

```js
async (itx) => {
  const mcp = await itx.connectToMcp("<base>/yoto/mcp", {
    headers: { authorization: 'Bearer getSecret("/secrets/yoto", { field: "accessToken" })' },
  });
  const players = await mcp.callTool("list_players");
  await mcp.close();
  return players;
};
```

Players back is the proof. Then write the connection down for the project's agents.

## What the tools do

`list_players`, `list_library`, `get_library_card`, `list_myo_cards`, `get_card`,
`list_library_groups`, `get_library_group`, `create_streaming_card`, `play_card`, `pause_playback`,
`resume_playback`, `stop_playback`, `set_volume`, `set_sleep_timer`, and, for making content,
`upload_audio`, `prepare_audio_upload`, `get_audio_upload`, `add_audio_to_card`, `get_playlist`,
`create_playlist`, `update_playlist`, `upload_cover_image`, `set_card_cover`, `list_icons`,
`upload_icon`, `get_player_config`, `update_player_config`, `set_volume_limit`. The server's
[README](https://github.com/iterate/zero-trust-mcp#yoto) and [authoring notes](https://github.com/iterate/zero-trust-mcp/blob/main/docs/yoto-authoring.md)
have the arguments and the limits.

- Commands report that Yoto *accepted* them, not that the player did them.
- `set_volume` is a percentage (0–100) of the current playback; `set_volume_limit` is 0–16 steps.
- Audio and images come in as public HTTPS URLs, up to 20 MiB and 5 MiB. A project file works: mint
  a link with `itx.files.get(path).url()` (valid for a week) and pass it as the URL.
- Streaming cards need internet on the player during playback.
- Not validated against a real Yoto account at the time of writing (the server's tests use a fake
  provider), so the first real call is the proof. Send what it says if it fails.
