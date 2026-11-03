# Publishing an app for TapDeploy

You ship three things: a **release ZIP** (your final build output), a small
**`tapdeploy.config.json`**, and a **link**. Whoever opens the link needs only a
Cloudflare account: no GitHub account, no local tools. TapDeploy never builds,
never runs npm and never executes anything from your archive: the server
verifies the exact bytes, plans every create/update/bind from them, shows the
user the plan, and applies it step by step with read-back. Anything it cannot
verify is refused before any write, not silently skipped.

What your config decides is what the user is asked, in one guided form:
which values they must or may enter (typed, validated), how your resources
are named and whether an upgrade may swap them, and where their own domain
goes. The sections below build up to it: [1. Build](#1-build-with-your-own-toolchain),
[2. Lay out the ZIP](#2-lay-out-the-release-zip), [3. Write the config](#3-write-the-config),
[4. Publish](#4-publish-and-share-the-link), [5. Test](#5-test-before-you-share).

## 1. Build with your own toolchain

You need a project that already deploys with `wrangler deploy` (or a static
site). Produce the **final** files, nothing that still needs a build:

```bash
# Worker: bundle src/ into build/ without deploying anything
npx wrangler deploy --dry-run --outdir build      # → build/index.js (+ .wasm, if any)

# Pages site: your framework's production build
npm run build --prefix site                       # → site/dist
```

Any toolchain works (`esbuild`, `rollup`, `vite build`, TinyGo/Rust → Wasm with
a small JS glue module); only the emitted ESM `.js`/`.mjs` and `.wasm` bytes
matter. TapDeploy checks the format, not whether the output runs on Workers.

## 2. Lay out the release ZIP

Each Worker or Pages site is a **unit**: a directory holding its own
`wrangler.jsonc` with final values (`main` points at the built file, never at
`src/index.ts`) next to the files it references. Paths may not leave a unit's
directory.

**One Worker** (the simplest case): everything at the ZIP root, no `units` in the
config.

```text
release.zip
├── wrangler.jsonc        # { "name": "notes", "main": "worker/main.mjs", "compatibility_date": "2026-10-01", "r2_buckets": [...] }
├── worker/main.mjs       # from build/
└── worker/engine.wasm    # optional binary module(s)
```

**One Pages site:** the same, with `"pages_build_output_dir": "public"` in place of
`main`/`assets`, and the site files under `public/`.

**Several units:** one directory per unit, each declared under `units` in the
config. Workers call each other through `services` bindings; TapDeploy orders
the deploy.

```text
release.zip
├── units/api/wrangler.jsonc    # { "name": "notes-api", "main": "index.js", "compatibility_date": "2026-10-01", ...bindings }
├── units/api/index.js
├── units/site/wrangler.jsonc   # { "name": "notes-site", "compatibility_date": "2026-10-01", "pages_build_output_dir": "public" }
└── units/site/public/…
```

**Resources only:** a release that just creates storage has no `wrangler.jsonc` and
no units (`"units": []` plus `resources`); the ZIP may hold a README.

```bash
mkdir -p release/units/api release/units/site/public
cp build/index.js release/units/api/ && cp units/api/wrangler.jsonc release/units/api/
cp -r site/dist/. release/units/site/public/ && cp units/site/wrangler.jsonc release/units/site/
(cd release && zip -r ../notes.zip .)
unzip -l notes.zip          # only final output: no .ts, node_modules or .env
```

Rules for every `wrangler.jsonc` (details under [Release ZIP reference](#release-zip-reference)):
final effective values only (no templating), ESM `main`, `compatibility_date`, and
only the binding families TapDeploy supports ([support.md](support.md)).
Unknown or deployment-affecting fields are refused rather than ignored.

## 3. Write the config

A complete example with a Worker, a Pages site, a resource and typed inputs:

```jsonc
{
  "schemaVersion": 3,
  "app": { "id": "you/notes", "name": "Notes" },
  "source": {
    "defaultUrl": "https://github.com/you/notes/releases/latest/download/notes.zip"
  },
  "capabilities": ["workers", "pages", "r2", "d1"],

  "units": [
    { "id": "api",  "kind": "worker", "wrangler": "units/api/wrangler.jsonc" },
    { "id": "site", "kind": "pages",  "wrangler": "units/site/wrangler.jsonc" }
  ],

  "resources": [
    { "kind": "d1", "name": "notes-db" },                          // persistent: upgrade keeps it
    { "kind": "r2", "name": "notes-cache", "upgradeKeep": false }  // replaceable: upgrade may swap it
  ],

  "inputs": [
    { "key": "ADMIN_EMAIL", "type": "string", "label": "Admin e-mail",
      "validation": { "pattern": "[^@\\s]+@[^@\\s]+" } },
    { "key": "REGION", "type": "select", "label": "Region", "upgradeKeep": true,
      "options": ["eu", "us", { "label": "Asia-Pacific", "value": "apac" }] },
    { "key": "RETENTION_DAYS", "type": "integer", "label": "Keep notes for (days)", "required": false,
      "validation": { "minimum": 1, "maximum": 365 } },
    { "key": "ADMIN_PASSWORD", "type": "secret", "label": "Admin password",
      "validation": { "minLength": 12 } }
  ]
}
```

The user sees: the Worker name (editable, prefilled), your inputs as typed
fields that cannot be submitted invalid, the resource names (editable at
install, prefilled with yours), an optional custom domain per Worker or Pages
site, and a review of everything before anything is written.

### Reading it: defaults first

Almost every key is optional. Booleans are named so the default is the common
case and you only write the exception:

| Key | Where | Default | Meaning |
|---|---|---|---|
| `upgradeKeep` | resource | `true` | `true`: an upgrade keeps the Worker bound to what it uses today (shown read-only). `false`: the user may bind another one. Use `false` for caches, never for a database. |
| `create` | resource | `true` | `true`: create it when missing. `false`: it must already exist. |
| `required` | input | `true` | Must be filled at install. On upgrade an empty value always keeps what is deployed. A secret with `false` may be left empty, and is then not set at all (see [Secrets](#secrets)). |
| `upgradeKeep` | input | `false` | `true`: not asked again on upgrade, the deployed value stays. `false`: upgrade shows the field; empty keeps, a value replaces. For secrets see [Secrets](#secrets): a required one the Worker does not have is still asked. |
| `generate` | secret input | `false` | `true`: TapDeploy generates a random value once; the user never enters it. |
| `allowLocalZip` | source | `true` | Let the user pick a local ZIP instead of `defaultUrl`. `false` requires `defaultUrl` and `expectedSha256`. |

### Top level

- `schemaVersion` is `3`. `app.id` is the immutable project identity (stamped
  into versions, Pages ownership markers and receipts): keep it stable.
- `source`: `defaultUrl` (https), `allowLocalZip`, `expectedSha256` (pins the
  exact ZIP). On github.com, `defaultUrl` must be a download:
  `…/releases/latest/download/<file>.zip`, `…/releases/download/<tag>/<file>.zip`
  or `…/archive/<ref>.zip`. A repository, release or file page (`…/releases/tag/…`,
  `…/blob/…`) is refused when the config is validated.
- `capabilities` are symbolic and must cover every family your Wrangler configs use,
  otherwise the plan fails with `DEVELOPER_SCOPE_UNDERDECLARED`. They map to OAuth
  scopes in code; a config can never author a raw scope. `zone` and `dns` are implied
  by any Worker or Pages unit, so custom domains need no declaration.

| In `wrangler.jsonc` | Capability |
|---|---|
| a Worker unit / a Pages unit | `workers` / `pages` |
| `r2_buckets`, `d1_databases`, `kv_namespaces`, `queues` | `r2`, `d1`, `kv`, `queues` |
| `vectorize`, `hyperdrive`, `secrets_store_secrets` | `vectorize`, `hyperdrive`, `secrets-store` |
| `ai`, `browser` | `workers-ai`, `browser-rendering` |
| `workflows`, `durable_objects` | `workflows`, `durable-objects` |
| zone `routes` | `routes`, `zone` |

### `units`

Omit for one Worker or Pages site at the ZIP root. Each entry: `id`, `kind`
(`worker` or `pages`), `wrangler` (path to its `wrangler.jsonc`), optional
`dependsOn` (only for an order TapDeploy cannot derive from bindings). With
`resources` and no `units` you get one Worker at the root; `"units": []` means
resources only.

### `resources`

Account resources (`r2`, `d1`, `kv`, `queue`, `vectorize`) your app uses.
TapDeploy creates them before any Worker is deployed; your `wrangler.jsonc`
binds them by name. A `vectorize` entry needs `dimensions` and `metric` to be created.
Listing a resource here is what lets you control it: a name the user may
change at install, `create`, and `upgradeKeep`. A resource that only appears in
a `wrangler.jsonc` is created by its Worker and always kept on upgrade; list it
here under the same name to give it these options. Resource and Pages project
names are suggestions: the user may rename them at install, so refer to
resources through bindings in your code, never by name. A `kv_namespaces`
binding in `wrangler.jsonc` names an existing namespace by `id` and is never
renamed; use a `resources` entry for a KV that TapDeploy creates.
Hyperdrive is always the user's own pick, and custom domains can always change.

### `inputs`

Values the user fills in on the Configure step.

- `key` becomes a Worker variable of that name (a `secret` becomes a secret
  binding, entered in the browser and never stored). A key your `wrangler.jsonc`
  already sets under `vars` is refused. `workerName` is the one reserved key: it
  names the Worker (add it only to constrain the name with `validation`).
- `type`: `string`, `text`, `integer`, `number`, `boolean`, `date`
  (`YYYY-MM-DD`), `select`, `multiselect` (both need `options`; a multiselect
  arrives comma-joined) or `secret`.
- `options`: plain values or `{ "label", "value" }` objects.
- `validation`: `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`,
  `values` (see [Validation](#validation)).
- `label`, `description`, `placeholder` are what the user reads. They are never
  checked: a rule written only in a description is not enforced.

#### Validation

Only `validation` decides whether a value is accepted.

| Rule | Applies to | Checked by |
|---|---|---|
| `minLength`, `maxLength` | text and secrets | browser; server too for non-secret inputs |
| `minimum`, `maximum` | `integer`, `number` | browser and server |
| `values` / `options` | any typed value / `select`, `multiselect` | browser and server |
| `pattern` | text and secrets | browser only |

- `pattern` is a JavaScript regular expression that must match the **whole**
  value: TapDeploy tests `^(?:your pattern)$`, so do not add `^`/`$` yourself.
  Lookaheads work. The server never runs a pattern from a config (a regular
  expression can take exponential time on a crafted value).
- A secret value never reaches the server before the deploy step, so **every
  rule on a secret is checked in the browser only**; the server only refuses a
  missing value it needs. If your app relies on a rule (for example a password
  strength), check it in the app as well.
- Combine rules for "at least 8 characters with letters and digits":

  ```json
  { "key": "OWNER_PASSWORD", "type": "secret", "label": "Owner password",
    "validation": { "minLength": 8, "pattern": "(?=.*[A-Za-z])(?=.*[0-9]).+" } }
  ```

  `minLength` alone would accept `12345678`; the description saying "letters
  and digits" changes nothing.

#### Secrets

A `secret` input becomes a Worker secret named by its `key`. The user types it
on the Configure step; it travels only with the Worker upload, never with the
plan, and is never stored. What happens depends on the declaration and on
whether the Worker already has a secret of that name:

| Declared as | Install | Upgrade, Worker has it | Upgrade, Worker does not have it |
|---|---|---|---|
| `"generate": true` | generated once by TapDeploy | kept | generated |
| required (default) | asked; must be filled | kept; a "Change" box offers a new value | asked; must be filled (there is nothing to keep) |
| `"required": false` | asked; may be left empty, and then **not set** | kept; "Change" offers a new value | asked; may be left empty, and then not set |
| … plus `"upgradeKeep": true` | as above | kept; never offered for change | required: still asked; optional: not asked, not set |

- An optional secret that is not set does not exist in the Worker: your code
  must treat a missing binding as "not provided" (for example generate a
  password itself).
- "Upgrade" includes upgrading a Worker that was deployed another way (a Git
  repository, wrangler): if its secrets have other names than your `key`s,
  they count as missing. See [Upgrading a Worker TapDeploy did not deploy](#upgrading-a-worker-tapdeploy-did-not-deploy).

### `install.policies`

Only `private-r2-owner-bootstrap/v1`: a one-time owner bootstrap for apps that
keep their owner account in a private R2 bucket. Its fields are names in your
app, not values: `r2Binding` (the bucket binding), `rootSecret` (a secret
TapDeploy generates once on a fresh install and never resets), `armSecret` and
`armValue` (`"yes"`, set only while first setup is pending), and the R2 object
keys `ownerKey`, `markerKey`, `initialPasswordKey` (checked for existence only,
never read). Before the Worker upload TapDeploy reads the Worker's secret names
and those objects and decides: fresh (generate the root, arm), resume, or
upgrade (an Owner exists: nothing is generated or armed). It refuses rather
than guess: `ROOT_MISSING` when an Owner exists but the Worker has no secret
named `rootSecret` (a new one would lock the Owner out), `BUCKET_MISSING`,
`RECOVERY_REQUIRED`. So `rootSecret` must be the exact name the deployed
Worker already uses. Do not also declare these secrets under `inputs`.

Full field reference: the JSON Schema
[`schemas/tapdeploy.config.v3.schema.json`](../schemas/tapdeploy.config.v3.schema.json)
(it also gives editors completion if you add `"$schema"`).

## 4. Publish and share the link

1. Attach `notes.zip` to a GitHub release (or any HTTPS host). GitHub release
   downloads go through the instance's relay, so they need no CORS. Build and
   attach it from CI so every tag publishes a release:

   ```yaml
   # .github/workflows/release.yml
   on: { push: { tags: ["v*"] } }
   permissions: { contents: write }
   jobs:
     release:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 24 }
         - run: npm ci
         - run: npx wrangler deploy --dry-run --outdir build
         - run: |
             mkdir -p release/units/api && cp build/index.js release/units/api/ && cp units/api/wrangler.jsonc release/units/api/
             (cd release && zip -r ../notes.zip .)
         - run: gh release create "$GITHUB_REF_NAME" notes.zip --generate-notes
           env: { GH_TOKEN: "${{ github.token }}" }
   ```

2. Commit `tapdeploy.config.json` and use its `raw.githubusercontent.com`
   address: the browser fetches the config directly, so its host must send
   CORS headers (raw.githubusercontent.com does).
3. Share `https://<instance>/?config=<URL-encoded config address>`, for example
   as a README button with TapDeploy's button image,
   `https://raw.githubusercontent.com/lpyedge/TapDeploy/master/src/web/public/button.svg`:

   ![Deploy with TapDeploy](../src/web/public/button.svg)

   It has the same height, border and type as Cloudflare's *Deploy to
   Cloudflare* button, so the two sit together as a pair. Load it from GitHub
   as below, whichever instance the button opens.

```markdown
[![Deploy with TapDeploy](https://raw.githubusercontent.com/lpyedge/TapDeploy/master/src/web/public/button.svg)](https://deploy.example.com/?config=https%3A%2F%2Fraw.githubusercontent.com%2Fyou%2Fnotes%2Fmain%2Ftapdeploy.config.json)
```

### Offering both TapDeploy and Deploy to Cloudflare

Put the two buttons on one line, TapDeploy first, and say right below them how
they differ: users pick by what they want to do, not by the button. Recommend
TapDeploy to people who want to run the app; *Deploy to Cloudflare* suits people
who want their own copy of the code to change. A template (replace the instance,
repository and config addresses, and keep the rows true for your app):

```markdown
## Deploy

[![Deploy with TapDeploy](https://raw.githubusercontent.com/lpyedge/TapDeploy/master/src/web/public/button.svg)](https://deploy.example.com/?config=https%3A%2F%2Fraw.githubusercontent.com%2Fyou%2Fnotes%2Fmain%2Ftapdeploy.config.json)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/you/notes)

**Recommended: TapDeploy.** It installs the prebuilt release into your
Cloudflare account from the browser, and upgrading is the same link again.
Choose *Deploy to Cloudflare* if you want your own copy of the code to change.

| | TapDeploy (recommended) | Deploy to Cloudflare |
|---|---|---|
| You need | a Cloudflare account | a Cloudflare account and a GitHub account |
| What happens | the prebuilt release is installed; you see every change before anything is written | this repository is copied into your GitHub account and built by Workers Builds |
| Settings | a form, checked before install | Cloudflare's setup form |
| Upgrade | open the same link and choose *Upgrade existing*; your data and secrets are kept | bring this repository's changes into your copy; every push redeploys |
| Best for | running the app | changing the code |

Already deployed with *Deploy to Cloudflare*? TapDeploy can upgrade that Worker:
disconnect its Git repository first (Worker → Settings → Build), then tick
*Take over* on the review.
```

Keep every row accurate for your app (for example, drop "your data and secrets
are kept" if an upgrade resets something), and write the same text in each
language your README has. In Chinese or Japanese, end bold text before
full-width punctuation (`**推薦使用 TapDeploy**。`, not `**推薦使用 TapDeploy。**`):
GitHub does not close bold that ends in such punctuation right before more text,
and shows the asterisks.

## 5. Test before you share

Open the link, sign in, and choose your ZIP from this computer on the release page: you get the full
plan (what will be created, refusals, cost notes) before anything is written. The
same bytes from the URL are the same release.

## Upgrading a Worker TapDeploy did not deploy

Users may already run your app, deployed from a Git repository (Workers Builds,
the Deploy to Cloudflare button) or with wrangler, and switch to your release.
The upgrade works, with these rules:

- **Takeover.** TapDeploy marks every version it uploads. A Worker whose
  serving version has no mark is shown as "Not deployed by TapDeploy" on the
  review, and the user must tick *Take over* first. Tell them to disconnect the
  Git repository (Worker → Settings → Build) first, or its next push replaces
  your release again. A Worker of another TapDeploy app, or one whose traffic is
  split across versions, is refused.
- **Bindings your release does not declare are carried over** verbatim: R2,
  D1, KV, queues, Vectorize, services, variables, rate limits, Workflows,
  Durable Objects, AI, Browser, Hyperdrive, Secrets Store; secrets are
  inherited by name. Any
  other kind (Analytics Engine, mTLS, dispatch namespaces, …) cannot be copied
  exactly, so the plan refuses (`uncarriable-binding`): declare it in your
  release or have the user remove it first.
- **Static assets are not carried over.** TapDeploy does not upload Worker
  static assets (`assets.directory`), so a release serves its frontend from the
  Worker code (or ships a separate Pages unit). When the deployed version has
  static assets, the new version has none, and the review says so on the Worker
  line. Older versions keep their assets.
- **Names must match the deployment you replace.** Secrets, `rootSecret` and
  binding names are looked up by name; a different name counts as missing (a
  required secret is asked for, an optional one stays unset, a missing root
  secret refuses with `ROOT_MISSING`).
- **workers.dev** is enabled only when your `wrangler.jsonc` says
  `"workers_dev": true`; TapDeploy never turns it off, and reports the address
  only when you declare it. Keep it in the release if your app is meant to be
  reached there.

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
  [support.md](support.md).
- Workers static assets: `assets.directory` is **unsupported** and rejected before planning (`WORKER_ASSETS_UNSUPPORTED`). Publish static files as a Pages site; Worker uploaded bytes cannot currently be attested by the server.
- Pages: `pages_build_output_dir` instead of `main`/`assets`.
- `routes[].custom_domain: true` is refused: the installing user chooses
  their own domain in the Configure step.
- Paths may never cross unit boundaries (`CROSS_UNIT_PATH`).

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
Secrets are entered by the user on the Configure step (see [Secrets](#secrets))
or generated server-side (`"generate": true`).

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
- **ZIP from this computer**: a file the user picks (or drops); the bytes are sent unchanged.

Both end at the same server-side verification, and identical bytes are the
same release. Before that, the browser unpacks and checks the ZIP in a Worker
with the same checks (a bad file, a mismatching `expectedSha256` or an oversize
download is refused before anything is uploaded); only the server's check issues
the release proof. There is no repository or branch picker and no build service.

## Limits

| Budget | Value | Refusal |
|---|---|---|
| ZIP (compressed / expanded) | 8 MiB / 24 MiB (the same 8 MiB limits a chosen file, a direct download and the GitHub relay, so nothing larger is downloaded) | `SERVER_ZIP_VERIFY_LIMIT` (413) / `INVALID_PREBUILT_ZIP` |
| Files per ZIP, bytes per file | 1024, 8 MiB | `INVALID_PREBUILT_ZIP` |
| Compression ratio, path depth | 100×, 16 | `INVALID_PREBUILT_ZIP` |
| Worker upload | 128 modules, ~6 MiB decoded | `payload-too-large` |
| Module name length | 256 chars | validation error |
| Pages static assets | 20,000 files | manifest bound error |

Every refusal happens before any write; nothing is chunked or retried around
a limit. Server cost: `/prepare` re-verifies the whole ZIP, so on the Workers
Free plan (10 ms CPU per request) a release with large assets is expected to
exceed the budget (measured locally, not on Cloudflare); use a Paid plan or the
Node build for such releases.

## Checklist before publishing

1. `unzip -l` shows only final output (no `.ts`, `node_modules` or `.env`).
2. Every `wrangler.jsonc` holds final values and `main` points at a built file
   in the ZIP.
3. `capabilities` cover every family the Wrangler configs use.
4. Workflow classes extend `WorkflowEntrypoint`, Durable Object classes extend
   `DurableObject`, and new Durable Object classes use `new_sqlite_classes` in a
   single migration tag.
5. Every rule a value must meet is in `validation` (a description is not
   checked), and your app copes with an optional secret that is not set.
6. No `assets.directory` in a Worker's `wrangler.jsonc`; `"workers_dev": true`
   if the app should answer on workers.dev.
7. If users may already run the app deployed another way: secret and binding
   names match that deployment ([upgrading](#upgrading-a-worker-tapdeploy-did-not-deploy)).
8. You tested the ZIP from this computer on an instance and read the plan,
   both as a new install and as an upgrade.
9. The README button loads its image from TapDeploy's repository
   ([step 4](#4-publish-and-share-the-link)); next to *Deploy to Cloudflare* it
   says how the two differ ([template](#offering-both-tapdeploy-and-deploy-to-cloudflare)).

## Distributing TapDeploy itself

Use Python 3 (standard library only) and the existing Node toolchain. Public source
archives include only Git-visible files under `src/`, `tests/`, `schemas/`,
`scripts/`, `docs/`, `.github/` and the explicit root-file allowlist in
`scripts/package-public-artifact.py`. Runtime archives contain only the built
Node server/public directory, Workers script/assets, manifests and license.
Never ZIP the entire workspace. Local credentials and runbook state are excluded.

```sh
npm run build
mkdir -p temp/release
python3 scripts/source-fingerprint.py --repo . --output temp/release/source.json
python3 scripts/package-public-artifact.py source --identity temp/release/source.json --output dist/releases/tapdeploy-source.zip
python3 scripts/package-public-artifact.py runtime --identity temp/release/source.json --output dist/releases/tapdeploy-runtime.zip
python3 scripts/scan-public-artifact.py dist/releases/tapdeploy-runtime.zip
```

Packaging rejects a stale input fingerprint and scans before writing an archive.
Embedded `manifest.json` records source/lockfile/file hashes and build versions;
the sidecar adds archive SHA-256 and scanner result (avoiding a circular self-hash).
The build must be re-run after source changes; the release runbook verifies that
binding before candidate acceptance. The bounded scanner recursively checks
ZIP/tar/gzip archives, rejects private paths, links, encrypted/unsupported archives,
known private-key/token patterns and the synthetic regression sentinel; it is not
a proof that arbitrary secrets cannot exist. Diagnostics contain types and paths,
never matched values. CI uploads only scanned archives and manifests, never raw
Playwright traces, HAR or storage state. Docker copies only named build inputs.
