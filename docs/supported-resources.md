# Supported resources and explicit limits

Capabilities are symbolic words in the V3 config (`workers`, `pages`, `r2`,
`d1`, `kv`, `queues`, `hyperdrive`, `vectorize`, `secrets-store`,
`workers-ai`, `browser-rendering`, `routes`, `dns`, `zone`, `workflows`,
`durable-objects`). The installer maps them to OAuth scopes in code; a
config can never author raw scopes. Anything the release resolves to that
the config did not declare fails the plan with
`DEVELOPER_SCOPE_UNDERDECLARED` — before any provider read.

## Verification status (read this before promising anything)

"Fully dispatched" below means implemented and contract-tested offline with
mocked provider HTTP; what has also run on a real account is listed in
[release-status.md](release-status.md).

| Class | Capabilities |
|---|---|
| Contract-tested offline; an earlier local-run report claims live success for the single-unit cases (historical, not part of this repository) | `workers` New/Upgrade, `pages` static, `r2`/`d1`/`kv`/`queues` bindings and queue consumers, cron + `ratelimits`, `durable-objects` (new-class), `workflows`, `secrets` inputs |
| Run live once on a local Node instance (2026-10-22, see release-status.md) | operator-chosen custom domains (bind, replace, unbind), `vectorize` (incl. creation by a resources unit), `secrets-store`, `workers-ai`, `browser-rendering` bindings |
| Contract-tested offline, never run live | multi-Worker releases with `services` edges, the private-R2 owner bootstrap, zone `routes` (needs a sandbox zone), `hyperdrive` bindings |
| Refused with a typed error before any write | everything under "Refused" below |
| Out of scope | any provider other than Cloudflare; building or compiling release code |

A release that depends on a row marked "never run live" works as far as the
offline contract goes; the installer does not claim more.

## Fully dispatched through the sealed graph

| Capability | Plan diffs | Step proof |
|---|---|---|
| `workers` | worker create/update, deployment create, schedule create/update | version binding+runtime readback; activation cutover check; postcheck `deployed` |
| `pages` | project create, static-assets create/update, deployment create | project/deploy readback; manifest bound to sealed hashes; postcheck terminal `success` |
| `r2` / `d1` / `kv` / `queues` | resource create (resource-only units) or Worker version binding | identity readback (`id` present, exactly one); version metadata readback |
| `queues` (consumer) | queue-consumer create/update on the queue's consumers subresource | consumer identity sealed in the receipt (id + delivering script) |
| `workflows` | workflow create/update | carrier class export proved at prepare; the exact binding is read back from the active version; the definition and direct schedules are applied via the Workflows API after cutover, then read back exactly |
| `durable-objects` | version binding (+ pure new-class migration, forwarded with the atomic upload) | own-script, exported class proved at prepare; every bound class covered by a pure new-class migration; version metadata read back |
| `ratelimits` | version binding only | official `{type:"ratelimit",namespace_id,simple}` read back from the version |
| `routes` | workers-route create (add-only) | the live route pattern is read back bound to this Worker in the declared zone |
| `services` (RPC) | dependency edges | dependent waits for dependency receipts; exact target verified |
| custom domains (`zone` + `dns`) | worker/pages custom-domain attach, update (confirmed replacement), detach (operator unbind) | the decision is re-made against live DNS and domain state at the step; the binding is read back afterwards |
| `hyperdrive` | Worker version binding to an existing configuration | `{type:"hyperdrive",id}` read back from the version |
| `vectorize` | index create (resources unit with `dimensions` + `metric`) or Worker version binding | index identity read back; `{type:"vectorize",index_name}` read back from the version |
| `secrets-store` | Worker version binding to an existing secret | `{type:"secrets_store_secret",store_id,secret_name}` read back from the version |
| `workers-ai` / `browser-rendering` | Worker version binding | `{type:"ai"}` / `{type:"browser"}` read back from the version |

## Custom domains

The **operator** (the person installing), not the publisher, chooses the
domain. Every config with a Worker or Pages unit makes the consent request
include Zone Read and DNS Write, and the Configure step offers, per HTTP unit:

- **Bind a domain**: pick one of the account's zones and type a subdomain
  (empty = the zone apex). An existing name is offered too; if it already
  serves something (DNS `A`/`AAAA`/`CNAME` records, or another Worker's
  Custom Domain) the operator must confirm that its current service may stop
  working, and the plan request carries that consent.
- **Upgrade**: the hostnames bound to the Worker / Pages project today are
  read from the account and listed; the operator can keep them, unbind any
  (with confirmation) or bind another.

Execution follows Cloudflare's documented behaviour:

- Worker: `PUT /accounts/{id}/workers/domains` creates the DNS record and the
  certificate. Confirmed conflicting records are deleted first, since an
  existing record blocks the Custom Domain.
- Pages: the hostname is registered on the project and a proxied `CNAME` to
  the project's `*.pages.dev` hostname is created.
- Unbind removes only this unit's own binding (and, for Pages, its own CNAME).
  A hostname bound to another Worker is never taken by a Pages site.

A publisher-declared `routes[].custom_domain: true` stays refused: the
hostname belongs to the installer's account, so only the operator picks it.

## Platform bindings

Declared in a Worker unit's `wrangler.jsonc` with the official Wrangler keys
and checked against the account at plan time. TapDeploy never creates a
Hyperdrive configuration, a Secrets Store or a store secret, because these
hold the installer's own credentials.

| Wrangler key | What TapDeploy does |
|---|---|
| `hyperdrive: [{ binding, id }]` | The Configure step lists the account's Hyperdrive configurations by name and the operator picks one per binding (without a pick, the release `id` is used if it exists in this account). Missing → the plan blocks with the binding named. `localConnectionString` is accepted and ignored (local dev only). |
| `vectorize: [{ binding, index_name }]` | Binds the existing index of that name. To have TapDeploy create it, declare it in a `resources` unit: `{ "kind": "vectorize", "name": "docs", "mode": "ensure", "dimensions": 384, "metric": "cosine" }` (`metric`: `cosine`, `euclidean` or `dot-product`). There is no default shape. |
| `secrets_store_secrets: [{ binding, store_id, secret_name }]` | Uses the store with that id if it exists in this account, else the account's only store. The secret must already exist there; otherwise the plan blocks and names it. |
| `ai: { binding }` | Workers AI binding. |
| `browser: { binding }` | Browser Rendering binding. |

All five are Worker-only: on a Pages unit they are refused at prepare
(`PLATFORM_BINDING_REQUIRES_WORKER`). The `remote` dev flag is refused rather
than ignored. The config must declare the matching capability
(`hyperdrive`, `vectorize`, `secrets-store`, `workers-ai`,
`browser-rendering`), else the plan fails with
`DEVELOPER_SCOPE_UNDERDECLARED`.

## Refused before any provider write (zero reads/writes)

- A publisher-declared custom hostname (`routes[].custom_domain: true`) and
  any DNS record the operator did not choose: domains are bound only through
  the operator's Configure-step choice (see "Custom domains").
- Cron schedules, queues, workflows, durable objects, or routes declared on a
  **Pages** release.
- Pages Functions material: a `_worker.js` at a structural root or a
  `functions/` source tree is refused at prepare with
  `PAGES_FUNCTIONS_UNSUPPORTED` — the sealed V3 release carries no worker
  bundle, so a Pages Functions release is never silently deployed static-only.
- The 2026 class-keyed `exports` workflow declaration: refused by the
  Wrangler parser (declare workflows through `workflows[]`).
- Destructive Durable Object history: any `renamed_classes`/`deleted_classes`
  migration, and `transferred_classes`, block the plan. Only pure new-class
  additions and the exact binding cover plan.
- Restructure-the-release errors surface as `UNSUPPORTED_GRAPH_OPERATION`
  (naming the feature) or a typed `INVALID_RELEASE_PROOF` detail, always before
  the first provider write.

## Cost and privacy posture

- Potentially billable operations are listed in the plan (`cost.operations`)
  and need explicit confirmation when `requiresConfirmation` is set; unknown
  costs block (`blockedUnknownCost`) until confirmed.
- Private R2 bootstrap without a provable owner/privacy posture is refused;
  public buckets, JWT rotation schemes, and `SETUP_ARMED`-style re-arming do
  not exist in this flow. The guarded owner bootstrap profile
  (`private-r2-owner-bootstrap/v1`) is executable: it validates the profile,
  re-reads live state, decides Fresh/Resume/Upgrade, and refuses on any
  ambiguous/denied/privacy-unproven state before the version upload.

## No delete execution path (one exception: unbinding a custom domain)

The graph dispatches only create/update/attach of approved actions;
`preserve` needs no dispatch, and `conflict`/unknown actions are blocked
before any write. The only `detach` is a custom domain the operator chose to
unbind (and confirmed) on upgrade; it removes this unit's own binding and
nothing else. Every other destructive change happens only through explicit
operator action in the Cloudflare dashboard, never through this installer.
Workers routes are add-only; an existing pattern is verified, never
rewritten.

## Transport and size ceilings

Prepare ZIP 8 MiB compressed / 24 MiB expanded / 1024 files / 8 MiB per file
/ 100× ratio / depth 16; Worker upload 128 modules within ~6 MiB decoded
(~8 MiB base64 envelope); module names ≤ 256 chars; Pages deploys ≤ 20,000
assets; asset-upload bodies ≤ 16 MiB; sealed release contexts ≤ 256 KiB,
phase receipts ≤ 16 KiB. Over anything: deterministic 4xx/413, zero writes
after the block point, no chunked retries.
