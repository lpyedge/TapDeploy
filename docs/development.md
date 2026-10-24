# Development

## Setup

Requires Node 24 (`.nvmrc`).

```bash
npm ci                       # or `npm run deps:install` to keep dependencies in temp/deps
cp .env.example .env.local   # fill in an OAuth client whose redirect URL is http://localhost:8787/api/auth/callback
npm run build && node dist/node/server.mjs   # UI + API on http://localhost:8787
```

For UI work, `npm run dev:node` (API, reloads on change) together with
`npm run dev:web` (Vite on :5173, proxying `/api`) is faster; set
`PUBLIC_ORIGIN=http://localhost:5173` and register that callback URL too.

`.env.local` is read by the Node runtime outside production only; never commit
real values. Settings are explained in [self-hosting.md](self-hosting.md#2-settings).

## Commands

| Command | What it does |
|---|---|
| `npm run dev:web` / `dev:node` / `dev:workers` | Vite UI (proxies `/api` to :8787) / Node runtime / `wrangler dev` |
| `npm run build` | UI → `dist/web`, Node server → `dist/node`, Worker → `dist/workers` |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |
| `npm run generate:validator` | regenerate `src/manifest/config-v3-validator.generated.js` after editing the config JSON Schema (Workers cannot compile a schema at runtime; a test fails when the file is stale) |
| `npm test` | Vitest (`tests/unit`, `tests/contracts`); run `npm run build` first |
| `npm run test:e2e` | Playwright against the Vite dev server |
| `PW_RUNTIME=node npm run test:e2e` | Playwright against the built Node server |
| `PW_RUNTIME=workers npm run test:e2e` | Playwright against the built Worker (`wrangler dev --local`) |

Playwright needs its browser once (`npx playwright install chromium`) and uses
port 5173 (`PW_PORT` to change it). Build first for `PW_RUNTIME=node|workers`
(use different `PW_PORT`s if you run them side by side): those runs also execute
`tests/e2e/runtime-auth.spec.ts` and `tests/e2e/built-assets.spec.ts` (the
compute Worker chunk and the BLAKE3 WASM are served same-origin and validate),
which the Vite run skips. CI (`.github/workflows/ci.yml`) runs all of
the above on every push and pull request, without secrets and without a
Cloudflare account.

## Repository layout

```
src/        api (Hono routes), auth (OAuth, sessions), core (planning, deploy steps),
            cloudflare (API client), manifest (config + wrangler parsing),
            release (ZIP verification), web (UI), runtime (Node and Workers entries)
tests/      unit, contracts (routes with mocked Cloudflare), e2e (Playwright), fixtures
scripts/    build and workspace helpers
schemas/    the config JSON Schema (its path is a published URL)
docs/       documentation
```

Generated and local-only (git-ignored): `temp/` (dependencies when installed
with `deps:install`, caches, test output; safe to delete), `dist/` (build
output), `.env.local`, and `plan/` (local notes). The root `wrangler.jsonc`
deploys TapDeploy itself; it is unrelated to the `wrangler.jsonc` files inside
a release ZIP.

Browser compute (release verification, source accessor, hashing) lives in
`src/web/compute/` and runs in a Dedicated Worker; the verification sequence is
shared with the server in `src/release/verify-prebuilt-release.ts`, and
`tests/unit/release-fixtures.ts` builds the 38-archive corpus (accepted, refused,
observation) that both are tested against. Do not add a second validator.

Design rules to keep when changing code: [ARCHITECTURE.md](ARCHITECTURE.md).
