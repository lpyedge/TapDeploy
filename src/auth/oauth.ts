import { toBase64Url, randomBytes } from "./crypto.js";

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export async function generatePkce(codeLength = 48): Promise<PkcePair> {
  const verifier = toBase64Url(randomBytes(codeLength));
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge, method: "S256" };
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>,
  );
  return toBase64Url(new Uint8Array(digest));
}

export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
  authBase?: string;
  tokenBase?: string;
  revokeBase?: string;
}

const DEFAULT_AUTH = "https://dash.cloudflare.com/oauth2/auth";
const DEFAULT_TOKEN = "https://dash.cloudflare.com/oauth2/token";
const DEFAULT_REVOKE = "https://dash.cloudflare.com/oauth2/revoke";

export interface AuthorizeParams {
  state: string;
  nonce: string;
  pkce?: PkcePair;
  prompt?: string;
}

export function buildAuthorizeUrl(cfg: OAuthConfig, params: AuthorizeParams): string {
  const url = new URL(cfg.authBase ?? DEFAULT_AUTH);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  if (params.pkce) {
    url.searchParams.set("code_challenge", params.pkce.challenge);
    url.searchParams.set("code_challenge_method", params.pkce.method);
  }
  if (params.prompt) {
    url.searchParams.set("prompt", params.prompt);
  }
  return url.toString();
}

export interface ExchangeResult {
  ok: boolean;
  accessToken?: string;
  tokenType?: string;
  scope?: string[];
  expiresIn?: number;
  status?: number;
  error?: string;
  raw?: Record<string, unknown>;
}

export async function exchangeCode(
  cfg: OAuthConfig,
  code: string,
  pkceVerifier?: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ExchangeResult> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", cfg.redirectUri);
  if (pkceVerifier) {
    body.set("code_verifier", pkceVerifier);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (cfg.clientSecret) {
    const basic = btoa(`${cfg.clientId}:${cfg.clientSecret}`);
    headers["Authorization"] = `Basic ${basic}`;
  }

  let res: Response;
  try {
    res = await fetcher(cfg.tokenBase ?? DEFAULT_TOKEN, {
      method: "POST",
      headers,
      body: body.toString(),
    });
  } catch (e) {
    return { ok: false, error: `token request failed: ${String(e)}` };
  }

  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: (raw["error_description"] as string) ?? (raw["error"] as string) ?? "token error",
      raw,
    };
  }

  const accessToken = raw["access_token"] as string;
  if (!accessToken) {
    return { ok: false, status: res.status, error: "missing access_token", raw };
  }
  if (raw["scope"] !== undefined && typeof raw["scope"] !== "string") return { ok: false, status: res.status, error: "invalid scope in token response" };
  const scope = typeof raw["scope"] === "string" ? raw["scope"].split(/\s+/).filter(Boolean) : undefined;

  return {
    ok: true,
    accessToken,
    tokenType: (raw["token_type"] as string) ?? "Bearer",
    scope,
    expiresIn: raw["expires_in"] as number | undefined,
    raw,
  };
}

export async function revokeToken(
  cfg: OAuthConfig,
  accessToken: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const body = new URLSearchParams();
  body.set("token", accessToken);
  body.set("token_type_hint", "access_token");
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (cfg.clientSecret) {
    headers["Authorization"] = `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`;
  }
  try {
    const res = await fetcher(cfg.revokeBase ?? DEFAULT_REVOKE, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers,
      body: body.toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
