import type { Context, Hono } from "hono";
import type { AppEnv, TapDeployEnv } from "../app.js";
import { parseCookies } from "../../auth/cookies.js";
import {
  generatePkce,
  buildAuthorizeUrl,
  exchangeCode,
  revokeToken,
  type OAuthConfig,
} from "../../auth/oauth.js";
import { deriveSealKey, sealJson, openSeal } from "../../auth/keys.js";
import { randomBase64Url, randomHex } from "../../auth/crypto.js";
import {
  createSession,
  readSession,
  sessionCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
  sessionCookieName,
} from "../../auth/session.js";
import { validateCsrf, validateOrigin } from "../../auth/csrf.js";
import { cookieName } from "../../auth/cookies.js";
import {
  prepareOAuthTxRequest,
  verifyGrantedScopes,
  type OAuthTxRequest,
} from "../../auth/oauth-tx.js";
import {
  parseConfigV3Text,
  validateConfigV3Entry,
  computeConfigV3Id,
  type ConfigV3,
} from "../../manifest/config-v3.js";

const TX_TTL_MS = 20 * 60 * 1000;
const SESSION_TTL_MS = 20 * 60 * 1000;

interface AuthCfg {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  publicOrigin: string;
}

function resolveAuthConfig(env: TapDeployEnv): AuthCfg {
  const publicOrigin = env.PUBLIC_ORIGIN ?? "";
  return {
    clientId: env.OAUTH_CLIENT_ID ?? "",
    clientSecret: env.OAUTH_CLIENT_SECRET ?? "",
    redirectUri: `${publicOrigin}/api/auth/callback`,
    publicOrigin,
  };
}

// The value has already been reduced to its origin when it named one (a
// trailing `/` is fine, see canonicalOrigin); anything else is refused with
// the expected format.
const ORIGIN_FORMAT = "use scheme://host or scheme://host:port, e.g. https://deploy.example.com or https://deploy.example.com:8443 (a trailing / is fine; http only for localhost, e.g. http://localhost:8787)";

function validatePublicOrigin(origin: string): { ok: boolean; error?: string } {
  if (!origin) {
    return { ok: false, error: `PUBLIC_ORIGIN is required: ${ORIGIN_FORMAT}` };
  }
  let url: URL | undefined;
  try {
    url = new URL(origin);
  } catch {
    url = undefined;
  }
  if (!url || url.origin !== origin) {
    return { ok: false, error: `PUBLIC_ORIGIN "${origin}" is not in the expected format: ${ORIGIN_FORMAT}` };
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (isLocalhost && url.protocol === "http:")) {
    return { ok: true };
  }
  return { ok: false, error: `PUBLIC_ORIGIN "${origin}" must use https: ${ORIGIN_FORMAT}` };
}

function validateAuthConfig(cfg: AuthCfg): string | null {
  const issues: string[] = [];
  if (!cfg.clientId) {
    issues.push("OAUTH_CLIENT_ID is required");
  }
  if (!cfg.clientSecret) {
    issues.push("OAUTH_CLIENT_SECRET is required");
  }
  const originCheck = validatePublicOrigin(cfg.publicOrigin);
  if (!originCheck.ok && originCheck.error) {
    issues.push(originCheck.error);
  }
  return issues.length > 0 ? issues.join("; ") : null;
}

function oauthConfig(cfg: AuthCfg, scopes: string[] = []): OAuthConfig {
  return {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
    scopes,
  };
}

// HKDF derivation is async; cache the derived key per client secret.
const keyCache = new Map<string, Promise<CryptoKey>>();

export async function loadKey(env: TapDeployEnv): Promise<CryptoKey> {
  const secret = env.OAUTH_CLIENT_SECRET;
  if (!secret) {
    throw new Error("OAUTH_CLIENT_SECRET is required");
  }
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = deriveSealKey(secret);
    keyCache.set(secret, cached);
  }
  return cached;
}

export function attachAuthRoutes(app: Hono<AppEnv>, env: TapDeployEnv): void {
  app.post("/api/auth/start", async (c) => startHandler(c, env));
  app.get("/api/auth/callback", async (c) => callbackHandler(c, env));
  app.get("/api/auth/session", async (c) => sessionHandler(c, env));
  app.post("/api/auth/logout", async (c) => logoutHandler(c, env));
  app.post("/api/auth/check-config", async (c) => checkConfigHandler(c, env));
}

function isConfigV3Shape(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 3
  );
}

// The request may carry the config (the SAME config the pre-auth entry phase
// validated). When present, the OAuth transaction is config-bounded: it records
// the config digest, the derived scope set, targets/capabilities and modes, and
// the consent URL requests exactly those scopes. When absent,
// we fail closed (no raw unfettered global-only start in a config-first flow) —
// the browser must load a config before Cloudflare sign-in.
async function startHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const cfg = resolveAuthConfig(env);
  const configError = validateAuthConfig(cfg);
  if (configError) {
    return c.json({ error: configError }, 500);
  }

  // Config-bounded start: the config-first wizard must send the
  // config text; we refuse a raw, unfettered global-only start. Only Config V3
  // (`schemaVersion: 3`) exists; anything else is an invalid config.
  let rawText: string | undefined;
  try {
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
    rawText = body?.text;
  } catch {
    rawText = undefined;
  }
  if (typeof rawText !== "string" || rawText.trim() === "") {
    // Config-first: refuse to start OAuth without a config.
    return c.json({ error: "config_required" }, 400);
  }
  const parsed = parseConfigV3Text(rawText);
  if (!parsed.ok || !isConfigV3Shape(parsed.value)) {
    return c.json({ error: "invalid_config", issues: [{ field: "schemaVersion", message: "only a Config V3 (schemaVersion 3) is supported" }] }, 400);
  }
  const entry = validateConfigV3Entry(parsed.value);
  if (!entry.ok || !entry.config) {
    return c.json({ error: "invalid_config", issues: entry.errors.slice(0, 20) }, 400);
  }
  const config: ConfigV3 = entry.config;

  const key = await loadKey(env);

  const state = randomHex(24);
  const nonce = randomBase64Url(24);
  const pkce = await generatePkce();

  const tx = await prepareOAuthTxRequest(config, { state, nonce, verifier: pkce.verifier });

  const envelope = await sealJson(key, tx as unknown as Record<string, unknown>);
  const txName = cookieName("tapdeploy_oauth_tx", cfg.publicOrigin);
  const txCookie = `${txName}=${encodeURIComponent(JSON.stringify(envelope))}; Path=/; Max-Age=${TX_TTL_MS / 1000}; HttpOnly; SameSite=Lax${
    cfg.publicOrigin.startsWith("https://") ? "; Secure" : ""
  }`;

  const authorizeUrl = buildAuthorizeUrl(
    oauthConfig(cfg, tx.scopes),
    { state, nonce, pkce },
  );

  return c.json(
    { url: authorizeUrl, configHash: tx.configHash, scopes: tx.scopes },
    200,
    { "Set-Cookie": txCookie },
  );
}

async function callbackHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const cfg = resolveAuthConfig(env);
  const url = new URL(c.req.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    const err = sanitizeOAuthError(error);
    return redirect(c, `${cfg.publicOrigin}/?auth=error&error=${err}`);
  }

  const cookies = parseCookies(c.req.raw.headers.get("cookie"));
  const txName = cookieName("tapdeploy_oauth_tx", cfg.publicOrigin);
  const txRaw = cookies[txName];
  if (!txRaw) {
    return redirect(c, `${cfg.publicOrigin}/?auth=error&error=missing_tx`);
  }

  const key = await loadKey(env).catch(() => null);
  if (!key) {
    return redirect(c, `${cfg.publicOrigin}/?auth=error&error=server_error`);
  }
  let tx: OAuthTxRequest;
  try {
    tx = (await openSeal(
      key,
      JSON.parse(decodeURIComponent(txRaw)) as never,
    )) as OAuthTxRequest;
  } catch {
    return redirect(c, `${cfg.publicOrigin}/?auth=error&error=bad_tx`);
  }

  if (!tx || tx.state !== state) {
    return redirect(c, `${cfg.publicOrigin}/?auth=error&error=bad_state`);
  }
  if (tx.issuedAt + TX_TTL_MS < Date.now()) {
    return redirect(c, `${cfg.publicOrigin}/?auth=error&error=expired_tx`);
  }

  const exchanged = await exchangeCode(oauthConfig(cfg), code, tx.verifier);
  if (!exchanged.ok) {
    // Stable error code only: never reflect upstream raw detail into the URL.
    return redirect(c, `${cfg.publicOrigin}/?auth=error&error=exchange`);
  }

  // Config-bounded one-shot: the granted scope set must cover every
  // scope the config-derived envelope requested. If a necessary scope was
  // declined, block (do NOT silently re-auth or continue) and lead the user back
  // to a visible block. `scope` is optional in the token response; absent means
  // all requested were granted.
  const granted = exchanged.scope;
  const scopeCheck = verifyGrantedScopes(tx.scopes, granted);
  if (!scopeCheck.ok) {
    return redirect(c, `${cfg.publicOrigin}/?auth=error&error=scope_denied`);
  }

  const session = await createSession(key, { ttlMs: SESSION_TTL_MS, publicOrigin: cfg.publicOrigin }, {
    accessToken: exchanged.accessToken!,
    tokenType: exchanged.tokenType ?? "Bearer",
    scope: tx.scopes,
    source: cfg.clientId,
    configHash: tx.configHash,
    sourcePolicy: { ...tx.source, appId: tx.appId, units: tx.units },
  });
  const attrs = sessionCookie(session, { ttlMs: SESSION_TTL_MS, publicOrigin: cfg.publicOrigin });
  const setCookie = sessionCookieHeader(attrs);
  const clearTx = `${txName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${cfg.publicOrigin.startsWith("https://") ? "; Secure" : ""}`;

  // Two independent Set-Cookie values: comma-folding a single header makes the
  // browser treat them as one cookie. Append each separately so both round trip.
  const headers = new Headers();
  headers.set("Location", `${cfg.publicOrigin}/?auth=success`);
  headers.append("Set-Cookie", setCookie);
  headers.append("Set-Cookie", clearTx);

  return new Response("OK", { status: 302, headers });
}

async function sessionHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const cfg = resolveAuthConfig(env);
  const cookies = parseCookies(c.req.raw.headers.get("cookie"));
  const raw = cookies[sessionCookieName(cfg.publicOrigin)];
  if (!raw) {
    return c.json({ authenticated: false }, 200);
  }
  const key = await loadKey(env).catch(() => null);
  if (!key) {
    return c.json({ authenticated: false, error: "session key unavailable" }, 200);
  }
  const payload = await readSession(key, raw);
  if (!payload) {
    return c.json({ authenticated: false }, 200);
  }
  return c.json({
    authenticated: true,
    expiresAt: payload.expiresAt,
    issuedAt: payload.issuedAt,
    scope: payload.scope,
    accountId: payload.accountId,
    source: payload.source,
    csrf: payload.csrf,
    configHash: payload.configHash,
  });
}

// Read-only coverage probe for the sealed-graph flow: reports whether the
// caller's config text is the exact config this session's one-shot OAuth was
// granted for. The browser calls this BEFORE upload/prepare/plan so a changed
// config surfaces an explicit "start a new authorization" state instead of a
// late config_mismatch at the plan boundary. Fails closed (matches:false)
// when unauthenticated, and never mints, extends or re-scopes anything.
async function checkConfigHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const cfg = resolveAuthConfig(env);
  const cookies = parseCookies(c.req.raw.headers.get("cookie"));
  const raw = cookies[sessionCookieName(cfg.publicOrigin)];
  const csrf = c.req.header("x-tapdeploy-csrf");
  const origin = c.req.header("origin");
  const key = await loadKey(env).catch(() => null);
  const payload = key && raw ? await readSession(key, raw) : null;
  if (!payload) {
    return c.json({ ok: true, matches: false, reason: "unauthenticated" });
  }
  if (!validateOrigin(cfg.publicOrigin, origin) || !validateCsrf(payload, csrf)) {
    return c.json({ error: "csrf/origin check failed" }, 403);
  }
  let text: unknown;
  try {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    text = body?.text;
  } catch {
    text = undefined;
  }
  if (typeof text !== "string" || text.trim() === "") {
    return c.json({ ok: true, matches: false, reason: "config_required" });
  }
  let shape: unknown;
  try {
    shape = JSON.parse(text) as unknown;
  } catch {
    return c.json({ ok: true, matches: false, reason: "invalid_config", detail: "config is not valid JSON" });
  }
  if (!isConfigV3Shape(shape)) {
    return c.json({ ok: true, matches: false, reason: "invalid_config", detail: "only a Config V3 (schemaVersion 3) is supported" });
  }
  const parsed = parseConfigV3Text(text);
  if (!parsed.ok) {
    return c.json({ ok: true, matches: false, reason: "invalid_config", detail: parsed.issue.message });
  }
  const entry = validateConfigV3Entry(parsed.value);
  if (!entry.ok || !entry.config) {
    return c.json({ ok: true, matches: false, reason: "invalid_config", detail: entry.errors.slice(0, 5).map((e) => `${e.field} ${e.message}`).join("; ") });
  }
  const configHash = await computeConfigV3Id(entry.config);
  if (!payload.configHash || payload.configHash !== configHash) {
    return c.json({ ok: true, matches: false, reason: "config_mismatch" });
  }
  return c.json({ ok: true, matches: true });
}

async function logoutHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const cfg = resolveAuthConfig(env);
  const cookies = parseCookies(c.req.raw.headers.get("cookie"));
  const raw = cookies[sessionCookieName(cfg.publicOrigin)];
  const csrf = c.req.header("x-tapdeploy-csrf");
  const origin = c.req.header("origin");

  const key = await loadKey(env).catch(() => null);
  const payload = key && raw ? await readSession(key, raw) : null;

  const originOk = validateOrigin(cfg.publicOrigin, origin);
  const csrfOk = payload ? validateCsrf(payload, csrf) : true;
  if (!originOk || !csrfOk) {
    return c.json({ error: "csrf/origin check failed" }, 403);
  }

  if (payload?.accessToken) {
    await revokeToken(oauthConfig(cfg), payload.accessToken);
  }

  return c.text("OK", {
    status: 200,
    headers: {
      "Set-Cookie": clearSessionCookieHeader({ ttlMs: SESSION_TTL_MS, publicOrigin: cfg.publicOrigin }),
    },
  });
}

const KNOWN_OAUTH_ERRORS = new Set([
  "access_denied",
  "invalid_scope",
  "unauthorized_client",
  "server_error",
  "temporarily_unavailable",
]);

function sanitizeOAuthError(raw: string | null): string {
  if (raw && KNOWN_OAUTH_ERRORS.has(raw)) {
    return raw;
  }
  return "provider_error";
}

function redirect(c: Context<AppEnv>, to: string): Response {
  return c.text("Redirecting…", { status: 302, headers: { Location: to } });
}
