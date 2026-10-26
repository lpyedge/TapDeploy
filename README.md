# TapDeploy

[![CI](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml/badge.svg)](https://github.com/lpyedge/TapDeploy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**One-click deployment of prebuilt apps into your own Cloudflare account, from
the browser.** English | [繁體中文](README.zh-TW.md)

A publisher shares a link. The user opens it, signs in to Cloudflare once,
reviews exactly what will be created, and confirms. TapDeploy deploys the
publisher's prebuilt Workers and Pages release, with its storage and bindings,
into the user's own account, on the user's own domain if they want one. The
workflow runs in the browser; every call to Cloudflare is made by the
installer's server on the user's behalf (Cloudflare's API cannot be called from a
page).

> **Status: not release-ready.** Tests and CI pass and the main features have
> run against a real account; hosting TapDeploy on Cloudflare Workers is being
> verified. A public demo instance is planned.

## Why TapDeploy

**1. Only a Cloudflare account is needed.** The person deploying needs no
GitHub account, no Node.js, no `wrangler`, no terminal and no repository to
fork. They open a link, sign in to Cloudflare once, and confirm. The publisher
ships prebuilt files, so nothing is built on anyone's machine or on a server.

**2. One config turns into a guided, validated form.** The publisher describes
the install in a small JSON file, and TapDeploy shows it as a single Configure
step that the user cannot get wrong:

- **Typed, validated inputs:** text, number, date, single or multiple choice,
  secrets; patterns, ranges and allowed values checked in the browser and again
  on the server; each one required or optional, and either asked again on
  upgrade or kept (an upgrade can change a secret such as an admin password).
  Every value arrives in the Worker as an environment variable.
- **Resources named and governed in one place:** R2, D1, KV, Queues and
  Vectorize with a suggested name the user may change, and a rule per resource
  for upgrades: keep it (a database) or let the user swap it (a cache).
- **Domains and services together:** a custom domain per Worker or Pages site,
  their names, and the account's Hyperdrive configuration, all chosen in the
  same form, then planned and applied in one go. Every step is read back from
  Cloudflare before the next; nothing is rolled back or deleted behind your
  back.

```json
{
  "schemaVersion": 3,
  "app": { "id": "you/notes", "name": "Notes" },
  "source": { "defaultUrl": "https://github.com/you/notes/releases/latest/download/notes.zip" },
  "capabilities": ["workers", "r2", "d1"],
  "resources": [
    { "kind": "d1", "name": "notes-db" },
    { "kind": "r2", "name": "notes-cache", "upgradeKeep": false }
  ],
  "inputs": [
    { "key": "REGION", "type": "select", "label": "Region", "options": ["eu", "us"] },
    { "key": "ADMIN_PASSWORD", "type": "secret", "label": "Admin password", "validation": { "minLength": 12 } }
  ]
}
```

## What it deploys

- **Compute:** Workers (modules, Wasm, cron, Durable Objects,
  Workflows) and static Pages sites.
- **Storage and bindings:** R2, D1, KV, Queues, Vectorize, Workers AI, Browser
  Rendering, Hyperdrive and Secrets Store (existing ones the user picks).
- **Domains:** the user binds their own domain to any Worker or Pages site, and
  can change it on upgrade.
- **Not supported:** Worker static assets (`assets.directory`, disabled pending server-authoritative byte verification), building source code (releases are prebuilt), Pages
  Functions, providers other than Cloudflare.

## How it works

1. **Open the link** `https://<instance>/?config=<config URL>`; the config names
   the app, its release ZIP and the Cloudflare permissions it needs.
2. **Sign in to Cloudflare once.** The consent page lists only those
   permissions; the token never reaches the page's JavaScript.
3. **Pick the release ZIP** (the published URL or a local file). Your browser
   checks it first, so a bad file is refused before it is uploaded; the server
   then verifies every byte and its check is the one that counts. Nothing is
   compiled. Your files are processed in the browser, but every Cloudflare call
   goes through the installer's server (Cloudflare's API allows no browser calls).
4. **Configure:** new install or upgrade, then the form the config describes
   (what must be answered first, optional settings collapsed): its inputs, the name of every Worker, Pages site and resource (the
   publisher's names are suggestions), and an optional domain per Worker or
   Pages site. On upgrade the resources in use today are kept unless the config
   lets the user swap them.
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

1. **Build** with your own toolchain (a Worker: `npx wrangler deploy --dry-run --outdir build`; a site: your framework's build).
2. **Lay out** one directory per Worker or Pages site, each with a final
   `wrangler.jsonc` (`main` pointing at the built file) next to its files, and
   zip it. One Worker can sit at the ZIP root:

   ```text
   notes.zip
   ├── wrangler.jsonc     # name, main: worker/main.mjs, bindings
   └── worker/main.mjs    # built output
   ```
3. **Describe** the install in `tapdeploy.config.json`: resources, inputs, units
   and capabilities (the example above).
4. **Publish** the ZIP (e.g. a GitHub release) and share
   `https://<instance>/?config=<config URL>`, for example as a README button.

Guide with directory layouts for every case, a CI workflow that builds the ZIP,
and the full config reference: [docs/publishing.md](docs/publishing.md).

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
