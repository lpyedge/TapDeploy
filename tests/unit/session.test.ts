import { describe, expect, it } from "vitest";
import {
  deriveSealKey,
  sealJson,
  openSeal,
} from "../../src/auth/keys.js";
import {
  createSession,
  readSession,
  sessionCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
  sessionCookieName,
  type SessionConfig,
} from "../../src/auth/session.js";

const cfg: SessionConfig = {
  ttlMs: 20 * 60 * 1000,
  publicOrigin: "https://installer.example",
  };

const PAYLOAD_SIZE_TARGET = 3500;

describe("seal/open roundtrip", () => {
  it("seals and opens a payload", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    const value = { hello: "world", n: 1 };
    const env = await sealJson(key, value);
    const out = await openSeal<typeof value>(key, env);
    expect(out).toEqual(value);
  });

  it("returns null when decrypting tampered ciphertext", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    const env = await sealJson(key, { x: 1 });
    const tampered = { ...env, ciphertext: env.ciphertext.slice(0, -2) + "AA" };
    expect(await openSeal(key, tampered)).toBeNull();
  });

  it("returns null on wrong version", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    const env = await sealJson(key, { x: 1 });
    expect(await openSeal(key, { ...env, version: "v9" as never })).toBeNull();
  });

  it("a key derived from another secret cannot open the seal", async () => {
    const env = await sealJson(await deriveSealKey("secret-a"), { x: 1 });
    expect(await openSeal(await deriveSealKey("secret-b"), env)).toBeNull();
    expect(await openSeal(await deriveSealKey("secret-a"), env)).toEqual({ x: 1 });
  });
});

describe("createSession / readSession", () => {
  it("creates a session and reads it back", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    const data = await createSession(key, cfg, {
      accessToken: "tok-123",
      tokenType: "Bearer",
      scope: ["Account:Read"],
      source: "client-123",
      accountId: "acct-1",
    });
    expect(data.payload.accessToken).toBe("tok-123");
    expect(data.payload.csrf).toBeTruthy();
    expect(data.payload.nonce).toBeTruthy();
    expect(data.payload.expiresAt).toBeGreaterThan(Date.now());

    const read = await readSession(key, data.cookieValue);
    expect(read?.accessToken).toBe("tok-123");
    expect(read?.accountId).toBe("acct-1");
  });

  it("returns null on an expired session", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    const data = await createSession(key, cfg, {
      accessToken: "tok",
      tokenType: "Bearer",
      scope: [],
      source: "client",
    });
    const now = data.payload.expiresAt + 1000;
    expect(await readSession(key, data.cookieValue, now)).toBeNull();
  });

  it("returns null on a tampered cookie", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    const data = await createSession(key, cfg, {
      accessToken: "tok",
      tokenType: "Bearer",
      scope: [],
      source: "client",
    });
    const tampered = data.cookieValue.slice(0, -2) + "AA";
    expect(await readSession(key, tampered)).toBeNull();
  });

  it("returns null on malformed cookie value", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    expect(await readSession(key, "not-json")).toBeNull();
  });

  it("returns null on a non-v1 payload", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    const env = await sealJson(key, { ...createPayload(), v: 2 });
    expect(await readSession(key, encodeURIComponent(JSON.stringify(env)))).toBeNull();
  });

  it("keeps a representative session cookie within the 3.5KB budget", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    // Representative big Cloudflare access token (~1KB) plus scope/claims.
    const bigToken = "AT".repeat(512);
    const data = await createSession(key, cfg, {
      accessToken: bigToken,
      tokenType: "Bearer",
      scope: ["Account:Read", "Workers Scripts:Read", "Workers R2 Storage:Write"],
      source: "client-123",
      accountId: "acct-123456789",
    });
    expect(data.encodedLength).toBeLessThanOrEqual(PAYLOAD_SIZE_TARGET);
  });
});

describe("cookie headers", () => {
  it("produces a hardened session cookie header", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    const data = await createSession(key, cfg, {
      accessToken: "tok",
      tokenType: "Bearer",
      scope: [],
      source: "client",
    });
    const header = sessionCookieHeader(sessionCookie(data, cfg));
    expect(header).toContain(`${sessionCookieName(cfg.publicOrigin)}=`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Priority=High");
    expect(header).toContain("Max-Age=1200");
  });

  it("omits Secure for non-https origins", async () => {
    const key = await deriveSealKey(crypto.randomUUID());
    const localCfg: SessionConfig = { ...cfg, publicOrigin: "http://localhost:8787" };
    const data = await createSession(key, localCfg, {
      accessToken: "tok",
      tokenType: "Bearer",
      scope: [],
      source: "client",
    });
    const header = sessionCookieHeader(sessionCookie(data, localCfg));
    expect(header).toContain("HttpOnly");
    expect(header).not.toContain("Secure");
  });

  it("clears the session cookie", () => {
    const header = clearSessionCookieHeader(cfg);
    expect(header).toContain(`${sessionCookieName(cfg.publicOrigin)}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
  });

  it("drops the __Host- prefix only on a plain-http (localhost) origin", () => {
    expect(sessionCookieName("http://localhost:8787")).toBe("tapdeploy_session");
    expect(sessionCookieName("https://installer.example")).toBe("__Host-tapdeploy_session");
  });
});

function createPayload() {
  return {
    v: 1,
    accessToken: "tok",
    tokenType: "Bearer",
    scope: [] as string[],
    expiresAt: Date.now() + 1000000,
    issuedAt: Date.now(),
    csrf: "x",
    nonce: "y",
    source: "client",
  };
}
