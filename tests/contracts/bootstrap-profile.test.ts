// contract-level oracle for the
// limited profile's read/verify surfaces, exercised through the real typed
// client with a stub recording fetcher (zero real network) and the real
// readiness HTTP semantics. All provider reads are GET-only; denied or
// unverified reads refuse — they are never read as "absent", and no arm
// binding can be planned for a public or unproven bucket.

import { describe, expect, it } from "vitest";

import {
  assessBootstrapPrivacy,
  bootstrapReadinessProblems,
  checkBootstrapRace,
  clientBootstrapRunner,
  decideBootstrapMode,
  fetchBootstrapReadiness,
  inspectBootstrapTarget,
  planBootstrapSecrets,
  validateBootstrapProfile,
} from "../../src/core/deploy/bootstrap-profile.js";
import {
  evaluateR2Privacy,
} from "../../src/core/deploy/r2-private-guard.js";
import { readR2PrivacyFacts } from "../../src/cloudflare/resources/r2.js";
import { createCloudflareClient } from "../../src/cloudflare/client/index.js";

const ACCOUNT = "a".repeat(32);
const SCRIPT = "owner-app";
const BUCKET = "media";
const READ_AT = 1_000_000;

const secretsPath = `/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`;
const bucketPath = `/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}`;
const managedPath = `${bucketPath}/domains/managed`;
const customPath = `${bucketPath}/domains/custom`;

function profile() {
  const result = validateBootstrapProfile({
    kind: "private-r2-owner-bootstrap/v1",
    unitId: "main",
    r2Binding: "R2_STORAGE",
    rootSecret: "JWT_SECRET",
    armSecret: "SETUP_ARMED",
    armValue: "yes",
    ownerKey: "auth/owner.json",
    markerKey: "auth/bootstrap-marker",
    initialPasswordKey: "auth/initial-owner-password.txt",
    readinessPath: "/api/auth/methods",
  } as never);
  if (!result.ok) throw new Error("profile should validate");
  return result.value;
}

function recorder(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ pathname: string; method: string }> = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href);
    calls.push({ pathname: url.pathname, method: (init?.method ?? "GET").toUpperCase() });
    return Promise.resolve(handler(url, init ?? {}));
  };
  return { fn, calls };
}

function envelope(result: unknown): Response {
  return Response.json({ success: true, result });
}

function clientWith(fn: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  return createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
}

describe("bootstrap profile — provider contract (typed client, stub fetcher)", () => {
  it("inspects a resumed install and proves privacy through official read-back only", async () => {
    const { fn, calls } = recorder((url) => {
      if (url.pathname === secretsPath) {
        return envelope([{ name: "JWT_SECRET", type: "secret_text" }]);
      }
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
    const client = clientWith(fn);

    const inspected = await inspectBootstrapTarget(
      clientBootstrapRunner(client, { objectExists: () => Promise.resolve(false) }),
      { workerName: SCRIPT, bucketName: BUCKET, profile: profile() },
    );
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value).toMatchObject({ workerExists: true, hasRoot: true, bucketExists: true });

    const decided = decideBootstrapMode(inspected.value);
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.value.mode).toBe("resume");

    const privacyFacts = await readR2PrivacyFacts(client, {
      accountId: ACCOUNT,
      bucketName: BUCKET,
      readAtMs: READ_AT,
    });
    const proof = assessBootstrapPrivacy(evaluateR2Privacy(privacyFacts), READ_AT);
    expect(proof.ok).toBe(true);
    if (!proof.ok) return;

    const before = inspected.value;
    const again = await inspectBootstrapTarget(
      clientBootstrapRunner(client, { objectExists: () => Promise.resolve(false) }),
      { workerName: SCRIPT, bucketName: BUCKET, profile: profile() },
    );
    if (!again.ok) throw new Error("re-inspect should succeed");
    expect(checkBootstrapRace(before, again.value, "resume").ok).toBe(true);

    const plan = planBootstrapSecrets({
      profile: profile(),
      mode: "resume",
      existingSecretNames: again.value.workerExists ? ["JWT_SECRET"] : [],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.value.uploaded).toEqual(["SETUP_ARMED"]);
      expect(plan.value.create).toEqual([{ type: "secret_text", name: "SETUP_ARMED", text: "yes" }]);
    }

    // Read-only throughout: the exact URL sequence and GET-only methods.
    expect(calls.map((call) => call.pathname)).toEqual([
      secretsPath,
      bucketPath,
      bucketPath,
      managedPath,
      customPath,
      secretsPath,
      bucketPath,
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("refuses a denied Worker-secret read instead of assuming 'no Worker'", async () => {
    const { fn, calls } = recorder((url) => {
      if (url.pathname === secretsPath) {
        return Response.json(
          { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
          { status: 403 },
        );
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const client = clientWith(fn);
    const inspected = await inspectBootstrapTarget(clientBootstrapRunner(client), {
      workerName: SCRIPT,
      bucketName: BUCKET,
      profile: profile(),
    });
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) {
      expect(inspected.refusal.code).toBe("INSPECT_FAILED");
      expect(inspected.refusal.detail).toContain("Could not check the Worker");
    }
    expect(calls).toEqual([{ pathname: secretsPath, method: "GET" }]);
  });

  it("keeps R2 object existence UNVERIFIED_OAUTH by default (never 'no Owner check')", async () => {
    const { fn, calls } = recorder((url) => {
      if (url.pathname === secretsPath) {
        return envelope([]);
      }
      if (url.pathname === bucketPath) {
        return envelope({ name: BUCKET, creation_date: "2026-01-01T00:00:00.000Z" });
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const client = clientWith(fn);
    const inspected = await inspectBootstrapTarget(clientBootstrapRunner(client), {
      workerName: SCRIPT,
      bucketName: BUCKET,
      profile: profile(),
    });
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.refusal.code).toBe("UNVERIFIED_OAUTH");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("refuses arming when read-back privacy is public or unknown (zero writes)", async () => {
    const { fn, calls } = recorder((url) => {
      if (url.pathname === bucketPath) {
        return envelope({ name: BUCKET, creation_date: "2026-01-01T00:00:00.000Z" });
      }
      if (url.pathname === managedPath) {
        return envelope({ domain: "pub-x.r2.dev", enabled: true });
      }
      if (url.pathname === customPath) {
        return envelope({ domains: [] });
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const client = clientWith(fn);
    const privacyFacts = await readR2PrivacyFacts(client, {
      accountId: ACCOUNT,
      bucketName: BUCKET,
      readAtMs: READ_AT,
    });
    const proof = assessBootstrapPrivacy(evaluateR2Privacy(privacyFacts), READ_AT);
    expect(proof.ok).toBe(false);
    if (!proof.ok) expect(proof.refusal.code).toBe("PRIVATE_PROOF_FAILED");

    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("bootstrap profile — readiness endpoint contract", () => {
  it("calls the app's own /api/auth/methods and reports not-ready states", async () => {
    const urls: string[] = [];
    const pending = await fetchBootstrapReadiness(
      (url) => {
        urls.push(url);
        return Promise.resolve(
          Response.json({ setup: "pending", methods: { password: { enabled: false } } }),
        );
      },
      { origin: "https://owner-app.example.workers.dev", readinessPath: "/api/auth/methods" },
    );
    expect(urls).toEqual(["https://owner-app.example.workers.dev/api/auth/methods"]);
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const problems = bootstrapReadinessProblems({
      methods: pending.methods,
      ownerExists: true,
      credentialExists: true,
      firstSetup: true,
      ownerKey: "auth/owner.json",
      initialPasswordKey: "auth/initial-owner-password.txt",
    });
    expect(problems.length).toBe(2);
    expect(problems.join(" ")).toContain('"pending"');
    expect(problems.join(" ")).toContain("not enabled");
  });
});
