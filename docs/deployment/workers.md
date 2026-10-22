# Running TapDeploy on Cloudflare Workers

The Workers build is TapDeploy itself: one Worker (API) plus Static Assets
(UI), with no database, KV, R2 or Durable Object of its own. This guide is for
the operator who runs an instance for other people; end users never need it.

**Status: verification in progress.** This path is covered by offline
contract tests, a local `wrangler dev --local` Playwright run and a Wrangler
dry-run of the build. The end-to-end run on a real Workers
deployment with a real Cloudflare OAuth client is under way; until it is
recorded in [release-status.md](../release-status.md), do not announce a
hosted instance as production-ready.

## 1. Domain and OAuth client

- A public instance needs its own domain, because Cloudflare verifies the
  OAuth client's domain with a DNS record (see
  [cloudflare-oauth.md](cloudflare-oauth.md)). Attach that domain to the
  Worker as a Custom Domain in the dashboard (Worker → Settings → Domains &
  Routes) after the first deploy. A `*.workers.dev` URL is fine for a private
  test client.
- `TAPDEPLOY_PUBLIC_ORIGIN` must be exactly that **bare origin**, e.g.
  `https://deploy.example.com`: no trailing `/`, no path, no query.
  TapDeploy refuses to start OAuth with anything else and never derives the
  origin from the `Host` header.
- Register the OAuth client with the redirect URL
  `<origin>/api/auth/callback` and the scopes you need
  ([cloudflare-oauth.md](cloudflare-oauth.md)).

## 2. Deploy

**From your GitHub repository (Workers Builds).** Fork or push this
repository, then in the dashboard choose **Workers & Pages → Create → Import a
repository** and pick it:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` (the default) |
| Root directory | empty (the repository root) |

Workers Builds installs the dependencies itself and uses Node 24 from
`.nvmrc`. Every push to the production branch then rebuilds and redeploys.
The Worker name you choose in the dashboard overrides `name` in
`wrangler.jsonc`. Set the configuration (step 3) under **Settings →
Variables and Secrets**, not as build variables: build variables are not
available at runtime.

**From a clone** (Node 24):

```bash
git clone https://github.com/lpyedge/TapDeploy.git && cd TapDeploy
npm ci
npm run build                                   # dist/workers/worker.mjs + dist/workers/assets
npx wrangler deploy --dry-run                   # checks the root wrangler.jsonc, uploads nothing
npx wrangler deploy --name <your-worker-name>
```

The root `wrangler.jsonc` points at `dist/workers/worker.mjs` and
`./dist/workers/assets`, and the API runs before the assets for `/api/*`. Pass
`--name` to choose the Worker name, and never reuse the name of a Worker that
serves something else.

## 3. Configuration as Worker secrets

`wrangler.jsonc` ships no `vars`, so nothing is baked into the bundle. Set
every value as a secret (later `wrangler deploy` runs keep secrets but drop
plain vars) and answer the prompt rather than putting values in shell history
or files:

```bash
for name in TAPDEPLOY_PUBLIC_ORIGIN TAPDEPLOY_OAUTH_CLIENT_ID TAPDEPLOY_OAUTH_CLIENT_SECRET; do
  npx wrangler secret put "$name" --name <your-worker-name>
done
```

In the dashboard (**Settings → Variables and Secrets**) add each one with
type **Secret**. These three values are the whole configuration: the client
secret also derives the key that encrypts session cookies. Until every value
exists, `/api/auth/start` answers 500 and names the missing setting. Each
change creates a new Worker version; that is expected.

## 4. Verify

- `GET /` serves the UI; `GET /api/health` returns `{"ok":true,"runtime":"workers",…}`.
- `GET /api/auth/session` while signed out returns `{"authenticated":false}`;
  unknown `/api/*` paths return an error, never the UI page.
- Sign in with a test account and install a throw-away test release before
  inviting anyone.

## 5. Plan limits

Official Workers limits (checked 2026-10-21; re-check at
<https://developers.cloudflare.com/workers/platform/limits/>):

| | Free | Paid |
|---|---|---|
| CPU time per request | 10 ms | 30 s default, 5 min max |
| Memory | 128 MB | 128 MB |
| Subrequests per request | 50 | 10,000 |

TapDeploy parses and hashes release ZIPs (up to 8 MiB compressed / 24 MiB
expanded) inside the Worker. Whether that fits the Free CPU limit has **not
been measured**; treat the Free plan as unsupported for hosting TapDeploy
until a measured run says otherwise, and use a Paid plan or the
[Node / Docker runtime](node-docker.md) meanwhile.

## 6. Rollback and rotation

- Roll back with `npx wrangler rollback <version-id> --name <worker>` (see
  `npx wrangler versions list --name <worker>`). Secrets belong to versions;
  check the rolled-back version still has all values.
- Rotating the client secret signs everyone out and cancels in-flight
  sign-ins (sessions last 20 minutes). Cloudflare lets an OAuth client hold two
  secrets during rotation: add the new one,
  `wrangler secret put TAPDEPLOY_OAUTH_CLIENT_SECRET`, then delete the old one.
- Apps already installed into users' accounts are unaffected by changes to
  your instance; TapDeploy never rolls them back or deletes them.
