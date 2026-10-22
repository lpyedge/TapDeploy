import { describe, expect, it } from "vitest";
import {
  generatePkce,
  sha256Base64Url,
  buildAuthorizeUrl,
  exchangeCode,
  revokeToken,
  verifyPkceChallenge,
  type OAuthConfig,
} from "../../src/auth/oauth.js";

const cfg: OAuthConfig = {
  clientId: "client-123",
  clientSecret: "secret-456",
  redirectUri: "https://installer.example/api/auth/callback",
  scopes: ["Account:Read", "Workers Scripts:Read"],
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PKCE", () => {
  it("generates a verifier and S256 challenge", async () => {
    const pkce = await generatePkce();
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(40);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.method).toBe("S256");
    expect(await verifyPkceChallenge(pkce.challenge, pkce.verifier)).toBe(true);
  });

  it("rejects a mismatched challenge", async () => {
    const pkce = await generatePkce();
    const other = await generatePkce();
    expect(await verifyPkceChallenge(pkce.challenge, other.verifier)).toBe(false);
  });
});

describe("sha256Base64Url", () => {
  it("returns base64url of sha256", async () => {
    const digest = await sha256Base64Url("hello");
    expect(digest).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(digest).not.toContain("+");
    expect(digest).not.toContain("/");
    expect(digest).not.toContain("=");
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds the Cloudflare authorize URL with all fields", async () => {
    const pkce = await generatePkce();
    const url = buildAuthorizeUrl(cfg, {
      state: "state-abc",
      nonce: "nonce-xyz",
      pkce,
      prompt: "login",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://dash.cloudflare.com");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("client-123");
    expect(parsed.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
    expect(parsed.searchParams.get("scope")).toBe("Account:Read Workers Scripts:Read");
    expect(parsed.searchParams.get("state")).toBe("state-abc");
    expect(parsed.searchParams.get("nonce")).toBe("nonce-xyz");
    expect(parsed.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("prompt")).toBe("login");
  });

  it("omits code_challenge when no PKCE is supplied", () => {
    const url = buildAuthorizeUrl(cfg, { state: "s", nonce: "n" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge")).toBeNull();
  });
});

describe("exchangeCode", () => {
  it("exchanges a code for an access token", async () => {
    const fetcher = async () =>
      jsonResponse({
        access_token: "tok-abc",
        token_type: "Bearer",
        scope: "Account:Read",
        expires_in: 3600,
      });
    const res = await exchangeCode(cfg, "code-1", "verifier-1", fetcher);
    expect(res.ok).toBe(true);
    expect(res.accessToken).toBe("tok-abc");
    expect(res.tokenType).toBe("Bearer");
    expect(res.scope).toEqual(["Account:Read"]);
    expect(res.expiresIn).toBe(3600);
  });

  it("sends code_verifier and Basic auth on the token request", async () => {
    let seen: { headers: Record<string, string>; body: string } | undefined;
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen = {
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      };
      return jsonResponse({ access_token: "tok" });
    };
    await exchangeCode(cfg, "code-1", "verifier-1", fetcher);
    expect(seen?.body).toContain("code_verifier=verifier-1");
    expect(seen?.body).toContain("code=code-1");
    expect(seen?.body).toContain("grant_type=authorization_code");
    expect(seen?.headers["Authorization"]).toBe(
      `Basic ${btoa("client-123:secret-456")}`,
    );
    expect(seen?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("reports an error payload from a non-2xx token response", async () => {
    const fetcher = async () =>
      jsonResponse({ error: "invalid_grant", error_description: "bad code" }, 400);
    const res = await exchangeCode(cfg, "bad", "v", fetcher);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toBe("bad code");
  });

  it("fails when access_token is missing", async () => {
    const fetcher = async () => jsonResponse({ token_type: "Bearer" });
    const res = await exchangeCode(cfg, "code", "v", fetcher);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("missing access_token");
  });

  it("returns ok:false when the network request throws", async () => {
    const fetcher = async () => {
      throw new Error("network down");
    };
    const res = await exchangeCode(cfg, "code", "v", fetcher);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/token request failed/);
  });
});

describe("revokeToken", () => {
  it("returns true on a 2xx revoke response", async () => {
    const fetcher = async () => new Response(null, { status: 200 });
    expect(await revokeToken(cfg, "tok", fetcher)).toBe(true);
  });

  it("returns false on a non-2xx revoke response", async () => {
    const fetcher = async () => new Response(null, { status: 400 });
    expect(await revokeToken(cfg, "tok", fetcher)).toBe(false);
  });

  it("returns false when the network request throws", async () => {
    const fetcher = async () => {
      throw new Error("down");
    };
    expect(await revokeToken(cfg, "tok", fetcher)).toBe(false);
  });
});
