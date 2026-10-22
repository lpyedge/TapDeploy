# Release status

**Not release-ready yet.** Two kinds of evidence are kept apart everywhere:

- **Live**: observed on a real Cloudflare account.
- **Contract-tested**: proven offline with mocked provider HTTP or a local
  simulator. A contract test is not a live pass.

## Current focus

**Cloudflare Workers hosting is being verified.** The end-to-end run (TapDeploy
deployed on Workers with its own domain and a real Cloudflare OAuth client,
then installing test releases) is in progress. Until its results are recorded
here, everything below that says "not verified" stays that way.

## Local gates

`typecheck`, `lint`, the Vitest suite and the Playwright suite against the
Vite, built Node and built Workers (`wrangler dev --local`) runtimes; CI runs
the same gates on every push ([development.md](development.md#continuous-integration)).
The Docker image builds, and its container reports healthy and serves the UI
and API ([deployment/node-docker.md](deployment/node-docker.md)).

## What is covered offline

- Sealed-graph execution through the real Hono route with mocked provider HTTP
  (`tests/contracts/graph-e2e-hono.test.ts` and the neighbouring `graph-*`
  suites); the provider fixture throws on any operation it does not model.
- Both ZIP sources (Local ZIP, pinned URL ZIP) through prepare/plan/step in
  the real browser UI with an intercepted API
  (`tests/e2e/prebuilt-ui-flow.spec.ts`), and over the real server-side
  verification (`tests/contracts/deploy-prepare.test.ts`): identical bytes give
  an identical archive identity; a wrong pin, tampered bytes or a missing pin
  issue no proof and make no outbound call.
- The GitHub release relay: allowlisted hosts only, every redirect hop
  re-checked, caller credentials never forwarded, size-bounded.
- The Workers-hosted OAuth/session contract through the real Worker entry:
  fail-closed configuration, bare-origin validation, hardened cookies, state
  and replay rejection, no token in session responses, CSRF-gated logout.
- Only Config V3 is accepted; other config shapes are `invalid_config`, and a
  step without the sealed plan context is refused.

## Live evidence

On 2026-10-21 an operator-run UI session against a real account, with the
installer running locally, deployed the common single-unit combinations
(plain Worker with secrets, upgrade adding storage, static assets, R2/D1/KV,
queue producer and consumer, cron with rate limit, Durable Object, Workflow, a
combined Worker, and a Pages site with redeploy) plus the typed refusals; six
defects were fixed afterwards. It ran against an earlier build.

On 2026-10-22 a local Node instance (real OAuth client, real account) drove the
browser UI headlessly through one three-unit release (resources unit + Worker
+ Pages site) and verified every result with independent API reads and HTTPS
requests:

- Install: a Vectorize index created by the resources unit (explicit
  dimensions and metric) and bound by the Worker; Worker bindings for Workers
  AI, Browser Rendering, D1, R2, a queue producer and Vectorize in the official
  shapes; Worker and Pages custom domains on the operator's zone, both serving
  over HTTPS.
- Upgrade: the bound domains were listed; one Pages domain was unbound (its
  CNAME removed) and another bound; a Secrets Store secret was bound from the
  account's own store (not the release's store id); a hostname used by the
  Pages CNAME was moved to the Worker after explicit confirmation.
- Defects found and fixed during the run: every upgrade of a Worker with a
  Secrets Store binding failed with `GRAPH_TARGET_STALE`; the result page
  showed a Pages per-deployment address instead of workers.dev / the
  production address / the bound custom domain.

Neither run used the hosted installer.

## What is NOT proven live

| Area | State |
|---|---|
| TapDeploy itself deployed on Workers (Static Assets + API) | verification in progress |
| Real Cloudflare OAuth on that origin (callback, cookies, logout) | verification in progress |
| Real Cloudflare OAuth and an install through a Docker instance | not verified |
| `?config=` one-click link and HTTPS/GitHub ZIP on the hosted installer | contract-tested only |
| Multi-Worker releases, private-R2 owner bootstrap, zone routes | contract-tested only; never run live |
| Operator-chosen custom domains, Vectorize, Secrets Store, Workers AI and Browser Rendering | run live once on a local Node instance; not on the hosted installer |
| Hyperdrive binding | contract-tested only; never run live |
| Workers Free plan for the hosted installer (10 ms CPU) | not measured; treat as unsupported |
| Billing behavior beyond observed plan limits | unverified |

Capability-level classification: [supported-resources.md](supported-resources.md).
Operator guides: [Cloudflare OAuth client](deployment/cloudflare-oauth.md),
[Workers](deployment/workers.md), [Node / Docker](deployment/node-docker.md).

## Scope

TapDeploy deploys to Cloudflare only. Other providers that offer an
authorized deployment API (for example Vercel) may be added later; none is
supported or partially implemented today.
