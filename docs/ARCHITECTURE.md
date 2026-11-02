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
| Config | One textarea (URL or JSON) and one button; `.json` can be dropped; `?config=` pre-fills and auto-submits once, taking priority over a previously stored config. Loading a config goes straight to Cloudflare consent (or straight into the flow when the session already covers that exact config); there is no Connect screen, and an expired session re-authorizes the same config directly. |
| Release | One page: the download link and a ZIP-from-this-computer drop zone (omitted when the config sets `allowLocalZip: false`). A chosen file wins and the link rests until it is removed; one Verify button. Prebuilt ZIPs only, at most 8 MiB (`RELEASE_MAX_BYTES`, one number for a chosen file, a direct download, the installer relay and the server check). The browser checks the ZIP first in a Worker (stage text, Cancel that terminates the Worker or aborts the call); the server then verifies the same bytes, and only that check issues the proof (section 3a). |
| Configure | Inline `New | Upgrade`. New: editable Worker name (pre-filled from the sealed release); a name that already exists is flagged with a switch to Upgrade. Upgrade: read-only dropdown of the account's Workers, manual entry if listing fails. Switching mode keeps the typed name. The server enforces the choice at plan time: New never updates a live Worker and Upgrade never creates one (`TARGET_MODE_CONFLICT`, zero writes). What must be answered (Worker name, required inputs, Hyperdrive) is always shown; everything optional (optional inputs and secret changes, resource names, custom domains) is a collapsed section that shows its current state and opens on demand, or stays open while it holds an error. Per Worker/Pages unit, an optional custom domain from the account's zones (`<sub>.<zone>`); replacing what serves a hostname today needs explicit consent; on Upgrade the bound hostnames are listed and one choice applies to them: keep (default), use another instead, or remove (unbinding needs consent). A release with Hyperdrive bindings requires picking one of the account's Hyperdrive configurations per binding. |
| Deploy | Review (effective names, create/update/preserve, cost, secrets) → confirm → inline progress → result card. |

Result card: every verified address is its own row, labelled (custom domain,
workers.dev, Pages site), and the custom domains the account says are bound to
what was deployed are listed too, so a domain an upgrade kept is not missing. A custom domain row keeps checking until the domain
serves, because Cloudflare answers the bind at once but DNS and the certificate
follow (a Pages domain reads `pending` for a few minutes): Pages domains by the
status the domains endpoint reports, Worker domains by an opaque HTTPS probe;
it says so while it waits and offers a re-check if the watch gives up. Without
any address the card lists the created identities and says why; a Cloudflare dashboard link is **always**
present. Every verified workers.dev address is retained for multi-Worker
releases. The dashboard link is derived from the approved plan's effective
Worker or Pages project name for any action (create, update, preserve) and falls
back to the account home. URLs are never invented. Every step has one primary
button whose enablement comes from the state machine plus input validation; the
stepper follows the machine stage. Account selection is locked after Release;
changing accounts starts a fresh flow. Planning locks configuration and Back,
and deployment marks itself running before the first async action and locks
exit/sign-out. A changed inventory query hides the previous Worker’s facts
until the new response arrives.

Worker name override: any valid name (`^[a-z0-9-]{1,63}$`, plus the declared
input's own validation when the config declares one) for a release with exactly
one Worker (a Worker plus Pages counts as one). With zero or several Workers the
release names are kept. Resource and Pages project names (`names` in the plan
request, `src/core/planning/resource-names.ts`): at install every R2 bucket,
D1 database (unless bound by id), queue and Vectorize index of the release, a
`resources` unit's KV namespace, and every Pages project, may be renamed; the
release's names are suggestions. The mapping is applied to the prepared units
and the config before any spec or graph exists. On upgrade the Configure step
sends the names the target Worker binds today (read from its settings) and the
plan's rebind guard refuses any other, except for resources whose config
entry says `upgradeKeep: false`: their bindings are marked `changeOnUpgrade`
and may move to another (or a new) resource. Service references never change.

Config shape: the JSON is the author-facing form; the planner works on
`plannedUnits(config)` (`src/manifest/config-v3.ts`): the Workers and Pages
units as declared (one implicit Worker at the ZIP root when `units` is omitted
and `resources` is set) plus one internal resource-only unit, id `resources`,
built from `resources`. Ordering between a Worker and a resource is derived
from the binding, so no dependency is declared.

Config inputs (`src/manifest/input-validation.ts`, shared by browser and
server): install asks for every input (`required` defaults true); upgrade asks
for the ones not marked `upgradeKeep`, and an empty value there keeps the
deployed one. The plan request is refused (`INVALID_INPUT`) for a value that is
missing at install, not asked on upgrade, or breaks the declared type and
`validation`; `validation.pattern` is the exception, applied in the browser only
(`inputPatternProblem`), because a publisher's regular expression can backtrack
exponentially and the server never evaluates one. Non-secret inputs are merged into the Worker's `vars` when the
specs are built, so the version upload and the postcheck treat them like
release variables; a key the release already sets is refused. On upgrade
`replaceSecrets` lists the secrets the user chose to change: their policy
becomes `replace`, the plan shows `secret: update`, and the new value rides in
the version upload instead of an inherit directive.

## 3. Sealed-graph protocol (do not weaken)

`prepare` (server verifies the ZIP bytes against the config the session was
authorized for and seals the result) → `plan` (server re-validates config,
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

## 3a. Browser compute: what it is and what it is not

The browser does real work, but none of it is authority.

- **Verification in a Dedicated Worker** (`src/web/compute/`). One Worker per
  release source runs `verifyPrebuiltRelease` (`src/release/verify-prebuilt-release.ts`),
  the same pure sequence `/api/deploy/prepare` runs (size, policy, unpack and
  lint, pin and origin checks, per-unit bundles), so a bad ZIP, a pin mismatch
  or an oversize file is refused before anything is uploaded, with the server's
  error code and detail. `releasePolicyFromConfigText` rebuilds the source policy
  from the config the user authorized. Cancel terminates the Worker; each run has
  a run number so a cancelled or replaced run can neither update the page nor
  install a source.
- **The Worker keeps the extracted files.** The page holds the original `Blob`
  (re-sent unchanged to `/prepare`, a `multipart/form-data` request with the
  config text, from which the server rebuilds the same source policy) and a narrow async `SourceAccessor`
  (`listFiles`, `readFile`, Worker-asset index/bytes by approved hash, Pages
  manifest/bytes by hash; fixed method names, no URL or arbitrary read). One
  live source per flow; it is released when replaced, removed or on unmount.
- **Hashing** (official Worker-asset hash, Pages BLAKE3) happens once per
  content in that Worker (per-source cache keyed by algorithm, content digest and
  exact extension). Pages BLAKE3 uses WebAssembly (`blake3-wasm`, pinned,
  same-origin asset, loaded only for a release that has a Pages unit, both for the
  browser-side verification and for the later manifest) and falls back to the
  pure-JS hash if WebAssembly is unavailable, blocked or fails on a call; the
  digest is identical either way and the server keeps its own JS hash. The app
  asks for no `unsafe-eval`. A browser without Worker support, or a Worker that
  dies (usually out of memory), gets a message that says so and what to try.
- **The server is unchanged as authority** (Stage 1, strict). `/prepare` still
  re-verifies every byte and issues `tapdeploy-verified-prebuilt-release/v1`; the
  browser's verdict is early feedback and is never submitted as a proof. The CPU
  moved onto the user's device is not removed from the server: measured locally,
  the strict `/prepare` route still takes hundreds of milliseconds for a release
  with large assets, so the Workers Free 10 ms CPU limit is **not cleared**
  (billed CPU is not measured). A trust change (for example a publisher-signed
  manifest) was researched and is not approved.
- **Worker static assets are unsupported.** Shared browser/server release verification rejects `assets.directory`; planning rejects older proofs, execution rejects older asset specs, and the direct relay refuses Worker uploads before reading the body. Plain Workers and static Pages remain supported.
- **Asset uploads** go browser → same-origin `POST /api/upload/assets` → three
  fixed Pages Cloudflare URLs with the short-lived upload JWT only. The relay
  authenticates and validates the request before it reads any body, counts and
  caps the bytes (16 MiB), drops a stalled sender, forwards the exact bytes and
  content type, and cancels the upstream request when the browser cancels. It is
  buffered after that point; streaming upstream is not enabled (not live
  verified). The browser retries a batch once after a transient failure (429,
  5xx, network), waiting for the provider's `Retry-After` or a short
  back-off (at most 10 s); 401/403 are never retried, and uploads are keyed by
  content hash, so a repeat is safe.
- **Dispatch order.** The plan response also carries non-secret
  `schedulerHints` (the unit dependency edges already sealed in the context).
  The driver uses them to avoid asking for work whose prerequisites are
  unfinished. The current plan must include valid hints covering every unit;
  missing/invalid hints are refused before dispatch, and a deadlock stops the
  run. There is no legacy dispatch path. The server still refuses
  (`GRAPH_DEPENDENCY_REQUIRED`) anything out of order. One
  aggregated `/step` per approved action; there is no generic fetch bridge
  (`tests/contracts/api-surface.test.ts` pins the route list).

## 4. OAuth model

Authorization is one-shot and bound to the exact config hash; scopes derive from
the config (`src/auth/scope-planner.ts`, `scope-registry.ts`). There is no scope
escalation: a different config needs a fresh authorization. A changed config
first calls the read-only `POST /api/auth/check-config`; covered configs go
straight to Release, others re-authorize; a plan/step `config_mismatch` (409)
returns the UI to the same panel. The config text lives only in the tab
(`sessionStorage`, 30 minutes); the server stores only its hash and the digest
of its source policy, never the policy itself, so both cookies stay far below the
browser's 4 KiB cookie limit for any valid config. Cookies, CSRF
and the redirect URI derive from the single trusted origin `PUBLIC_ORIGIN`.
The session and OAuth-transaction cookies are sealed with AES-GCM under a key
derived (HKDF) from the OAuth client secret; a session lasts at most 20 minutes
and never past the provider token it carries (`expires_in` minus 15 s; a token
that is already expiring ends the callback with `token_expired`). A provider
401 reaches the browser as 401 (sign in again for the same config), a provider
403 as 403 (the account lacks a permission: signing in again will not help),
and only a missing target is 404. *Sign out* (hidden while a deploy runs) calls
`/api/auth/logout`: the server revokes the provider token and clears the cookie.
The UI waits for this response before announcing sign-out; a failed request
keeps retry available. The
scopes requested are exactly the config's; the client registration is the
only upper bound (Cloudflare answers `invalid_scope` beyond it).

## 5. Code shape

```
src/api/routes/   HTTP boundary: auth, accounts (accounts, targets, domains, Hyperdrive list), deploy-prepare/plan/step, asset-upload, release-download (`read-bounded-body.ts`: the counted, deadline-limited body reader)
src/auth/         OAuth, tx, session, cookies, CSRF, scope ledger (single source of scope truth)
src/core/planning/ graph, units, unit-specs (release → sealed specs), request-inputs, plan + per-family planners (worker-resource-planners, rebind-guards, plan-domains), operation support (capability gate), digest, snapshot, drift, execution context
src/core/deploy/  step phases, bindings, secrets, postcheck, bootstrap, R2 privacy guard, domains, pages
src/cloudflare/   provider adapters (models, resources, assets, pages, client)
src/manifest/     config-v3 (contract), wrangler-v3 (normalization: schema, keys, resources)
src/release/      prebuilt ZIP unpack + safety lint, per-unit bundles, `verify-prebuilt-release.ts` (the verification sequence shared by `/prepare` and the browser Worker), artifact proof
src/web/          App.tsx (session + config entry), V3Flow.tsx (release → configure → deploy), the V3*Panel components, configure-model.ts / use-configure-form.ts (Configure state, pure plan request), v3-flow-machine.ts, graph-deploy-runner.ts (GraphDeployRunner)
src/runtime/      node.ts (:8787), workers.ts
```

- Frontend state: `V3FlowMachine` stages `release → configure → deploy → done`,
  explicit transition table, illegal jumps throw, upstream changes clear
  downstream caches, a mismatch returns to an empty `release`. `V3Flow` wires
  state to the panels; what the Configure step means (units, readiness, the plan
  request) is pure code in `configure-model.ts`.
- Deploy driver: `GraphDeployRunner` (stable entry `runGraphDeploy`) runs actions,
  then Worker postchecks, then Pages postchecks. A Worker deployment id never
  enters the Pages loop. `graph-scheduler.ts` validates `schedulerHints`
  (dispatch order only). "Stop after this step" aborts future actions, never
  the one in flight, and never rolls anything back.
- Browser compute: `src/web/compute/` (`client.ts` handles, `release.worker.ts`,
  `source-store.ts` accessor, `hash-cache.ts`, `pages-hasher.ts`, `protocol.ts`
  versioned messages, `release-policy.ts`, `refusal-message.ts`).
- Composition over inheritance; no deep class hierarchies.
- Config V3 is the only config format: any other shape is `invalid_config`, and
  a deploy step without the sealed execution context from `/api/deploy/plan` is
  refused before any provider call.

## 6. Resource rules (read before changing a provider path)

Worker: the release name, optionally overridden (section 2). Worker static
assets are disabled at prepare, plan, step and relay boundaries in both runtimes.
The existing format/hash code does not establish upload authority. Cloudflare
Workers Assets was observed serving bytes inconsistent with the submitted hash;
there is no supported browser-trust exception. Pages remains a separate path.
Cron: whole-set PUT with exact ordered
readback; an empty approved set preserves. KV: the id is a claim, lookup only,
never created from an id. D1: verified `database_id`; resource-only units may
ensure by name. R2: verified by name; private bootstrap is a guarded owner flow
(fresh/resume/upgrade, privacy proof, re-check before write). Queue: producer
binding rides the version, consumer registers after exact activation. Workflow:
carrier class must be an exported `WorkflowEntrypoint` subclass, bound by the
version, schedules read back. Durable Object: own-script class, binding plus the
single pure new-class migration (section 3). RateLimit: version metadata binding
only. workers.dev: only when the release declares `workers_dev: true`; the URL is
built from provider reads. Pages: static direct upload with hashed assets, each stored with the content
type of its extension (without one a browser downloads an HTML page; a hash
already stored keeps the type it was stored with);
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
disposable-account acceptance passes, the release stays not ready. The e2e suite
also runs against the built Node server and real workerd (`PW_RUNTIME=node|workers`),
where `tests/e2e/built-assets.spec.ts` checks that the compute Worker chunk and
the BLAKE3 WASM are served same-origin, validate, and ask for no `unsafe-eval`.

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
