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
| Custom domains | the user binds, replaces (with confirmation) or unbinds their own hostname on any Worker or Pages site | yes |
| Hyperdrive | bind an existing configuration the user picks | no |
| Several Workers with `services` bindings, zone routes, private-R2 owner bootstrap | supported | no |

"Live: yes" means it ran from a local instance against a real account
(2026-10-21/22), not yet from a hosted instance.

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
