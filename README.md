# TapDeploy

[![CI](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml/badge.svg)](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**One-click deployment of prebuilt apps into your own Cloudflare account, from
the browser.** English | [繁體中文](README.zh-TW.md)

A publisher shares a link. The user opens it, signs in to Cloudflare once,
reviews exactly what will be created, and confirms. TapDeploy deploys the
prebuilt Workers and Pages release, with its storage and bindings, into the
user's account, optionally on the user's own domain. The user needs only a
browser and a Cloudflare account.

> **Status: not release-ready.** Tests and CI pass and the main features have
> run against a real account; hosting TapDeploy on Cloudflare Workers is being
> verified. A public demo instance is planned.

## What it deploys

- **Compute:** Workers (modules, Wasm, static assets, cron, Durable Objects,
  Workflows) and static Pages sites.
- **Storage and bindings:** R2, D1, KV, Queues, Vectorize, Workers AI, Browser
  Rendering, Hyperdrive and Secrets Store (existing ones the user picks).
- **Domains:** the user binds their own domain to any Worker or Pages site, and
  can change it on upgrade.
- **Not supported:** building source code (releases are prebuilt), Pages
  Functions, providers other than Cloudflare.

## How it works

1. **Open the link** `https://<instance>/?config=<config URL>`; the config names
   the app, its release ZIP and the Cloudflare permissions it needs.
2. **Sign in to Cloudflare once.** The consent page lists only those
   permissions; the token never reaches the page's JavaScript.
3. **Pick the release ZIP** (the published URL or a local file). The server
   verifies every byte; nothing is compiled.
4. **Configure:** new install or upgrade, an optional domain per Worker or Pages
   site, and the Hyperdrive configuration if the app uses one.
5. **Review and confirm.** The plan lists everything that will be created or
   changed and any billing risk. Every step is read back from Cloudflare before
   the next; nothing is rolled back or deleted behind your back.

## Run your own instance

On **Cloudflare Workers** or **Node.js / Docker**, with three settings:
`PUBLIC_ORIGIN`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`.

1. Register a Cloudflare OAuth client with redirect URL
   `https://<your-domain>/api/auth/callback` and the scopes listed in the guide.
   A public instance needs its own domain (Cloudflare verifies it).
2. Deploy:
   - **Workers:** import this repository in the dashboard (**Workers & Pages →
     Create → Import a repository**, build command `npm run build`) and add the
     settings under **Settings → Runtime variables and secrets**.
   - **Node / Docker:** `npm ci && npm run build && node dist/node/server.mjs`,
     or `docker compose up -d --build`, behind a TLS reverse proxy.

Guide: [docs/self-hosting.md](docs/self-hosting.md).

## Publish an app

1. Build with your own toolchain (a Worker: `npx wrangler deploy --dry-run --outdir build`).
2. Zip the output with one final `wrangler.jsonc` per Worker or Pages site.
3. Write a `tapdeploy.config.json` listing the units and capabilities.
4. Publish the ZIP (e.g. a GitHub release) and share
   `https://<instance>/?config=<config URL>`, for example as a README button.

Guide with a worked example and the full reference: [docs/publishing.md](docs/publishing.md).

## Develop

```bash
npm ci
cp .env.example .env.local   # your OAuth client for http://localhost:8787
npm run build && node dist/node/server.mjs
npm test
```

Guide: [docs/development.md](docs/development.md).

## License

[MIT](LICENSE) © lpyedge. More: [what is supported](docs/support.md),
[security](docs/security.md), [architecture](docs/ARCHITECTURE.md). Other
providers with an authorized deployment API (such as Vercel) may follow.
