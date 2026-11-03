# What TapDeploy supports

**Status: not release-ready.** Everything below is covered by offline tests
with mocked Cloudflare APIs; the "Live" column says what has also run against
a real account. Hosting TapDeploy itself on Workers is being verified.

| Feature | What TapDeploy does | Live |
|---|---|---|
| Workers | create or upgrade (new version, then activation), ESM + Wasm modules, cron, `workers.dev`, rate limits | yes |
| Worker static assets | `assets.directory`: disabled until server-authoritative upload integrity is implemented | **no** |
| Pages | static sites (project, assets, deployment) | yes |
| R2, D1, KV, Queues | create when missing (per config) or bind an existing one; queue consumers | yes |
| Durable Objects | own-script classes with a single new-class migration | yes |
| Workflows | binding, definition and schedules | yes |
| Vectorize | bind an index; create it from a `resources` unit with `dimensions` + `metric` | yes |
| Secrets Store | bind an existing secret (the release's store, else the account's only store) | yes |
| Workers AI, Browser Rendering | bindings | yes |
| Custom domains | the user binds, replaces (with confirmation) or unbinds their own hostname on any Worker or Pages site; the result page shows when it is live (a new domain can take a few minutes) | yes |
| Hyperdrive | bind an existing configuration the user picks | no |
| Several Workers with `services` bindings, zone routes, private-R2 owner bootstrap | supported | no |

"Live: yes" means it ran from a local instance against a real account
(2026-10-21/22), not yet from a hosted instance, and with the code of that day.

**Run live on the current build (2026-10-24, a disposable `tapdeploy-live-*` set):**
Worker and Pages install and upgrade from a local ZIP with the browser-Worker
check and WebAssembly Pages hashing, a custom domain, a four-Worker service-binding
chain in dependency order, preserved R2/D1/Queue/Vectorize/AI/Browser bindings,
the Pages asset relay, and forged-input refusals with unchanged provider state.

**Not live verified in the current build** (offline tests on Node and a local
workerd with Cloudflare's HTTP mocked only): a release downloaded from a GitHub
link, the Workers static-asset relay through the installer, creating R2/D1/KV/Queue
resources and Durable Objects/Workflows (earlier runs only), the session lifetime
against a real token expiry, and a streamed (rather than buffered) upload to Cloudflare, which
is not enabled (a direct probe on 2026-10-24 showed Cloudflare accepts a chunked
body on the Workers-assets and Pages upload endpoints). Cloudflare-side CPU and request metrics have not been measured:
on the Workers Free plan `prepare` is expected to exceed 10 ms CPU for any
release with large assets (see [self-hosting](self-hosting.md#3a-deploy-on-cloudflare-workers)).

**Release ZIP:** a local file, a GitHub release link (through the instance's
relay) or an HTTPS link that sends CORS headers, at most 8 MiB / 24 MiB expanded
(see [limits](publishing.md#limits)).

## How a deploy behaves

- **Plan first.** The user sees every create/update/bind, costs that may be
  billed (confirmation required) and anything refused, before any write.
- **Verified steps.** Each step re-reads the account, writes, then reads the
  result back; a change made by someone else in between stops the deploy.
- **No surprises.** No automatic rollback; nothing is deleted except a domain
  the user chose to unbind. Existing resources are reused, never replaced.
- **Names.** At install the user may rename every resource and Pages project
  (the release's names are suggestions); an upgrade keeps the resources the
  Worker is bound to, except those the config marks `upgradeKeep: false`.
- **TapDeploy never creates** Hyperdrive configurations, Secrets Stores or
  store secrets: they hold the user's own credentials.

## Refused before any write

- Building source code: releases must be prebuilt (`UNCOMPILED_ENTRYPOINT`). A
  Worker's `main` must be a built `.js`/`.mjs` module, so TypeScript, Python,
  Rust and other source entry points are not supported.
- Pages Functions (`_worker.js`, `functions/`) — `PAGES_FUNCTIONS_UNSUPPORTED`.
- Cron, queues, Workflows, Durable Objects, routes or platform bindings on a
  Pages site.
- A publisher-declared custom domain (`routes[].custom_domain`): only the
  user picks their domain.
- Renaming, deleting or transferring Durable Object classes, and migration
  histories with more than one tag.
- Anything the config's `capabilities` do not cover
  (`DEVELOPER_SCOPE_UNDERDECLARED`).
- Providers other than Cloudflare.

## When something goes wrong

Nothing is rolled back and nothing is deleted behind your back, so after a
failure the account holds exactly what the finished steps wrote. **Start over**
(*Deploy another release* on the result card): the new plan reads the account again, reuses
what the interrupted run already created and only does what is missing.

| What you see | Meaning | What to do |
|---|---|---|
| Sign-in expired, or "sign in again" | the session lasts at most 20 minutes (or the Cloudflare token's life) | sign in again for the same config; nothing is written before you confirm a new plan |
| "Cloudflare denied this action" (403) | the signed-in account lacks a permission the install needs | signing in again will not help: use an account with the right role |
| `invalid_scope` after sign-in | the instance's OAuth client lacks a permission this app needs | tell the instance operator ([self-hosting](self-hosting.md#1-register-a-cloudflare-oauth-client)) |
| `scope_denied` | you declined a permission the config needs | nothing was created; start the sign-in again and allow it |
| The ZIP is refused (`INVALID_PREBUILT_ZIP`, `SERVER_ZIP_VERIFY_LIMIT`, "does not match its declared size", `UNCOMPILED_ENTRYPOINT`, `PAGES_FUNCTIONS_UNSUPPORTED`, `SOURCE_POLICY_MISMATCH`) | the file breaks a [release rule](publishing.md#limits) or is not the release the publisher pinned | nothing was uploaded; get a fresh copy from the publisher's link |
| `TARGET_MODE_CONFLICT` | New install, but a Worker with that name exists (or Upgrade of one that does not) | switch to Upgrade, or choose another name; no write happened |
| "Not deployed by TapDeploy" on the review (`unmanaged-worker`) | the Worker was deployed another way (a Git repository, the dashboard or wrangler) | tick *Take over* to replace its code with this release; if a Git repository is connected (the Worker's Settings → Build), disconnect it first or its next push replaces the release again |
| "A secret needs a value" on the review | the plan creates a secret the Worker does not have yet (nothing to keep), and Configure could not tell beforehand | *Back to Configure*, enter it there, review again |
| `uncarriable-binding` on the review | the live Worker has a binding the new version cannot copy exactly (Analytics Engine, mTLS, …) and the release does not declare it | remove it from the Worker in the dashboard, or ask the publisher to declare it; nothing was written |
| `inherit-source-unavailable` | the live Worker's serving version could not be read exactly (traffic split across versions, or it changed meanwhile) | deploy one version to all traffic in the dashboard, then start over |
| `ROOT_MISSING` | the app keeps an Owner in its bucket, but the Worker lacks the root secret the config names (often a Worker deployed another way under a different secret name) | the publisher's `rootSecret` must match the deployed Worker; nothing was changed, and the secret is never reset |
| `INSPECT_FAILED` (guarded owner bootstrap) | a read of the Worker, its R2 bucket or the Owner record did not get a clear answer; the message ends with Cloudflare's reason or HTTP status | nothing was changed; try again, and report the status if it repeats |
| `unrelated-worker` | the Worker belongs to another TapDeploy app, or no single version serves it (split traffic, no active deployment) | choose another name, or deploy one version to all traffic in the dashboard; no write happened |
| Sending files fails with "rate limited" (429) or a Cloudflare 5xx | the installer already retried that upload once, waiting the time Cloudflare asked for (at most 10 s) | wait a minute and start over; files Cloudflare already stores are not sent again |
| Any other step fails with a Cloudflare 429/5xx | not retried automatically | wait, then start over |
| "Deployment did not complete", "Stopped at …" | a step failed or you pressed Stop; earlier steps stay live | check the dashboard link, then start over |
| "Still in progress at Cloudflare" | the Pages deployment is still building | open the dashboard link; start over once it settles |
| Success without an address | the release has no HTTP entry (cron, queue, Workflow) or no `workers.dev` name | the card lists what was created and the dashboard link; check it there |

**Signing out.** *Sign out* (top of the install page, not shown while a deploy
runs) asks Cloudflare to revoke the installer's token and clears the session.
Do it when you are done; otherwise the session ends by itself within 20 minutes.
