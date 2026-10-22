// R2 privacy guard oracle.
//
// Provider interactions are exercised through the typed client with a stub
// recording fetcher (zero real network): the official read surfaces are
// managed r2.dev flag + custom domain list, and the guard must prove privacy
// by read-back — disabled+empty PASS; enabled FAIL; disabled+one custom
// domain FAIL; denied/empty/timeout UNKNOWN; same-name different jurisdiction
// blocked. Nothing in the module can arm a bootstrap, disable a public domain
// or write a secret (no such exports exist; pinned at the bottom).

import { describe, expect, it } from "vitest";

import {
  R2_PRIVACY_PROOF_MAX_AGE_MS,
  evaluateR2Privacy,
  gateR2Bootstrap,
  r2ProofIsFresh,
  type R2PrivacyFacts,
  type R2PrivacyRead,
} from "../../src/core/deploy/r2-private-guard.js";
import { readR2PrivacyFacts } from "../../src/cloudflare/resources/r2.js";
import { createCloudflareClient } from "../../src/cloudflare/client/index.js";
import type { CloudflareErrorKind } from "../../src/cloudflare/client/errors.js";

const ACCOUNT = "a".repeat(32);
const BUCKET = "media";
const READ_AT = 1_000_000;

const ok = <T,>(value: T): R2PrivacyRead<T> => ({ ok: true, value });
const err = <T = never,>(kind: CloudflareErrorKind): R2PrivacyRead<T> => ({ ok: false, kind });

function facts(overrides: Partial<R2PrivacyFacts> = {}): R2PrivacyFacts {
  return {
    accountId: ACCOUNT,
    bucketName: BUCKET,
    readAtMs: READ_AT,
    bucket: ok({ name: BUCKET }),
    managedDomain: ok({ domain: "pub-x.r2.dev", enabled: false }),
    customDomains: ok([]),
    ...overrides,
  };
}

// An exact-URL recording fetcher: every call is captured and answered by the
// supplied handler, so tests assert the URL family without any real network.
function recorder(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = input instanceof Request ? input.url : String(input);
    calls.push(new URL(href).pathname);
    return Promise.resolve(handler(new URL(href), init ?? {}));
  };
  return { fn, calls };
}

function envelope(result: unknown): Response {
  return Response.json({ success: true, result });
}

const bucketPath = `/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}`;
const managedPath = `${bucketPath}/domains/managed`;
const customPath = `${bucketPath}/domains/custom`;

describe("r2-private-guard — classification", () => {
  it("PASSes only with r2.dev disabled AND zero custom domains (read-back proof)", () => {
    const decision = evaluateR2Privacy(facts());
    expect(decision.state).toBe("PRIVATE_VERIFIED");
    expect(decision.reasons).toEqual([]);
    if (decision.state !== "PRIVATE_VERIFIED") throw new Error("unreachable");
    const proof = decision.proof;
    expect(Object.isFrozen(proof)).toBe(true);
    expect(proof).toEqual({
      proofKind: "r2-private-readback",
      state: "PRIVATE_VERIFIED",
      accountId: ACCOUNT,
      bucketName: BUCKET,
      jurisdiction: null,
      managedDomainEnabled: false,
      customDomainCount: 0,
      readAtMs: READ_AT,
    });
    // The proof is immutable: no caller can downgrade it after the fact.
    expect(() => {
      (proof as unknown as { bucketName: string }).bucketName = "other";
    }).toThrow(TypeError);
    expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
  });

  it("FAILs (refuses) when the managed r2.dev endpoint is enabled", () => {
    const decision = evaluateR2Privacy(
      facts({ managedDomain: ok({ domain: "pub-x.r2.dev", enabled: true }) }),
    );
    expect(decision.state).toBe("PUBLIC_EXPOSED");
    expect(decision.reasons.map((r) => r.code)).toEqual(["managed-domain-enabled"]);
    expect(decision.reasons[0]?.detail).toContain("never auto-disabled");
    const gate = gateR2Bootstrap(decision, READ_AT);
    expect(gate).toMatchObject({ allowed: false, state: "PUBLIC_EXPOSED", requiresRefresh: false });
  });

  it("FAILs even with r2.dev disabled when one custom domain is attached", () => {
    const decision = evaluateR2Privacy(
      facts({ customDomains: ok([{ domain: "cdn.example.com", enabled: true }]) }),
    );
    expect(decision.state).toBe("PUBLIC_EXPOSED");
    expect(decision.reasons.map((r) => r.code)).toEqual(["custom-domains-present"]);
    expect(decision.reasons[0]?.detail).toContain("cdn.example.com");
    expect(decision.reasons[0]?.detail).toContain("never auto-detached");
    expect(gateR2Bootstrap(decision, READ_AT).allowed).toBe(false);
  });

  it("treats denied / empty / timeout / absent reads as UNKNOWN — never private", () => {
    const cases: Array<[R2PrivacyFacts, string]> = [
      [facts({ bucket: err("not-found") }), "bucket-not-found"],
      [facts({ bucket: err("unauthorized") }), "read-failed"],
      [facts({ managedDomain: err("forbidden") }), "read-failed"],
      [facts({ managedDomain: err("invalid-response") }), "read-failed"],
      [facts({ managedDomain: err("network") }), "read-failed"],
      [facts({ customDomains: err("server") }), "read-failed"],
      [facts({ customDomains: err("invalid-response") }), "read-failed"],
    ];
    for (const [input, code] of cases) {
      const decision = evaluateR2Privacy(input);
      expect(decision.state).toBe("UNKNOWN");
      expect(decision.reasons.map((r) => r.code)).toEqual([code]);
      const gate = gateR2Bootstrap(decision, READ_AT);
      expect(gate.allowed).toBe(false);
      expect(gate.state).toBe("UNKNOWN");
      if (gate.allowed) throw new Error("unreachable");
      expect(gate.requiresRefresh).toBe(true);
    }
  });

  it("blocks a same-name bucket in a different (or unverifiable) jurisdiction", () => {
    const wrongJurisdiction = evaluateR2Privacy(
      facts({ jurisdiction: "eu", bucket: ok({ name: BUCKET, jurisdiction: "wnam" }) }),
    );
    expect(wrongJurisdiction.state).toBe("UNKNOWN");
    expect(wrongJurisdiction.reasons.map((r) => r.code)).toEqual(["jurisdiction-mismatch"]);

    const missingJurisdiction = evaluateR2Privacy(
      facts({ jurisdiction: "eu", bucket: ok({ name: BUCKET }) }),
    );
    expect(missingJurisdiction.state).toBe("UNKNOWN");
    expect(missingJurisdiction.reasons.map((r) => r.code)).toEqual(["jurisdiction-mismatch"]);

    const matchingJurisdiction = evaluateR2Privacy(
      facts({ jurisdiction: "eu", bucket: ok({ name: BUCKET, jurisdiction: "eu" }) }),
    );
    expect(matchingJurisdiction.state).toBe("PRIVATE_VERIFIED");
    if (matchingJurisdiction.state !== "PRIVATE_VERIFIED") throw new Error("unreachable");
    expect(matchingJurisdiction.proof.jurisdiction).toBe("eu");

    const mismatchedIdentity = evaluateR2Privacy(
      facts({ bucket: ok({ name: "other-bucket" }) }),
    );
    expect(mismatchedIdentity.state).toBe("UNKNOWN");
    expect(mismatchedIdentity.reasons.map((r) => r.code)).toEqual(["identity-mismatch"]);
  });

  it("gates writes on proof freshness (TOCTOU): stale proofs require a re-read", () => {
    const decision = evaluateR2Privacy(facts());
    if (decision.state !== "PRIVATE_VERIFIED") throw new Error("expected verified");
    const fresh = gateR2Bootstrap(decision, READ_AT);
    expect(fresh).toMatchObject({ allowed: true, state: "PRIVATE_VERIFIED" });
    if (!fresh.allowed) throw new Error("unreachable");
    expect(fresh.expiresAtMs).toBe(READ_AT + R2_PRIVACY_PROOF_MAX_AGE_MS);

    const atLimit = gateR2Bootstrap(decision, READ_AT + R2_PRIVACY_PROOF_MAX_AGE_MS);
    expect(atLimit.allowed).toBe(true);

    const stale = gateR2Bootstrap(decision, READ_AT + R2_PRIVACY_PROOF_MAX_AGE_MS + 1);
    expect(stale.allowed).toBe(false);
    if (stale.allowed) throw new Error("unreachable");
    expect(stale.requiresRefresh).toBe(true);
    expect(stale.state).toBe("PRIVATE_VERIFIED");
    expect(stale.reason).toContain("stale");

    // Clock skew (proof from the future) is not fresh either.
    expect(r2ProofIsFresh(decision.proof, READ_AT - 1)).toBe(false);
  });
});

describe("r2-private-guard — read-only adapter with stub fetcher (no network)", () => {
  it("reads the three surfaces via the allowlisted routes and verifies privacy", async () => {
    const { fn, calls } = recorder((url) => {
      if (url.pathname === bucketPath) {
        return envelope({ name: BUCKET, creation_date: "2026-01-01T00:00:00.000Z" });
      }
      if (url.pathname === managedPath) {
        return envelope({ domain: "pub-x.r2.dev", enabled: false });
      }
      if (url.pathname === customPath) {
        return envelope({ domains: [] });
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);

    const readFacts = await readR2PrivacyFacts(client, {
      accountId: ACCOUNT,
      bucketName: BUCKET,
      readAtMs: READ_AT,
    });
    expect(calls).toEqual([bucketPath, managedPath, customPath]);
    expect(readFacts.bucket).toEqual({ ok: true, value: { name: BUCKET } });
    expect(readFacts.managedDomain).toEqual({
      ok: true,
      value: { domain: "pub-x.r2.dev", enabled: false },
    });
    expect(readFacts.customDomains).toEqual({ ok: true, value: [] });

    const decision = evaluateR2Privacy(readFacts);
    expect(decision.state).toBe("PRIVATE_VERIFIED");
    expect(gateR2Bootstrap(decision, READ_AT).allowed).toBe(true);
  });

  it("classifies a disabled r2.dev with one read-back custom domain as PUBLIC_EXPOSED", async () => {
    const { fn } = recorder((url) => {
      if (url.pathname === bucketPath) {
        return envelope({ name: BUCKET, creation_date: "2026-01-01T00:00:00.000Z" });
      }
      if (url.pathname === managedPath) {
        return envelope({ domain: "pub-x.r2.dev", enabled: false });
      }
      if (url.pathname === customPath) {
        return envelope({
          domains: [{ domain: "cdn.example.com", enabled: true, zoneId: "z1" }],
        });
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const readFacts = await readR2PrivacyFacts(client, {
      accountId: ACCOUNT,
      bucketName: BUCKET,
      readAtMs: READ_AT,
    });
    expect(readFacts.customDomains).toEqual({
      ok: true,
      value: [{ domain: "cdn.example.com", enabled: true }],
    });
    expect(evaluateR2Privacy(readFacts).state).toBe("PUBLIC_EXPOSED");
  });

  it("turns an empty managed response into invalid-response => UNKNOWN", async () => {
    const { fn } = recorder((url) => {
      if (url.pathname === bucketPath) {
        return envelope({ name: BUCKET, creation_date: "2026-01-01T00:00:00.000Z" });
      }
      if (url.pathname === managedPath) {
        return envelope({});
      }
      if (url.pathname === customPath) {
        return envelope({ domains: [] });
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const readFacts = await readR2PrivacyFacts(client, {
      accountId: ACCOUNT,
      bucketName: BUCKET,
      readAtMs: READ_AT,
    });
    expect(readFacts.managedDomain).toEqual({ ok: false, kind: "invalid-response" });
    const decision = evaluateR2Privacy(readFacts);
    expect(decision.state).toBe("UNKNOWN");
    expect(gateR2Bootstrap(decision, READ_AT)).toMatchObject({ allowed: false, requiresRefresh: true });
  });

  it("turns denied and timed-out reads into UNKNOWN (scope shortfall / network)", async () => {
    const denied = recorder((url) => {
      if (url.pathname === bucketPath) {
        return envelope({ name: BUCKET, creation_date: "2026-01-01T00:00:00.000Z" });
      }
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 403 },
      );
    });
    const deniedClient = createCloudflareClient({
      accessToken: "tok",
      fetcher: denied.fn,
    }).withAccount(ACCOUNT);
    const deniedFacts = await readR2PrivacyFacts(deniedClient, {
      accountId: ACCOUNT,
      bucketName: BUCKET,
      readAtMs: READ_AT,
    });
    expect(deniedFacts.managedDomain).toEqual({ ok: false, kind: "forbidden" });
    expect(deniedFacts.customDomains).toEqual({ ok: false, kind: "forbidden" });
    expect(evaluateR2Privacy(deniedFacts).state).toBe("UNKNOWN");

    const timeout = recorder(() => {
      throw new Error("timed out");
    });
    const timeoutClient = createCloudflareClient({
      accessToken: "tok",
      fetcher: timeout.fn,
    }).withAccount(ACCOUNT);
    const timeoutFacts = await readR2PrivacyFacts(timeoutClient, {
      accountId: ACCOUNT,
      bucketName: BUCKET,
      readAtMs: READ_AT,
    });
    expect(timeoutFacts.bucket).toEqual({ ok: false, kind: "network" });
    expect(evaluateR2Privacy(timeoutFacts).state).toBe("UNKNOWN");
  });
});

describe("r2-private-guard — no arm / secret / public-toggle surface", () => {
  it("exports exactly the classification and gate functions (nothing can arm or write)", async () => {
    const guard = await import("../../src/core/deploy/r2-private-guard.js");
    expect(Object.keys(guard).sort()).toEqual([
      "R2_PRIVACY_PROOF_MAX_AGE_MS",
      "evaluateR2Privacy",
      "gateR2Bootstrap",
      "r2ProofIsFresh",
    ]);
  });
});
