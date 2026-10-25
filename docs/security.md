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
- Asset bytes go from the browser through the installer's own origin
  (`POST /api/upload/assets`, because Cloudflare's API allows no browser calls)
  to four fixed Cloudflare URLs, under short-lived, project-scoped JWTs. The
  relay is not a general proxy: it needs a session and CSRF, validates the
  target, token, content type and account **before it reads any body**, caps and
  counts the bytes it then reads (16 MiB), drops a stalled sender, forwards the
  exact bytes, and never sees or forwards the OAuth token. The server verifies
  the approved manifest/set before creating versions or deployments. The API
  surface is a fixed list of typed operations (no generic fetch bridge). What the
  server does **not** verify is the uploaded asset bytes themselves: it only
  forwards them, and (measured on a real account, 2026-10-24) Cloudflare Workers
  Assets accepts and serves bytes that do not match the hash they were uploaded
  under, while Pages stores by content hash and leaves a forged hash missing. The
  sealed hashes bind the file set, not what the browser then sends.
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
