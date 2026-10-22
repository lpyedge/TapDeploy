# Running TapDeploy on Node.js or Docker

The Node runtime is the same API and UI as the Workers build, served by
`@hono/node-server` from one process. It keeps no state of its own: no
database, no volume, no files written at runtime. Sessions are sealed,
short-lived HttpOnly cookies, so any number of instances can run behind a
load balancer as long as they share the same OAuth client secret (the
session-cookie key is derived from it).

## What is verified

| Check | Evidence |
|---|---|
| Built server serves the UI and API from any working directory | contract test `tests/contracts/node-runtime.test.ts` |
| Full browser UI flow against `dist/node/server.mjs` | Playwright, `TAPDEPLOY_PW_RUNTIME=node` |
| `docker build` succeeds; the container runs as `node`, reports `healthy`, serves `/`, `/api/health`, `/api/auth/session` | manual smoke, 2026-10-21 (Docker 29.8) |
| Real Cloudflare sign-in and installs through a local Node instance | live, 2026-10-22 ([release-status.md](../release-status.md)) |
| Real Cloudflare sign-in through a Docker instance | **not yet verified** |

## How it works

- `npm run build` produces `dist/node/server.mjs` (esbuild bundle of
  `src/runtime/node.ts`; npm packages stay external) and `dist/node/public/`
  (the UI). The server serves `public/` next to itself and the API under
  `/api/*`.
- Configuration comes only from environment variables (table below). With
  `NODE_ENV=production` the developer-only `.env.local` loader is off.
- The server listens on all interfaces on `PORT` (default `8787`) and stops
  cleanly on `SIGTERM`/`SIGINT`. Firewall the port so only your reverse proxy
  reaches it.
- `TAPDEPLOY_PUBLIC_ORIGIN` is the only origin TapDeploy trusts for cookies,
  CSRF checks and the OAuth redirect URL. `Host` and `X-Forwarded-*` headers
  are ignored, so a reverse proxy only has to terminate TLS and forward to the
  local port.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `TAPDEPLOY_PUBLIC_ORIGIN` | yes | bare public origin, e.g. `https://deploy.example.com` (no trailing `/`, no path) |
| `TAPDEPLOY_OAUTH_CLIENT_ID` | yes | Cloudflare OAuth client ID ([setup](cloudflare-oauth.md)) |
| `TAPDEPLOY_OAUTH_CLIENT_SECRET` | yes | client secret; also derives the session-cookie key, so rotating it signs everyone out |
| `PORT` | no | listen port, default `8787` |
| `NODE_ENV` | recommended | `production` |

## Option A: plain Node.js

Requires Node.js ≥ 24.

```bash
git clone https://github.com/lpyedge/TapDeploy.git && cd TapDeploy
npm ci && npm run build && npm prune --omit=dev
NODE_ENV=production PORT=8787 \
TAPDEPLOY_PUBLIC_ORIGIN=https://deploy.example.com \
TAPDEPLOY_OAUTH_CLIENT_ID=… TAPDEPLOY_OAUTH_CLIENT_SECRET=… \
node dist/node/server.mjs
```

For a long-running service use a process manager. A systemd example, with the
values in a root-only file (`chmod 600`) outside the application directory:

```ini
# /etc/systemd/system/tapdeploy.service
[Unit]
Description=TapDeploy
After=network-online.target

[Service]
WorkingDirectory=/opt/tapdeploy
EnvironmentFile=/etc/tapdeploy.env
Environment=NODE_ENV=production PORT=8787
ExecStart=/usr/bin/node /opt/tapdeploy/dist/node/server.mjs
User=tapdeploy
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Put a TLS-terminating reverse proxy (Nginx, Caddy, IIS, Apache) for your
domain in front and forward to `127.0.0.1:8787`.

## Option B: Docker

The `Dockerfile` builds in a `node:24-slim` stage (`npm ci`, `npm run build`,
`npm prune --omit=dev`) and copies only `node_modules`, `dist/node` and
`package.json` into the runtime stage. The container runs as the unprivileged
`node` user, listens on `0.0.0.0:8787` and has a `HEALTHCHECK` on
`/api/health`. `.dockerignore` keeps `.env*`, keys, `plan/`, `temp/` and
`dist/` out of the build context.

```bash
# .env next to compose.yaml (never commit it)
TAPDEPLOY_PUBLIC_ORIGIN=https://deploy.example.com
TAPDEPLOY_OAUTH_CLIENT_ID=…
TAPDEPLOY_OAUTH_CLIENT_SECRET=…
```

```bash
docker compose up -d --build       # builds tapdeploy:local, publishes port 8787
docker compose ps                  # STATUS shows (healthy)
curl -s http://127.0.0.1:8787/api/health
```

Compose refuses to start when a required value is missing. Publish the port
only to a reverse proxy on the same host (for example `127.0.0.1:8787:8787`)
when TLS is terminated there.

## Verify

- `GET /api/health` returns `{"ok":true,"runtime":"node",…}`.
- `GET /api/auth/session` while signed out returns `{"authenticated":false}`.
- Sign in through your domain with a test account and install a throw-away
  release before inviting anyone.
