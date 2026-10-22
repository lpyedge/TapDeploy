// The limited built-in install profile `private-r2-owner-bootstrap/v1`. No
// provider calls here — the decision semantics are exercised against facts/fakes, and the version-upload merge is exercised
// through the real prepareSecretBindings with a fake step context. Secret
// VALUES are never asserted in reports: the canary only proves a generated
// value stays inside the upload bindings.

import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_PROFILE_KIND,
  DEFAULT_BOOTSTRAP_READINESS_PATH,
  assessBootstrapPrivacy,
  bootstrapReadinessProblems,
  bootstrapRetrievalSteps,
  checkBootstrapRace,
  clientBootstrapRunner,
  decideBootstrapMode,
  fetchBootstrapReadiness,
  inspectBootstrapTarget,
  parseBootstrapDirective,
  planBootstrapSecrets,
  validateBootstrapProfile,
  BootstrapObjectReadUnverifiedError,
  type BootstrapRunner,
  type BootstrapTargetFacts,
} from "../../src/core/deploy/bootstrap-profile.js";
import {
  evaluateR2Privacy,
  type R2PrivacyFacts,
} from "../../src/core/deploy/r2-private-guard.js";
import { prepareSecretBindings } from "../../src/core/deploy/secrets.js";
import type { DeployStepContext } from "../../src/core/deploy/steps.js";

const ACCOUNT = "a".repeat(32);
const BUCKET = "media";
const SCRIPT = "owner-app";
const READ_AT = 1_000_000;

function rawPolicy(overrides: Record<string, unknown> = {}) {
  return {
    kind: BOOTSTRAP_PROFILE_KIND,
    unitId: "main",
    r2Binding: "R2_STORAGE",
    rootSecret: "JWT_SECRET",
    armSecret: "SETUP_ARMED",
    armValue: "yes",
    ownerKey: "auth/owner.json",
    markerKey: "auth/bootstrap-marker",
    initialPasswordKey: "auth/initial-owner-password.txt",
    readinessPath: "/api/auth/methods",
    ...overrides,
  };
}

function profile() {
  const result = validateBootstrapProfile(rawPolicy() as never);
  if (!result.ok) throw new Error(`profile should validate: ${result.refusal.detail}`);
  return result.value;
}

function facts(overrides: Partial<BootstrapTargetFacts> = {}): BootstrapTargetFacts {
  return {
    workerExists: false,
    hasRoot: false,
    hasLegacySetupPassword: false,
    bucketExists: false,
    ownerExists: false,
    markerExists: false,
    ...overrides,
  };
}

function privacyFacts(overrides: Partial<R2PrivacyFacts> = {}): R2PrivacyFacts {
  return {
    accountId: ACCOUNT,
    bucketName: BUCKET,
    readAtMs: READ_AT,
    bucket: { ok: true, value: { name: BUCKET } },
    managedDomain: { ok: true, value: { domain: "pub-x.r2.dev", enabled: false } },
    customDomains: { ok: true, value: [] },
    ...overrides,
  };
}

function fakeRunner(options: {
  calls?: string[];
  secrets?: string[] | null;
  bucket?: boolean;
  owner?: boolean;
  marker?: boolean;
  objectError?: Error;
}): BootstrapRunner {
  const calls = options.calls ?? [];
  return {
    async secretNames(workerName) {
      calls.push(`secretNames:${workerName}`);
      return options.secrets ?? null;
    },
    async bucketExists(bucketName) {
      calls.push(`bucketExists:${bucketName}`);
      return options.bucket ?? false;
    },
    async objectExists(bucketName, key) {
      calls.push(`objectExists:${bucketName}:${key}`);
      if (options.objectError) throw options.objectError;
      return key === profile().ownerKey ? options.owner === true : options.marker === true;
    },
  };
}

function stepCtx(options: {
  secrets?: Record<string, string>;
  secretNames?: string[];
  activeVersion?: string;
  r2?: Array<{ binding: string; bucketName: string }>;
} = {}) {
  const activeVersion = options.activeVersion;
  return {
    spec: {
      cloudflare: {
        secrets: Object.fromEntries(
          Object.entries(options.secrets ?? {}).map(([name, policy]) => [name, policy]),
        ),
        r2: options.r2 ?? [],
        d1: [],
        kv: [],
        queues: [],
        hyperdrive: [],
        vectorize: [],
        secretsStore: [],
        runtimeBindings: [],
      },
      wrangler: { vars: {} },
      assets: [],
    },
    snapshot: {
      secretNames: options.secretNames ?? [],
      activeDeploymentVersionIds: activeVersion ? [activeVersion] : [],
      activeBindings: activeVersion
        ? (options.secretNames ?? []).map((name) => ({ name, type: "secret_text" }))
        : undefined,
    },
  } as unknown as DeployStepContext;
}

function verifiedDirective() {
  const decision = evaluateR2Privacy(privacyFacts());
  const proof = assessBootstrapPrivacy(decision, READ_AT);
  if (!proof.ok) throw new Error("expected a private proof");
  return {
    profile: profile(),
    mode: "fresh" as const,
    bucketName: BUCKET,
    privacyProof: proof.value,
  };
}

describe("bootstrap profile — validation and limited state table", () => {
  it("validates the profile fields and defaults the readiness path", () => {
    const ok = validateBootstrapProfile(rawPolicy() as never);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.readinessPath).toBe("/api/auth/methods");

    const noPath = validateBootstrapProfile(rawPolicy({ readinessPath: undefined }) as never);
    expect(noPath.ok).toBe(true);
    if (noPath.ok) expect(noPath.value.readinessPath).toBe(DEFAULT_BOOTSTRAP_READINESS_PATH);

    const cases: Array<Record<string, unknown>> = [
      { kind: "other/v1" },
      { armValue: "true" },
      { ownerKey: "../escape.json" },
      { ownerKey: "a//b" },
      { markerKey: "auth/bootstrap-marker/" },
      { rootSecret: "SETUP_ARMED" },
      { markerKey: "auth/owner.json" },
      { readinessPath: "https://evil.example/x" },
      { readinessPath: "//evil.example/x" },
      { unknownField: 1 },
    ];
    for (const override of cases) {
      const result = validateBootstrapProfile(rawPolicy(override) as never);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe("INVALID_PROFILE");
    }
  });

  it("decides fresh/resume/upgrade and refusals exactly like the reference protocol", () => {
    const cases: Array<[BootstrapTargetFacts, string]> = [
      [facts(), "fresh"],
      [facts({ workerExists: true, bucketExists: true }), "fresh"],
      [facts({ hasRoot: true, bucketExists: true }), "resume"],
      [facts({ workerExists: true, hasRoot: true, bucketExists: true, ownerExists: true }), "upgrade"],
      [facts({ bucketExists: true, ownerExists: true }), "ROOT_MISSING"],
      [facts({ bucketExists: true, markerExists: true }), "RECOVERY_REQUIRED"],
      [facts({ workerExists: true, bucketExists: false }), "BUCKET_MISSING"],
      [facts({ hasRoot: true, bucketExists: false }), "BUCKET_MISSING"],
    ];
    for (const [input, expected] of cases) {
      const result = decideBootstrapMode(input);
      if (expected === "fresh" || expected === "resume" || expected === "upgrade") {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.mode).toBe(expected);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.refusal.code).toBe(expected);
      }
    }
  });

  it("inspects in reference order and reads objects only when the bucket exists", async () => {
    const absentCalls: string[] = [];
    const absent = await inspectBootstrapTarget(
      fakeRunner({ calls: absentCalls, secrets: null, bucket: false }),
      { workerName: SCRIPT, bucketName: BUCKET, profile: profile() },
    );
    expect(absent.ok).toBe(true);
    expect(absentCalls).toEqual([`secretNames:${SCRIPT}`, `bucketExists:${BUCKET}`]);

    const presentCalls: string[] = [];
    const present = await inspectBootstrapTarget(
      fakeRunner({ calls: presentCalls, secrets: ["JWT_SECRET"], bucket: true, owner: false, marker: true }),
      { workerName: SCRIPT, bucketName: BUCKET, profile: profile() },
    );
    expect(presentCalls).toEqual([
      `secretNames:${SCRIPT}`,
      `bucketExists:${BUCKET}`,
      `objectExists:${BUCKET}:auth/owner.json`,
      `objectExists:${BUCKET}:auth/bootstrap-marker`,
    ]);
    expect(present.ok).toBe(true);
    if (present.ok) {
      expect(present.value).toEqual({
        workerExists: true,
        hasRoot: true,
        hasLegacySetupPassword: false,
        bucketExists: true,
        ownerExists: false,
        markerExists: true,
      });
      const decided = decideBootstrapMode(present.value);
      expect(decided.ok).toBe(false);
      if (!decided.ok) expect(decided.refusal.code).toBe("RECOVERY_REQUIRED");
    }
  });

  it("turns every inspection failure into a refusal, never 'absent'", async () => {
    const failing: BootstrapRunner = {
      async secretNames() {
        throw new Error("403 denied\nsecond-line that is dropped");
      },
      async bucketExists() {
        return false;
      },
      async objectExists() {
        return false;
      },
    };
    const refused = await inspectBootstrapTarget(failing, {
      workerName: SCRIPT,
      bucketName: BUCKET,
      profile: profile(),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("INSPECT_FAILED");
      expect(refused.refusal.detail).toContain("Could not check the Worker");
      expect(refused.refusal.detail).not.toContain("second-line");
      expect(refused.refusal.detail.length).toBeLessThanOrEqual(280);
    }

    const unverified = await inspectBootstrapTarget(
      fakeRunner({ bucket: true, objectError: new BootstrapObjectReadUnverifiedError("no grant") }),
      { workerName: SCRIPT, bucketName: BUCKET, profile: profile() },
    );
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) {
      expect(unverified.refusal.code).toBe("UNVERIFIED_OAUTH");
      expect(unverified.refusal.detail).toContain("never treated as absent");
    }
  });
});

describe("bootstrap profile — proof gate, race, secret planning", () => {
  it("arms only with a fresh PRIVATE_VERIFIED proof", () => {
    const verified = assessBootstrapPrivacy(evaluateR2Privacy(privacyFacts()), READ_AT);
    expect(verified.ok).toBe(true);

    const exposed = assessBootstrapPrivacy(
      evaluateR2Privacy(privacyFacts({ managedDomain: { ok: true, value: { domain: "pub-x.r2.dev", enabled: true } } })),
      READ_AT,
    );
    expect(exposed.ok).toBe(false);
    if (!exposed.ok) {
      expect(exposed.refusal.code).toBe("PRIVATE_PROOF_FAILED");
      expect(exposed.refusal.detail).toContain("never auto-disabled");
    }

    const unknown = assessBootstrapPrivacy(
      evaluateR2Privacy(privacyFacts({ customDomains: { ok: false, kind: "forbidden" } })),
      READ_AT,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.refusal.code).toBe("STATE_UNKNOWN");

    const stale = assessBootstrapPrivacy(evaluateR2Privacy(privacyFacts()), READ_AT + 60_001);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.refusal.code).toBe("PRIVATE_PROOF_FAILED");
      expect(stale.refusal.detail).toContain("stale");
    }
  });

  it("detects parallel installs and prewrite drift as RACE_DETECTED", () => {
    const before = facts({ bucketExists: true });
    const after = facts({ bucketExists: true, hasRoot: true });
    const raced = checkBootstrapRace(before, after, "fresh");
    expect(raced.ok).toBe(false);
    if (!raced.ok) expect(raced.refusal.code).toBe("RACE_DETECTED");

    const markerAppeared = checkBootstrapRace(before, facts({ bucketExists: true, markerExists: true }), "fresh");
    expect(markerAppeared.ok).toBe(false);
    if (!markerAppeared.ok) expect(markerAppeared.refusal.code).toBe("RACE_DETECTED");

    const stable = checkBootstrapRace(before, facts({ bucketExists: true }), "fresh");
    expect(stable.ok).toBe(true);

    // Changed privacy between inspect and write still refuses at the gate.
    const flip = assessBootstrapPrivacy(
      evaluateR2Privacy(
        privacyFacts({ customDomains: { ok: true, value: [{ domain: "cdn.example.com", enabled: false }] } }),
      ),
      READ_AT,
    );
    expect(flip.ok).toBe(false);
    if (!flip.ok) expect(flip.refusal.code).toBe("PRIVATE_PROOF_FAILED");
  });

  it("plans root once on fresh, arms with the upload, keeps root on resume, never upgrades secrets", () => {
    const CANARY = "CANARY_ROOT_VALUE_9f3";
    const fresh = planBootstrapSecrets({
      profile: profile(),
      mode: "fresh",
      existingSecretNames: [],
      generateRoot: () => CANARY,
    });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      expect(fresh.value.create).toEqual([
        { type: "secret_text", name: "JWT_SECRET", text: CANARY },
        { type: "secret_text", name: "SETUP_ARMED", text: "yes" },
      ]);
      expect(fresh.value.uploaded).toEqual(["JWT_SECRET", "SETUP_ARMED"]);
      // The generated value lives only inside the upload binding, never in a
      // report: `uploaded` carries names only.
      expect(JSON.stringify(fresh.value.uploaded)).not.toContain(CANARY);
    }

    const freshAgain = planBootstrapSecrets({
      profile: profile(),
      mode: "fresh",
      existingSecretNames: ["JWT_SECRET"],
    });
    expect(freshAgain.ok).toBe(false);
    if (!freshAgain.ok) expect(freshAgain.refusal.code).toBe("STATE_UNKNOWN");

    const resume = planBootstrapSecrets({
      profile: profile(),
      mode: "resume",
      existingSecretNames: ["JWT_SECRET"],
    });
    expect(resume.ok).toBe(true);
    if (resume.ok) {
      expect(resume.value.create).toEqual([{ type: "secret_text", name: "SETUP_ARMED", text: "yes" }]);
      expect(resume.value.uploaded).toEqual(["SETUP_ARMED"]);
    }

    const resumeWithoutRoot = planBootstrapSecrets({
      profile: profile(),
      mode: "resume",
      existingSecretNames: [],
    });
    expect(resumeWithoutRoot.ok).toBe(false);
    if (!resumeWithoutRoot.ok) expect(resumeWithoutRoot.refusal.code).toBe("STATE_UNKNOWN");

    const resumeArmed = planBootstrapSecrets({
      profile: profile(),
      mode: "resume",
      existingSecretNames: ["JWT_SECRET", "SETUP_ARMED"],
    });
    expect(resumeArmed.ok).toBe(true);
    if (resumeArmed.ok) expect(resumeArmed.value.create).toEqual([]);

    const upgrade = planBootstrapSecrets({
      profile: profile(),
      mode: "upgrade",
      existingSecretNames: ["JWT_SECRET", "SETUP_ARMED"],
    });
    expect(upgrade.ok).toBe(true);
    if (upgrade.ok) {
      expect(upgrade.value.create).toEqual([]);
      expect(upgrade.value.uploaded).toEqual([]);
    }
  });

  it("keeps the secret canary out of readiness problems and retrieval steps", () => {
    const CANARY = "CANARY_ROOT_VALUE_9f3";
    const problems = bootstrapReadinessProblems({
      methods: { setup: "ready", methods: { password: { enabled: true } } },
      ownerExists: true,
      credentialExists: true,
      firstSetup: true,
      ownerKey: "auth/owner.json",
      initialPasswordKey: "auth/initial-owner-password.txt",
    });
    expect(problems).toEqual([]);
    const steps = bootstrapRetrievalSteps({
      siteUrl: "https://app.example.workers.dev",
      bucketName: BUCKET,
      initialPasswordKey: "auth/initial-owner-password.txt",
    });
    const serialized = JSON.stringify({ problems, steps });
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("JWT_SECRET");
    expect(serialized).toContain("auth/initial-owner-password.txt");
  });
});

describe("bootstrap profile — readiness and directive parsing", () => {
  it("is not ready when the sign-in status is pending, disabled or unreadable", () => {
    const base = {
      methods: { setup: "ready", methods: { password: { enabled: true } } },
      ownerExists: true,
      credentialExists: true,
      firstSetup: false,
      ownerKey: "auth/owner.json",
      initialPasswordKey: "auth/initial-owner-password.txt",
    };
    expect(bootstrapReadinessProblems(base)).toEqual([]);
    const pending = bootstrapReadinessProblems({ ...base, methods: { setup: "pending", methods: { password: { enabled: true } } } });
    expect(pending.join(" ")).toContain('the setup state is "pending"');
    const disabled = bootstrapReadinessProblems({ ...base, methods: { setup: "ready", methods: { password: { enabled: false } } } });
    expect(disabled.join(" ")).toContain("not enabled");
    const unreadable = bootstrapReadinessProblems({ ...base, methods: null });
    expect(unreadable.join(" ")).toContain("could not be read");
    const missingOwner = bootstrapReadinessProblems({ ...base, ownerExists: false });
    expect(missingOwner.join(" ")).toContain("auth/owner.json");
    const firstSetupMissing = bootstrapReadinessProblems({ ...base, firstSetup: true, credentialExists: false });
    expect(firstSetupMissing.join(" ")).toContain("auth/initial-owner-password.txt");
    expect(bootstrapReadinessProblems({ ...base, firstSetup: true, credentialExists: false }).length).toBe(1);
  });

  it("fetches readiness on the deployed origin only; failures are unreadable", async () => {
    const urls: string[] = [];
    const ready = await fetchBootstrapReadiness(
      (url) => {
        urls.push(url);
        return Promise.resolve(Response.json({ setup: "ready", methods: { password: { enabled: true } } }));
      },
      { origin: "https://app.example.workers.dev", readinessPath: "/api/auth/methods" },
    );
    expect(urls).toEqual(["https://app.example.workers.dev/api/auth/methods"]);
    expect(ready.ok).toBe(true);

    const denied = await fetchBootstrapReadiness(
      () => Promise.resolve(new Response("nope", { status: 503 })),
      { origin: "https://app.example.workers.dev", readinessPath: "/api/auth/methods" },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.detail).toContain("HTTP 503");

    const network = await fetchBootstrapReadiness(
      () => Promise.reject(new Error("timeout")),
      { origin: "https://app.example.workers.dev", readinessPath: "/api/auth/methods" },
    );
    expect(network.ok).toBe(false);

    const foreign = await fetchBootstrapReadiness(
      () => Promise.resolve(Response.json({})),
      { origin: "https://app.example.workers.dev", readinessPath: "https://evil.example/x" },
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.detail).toContain("must stay on the deployed Worker origin");
  });

  it("parses the step-arg directive strictly and re-validates the proof", () => {
    const valid = parseBootstrapDirective(verifiedDirective());
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.mode).toBe("fresh");
      expect(valid.value.profile.rootSecret).toBe("JWT_SECRET");
    }

    const bad: unknown[] = [
      { ...verifiedDirective(), mode: "install" },
      { ...verifiedDirective(), extra: 1 },
      { ...verifiedDirective(), privacyProof: undefined },
      { ...verifiedDirective(), bucketName: "other-bucket" },
      {
        ...verifiedDirective(),
        privacyProof: { ...verifiedDirective().privacyProof, state: "PUBLIC_EXPOSED" },
      },
      {
        ...verifiedDirective(),
        privacyProof: { ...verifiedDirective().privacyProof, managedDomainEnabled: true },
      },
    ];
    for (const value of bad) {
      const result = parseBootstrapDirective(value);
      expect(result.ok).toBe(false);
    }
  });
});

describe("bootstrap profile — version-upload merge (no standalone secret PUT)", () => {
  it("merges fresh root + arm bindings into the same version upload", () => {
    const result = prepareSecretBindings(stepCtx(), {}, verifiedDirective());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings).toHaveLength(2);
    expect(result.bindings[0]).toMatchObject({ type: "secret_text", name: "JWT_SECRET" });
    expect(result.bindings[1]).toEqual({ type: "secret_text", name: "SETUP_ARMED", text: "yes" });
    expect(typeof (result.bindings[0] as { text: unknown }).text).toBe("string");
    expect((result.bindings[0] as { text: string }).text.length).toBeGreaterThan(16);
  });

  it("resume inherits the existing root from the active version and arms once", () => {
    const active = "00000000-0000-4000-8000-000000000001";
    const decision = evaluateR2Privacy(privacyFacts());
    const proof = assessBootstrapPrivacy(decision, READ_AT);
    if (!proof.ok) throw new Error("expected a private proof");
    const result = prepareSecretBindings(
      stepCtx({ secretNames: ["JWT_SECRET"], activeVersion: active }),
      {},
      { profile: profile(), mode: "resume", bucketName: BUCKET, privacyProof: proof.value },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings).toEqual([
      { type: "inherit", name: "JWT_SECRET", version_id: active },
      { type: "secret_text", name: "SETUP_ARMED", text: "yes" },
    ]);
  });

  it("refuses to merge without a valid proof, on collisions, or on a second root", () => {
    const noProof = prepareSecretBindings(stepCtx(), {}, {
      ...verifiedDirective(),
      privacyProof: { ...verifiedDirective().privacyProof, state: "UNKNOWN" },
    } as never);
    expect(noProof.ok).toBe(false);
    if (!noProof.ok && !noProof.failure.ok) {
      expect(noProof.failure.error.kind).toBe("bootstrap-refused");
      expect(noProof.failure.error.detail).toContain("PRIVATE_PROOF_FAILED");
    }

    const collision = prepareSecretBindings(
      stepCtx({ secrets: { SETUP_ARMED: "prompt-on-install" } }),
      { SETUP_ARMED: "user-value" },
      verifiedDirective(),
    );
    expect(collision.ok).toBe(false);
    if (!collision.ok && !collision.failure.ok) {
      expect(collision.failure.error.kind).toBe("bootstrap-refused");
      expect(collision.failure.error.detail).toContain("collides");
    }

    const reserved = prepareSecretBindings(
      stepCtx({ r2: [{ binding: "JWT_SECRET", bucketName: "media" }] }),
      {},
      verifiedDirective(),
    );
    expect(reserved.ok).toBe(false);

    const secondRoot = prepareSecretBindings(
      stepCtx({ secretNames: ["JWT_SECRET"], activeVersion: "00000000-0000-4000-8000-000000000001" }),
      {},
      verifiedDirective(),
    );
    expect(secondRoot.ok).toBe(false);
    if (!secondRoot.ok && !secondRoot.failure.ok) {
      expect(secondRoot.failure.error.detail).toContain("STATE_UNKNOWN");
    }
  });

  it("keeps the legacy call path unchanged when no bootstrap directive is present", () => {
    const legacy = prepareSecretBindings(
      stepCtx({ secrets: { PASSWORD: "prompt-on-install" } }),
      { PASSWORD: "must-not-overwrite" },
    );
    expect(legacy).toEqual({
      ok: true,
      bindings: [{ type: "secret_text", name: "PASSWORD", text: "must-not-overwrite" }],
    });
    const clientRunner = clientBootstrapRunner({
      listSecrets: () => Promise.reject(Object.assign(new Error("nope"), { kind: "not-found" })),
      getR2Bucket: () => Promise.reject(Object.assign(new Error("nope"), { kind: "not-found" })),
    });
    expect(typeof clientRunner.objectExists).toBe("function");
  });
});
