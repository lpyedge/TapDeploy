# Security model

## Trust boundaries

1. **Publisher bytes are untrusted code to deploy, never to run.** The ZIP is
   parsed, hashed, and planned — modules are never imported, evaluated, or
   built on the installer server, and no archive hook/script ever executes.
2. **The browser is untrusted for authority.** It does real work (it unpacks
   and checks the ZIP in a Worker, hashes assets, and warns early), but its
   verdict is advice: the server re-verifies the same bytes at `/prepare` and
   only that check issues the release proof. It selects which approved
   action to run and re-sends bytes, but every request is re-verified: sealed
   execution context, sealed plan approval, exact action/phase match,
   rehashed bytes, fresh provider ownership/drift/billing/privacy guards, and
   post-write readback. A content hash proves bytes did not change after
   approval; it never proves a release benign. Cloudflare permissions and
   your explicit confirmation carry that decision.
3. **The provider is the ground truth.** Snapshots are re-read before every
   mutation; receipts bind observed state, not 2xx responses. Outside changes
   (foreign cutover, redeploy, renamed resources) invalidate receipts and
   stop the graph instead of being adopted.

## What the installer will and will not do

- Never exposes the OAuth token to browser JavaScript (sealed HttpOnly
  cookie + CSRF; short-lived).
- The browser never calls `api.cloudflare.com` itself: the token never leaves
  the server, and Cloudflare's API sends no CORS headers anyway (a WebAssembly
  client would hit the same wall). So every Cloudflare read and write is a short
  Worker request, and anything that polls (the result page's domain watch) is
  kept to one read per check, spread out over time.
- Never puts secrets in URLs, logs, evidence, plans, tokens, or ZIPs.
  Prompt secrets (first install, or a replacement the user chose on upgrade)
  live only in the step that needs them;
  generated secrets (`generate`) are server-created; active secret values are never
  read back, only their names/types.
- Never auto-rolls back or deletes on failure. Partial progress is reported
  with sealed receipts; resumption only repeats unverified work.
- Never silently skips, downgrades, or falls back: unsupported operations,
  undeclared capabilities, unconfirmed costs, and ambiguous readbacks all
  block with typed errors and zero provider writes after the block point.
- Worker static-assets deployment is **UNSUPPORTED**, default fail-closed in
  both runtimes (`WORKER_ASSETS_UNSUPPORTED`). Shared browser/server verification
  refuses releases declaring Worker assets; planning refuses older proofs;
  execution refuses older sealed asset specs; the relay refuses Worker uploads
  before reading bytes or contacting Cloudflare. A hostile browser cannot bypass
  this by supplying its own hash, JWT, account or body. There is no override.
  Previous real-account evidence (2026-10-24) showed Cloudflare Workers Assets
  serving bytes that did not match the supplied hash. No server-authoritative
  upload authorization/byte verifier is implemented, so provider 2xx is not proof.
- Pages asset requests use three fixed same-origin relay targets, session/CSRF,
  bounded bodies (16 MiB), scoped JWTs and bounded upstream responses. Historical
  live evidence found forged Pages hashes missing at readback; current live
  verification is still required. Pages behavior does not establish Worker safety.
- The OAuth session never outlives its provider token: at most 20 minutes, and
  shorter when the token's `expires_in` is (minus a 15 s margin); a token that
  is already expiring creates no session (`token_expired`). A provider 401 is
  reported as 401 (sign in again for the same config), a provider 403 as 403
  (missing permission; re-signing in would not help), never as "not found".
- ZIP bombs, traversal, symlinks, oversize archives (8 MiB), secret files,
  uncompiled sources and `wrangler.toml` are rejected at the prepare boundary,
  before planning; the browser runs the same checks first so a bad file is
  refused before it is uploaded (advice only, the server check is the proof).
  Each entry is inflated to exactly the size its ZIP header declares and the
  decoder stops the moment it would exceed it, so a header that understates the
  content is refused (not truncated) and cannot make the installer inflate a bomb.
- Browser WebAssembly (BLAKE3 for Pages hashes) is a same-origin asset loaded
  only when needed; the app asks for no `unsafe-eval`, and if a deployment's CSP
  blocks WebAssembly (it would need `script-src 'wasm-unsafe-eval'`) the same hash
  is computed in plain JavaScript.
- A publisher-signed manifest that would let the server skip re-verification
  was researched and is **not** adopted: the release proof stays
  `tapdeploy-verified-prebuilt-release/v1`.

## Operator duties

Review the plan diffs, the account, and the paid-risk disclosure before
confirming. Treat a stopped deploy as live partial state: inspect Cloudflare
before retrying, and re-plan rather than forcing a stale approval.

## Sign-out contract

`POST /api/auth/logout` clears the browser session cookie after Origin/CSRF
validation even when provider revocation fails. JSON distinguishes
`providerRevocation: confirmed | unconfirmed | not_applicable` and
`localSessionCleared: true`; responses are `no-store`. Revocation waits at most
five seconds. Unconfirmed revocation is shown with a Dashboard management notice.
The stateless sealed session has no server-side revocation list: a previously
copied cookie can remain cryptographically valid until expiry; local sign-out
means clearing this browser's cookie, not invalidating every copy. Provider
revocation and real Cloudflare behavior require separate live verification.

## HTTP responses

All dynamic API responses, including errors and redirects, are `no-store`.
The shared Hono middleware also protects Node static responses. Workers static
responses use `src/web/public/_headers`, copied by Vite: Cloudflare does not apply
that file to Worker-generated API responses ([Workers headers documentation](https://developers.cloudflare.com/workers/static-assets/headers/)).
Both paths use `nosniff`, `no-referrer`, `DENY` and CSP with same-origin scripts
and workers, no objects/base/frame ancestors, and HTTPS connections for publisher
config/ZIP downloads. Inline styles are allowed for the existing React UI; inline
scripts and JavaScript eval are blocked. Only WASM compilation is allowed via
`wasm-unsafe-eval`; an operator policy blocking it can use the existing Pages
JavaScript hasher. Static responses revalidate with `no-cache`.
