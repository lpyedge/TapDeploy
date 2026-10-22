# Self-hosting TapDeploy

An instance is one app with no database: an API plus the UI, on **Cloudflare
Workers** or **Node.js / Docker** (the same code). You need a Cloudflare OAuth
client and three settings.

## 1. Register a Cloudflare OAuth client

Dashboard: **Manage Account → OAuth clients → Create client**
([Cloudflare docs](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)).

| Field | Value |
|---|---|
| Response type / Grant type | `code` / Authorization Code |
| Token endpoint authentication | `client_secret_basic` (TapDeploy also always uses PKCE `S256`) |
| Redirect URL | `https://<your-domain>/api/auth/callback`, exactly |
| Client URL | `https://<your-domain>` |
| Scopes | all of the table below, every one **Required** (not optional) |

Cloudflare shows the client secret only once: save it.

New clients are **private**: only members of your Cloudflare account can sign
in, which is enough for testing. To let anyone use your instance, make the
client **public**; Cloudflare first verifies the client URL's domain with a
DNS `TXT` record (`cloudflare_oauth_client_publisher=…`). That is why a public
instance needs **its own domain** (a shared `*.workers.dev` hostname cannot be
verified). Publishing is permanent.

| Dashboard name | Scope ID | Used for |
|---|---|---|
| Workers Admin | `workers-scripts.admin` | Workers: scripts, versions, deployments, cron, Durable Objects, Workflows, rate limits, secrets, `workers.dev` |
| Pages Write | `page.write` | Pages projects and deployments |
| D1 Write | `d1.write` | D1 databases |
| Workers KV Storage Write | `workers-kv-storage.write` | KV namespaces |
| Workers R2 Storage Write | `workers-r2.write` | R2 buckets |
| Queues Write | `queues.write` | queues, producers and consumers |
| Workers Routes Write | `workers-routes.write` | zone routes |
| Zone Read | `zone.read` | listing the user's domains (custom domains, routes) |
| DNS Write | `dns.write` | binding the user's own domain |
| Hyperdrive Write | `query-cache.write` | Hyperdrive bindings |
| Vectorize Write | `vectorize.write` | Vectorize indexes and bindings |
| Secrets Store Write | `secrets-store.write` | Secrets Store bindings |
| Workers AI Write | `ai.write` | Workers AI binding |
| Browser Run Write | `browser-rendering.write` | Browser Rendering binding |

Each install requests only the scopes its app needs; Zone Read and DNS Write
are requested for every app with a Worker or Pages site, so users can bind a
domain. A scope the client lacks makes Cloudflare refuse with `invalid_scope`,
and TapDeploy tells the user.

## 2. Settings

| Name | Value |
|---|---|
| `PUBLIC_ORIGIN` | the address users open, e.g. `https://deploy.example.com` (http only for `localhost`) |
| `OAUTH_CLIENT_ID` | the OAuth client ID |
| `OAUTH_CLIENT_SECRET` | the OAuth client secret; it also derives the key that encrypts session cookies, so rotating it signs everyone out |
| `PORT` | Node only, default `8787` |

Until all three are set, sign-in answers with an error naming the missing one.

## 3a. Deploy on Cloudflare Workers

**From GitHub (Workers Builds).** Fork or push this repository, then
**Workers & Pages → Create → Import a repository**:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` (default) |
| Root directory | empty |

Dependencies are installed automatically, Node 24 comes from `.nvmrc`, and
every push redeploys. Add the settings under **Settings → Runtime variables
and secrets** (not the Build variables, which are not available at runtime);
make `OAUTH_CLIENT_SECRET` a **Secret**. `wrangler.jsonc` sets `keep_vars`, so
deploys keep them. Then attach your domain under **Settings → Domains &
Routes**.

**From the command line:**

```bash
git clone https://github.com/lpyedge/TapDeploy.git && cd TapDeploy
npm ci && npm run build
npx wrangler deploy --name <worker-name>
for name in PUBLIC_ORIGIN OAUTH_CLIENT_ID OAUTH_CLIENT_SECRET; do
  npx wrangler secret put "$name" --name <worker-name>
done
```

The Workers Free plan allows 10 ms CPU per request; whether ZIP verification
fits has not been measured, so use a Paid plan or Node/Docker if `prepare`
fails.

## 3b. Deploy with Node.js or Docker

```bash
git clone https://github.com/lpyedge/TapDeploy.git && cd TapDeploy
npm ci && npm run build && npm prune --omit=dev
NODE_ENV=production PUBLIC_ORIGIN=https://deploy.example.com \
OAUTH_CLIENT_ID=… OAUTH_CLIENT_SECRET=… node dist/node/server.mjs
```

Or with Docker: put the settings in a `.env` next to `compose.yaml` (see
`.env.example`) and run `docker compose up -d --build`. The container runs as
the unprivileged `node` user and has a health check.

The server listens on all interfaces on `PORT`. Put a TLS reverse proxy (Nginx,
Caddy, …) for your domain in front and firewall the port. TapDeploy trusts
only `PUBLIC_ORIGIN`, never `Host` or `X-Forwarded-*` headers. It keeps no
state, so several instances with the same settings can run side by side.

## 4. Check it

- `GET /api/health` returns `{"ok":true,…}`.
- Open the instance, load a config and sign in: the consent page shows your
  client name and only the scopes that config needs.
- Install a throw-away release before inviting anyone.

Apps users installed are not affected by changes to your instance; TapDeploy
never rolls them back or deletes them.
