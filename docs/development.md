# Development

## Setup

```bash
npm run deps:install         # npm ci into the disposable temp/deps, links ./node_modules
cp .env.example .env.local   # then fill in your OAuth client (see below)
npm run dev:node             # Node runtime -> http://127.0.0.1:8787
```

Requires Node >= 24 (`.nvmrc`). `build`, `typecheck`, `lint`, `test*` and `dev:*`
run `scripts/ensure-dev-deps.mjs` first and reinstall only when `temp/deps` is
missing or `package.json`/`package-lock.json` changed, so deleting `temp/` is
always safe (reinstalling needs the network; npm tokens are never copied). A
physical `node_modules` (a plain `npm ci`, the Docker build) is left alone.
`npm run deps:verify` checks without installing. The managed link is not
supported on Windows: run `npm ci` in the repository root instead.

`dev:workers`, `npm test`, `test:contracts` and `test:e2e` also link `.wrangler`
to `temp/wrangler` (`scripts/ensure-wrangler-link.mjs`; the Wrangler dry-run in
the contract tests writes `.wrangler/tmp`, and the link is re-created after
`temp/` was deleted); an existing physical `.wrangler` is moved
there once, byte-for-byte.

`.env.local` is auto-loaded by the Node runtime in development (only keys not
already in the environment). The compiled Node server serves the UI from its
module-relative `public/`, independent of the working directory.

## Environment variables

Copy `.env.example` to `.env.local` (git-ignored, loaded only by the Node
runtime outside production); never put real values in a file you commit or
share.

| Variable | Meaning |
|---|---|
| `TAPDEPLOY_PUBLIC_ORIGIN` | the bare origin users reach, e.g. `http://localhost:8787` (dev) or `https://deploy.example.com`: no trailing `/`, no path. OAuth refuses to start otherwise |
| `TAPDEPLOY_OAUTH_CLIENT_ID`, `TAPDEPLOY_OAUTH_CLIENT_SECRET` | the registered Cloudflare OAuth client; the secret also derives the session-cookie key |
| `PORT` | Node runtime only (default 8787, all interfaces) |

For local development, register a separate OAuth client whose redirect URL is
`http://localhost:8787/api/auth/callback`.

On a Workers deployment these are Worker secrets, not file values. Operator
guides: [Cloudflare OAuth client](deployment/cloudflare-oauth.md),
[Workers](deployment/workers.md), [Node / Docker](deployment/node-docker.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev:web` / `dev:node` / `dev:workers` | Vite UI (proxies `/api` to :8787) / Node runtime / `wrangler dev` |
| `npm run build` | `build:web` (Vite → `dist/web`), `build:node` (`dist/node`), `build:workers` (`dist/workers`) |
| `npm run typecheck` / `lint` | `tsc --noEmit` / ESLint |
| `npm test` | Vitest (`tests/unit`, `tests/contracts`); `test:unit`, `test:contracts` run one half |
| `npm run test:e2e` | Playwright against the Vite dev server |
| `TAPDEPLOY_PW_RUNTIME=node npm run test:e2e` | against `dist/node/server.mjs` (build first) |
| `TAPDEPLOY_PW_RUNTIME=workers npm run test:e2e` | against `wrangler dev --local` on `dist/workers` (build first) |

Order matters on a cold tree: run `npm run build` before `npm test` (the runtime
contract tests repackage `dist/web`) and before the node/workers Playwright
runs. Run one Playwright suite at a time (they share a port) and do not edit
`src/` while one runs. Set `TAPDEPLOY_PW_PORT` to change the port.

## External prerequisites, ports and exit codes

- **Network:** `deps:install` (and any script that triggers it) needs the npm
  registry on a cold `temp/` or after a lockfile change.
- **Playwright browser:** `test:e2e` needs the Playwright Chromium build, which
  is downloaded outside the repository (`npx playwright install chromium`,
  per-user cache, e.g. `~/.cache/ms-playwright` on Linux; set
  `PLAYWRIGHT_BROWSERS_PATH` to move it). Deleting `temp/` does not remove it.
- **Ports:** the Node runtime listens on `PORT` (default 8787, `.env.example`);
  Vite on 5173 with `--strictPort`; Playwright uses `TAPDEPLOY_PW_PORT` (default 5173)
  and owns that port: it fails if the port is taken unless `TAPDEPLOY_PW_REUSE=1`.
  Stop `dev:web` before `test:e2e`, or run one of them with another port
  (`TAPDEPLOY_PW_PORT=5199 npm run test:e2e`).
- **Exit codes:** every gate above is judged by its process exit code, not by
  scrolling output. Check it directly (`npm test; echo $?`); behind a pipe
  (`| tee`) use `set -o pipefail` so a downstream command cannot hide a failure.
  Test and file counts change with the suite and are not recorded here.

Offline gates never replace a live run on a real Cloudflare account; what has
run live is recorded in [release-status.md](release-status.md).

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request to `main`, on
Node 24 with `npm ci` (a physical `node_modules`, which the dependency script
leaves alone): `typecheck`, `lint`, `build`, `npm test`, the three Playwright
runtimes (Vite, built Node, built Workers via `wrangler dev --local`). It needs
no secrets and never talks to a Cloudflare account.

## Repository layout

```
src/            product code (api, auth, core, cloudflare, manifest, release, web, runtime)
tests/          unit, contracts, e2e and fixtures (versioned, never moved to temp)
scripts/        build and workspace tooling (scripts/lib: shared helpers)
docs/           documentation; docs/deployment: operator guides
.github/        CI workflow (.github/workflows/ci.yml)
schemas/        public machine-readable contract (tapdeploy.config.v3.schema.json)
README.md, README.zh-TW.md, LICENSE, package.json, package-lock.json, tsconfig.json, vite.config.ts,
vitest.config.ts, playwright.config.ts, eslint.config.js, wrangler.jsonc,
Dockerfile, compose.yaml, .env.example, .nvmrc, .gitignore, .dockerignore
                tool entrypoints that must stay at the root
```

Ignored by git:

| Path | Role | Safe to delete? |
|---|---|---|
| `temp/` | disposable tool workspace: `deps/` (physical npm packages), `npm-cache/`, `vite-cache/`, `vitest/`, `playwright/`, `wrangler/` (simulator state, tmp) | yes; it is rebuilt by the npm scripts (network needed for deps). Don't delete it while a server or test is running. |
| `node_modules` | symlink to `temp/deps/node_modules` (or a physical install) | managed by `scripts/ensure-dev-deps.mjs` |
| `.wrangler` | symlink to `temp/wrangler` | managed by `scripts/ensure-wrangler-link.mjs`; contains local simulator data |
| `dist/` | build outputs only: `web/`, `node/`, `workers/` | yes; `npm run build` recreates it |
| `plan/` | local task records, evidence and private credentials (git-ignored) | **no**; it is not generated |
| `.env.local` and other `.env*` | local secrets | **no** |

Rules of thumb: `wrangler.jsonc` at the root configures *this installer's* Workers
runtime and is unrelated to the `wrangler.jsonc` inside a release ZIP.
`schemas/` stays at the root because its path is a published URL of a machine
contract. `.env.example` is the only tracked `.env*` file; `.gitignore` and
`.dockerignore` keep every other one out of git and out of the Docker build
context.

## Where output goes

Everything regenerable lands under `temp/`:
Playwright artifacts in `temp/playwright/results`, Vite/Vitest cache in
`temp/vite-cache`, an explicit `--reporter=json` report in
`temp/vitest/reports/output.json`, Wrangler simulator state in `temp/wrangler`.
Nothing should reappear as `.vitest/`, `test-results/` or a physical
`.wrangler/` in the repository root.

Business rules to preserve while changing code:
[architecture/business-contract.md](architecture/business-contract.md).
