# TapDeploy

[![CI](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml/badge.svg)](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**One-click deployment of prebuilt apps into your own Cloudflare account, from
the browser.** English | [繁體中文](README.zh-TW.md)

A publisher shares a link. The user opens it, signs in to Cloudflare once,
reviews exactly what will be created, and confirms. TapDeploy deploys the
publisher's prebuilt Workers and Pages release, with its storage and platform
bindings, straight into the user's account, optionally on the user's own
domain. The user needs only a browser and a Cloudflare account: no Node,
Wrangler, Git or GitHub account.

## Status

> **Not release-ready yet.** Local gates and CI pass, and the custom-domain
> and platform-binding paths have run once against a real account from a local
> instance; **hosting TapDeploy on Cloudflare Workers is being verified end to
> end**. What is and is not proven: [docs/release-status.md](docs/release-status.md).

## Demo

A public demo instance is **planned (TBD)**. Its address and a sample app link
will be published here once the Workers verification is complete.

## What it deploys

| | |
|---|---|
| Compute | Workers (ESM modules, Wasm, static assets, cron, `workers.dev`, Durable Objects, Workflows, rate limits, service bindings), Pages static sites |
| Storage | R2, D1, KV, Queues (producers and consumers), Vectorize |
| Platform bindings | Workers AI, Browser Rendering, Hyperdrive (an existing configuration the user picks), Secrets Store (an existing secret) |
| Domains | the user binds their own hostname to any Worker or Pages site at install, and can change it on upgrade |
| Not supported | building source code (releases are prebuilt), Pages Functions, providers other than Cloudflare |

Exact per-feature proof and explicit refusals: [docs/supported-resources.md](docs/supported-resources.md).

## How it works

1. **Open the link.** It carries the app's config
   (`?config=https://…/tapdeploy.config.json`); the config names the app, its
   release and the Cloudflare capabilities it needs.
2. **Sign in to Cloudflare once.** The consent page lists only the permissions
   that config needs. The token stays in a sealed HttpOnly cookie on the
   server; page JavaScript never sees it.
3. **Pick the release ZIP.** Download the published HTTPS ZIP (GitHub release
   assets are relayed safely) or choose a local file. The server, not the
   browser, verifies every byte; nothing is compiled.
4. **Configure.** Choose a new install or an upgrade, optionally bind one of
   your own domains to each Worker or Pages site (on upgrade, see and change
   the domains bound today), and pick your Hyperdrive configuration when the
   app uses one.
5. **Review and confirm.** The plan shows every Worker, Pages project and
   resource that will be created or updated, and any cost risk. Each step is
   verified against Cloudflare before the next one starts; nothing is ever
   rolled back automatically, and nothing is deleted except a domain you chose
   to unbind.

Security model: [docs/security.md](docs/security.md). End-user walkthrough:
[docs/install.md](docs/install.md).

## Run your own instance

TapDeploy runs on **Cloudflare Workers** (UI as Static Assets) or on
**Node.js** (directly or with Docker); both are the same code and neither
needs a database.

1. [Register a Cloudflare OAuth client](docs/deployment/cloudflare-oauth.md):
   redirect URL, scopes, and domain verification. A public instance needs
   **its own domain**, because Cloudflare verifies the OAuth client's domain.
2. Deploy it:
   - [Cloudflare Workers](docs/deployment/workers.md) (verification in progress):
     import the repository in the dashboard (build command `npm run build`), or
     `npm ci && npm run build && npx wrangler deploy --name <name>`; then set
     the three `TAPDEPLOY_*` values (public origin, OAuth client ID and secret)
     as Worker secrets.
   - [Node.js or Docker](docs/deployment/node-docker.md):
     `npm ci && npm run build && node dist/node/server.mjs`, or
     `docker compose up -d --build`, behind your TLS reverse proxy.

## Publish an app for TapDeploy

1. Build with your own toolchain (for a Worker: `npx wrangler deploy --dry-run --outdir build`).
2. Zip the final output with one `wrangler.jsonc` per Worker or Pages unit.
3. Write a `tapdeploy.config.json` that names the units and their capabilities.
4. Publish the ZIP (e.g. a GitHub release) and share
   `https://<instance>/?config=<config URL>`, for example as a README button.

Step by step, with a TypeScript Worker plus a Pages site:
[release publisher guide](docs/release-publisher-guide.md#quick-start-from-a-wrangler-project-to-a-one-click-link).
The same guide has the full config and release ZIP reference; the config JSON
Schema is [`schemas/tapdeploy.config.v3.schema.json`](schemas/tapdeploy.config.v3.schema.json).

## Develop

```bash
npm run deps:install         # dependencies live in the disposable temp/deps
cp .env.example .env.local   # fill in your OAuth client; never commit .env*
npm run dev:node             # Node runtime -> http://127.0.0.1:8787
npm run build && npm test    # checks; details in docs/development.md
```

Variables: [docs/development.md](docs/development.md#environment-variables). More:
[docs/development.md](docs/development.md),
[docs/architecture/business-contract.md](docs/architecture/business-contract.md).

## Roadmap

- Finish and publish the Cloudflare Workers hosting verification.
- Public demo instance (TBD).
- Other providers that offer an authorized deployment API, such as Vercel,
  may follow. None is supported or started today.

## License

[MIT](LICENSE) © lpyedge. Source: <https://github.com/lpyedge/TapDeploy>.
