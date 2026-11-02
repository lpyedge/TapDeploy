import { sealJson, openSeal, type SealedEnvelope } from "./keys.js";
import { randomBase64Url } from "./crypto.js";
import { cookieName } from "./cookies.js";

export interface SessionPayload {
  v: 1;
  accessToken: string;
  tokenType: string;
  scope: string[];
  expiresAt: number;
  issuedAt: number;
  csrf: string;
  nonce: string;
  accountId?: string;
  source: string;
  // Digest of the authorized config's source policy (src/auth/oauth-tx.ts).
  // Only digests live in the cookie, which must stay under the browser's 4 KiB
  // limit for every valid config; /api/deploy/prepare rebuilds the policy from
  // the config text it receives.
  sourcePolicyDigest?: string;
  // the canonical SHA-256 of the config this one-shot OAuth was bound to
  //. A session that was created against a different/null config cannot be
  // reused for another config's deploy without re-authorization.
  configHash?: string;
}

export interface SessionData {
  payload: SessionPayload;
  envelope: SealedEnvelope;
  cookieValue: string;
  encodedLength: number;
}

export function sessionCookieName(publicOrigin: string): string {
  return cookieName("tapdeploy_session", publicOrigin);
}

export interface SessionConfig {
  ttlMs: number;
  publicOrigin: string;
}

// Margin kept between a session's end and the provider token's own expiry, so a
// slightly fast server clock cannot leave a session that outlives its token.
export const TOKEN_CLOCK_SKEW_MS = 15_000;

/**
 * Session lifetime for a freshly issued provider token: never longer than
 * `maxMs`, never past the token's own `expires_in` (minus the clock-skew margin).
 * An absent or malformed `expires_in` keeps the conservative `maxMs`; a token
 * that is already expired or about to be (nothing left after the margin) yields
 * null: there is no session worth building on it.
 */
export function sessionTtlMs(expiresInSeconds: unknown, maxMs: number): number | null {
  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)) return maxMs;
  const ttl = Math.min(maxMs, Math.floor(expiresInSeconds * 1000) - TOKEN_CLOCK_SKEW_MS);
  return ttl > 0 ? ttl : null;
}

export async function createSession(
  key: CryptoKey,
  cfg: SessionConfig,
  token: {
    accessToken: string;
    tokenType: string;
    scope: string[];
    source: string;
    accountId?: string;
    configHash?: string;
    sourcePolicyDigest?: string;
  },
): Promise<SessionData> {
  const now = Date.now();
  const payload: SessionPayload = {
    v: 1,
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    scope: token.scope,
    expiresAt: now + cfg.ttlMs,
    issuedAt: now,
    csrf: randomBase64Url(24),
    nonce: randomBase64Url(24),
    accountId: token.accountId,
    source: token.source,
    configHash: token.configHash,
    sourcePolicyDigest: token.sourcePolicyDigest,
  };
  const envelope = await sealJson(key, payload);
  const json = JSON.stringify(envelope);
  const cookieValue = encodeURIComponent(json);
  return {
    payload,
    envelope,
    cookieValue,
    encodedLength: cookieValue.length,
  };
}

export async function readSession(
  key: CryptoKey,
  cookieValue: string,
  now = Date.now(),
): Promise<SessionPayload | null> {
  let envelope: SealedEnvelope;
  try {
    envelope = JSON.parse(decodeURIComponent(cookieValue)) as SealedEnvelope;
  } catch {
    return null;
  }
  const payload = await openSeal<SessionPayload>(key, envelope);
  if (!payload) {
    return null;
  }
  if (payload.v !== 1) {
    return null;
  }
  if (payload.expiresAt <= now) {
    return null;
  }
  return payload;
}

export interface CookieAttrs {
  value: string;
  name: string;
  maxAgeSec: number;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Lax";
  priority?: "High";
}

export function sessionCookie(
  session: SessionData,
  cfg: SessionConfig,
): CookieAttrs {
  return {
    value: session.cookieValue,
    name: sessionCookieName(cfg.publicOrigin),
    maxAgeSec: Math.floor(cfg.ttlMs / 1000),
    path: "/",
    secure: cfg.publicOrigin.startsWith("https://"),
    httpOnly: true,
    sameSite: "Lax",
    priority: "High",
  };
}

export function sessionCookieHeader(attrs: CookieAttrs): string {
  let c = `${attrs.name}=${attrs.value}; Path=${attrs.path}; Max-Age=${attrs.maxAgeSec}; SameSite=${attrs.sameSite}`;
  if (attrs.secure) {
    c += "; Secure";
  }
  c += "; HttpOnly";
  if (attrs.priority) {
    c += `; Priority=${attrs.priority}`;
  }
  return c;
}

export function clearSessionCookieHeader(cfg: SessionConfig): string {
  const name = sessionCookieName(cfg.publicOrigin);
  let c = `${name}=; Path=/; Max-Age=0`;
  if (cfg.publicOrigin.startsWith("https://")) {
    c += "; Secure";
  }
  c += "; HttpOnly; SameSite=Lax";
  return c;
}
