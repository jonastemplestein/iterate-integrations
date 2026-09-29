# iterate-integrations

Small integrations for [iterate](https://github.com/iterate/iterate) projects, one folder each. A
folder's `README.md` is the recipe: read it, then follow it. Each folder is also a package, built by
CI and served by [pkg.pr.new](https://pkg.pr.new) (never npm): a project's config repo depends on
`https://pkg.pr.new/jonastemplestein/iterate-integrations/<package>@<commit>`.

| Folder | Package | What it does |
| --- | --- | --- |
| [`pebble/`](pebble) | `iterate-pebble` | Receive Pebble Index 01 ring recordings (transcript event + audio file). |
| [`waitrose/`](waitrose) | `iterate-waitrose` | The Waitrose grocery API as a Cap'n Web RPC target, and its login as a secret's exchange code. |
