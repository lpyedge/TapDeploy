# Cloudflare OAuth client setup

Every TapDeploy instance (Workers, Node or Docker) signs users in with a
Cloudflare OAuth client that **you, the operator,** register. Users then
authorize your instance once per install; TapDeploy never sees their password
or an API token they created.

Official reference: [Create your OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
(checked 2026-10-21; re-check before you rely on details).

## 1. You need your own domain

- New Cloudflare OAuth clients are **private**: only members of the account
  that created them can authorize them. That is enough for testing.
- To let any Cloudflare user install through your instance, the client must
  be made **public**, and Cloudflare requires you to **verify the client
  URL's domain** first, by publishing a DNS `TXT` record that starts with
  `cloudflare_oauth_client_publisher=`. Publishing is permanent: a public
  client cannot go back to private, and the verified domain cannot change.
- You can only publish that record on a domain whose DNS you control, so a
  public instance needs **its own domain** (for example
  `deploy.example.com`); a shared `*.workers.dev` or `*.pages.dev` hostname
  will not do.
- Use that same origin everywhere: the client URL, the redirect URL and
  `TAPDEPLOY_PUBLIC_ORIGIN`. Cloudflare's docs do not say whether the redirect
  URL must share the client URL's domain; keeping one origin avoids the
  question.

## 2. Create the client

Dashboard: **Manage Account → OAuth clients → Create client** (needs the
Super Administrator, Administrator or OAuth Client Write role).

| Field | Value |
|---|---|
| Client name | your instance name, e.g. `TapDeploy` |
| Response type | `code` |
| Grant type | Authorization Code |
| Token endpoint authentication | `client_secret_basic` (TapDeploy sends the secret with HTTP Basic and always uses PKCE `S256`) |
| Redirect URL | `https://<your-domain>/api/auth/callback`, exactly |
| Client URL (public clients) | `https://<your-domain>` |
| Scopes | see the table below; leave every scope **Required** |

Save the **Client ID** and **Client Secret** immediately: Cloudflare shows the
secret only once. Store them as Worker secrets or server environment values
(`TAPDEPLOY_OAUTH_CLIENT_ID`, `TAPDEPLOY_OAUTH_CLIENT_SECRET`), never in the
repository, a config file or a URL.

Do **not** mark scopes as optional. TapDeploy refuses a partial grant
(`scope_denied`) instead of asking a second time, so a declined scope only
turns into a failed install.

## 3. Scopes

Register on the client every scope the apps you want to serve may need;
TapDeploy has no scope setting of its own. For each install it requests only
the subset that the app's config needs. If that subset includes a scope the
client does not carry, Cloudflare refuses on its consent page
(`invalid_scope`) and TapDeploy tells the user the instance's client is
missing a permission.

| Dashboard name | Scope ID | Used for | Status in TapDeploy today |
|---|---|---|---|
| Workers Admin | `workers-scripts.admin` | every Worker install: scripts, versions, deployments, cron triggers, Durable Objects, Workflows, rate limits, Worker secrets, `workers.dev` | implemented, contract-tested |
| Pages Write | `page.write` | Pages projects and deployments (static sites) | implemented, contract-tested |
| D1 Write | `d1.write` | D1 databases | implemented, contract-tested |
| Workers KV Storage Write | `workers-kv-storage.write` | KV namespaces | implemented, contract-tested |
| Workers R2 Storage Write | `workers-r2.write` | R2 buckets | implemented, contract-tested |
| Queues Write | `queues.write` | queues, producers and consumers | implemented, contract-tested |
| Workers Routes Write | `workers-routes.write` | add-only zone routes | implemented, contract-tested, never run live |
| Zone Read | `zone.read` | listing the account's zones for custom domains and zone routes | implemented, contract-tested, run live once (local instance); **requested automatically** for every config with a Worker or Pages unit |
| DNS Write | `dns.write` | binding the operator's own hostname to a Worker or Pages site (Custom Domains, the Pages CNAME, replacing a record the operator confirmed) | implemented, contract-tested, run live once (local instance); **requested automatically** for every config with a Worker or Pages unit |
| Hyperdrive Write | `query-cache.write` | listing the account's Hyperdrive configurations; a Worker binds the one the operator picks | implemented (bind existing only), contract-tested |
| Vectorize Write | `vectorize.write` | binding an existing index, or creating one a resources unit declares with `dimensions` and `metric` | implemented, contract-tested, run live once (local instance) |
| Secrets Store Write | `secrets-store.write` | binding an existing secret of the account's Secrets Store (ordinary Worker secrets use Workers Admin) | implemented (bind existing only), contract-tested, run live once (local instance) |
| Workers AI Write | `ai.write` | the `ai` binding | implemented (binding only), contract-tested, run live once (local instance) |
| Browser Run Write | `browser-rendering.write` | the `browser` binding (Browser Rendering) | implemented (binding only), contract-tested, run live once (local instance) |

"Contract-tested" means proven with mocked provider HTTP; see
[release-status.md](../release-status.md) for what has run against a real
account. TapDeploy requests a scope only when the config needs it: the
declared capabilities, plus Zone Read and DNS Write whenever the config has a
Worker or Pages unit, so the operator can bind a domain at install time.
Because of that, a client that serves Worker or Pages apps **must register
`zone.read` and `dns.write`**. Registering all fourteen scopes above lets the
instance serve any app TapDeploy supports.

## 4. Check it

1. Deploy your instance ([Workers](workers.md) or [Node / Docker](node-docker.md)).
2. Open it, load a test config and choose **Sign in with Cloudflare**. The
   consent page must show your client name and only the scopes that config
   needs; after **Allow** you return to `https://<your-domain>/` signed in.
3. A wrong redirect URL fails at Cloudflare; a scope the client does not
   carry comes back as `invalid_scope` and is shown to the user.

Still to confirm in the live verification: that the consent page lists only
the requested subset when the client registers more scopes than a config needs.
