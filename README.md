# iterategrations

Small integrations for [iterate](https://github.com/iterate/iterate) projects, one folder each. A
folder's `README.md` is the recipe: read it, then follow it. Each folder is also a package, built by
CI and served by [pkg.pr.new](https://pkg.pr.new) (never npm): a project's config repo depends on
`https://pkg.pr.new/jonastemplestein/iterategrations/<package>@<commit>`.

| Folder | Package | What it does |
| --- | --- | --- |
| [`pebble/`](pebble) | `iterate-pebble` | Receive Pebble Index 01 ring recordings (transcript event + audio file). |
| [`waitrose/`](waitrose) | `iterate-waitrose` | The Waitrose grocery API as a Cap'n Web RPC target, and its login as a secret's exchange code. |
| [`monzo/`](monzo) | `iterate-monzo` | Monzo transactions as events (a webhook with a generated secret in its URL), signed in through zero-trust-mcp. |
| [`yoto/`](yoto) | none | Yoto players and library for a project's agents, connected through zero-trust-mcp. |
| [`whatsapp/`](whatsapp) | none: run with `iterate provide` | Your WhatsApp (Baileys, from your own computer) as `itx.whatsapp`, every message an event; a dummy to try it without an account. |

[`zero-trust-mcp.md`](zero-trust-mcp.md) is the shared step behind Monzo and Yoto: connecting a
[zero-trust-mcp](https://github.com/iterate/zero-trust-mcp) server, which keeps no credentials of its
own, to a project. A folder without a package is just a recipe.

## Working on this repo

pnpm and [Vite+](https://viteplus.dev) (oxfmt, oxlint with type checking, Vitest, tsdown):

```sh
pnpm install   # also builds every package (the tests and the type check read dist) and installs the pre-commit hook
pnpm check     # vp check: format, lint, type-check
pnpm test      # each package's tests, against a fresh build
```

A commit runs `vp check --fix` on its staged files. A package's build is its `vite.config.ts`
(`vp pack`); the rest of the toolchain is the root `vite.config.ts`.
