# Security model

## Trust boundaries

1. **Publisher bytes are untrusted code to deploy, never to run.** The ZIP is
   parsed, hashed, and planned — modules are never imported, evaluated, or
   built on the installer server, and no archive hook/script ever executes.
2. **The browser is untrusted for authority.** It selects which approved
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
- Asset bytes travel browser→Cloudflare directly under short-lived,
  project-scoped JWTs; the OAuth token never leaves the server, and the
  server verifies the approved manifest/set before creating versions or
  deployments.
- ZIP bombs, traversal, symlinks, oversize archives, secret files,
  uncompiled sources and `wrangler.toml` are rejected at the prepare boundary,
  before planning.

## Operator duties

Review the plan diffs, the account, and the paid-risk disclosure before
confirming. Treat a stopped deploy as live partial state: inspect Cloudflare
before retrying, and re-plan rather than forcing a stale approval.
