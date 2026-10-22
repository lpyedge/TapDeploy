# Architecture

How TapDeploy is shaped and what it promises. Review a change against this
page and update it in the same change when behavior changes.

## 1. Product

A user installs or safely upgrades a publisher's **prebuilt** Worker/Pages
release from the browser: read an independent `tapdeploy.config.json`, authorize
Cloudflare once, choose a release (URL or local ZIP), choose install/upgrade and
resource identity, review the diff, deploy, verify bindings and health.

- Exactly two runtimes: Cloudflare Workers (API + static assets) and native
  Node. Docker/IIS/Apache/Nginx only host the Node build.
- No installer-owned database: the browser holds short-lived progress, the
  backend holds a sealed stateless OAuth session, Cloudflare is the only source
  of truth. No durable deployment ledger, no resident worker.

## 2. User journey (four steps, one Deploy page)

`Config → Release → Configure → Deploy` (review, progress and result all live on
the Deploy page; there is no separate Connect, progress or done page).

| Step | Contract |
|---|---|
| Config | One textarea (URL or JSON) and one button; `.json` can be dropped; `?config=` pre-fills and auto-submits once. Loading a config goes straight to Cloudflare consent (or straight into the flow when the session already covers that exact config); there is no Connect screen, and an expired session re-authorizes the same config directly. |
| Release | Inline segmented choice `Download URL | Local ZIP file`, one Prepare button; switching clears the other side. Prebuilt ZIPs only. |
| Configure | Inline `New | Upgrade`. New: editable Worker name (pre-filled from the sealed release); a name that already exists is flagged with a switch to Upgrade. Upgrade: read-only dropdown of the account's Workers, manual entry if listing fails. Switching mode keeps the typed name. The server enforces the choice at plan time: New never updates a live Worker and Upgrade never creates one (`TARGET_MODE_CONFLICT`, zero writes). Per Worker/Pages unit, an optional custom domain from the account's zones (`<sub>.<zone>`); replacing what serves a hostname today needs explicit consent; on Upgrade the bound hostnames are listed and can be unbound (with consent). A release with Hyperdrive bindings requires picking one of the account's Hyperdrive configurations per binding. |
| Deploy | Review (effective names, create/update/preserve, cost, secrets) → confirm → inline progress → result card. |

Result card: a verified public URL is the large link; without one it lists the
created identities and says why; a Cloudflare dashboard link is **always**
present. The dashboard link is derived from the approved plan's effective
Worker or Pages project name for any action (create, update, preserve) and falls
back to the account home. URLs are never invented. Every step has one primary
button whose enablement comes from the state machine plus input validation; the
stepper follows the machine stage.

Worker name override: any valid name (`^[a-z0-9-]{1,63}$`, plus the declared
input's own validation when the config declares one) for a release with exactly
one Worker (a Worker plus Pages counts as one). With zero or several Workers the
release names are kept. Pages project names and service references never change.

## 3. Sealed-graph protocol (do not weaken)

`prepare` (server seals the ZIP bytes) → `plan` (server re-validates config,
recomputes the hash, seals graph + context + approval) → `step` (server
re-verifies context, action, receipts and a fresh snapshot, performs the write,
reads the target back and seals a receipt).

- The browser never chooses units, actions, targets, versions or phases; a
  provider 2xx is not success, only an exact readback is (`GRAPH_READBACK_MISMATCH`).
- Receipts bind nonce, config hash, account, source policy, plan and context
  digests, unit, action, phase and state hash; they are re-verified against the
  live snapshot, so out-of-band changes invalidate them. Replaying a receipt is
  idempotent (`IDEMPOTENT_VERIFIED`) and writes nothing.
- **Pages, existing project**: a plan that preserves an existing project has no
  mutation and therefore no receipt. The dependent steps (`pages-register-assets`,
  `pages-deploy`) instead re-prove on every call that the project still has the
  sealed immutable id and ownership marker (`GRAPH_PROJECT_CONFLICT`) and that the
  baseline deployment is unchanged (`GRAPH_TARGET_STALE`), before any write. A
  fresh install still requires the verified project-create receipt.
- **Durable Object migrations**: only a single, pure new-class migration entry is
  supported. A multi-tag history, malformed entries or any rename/delete/transfer
  is refused at plan time (`UNSUPPORTED_MIGRATION_HISTORY`, `DO_MIGRATION_*`)
  before any provider call; the same pure validator re-checks at upload. TapDeploy never
  rewrites or squashes tags that may already be deployed.

## 4. OAuth model

Authorization is one-shot and bound to the exact config hash; scopes derive from
the config (`src/auth/scope-planner.ts`, `scope-registry.ts`). There is no scope
escalation: a different config needs a fresh authorization. A changed config
first calls the read-only `POST /api/auth/check-config`; covered configs go
straight to Release, others re-authorize; a plan/step `config_mismatch` (409)
returns the UI to the same panel. The config text lives only in the tab
(`sessionStorage`, 30 minutes); the server stores only its hash. Cookies, CSRF
and the redirect URI derive from the single trusted origin `PUBLIC_ORIGIN`.
The session and OAuth-transaction cookies are sealed with AES-GCM under a key
derived (HKDF) from the OAuth client secret; sessions last 20 minutes. The
scopes requested are exactly the config's; the client registration is the
only upper bound (Cloudflare answers `invalid_scope` beyond it).

## 5. Code shape

```
src/api/routes/   HTTP boundary: auth, accounts (accounts, targets, domains, Hyperdrive list), deploy-prepare/plan/step, asset-upload, release-download
src/auth/         OAuth, tx, session, cookies, CSRF, scope ledger (single source of scope truth)
src/core/planning/ graph, units, operation support (capability gate), digest, snapshot, drift, execution context
src/core/deploy/  step phases, bindings, secrets, postcheck, bootstrap, R2 privacy guard, domains, pages
src/cloudflare/   provider adapters (models, resources, assets, pages, client)
src/manifest/     config-v3 (contract), wrangler-v3 (normalization: schema, keys, resources)
src/release/      prebuilt ZIP unpack + safety lint, per-unit bundles, artifact proof
src/web/          App.tsx (V3 flow), v3-flow-machine.ts, graph-deploy-runner.ts (GraphDeployRunner), ConfigEntry, Shell
src/runtime/      node.ts (:8787), workers.ts
```

- Frontend state: `V3FlowMachine` stages `release → configure → deploy → done`,
  explicit transition table, illegal jumps throw, upstream changes clear
  downstream caches, a mismatch returns to an empty `release`. `V3Flow` is view
  code only.
- Deploy driver: `GraphDeployRunner` (stable entry `runGraphDeploy`) runs actions,
  then Worker postchecks, then Pages postchecks. A Worker deployment id never
  enters the Pages loop.
- Composition over inheritance; no deep class hierarchies.
- Config V3 is the only config format: any other shape is `invalid_config`, and
  a deploy step without the sealed execution context from `/api/deploy/plan` is
  refused before any provider call.

## 6. Resource rules (read before changing a provider path)

Worker: the release name, optionally overridden (section 2). Static assets:
register → browser upload → complete, completion JWT bound to the version upload,
the browser's hashes are never trusted. Cron: whole-set PUT with exact ordered
readback; an empty approved set preserves. KV: the id is a claim, lookup only,
never created from an id. D1: verified `database_id`; resource-only units may
ensure by name. R2: verified by name; private bootstrap is a guarded owner flow
(fresh/resume/upgrade, privacy proof, re-check before write). Queue: producer
binding rides the version, consumer registers after exact activation. Workflow:
carrier class must be an exported `WorkflowEntrypoint` subclass, bound by the
version, schedules read back. Durable Object: own-script class, binding plus the
single pure new-class migration (section 3). RateLimit: version metadata binding
only. workers.dev: only when the release declares `workers_dev: true`; the URL is
built from provider reads. Pages: static direct upload with hashed assets;
Functions (`_worker.js`, `functions/`) are refused at prepare. Routes: explicit
zone opt-in, unknown zones or duplicate patterns fail closed. Custom domains:
chosen only by the operator (a config with a Worker/Pages unit implies
`zone` + `dns`); the plan and the `reconcile-domains` step share one pure
decision (`src/core/deploy/custom-domains.ts`) re-made on live state; Workers
use the Custom Domains API, Pages a project domain plus its own proxied CNAME;
detach touches only this unit's binding. Platform bindings (Worker only):
Hyperdrive and Secrets Store secrets bind existing account objects and are
never created; Vectorize binds by index name and is created only by a
resources unit declaring `dimensions` + `metric`; `ai` and `browser` are
binding-only. A resource another unit of the same release creates is planned
as a `skip` in the binding unit, which waits for the creator's receipt.

## 7. What counts as green

`npm run lint`, `typecheck`, `build`, `test` and the Playwright suite on all
three runtimes (`vite`, `node`, `workers`) pass on the **current** source; mocks
must be shaped like the live provider (the fixture refuses a Pages project
without a production branch, an array `migrations` upload and a bare Workflow
class). A capability may be called supported only with route-level success and
forged-input failure tests. Offline green is never a live pass: until a
disposable-account acceptance passes, the release stays not ready.

## 8. Lessons that must not regress

| Symptom | Root cause | Rule |
|---|---|---|
| Every Worker deploy failed at postcheck | postcheck version id was always empty | accept only a version equal to the verified receipt's sealed version; keep success and forged-input tests |
| `GRAPH_PHASE_MISMATCH` after postcheck | Worker deployment id leaked into the Pages loop | only Pages-kind units contribute deployment ids; mocks return the real shape |
| `config_mismatch` after switching config | config text was lost across the redirect, no pre-check | `check-config` probe, re-authorize at submit, persist/restore, map 409 to the same panel |
| Review appeared skipped | the flow lacked a Configure stage and a stepper tied to the stage | stepper follows the machine; flow changes update e2e |
| Existing Pages project deadlocked | preserve has no receipt but dependents required one | fresh predicate for preserve (section 3), receipt for create |
| Multi-tag DO history failed after resources were created | the check ran only at version upload | validate at plan time with the same pure validator |
| Flaky e2e | two servers on one port; edits during a run | one run at a time; do not edit `src` while it runs |

## 9. Review checklist

- Server behavior changed: success and failure route tests, mocks shaped like the provider?
- Plan inputs changed: allowlist, server validation, single/multi-unit rules?
- UI flow changed: transition table, `can()` guard, stepper mapping, e2e?
- New route: CSRF/origin checked, no secret/token in responses or logs?
- Never: silently adopt foreign resources, invent URLs, escalate scopes, put
  secrets/tokens/`.env*` in archives or logs, commit or force-add generated
  output, hide a red test by reclassifying it.
