# What TapDeploy supports

**Status: not release-ready.** Everything below is covered by offline tests
with mocked Cloudflare APIs; the "Live" column says what has also run against
a real account. Hosting TapDeploy itself on Workers is being verified.

| Feature | What TapDeploy does | Live |
|---|---|---|
| Workers | create or upgrade (new version, then activation), ESM + Wasm modules, static assets, cron, `workers.dev`, rate limits | yes |
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

- Building source code: releases must be prebuilt (`UNCOMPILED_ENTRYPOINT`).
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
