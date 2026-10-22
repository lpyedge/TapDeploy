# Publishing an app for TapDeploy

TapDeploy installs **prebuilt** releases. You compile with your own toolchain and
publish a final ZIP; TapDeploy never builds, never runs npm, and never executes
anything from the archive on its server. The server verifies the exact bytes,
plans a sealed execution graph from them, and dispatches each approved action
with provider readback. Anything the server cannot verify is refused before
any provider write — not silently skipped.

## Quick start: from a Wrangler project to a one-click link

You need a project that already deploys with `wrangler deploy`, and the
address of a TapDeploy instance (your own, see the
[README](../README.md#run-your-own-instance); a public instance is planned).
The example ships a TypeScript Worker plus a static Pages site.

### 1. Build with your own toolchain

```bash
# Worker: bundle src/ into build/index.js without deploying anything
npx wrangler deploy --dry-run --outdir build

# Pages site: your framework's production build, e.g. into site/dist
npm run build --prefix site
```

### 2. Lay out the release ZIP

One directory per unit, each with a `wrangler.jsonc` that holds the **final**
values (`main` points at the built file, not at `src/index.ts`):

```text
release/
├── units/api/wrangler.jsonc   # { "name": "my-app-api", "main": "index.js", "compatibility_date": "2026-10-01", ... bindings }
├── units/api/index.js         # copied from build/ (the source map is optional)
├── units/site/wrangler.jsonc  # { "name": "my-app-site", "compatibility_date": "2026-10-01", "pages_build_output_dir": "public" }
└── units/site/public/…        # copied from site/dist
```

```bash
(cd release && zip -r ../my-app.zip .)
```

A single Worker or a single Pages site can skip `units/`: put its
`wrangler.jsonc` at the ZIP root and leave `units` out of the config.

### 3. Write `tapdeploy.config.json`

```json
{
  "schemaVersion": 3,
  "app": { "id": "you/my-app", "name": "My App" },
  "source": {
    "defaultUrl": "https://github.com/you/my-app/releases/latest/download/my-app.zip",
    "allowLocalZip": true
  },
  "capabilities": ["workers", "pages", "d1"],
  "units": [
    { "id": "api", "kind": "worker", "wrangler": "units/api/wrangler.jsonc" },
    { "id": "site", "kind": "pages", "wrangler": "units/site/wrangler.jsonc" }
  ]
}
```

`capabilities` must cover every family the Wrangler configs use, otherwise
the plan fails with `DEVELOPER_SCOPE_UNDERDECLARED`:

| In `wrangler.jsonc` | Capability |
|---|---|
| a Worker unit / a Pages unit | `workers` / `pages` |
| `r2_buckets`, `d1_databases`, `kv_namespaces`, `queues` | `r2`, `d1`, `kv`, `queues` |
| `vectorize`, `hyperdrive`, `secrets_store_secrets` | `vectorize`, `hyperdrive`, `secrets-store` |
| `ai`, `browser` | `workers-ai`, `browser-rendering` |
| `workflows`, `durable_objects` | `workflows`, `durable-objects` |
| zone `routes` | `routes`, `zone` |

You never list `zone` and `dns` for custom domains: any Worker or Pages unit
implies them, so the installing user can bind their own domain. Full field
reference: [Config reference](#config-reference) below and the JSON Schema
[`schemas/tapdeploy.config.v3.schema.json`](../schemas/tapdeploy.config.v3.schema.json).

### 4. Publish and share the link

1. Attach `my-app.zip` to a GitHub release (or any HTTPS host). GitHub release
   downloads go through the instance's relay, so they need no CORS.
2. Commit `tapdeploy.config.json` and use its `raw.githubusercontent.com`
   address: the browser fetches the config directly, so its host must send
   CORS headers (raw.githubusercontent.com does).
3. Share `https://<instance>/?config=<URL-encoded config address>`, for example
   as a README button:

```markdown
[![Deploy with TapDeploy](https://img.shields.io/badge/Deploy%20with-TapDeploy-f38020)](https://deploy.example.com/?config=https%3A%2F%2Fraw.githubusercontent.com%2Fyou%2Fmy-app%2Fmain%2Ftapdeploy.config.json)
```

### 5. Test before you share

Open the link, sign in, choose **Local ZIP** and pick your ZIP: you get the
full plan (what will be created, refusals, cost notes) before anything is
written. The same bytes from the URL are the same release.

## Config reference

```jsonc
{
  "schemaVersion": 3,
  "app": { "id": "example/notes", "name": "Notes" },
  "source": {
    "defaultUrl": "https://example.org/notes-release.zip",
    "allowLocalZip": true,
    "expectedSha256": "…optional 64-hex…"
  },
  "capabilities": ["workers", "r2"],
  "units": [{ "id": "api", "kind": "worker", "wrangler": "units/api/wrangler.jsonc" }]
}
```

- `app.id` is the immutable project identity (stamped into versions, Pages
  ownership markers and receipts). Keep it stable across releases.
- `capabilities` are symbolic (table in the quick start); they map to OAuth
  scopes in code, and a config can never author a raw scope.
- `units` (optional): omitted means one implicit unit (`main`) whose
  `wrangler.jsonc` sits at the ZIP root. `kind` is `worker`, `pages` or
  `resources`; a `resources` unit has no `wrangler` key and lists
  `resources` (`r2`, `d1`, `kv`, `queue`, `vectorize`, each with
  `mode: "ensure"` to create it when missing or `"bind-existing"`;
  `vectorize` needs `dimensions` and `metric` to be created). `dependsOn`
  orders units.
- `inputs` (optional): nonsecret values the user fills in (including
  `select` options) and `secret` inputs collected in the browser, never stored.
- `install.policies` (optional): only `private-r2-owner-bootstrap/v1`, a
  one-time owner bootstrap for apps that keep their owner account in a
  private R2 bucket.
- `source.expectedSha256` pins the exact ZIP; `allowLocalZip: false` requires
  that pin.

## Release ZIP reference

A ZIP containing **final build output only**. TapDeploy performs no build or
npm step and never executes anything from the archive on its server.

### Per-unit `wrangler.jsonc`

Exactly one per Worker or Pages unit, with **final effective values** (no
placeholders, no templating). Unknown or deployment-affecting fields are
refused rather than ignored (`UNKNOWN_WRANGLER_FIELD`,
`UNSUPPORTED_WRANGLER_FEATURE`); a `wrangler.toml` is refused (convert it).

- `name`, `main` (built ESM `.mjs`/`.js`, relative to the unit directory),
  `compatibility_date` (`YYYY-MM-DD`). A `main` pointing at `.ts`/`.tsx`/`.jsx`
  is refused (`UNCOMPILED_ENTRYPOINT`).
- Bindings: `r2_buckets`, `d1_databases`, `kv_namespaces`, `queues`
  (producers and consumers), `workflows`, `durable_objects` (+ `migrations`),
  `ratelimits`, `services`, `vars`, `compatibility_flags`, zone `routes`
  (add-only), and on Worker units `hyperdrive`, `vectorize`,
  `secrets_store_secrets`, `ai`, `browser`. Behaviour per family:
  [supported-resources.md](supported-resources.md).
- Workers static assets: `assets.directory` (+ optional `binding`).
- Pages: `pages_build_output_dir` instead of `main`/`assets`.
- `routes[].custom_domain: true` is refused: the installing user chooses
  their own domain in the Configure step.

### Layouts

**Single unit:** one `wrangler.jsonc` at the ZIP root (unit id `main`).

```text
release.zip
├── wrangler.jsonc        # name, main: worker/main.mjs, bindings, vars
├── worker/main.mjs       # built ESM entry
├── worker/engine.wasm    # optional binary module(s)
└── public/…              # optional static assets (assets.directory)
```

**Multiple units:** one directory per unit, each with its own
`wrangler.jsonc`, declared in `units[]`. Paths may never cross unit
boundaries (`CROSS_UNIT_PATH`). Workers call each other through `services`
bindings; the graph orders the deploy.

**Resource-only:** all units are `kind: "resources"` and the ZIP has no
`wrangler.jsonc`.

### Modules and assets

- Worker modules are every `.mjs`/`.js`/`.wasm` file in the unit directory
  outside the asset directory, hash-bound (`sha256`, size). `.wasm` stays
  binary end to end. Each approved module must arrive exactly once with
  exact bytes at deploy time (`HASH_DRIFT`, `SIZE_MISMATCH` otherwise).
- Pages: `_worker.js` or a `functions/` tree is refused
  (`PAGES_FUNCTIONS_UNSUPPORTED`), and `_redirects`, `_headers`,
  `_routes.json` are not deployed as static assets. Ship static output only.
- The per-unit bundle digest covers paths, hashes and sizes, never ZIP
  metadata, so re-zipping identical inputs gives an identical release.

### Secrets are never shipped

`.env`, `.env.*`, `.dev.vars*` and key-like files are refused (`SECRET_FILE`).
Secrets are entered by the user at install time (prompt-on-install) or
generated server-side (generate-once).

## Toolchains

Only the final bytes matter:

- **JS/TS**: `wrangler deploy --dry-run --outdir`, `esbuild`, `rollup`,
  `vite build` → ESM; point `main` at the emitted entry.
- **Static sites (React, Vue, …)**: ship the production build as a Pages unit.
- **Go (TinyGo), Rust, .NET → Wasm**: a small JS glue module as `main` plus
  the `.wasm` file. TapDeploy checks the format, not whether the toolchain's
  output runs on Workers: verify that on Cloudflare yourself.
- **Other languages**: only through a JS/Wasm bundle you produce.

## Where the ZIP lives

- **HTTPS URL**: a GitHub release asset (`…/releases/download/<tag>/<file>.zip`
  or `…/releases/latest/download/<file>.zip`) goes through the instance's
  bounded relay; any other HTTPS host must send CORS headers.
- **Local ZIP**: a file the user picks; the bytes are sent unchanged.

Both end at the same server-side verification, and identical bytes are the
same release. There is no repository or branch picker and no build service.

## Limits

| Budget | Value | Refusal |
|---|---|---|
| ZIP (compressed / expanded) | 8 MiB / 24 MiB | `SERVER_ZIP_VERIFY_LIMIT` (413) / `INVALID_PREBUILT_ZIP` |
| Files per ZIP, bytes per file | 1024, 8 MiB | `INVALID_PREBUILT_ZIP` |
| Compression ratio, path depth | 100×, 16 | `INVALID_PREBUILT_ZIP` |
| Worker upload | 128 modules, ~6 MiB decoded | `payload-too-large` |
| Module name length | 256 chars | validation error |
| Pages static assets | 20,000 files | manifest bound error |

Every refusal happens before any write; nothing is chunked or retried around
a limit.

## Checklist before publishing

1. `unzip -l` shows only final output (no `.ts`, `node_modules` or `.env`).
2. Every `wrangler.jsonc` holds final values and `main` points at a built file
   in the ZIP.
3. `capabilities` cover every family the Wrangler configs use.
4. Workflow classes extend `WorkflowEntrypoint`, Durable Object classes extend
   `DurableObject`, and new Durable Object classes use `new_sqlite_classes` in a
   single migration tag.
5. You tested the ZIP with **Local ZIP** on an instance and read the plan.
