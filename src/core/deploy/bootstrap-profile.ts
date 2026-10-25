// Built-in limited install profile `private-r2-owner-bootstrap/v1`: the
// one-time owner bootstrap of an app that keeps its owner account in a private
// R2 bucket (a root secret, an arm flag the app consumes on first start, and
// owner/marker objects in the bucket). Fixed fields, fixed semantics: no
// free-form JSON conditions, no arbitrary function names, no JS/SQL/shell.
//
// Invariants:
//   - a root secret is generated at most once per Worker and NEVER when an
//     Owner already exists (fresh generates; resume keeps; upgrade neither)
//   - `SETUP_ARMED=yes` is planned ONLY together with a complete Worker version
//     upload and ONLY when the state is fresh/resume AND a fresh
//     R2PrivacyProof(PRIVATE_VERIFIED) is presented — never a standalone
//     Secret PUT, never from a wrangler binding or a compiled env var
//   - every read failure (denied/timeout/ambiguous) is a refusal, never
//     "absent"; R2 object existence reads without a verified OAuth grant stay
//     UNVERIFIED_OAUTH and are never downgraded to "no Owner check"
//   - the Owner password is created and held by the deployed Worker only; this
//     module never generates, reads, returns or logs it — reports carry R2
//     object PATHS (present/absent/unknown) only
//   - no ACID pretense: identity/state is re-read immediately before the write
//     and any drift refuses (RACE_DETECTED) with a safe resume (re-run inspect)

import type { ConfigV3InstallPolicy } from "../../manifest/config-v3.js";
import {
  R2_PRIVACY_PROOF_MAX_AGE_MS,
  gateR2Bootstrap,
  type R2PrivacyDecision,
  type R2PrivacyProof,
} from "./r2-private-guard.js";
import { randomBase64Url } from "../../auth/crypto.js";

// ---------------------------------------------------------------------------
// Profile constants (validated, never free-form)
// ---------------------------------------------------------------------------

export const BOOTSTRAP_PROFILE_KIND = "private-r2-owner-bootstrap/v1";
export const DEFAULT_BOOTSTRAP_READINESS_PATH = "/api/auth/methods";

const PROFILE_FIELDS = [
  "kind",
  "unitId",
  "r2Binding",
  "rootSecret",
  "armSecret",
  "armValue",
  "ownerKey",
  "markerKey",
  "initialPasswordKey",
  "readinessPath",
] as const;

const TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SECRET_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const OBJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const READINESS_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,127}$/;
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

// ---------------------------------------------------------------------------
// Result / refusal vocabulary
// ---------------------------------------------------------------------------

type BootstrapRefusalCode =
  | "INVALID_PROFILE"
  | "INSPECT_FAILED"
  | "UNVERIFIED_OAUTH"
  | "BUCKET_MISSING"
  | "RECOVERY_REQUIRED"
  | "ROOT_MISSING"
  | "STATE_UNKNOWN"
  | "PRIVATE_PROOF_FAILED"
  | "RACE_DETECTED"
  | "BUCKET_CREATE_FAILED"
  | "READINESS_NOT_READY";

interface BootstrapRefusal {
  code: BootstrapRefusalCode;
  detail: string;
}

export type BootstrapResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: BootstrapRefusal };

function refuse(code: BootstrapRefusalCode, detail: string): { ok: false; refusal: BootstrapRefusal } {
  return { ok: false, refusal: { code, detail } };
}

function describe(error: unknown): string {
  const message =
    error !== null && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return message.split("\n")[0]!.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Profile validation (fixed semantics; strict enum)
// ---------------------------------------------------------------------------

export interface BootstrapProfile {
  kind: typeof BOOTSTRAP_PROFILE_KIND;
  unitId: string;
  r2Binding: string;
  rootSecret: string;
  armSecret: string;
  armValue: "yes";
  ownerKey: string;
  markerKey: string;
  initialPasswordKey: string;
  readinessPath: string;
}

function validObjectKey(key: string): boolean {
  return (
    OBJECT_KEY_RE.test(key) &&
    !key.includes("..") &&
    !key.includes("//") &&
    !key.endsWith("/")
  );
}

export function validateBootstrapProfile(
  policy: ConfigV3InstallPolicy,
): BootstrapResult<BootstrapProfile> {
  const raw = policy as unknown as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (key) => !(PROFILE_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    return refuse("INVALID_PROFILE", `unknown profile field(s): ${unknown.join(", ")}`);
  }
  if (raw["kind"] !== BOOTSTRAP_PROFILE_KIND) {
    return refuse("INVALID_PROFILE", `unsupported install policy kind "${String(raw["kind"])}"`);
  }
  if (raw["armValue"] !== "yes") {
    return refuse("INVALID_PROFILE", "armValue must be the fixed literal \"yes\"");
  }
  const stringField = (name: string): string | null =>
    typeof raw[name] === "string" ? (raw[name] as string) : null;
  const unitId = stringField("unitId");
  const r2Binding = stringField("r2Binding");
  const rootSecret = stringField("rootSecret");
  const armSecret = stringField("armSecret");
  const ownerKey = stringField("ownerKey");
  const markerKey = stringField("markerKey");
  const initialPasswordKey = stringField("initialPasswordKey");
  for (const [name, value] of [
    ["unitId", unitId],
    ["r2Binding", r2Binding],
  ] as const) {
    if (value === null || !TOKEN_RE.test(value)) {
      return refuse("INVALID_PROFILE", `${name} must match ${String(TOKEN_RE)}`);
    }
  }
  for (const [name, value] of [
    ["rootSecret", rootSecret],
    ["armSecret", armSecret],
  ] as const) {
    if (value === null || !SECRET_NAME_RE.test(value)) {
      return refuse("INVALID_PROFILE", `${name} must match ${String(SECRET_NAME_RE)}`);
    }
  }
  for (const [name, value] of [
    ["ownerKey", ownerKey],
    ["markerKey", markerKey],
    ["initialPasswordKey", initialPasswordKey],
  ] as const) {
    if (value === null || !validObjectKey(value)) {
      return refuse(
        "INVALID_PROFILE",
        `${name} must be a safe relative R2 object key (no "..", no "//", no trailing "/", <=256 chars)`,
      );
    }
  }
  if (rootSecret === armSecret) {
    return refuse("INVALID_PROFILE", "rootSecret and armSecret must be distinct");
  }
  if (ownerKey === markerKey || ownerKey === initialPasswordKey || markerKey === initialPasswordKey) {
    return refuse("INVALID_PROFILE", "ownerKey, markerKey and initialPasswordKey must be distinct");
  }
  const readinessPath = raw["readinessPath"] ?? DEFAULT_BOOTSTRAP_READINESS_PATH;
  if (
    typeof readinessPath !== "string" ||
    !READINESS_PATH_RE.test(readinessPath) ||
    readinessPath.startsWith("//") ||
    readinessPath.includes(":")
  ) {
    return refuse(
      "INVALID_PROFILE",
      "readinessPath must be a same-origin relative path (starting \"/\", no scheme/host)",
    );
  }
  return {
    ok: true,
    value: {
      kind: BOOTSTRAP_PROFILE_KIND,
      unitId: unitId!,
      r2Binding: r2Binding!,
      rootSecret: rootSecret!,
      armSecret: armSecret!,
      armValue: "yes",
      ownerKey: ownerKey!,
      markerKey: markerKey!,
      initialPasswordKey: initialPasswordKey!,
      readinessPath,
    },
  };
}

// ---------------------------------------------------------------------------
// Read-only inspection (runner = provider reads; any throw = refusal)
// ---------------------------------------------------------------------------

export interface BootstrapTargetFacts {
  workerExists: boolean;
  hasRoot: boolean;
  bucketExists: boolean;
  ownerExists: boolean;
  markerExists: boolean;
}

export interface BootstrapRunner {
  /** Worker secret NAMES only (`null` when the Worker does not exist). Never values. */
  secretNames(workerName: string): Promise<string[] | null>;
  bucketExists(bucketName: string): Promise<boolean>;
  /** Existence only — never object contents (the initial password object is never read). */
  objectExists(bucketName: string, key: string): Promise<boolean>;
}

// Raised when an R2 object-existence read has no verified OAuth grant yet. The
// task keeps this UNVERIFIED_OAUTH: it must never be downgraded to "assume no
// Owner" (an unchecked bootstrap would be exactly the unsafe shortcut).
export class BootstrapObjectReadUnverifiedError extends Error {
  readonly code = "UNVERIFIED_OAUTH" as const;
  constructor(message: string) {
    super(message);
    this.name = "BootstrapObjectReadUnverifiedError";
  }
}

export interface BootstrapInspectInput {
  workerName: string;
  bucketName: string;
  profile: BootstrapProfile;
}

async function attempt<T>(
  what: string,
  action: () => Promise<T>,
): Promise<BootstrapResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    if (error instanceof BootstrapObjectReadUnverifiedError) {
      return refuse(
        "UNVERIFIED_OAUTH",
        `${error.message}; the Owner/marker existence is never treated as absent and nothing was changed`,
      );
    }
    return refuse("INSPECT_FAILED", `Could not check ${what}, so nothing was changed. ${describe(error)}`);
  }
}

/**
 * Read-only target inspection in the reference protocol's exact order:
 * Worker secrets (names only) -> bucket existence -> Owner/marker objects
 * (only when the bucket exists). Every failure refuses; absence is only ever
 * reported when the provider positively answered.
 */
export async function inspectBootstrapTarget(
  runner: BootstrapRunner,
  input: BootstrapInspectInput,
): Promise<BootstrapResult<BootstrapTargetFacts>> {
  const secrets = await attempt(`the Worker "${input.workerName}"`, () =>
    runner.secretNames(input.workerName),
  );
  if (!secrets.ok) return secrets;
  const bucket = await attempt(`the R2 bucket "${input.bucketName}"`, () =>
    runner.bucketExists(input.bucketName),
  );
  if (!bucket.ok) return bucket;
  let ownerExists = false;
  let markerExists = false;
  if (bucket.value) {
    const owner = await attempt("the Owner record", () =>
      runner.objectExists(input.bucketName, input.profile.ownerKey),
    );
    if (!owner.ok) return owner;
    const marker = await attempt("the setup marker", () =>
      runner.objectExists(input.bucketName, input.profile.markerKey),
    );
    if (!marker.ok) return marker;
    ownerExists = owner.value;
    markerExists = marker.value;
  }
  const names = new Set(secrets.value ?? []);
  return {
    ok: true,
    value: {
      workerExists: secrets.value !== null,
      hasRoot: names.has(input.profile.rootSecret),
      bucketExists: bucket.value,
      ownerExists,
      markerExists,
    },
  };
}

// ---------------------------------------------------------------------------
// Limited state table (identical order to the reference `decide`)
// ---------------------------------------------------------------------------

export type BootstrapMode = "fresh" | "resume" | "upgrade";

export function decideBootstrapMode(
  facts: BootstrapTargetFacts,
): BootstrapResult<{ mode: BootstrapMode }> {
  if (!facts.bucketExists && (facts.workerExists || facts.hasRoot)) {
    return refuse(
      "BUCKET_MISSING",
      "The Worker exists but its R2 bucket does not, so this is not a fresh install. Nothing was changed.",
    );
  }
  if (facts.markerExists && !facts.ownerExists) {
    return refuse(
      "RECOVERY_REQUIRED",
      "First setup was started on this bucket but never finished (a setup marker exists and no Owner). Nothing was changed.",
    );
  }
  if (facts.ownerExists) {
    if (!facts.hasRoot) {
      return refuse(
        "ROOT_MISSING",
        "This bucket already has an Owner, but the Worker has no root secret. A new one would lock the Owner out, so nothing was changed and the secret is never reset.",
      );
    }
    return { ok: true, value: { mode: "upgrade" } };
  }
  return { ok: true, value: { mode: facts.hasRoot ? "resume" : "fresh" } };
}

// ---------------------------------------------------------------------------
// Privacy gate (proof) + prewrite race re-check
// ---------------------------------------------------------------------------

/**
 * Prewrite privacy gate: only a fresh PRIVATE_VERIFIED proof may arm.
 * PUBLIC_EXPOSED / stale proofs fail PRIVATE_PROOF_FAILED (never
 * auto-disabled); every UNKNOWN read fails STATE_UNKNOWN.
 */
export function assessBootstrapPrivacy(
  decision: R2PrivacyDecision,
  nowMs: number,
  maxAgeMs: number = R2_PRIVACY_PROOF_MAX_AGE_MS,
): BootstrapResult<R2PrivacyProof> {
  const gate = gateR2Bootstrap(decision, nowMs, maxAgeMs);
  if (gate.allowed) {
    return { ok: true, value: gate.proof };
  }
  if (gate.state === "UNKNOWN") {
    return refuse("STATE_UNKNOWN", gate.reason);
  }
  return refuse("PRIVATE_PROOF_FAILED", gate.reason);
}

/**
 * The identity/state is re-read immediately before the change: two installs
 * started together must not both create a root. Cloudflare offers no general
 * ACID transaction, so a change refuses as RACE_DETECTED with a safe resume
 * (re-run inspect); no atomicity is claimed.
 */
export function checkBootstrapRace(
  before: BootstrapTargetFacts,
  after: BootstrapTargetFacts,
  expectedMode: BootstrapMode,
): BootstrapResult<{ mode: BootstrapMode }> {
  const again = decideBootstrapMode(after);
  if (!again.ok) {
    return refuse(
      "RACE_DETECTED",
      `The Worker or bucket changed while this deploy was starting (now ${again.refusal.code}). Nothing was changed; run it again.`,
    );
  }
  if (again.value.mode !== expectedMode || after.hasRoot !== before.hasRoot) {
    return refuse(
      "RACE_DETECTED",
      "The Worker or bucket changed while this deploy was starting (another install?). Nothing was changed; run it again.",
    );
  }
  return { ok: true, value: { mode: expectedMode } };
}

// ---------------------------------------------------------------------------
// Secret planning (values only inside upload bindings; never reported)
// ---------------------------------------------------------------------------

/** Structural re-validation of a privacy proof carried through step args. */
export function validateBootstrapPrivacyProof(proof: unknown): proof is R2PrivacyProof {
  if (proof === null || typeof proof !== "object") return false;
  const p = proof as Record<string, unknown>;
  return (
    p["proofKind"] === "r2-private-readback" &&
    p["state"] === "PRIVATE_VERIFIED" &&
    typeof p["accountId"] === "string" &&
    p["accountId"].length > 0 &&
    typeof p["bucketName"] === "string" &&
    p["bucketName"].length > 0 &&
    (p["jurisdiction"] === null || typeof p["jurisdiction"] === "string") &&
    p["managedDomainEnabled"] === false &&
    p["customDomainCount"] === 0 &&
    typeof p["readAtMs"] === "number" &&
    Number.isFinite(p["readAtMs"])
  );
}

export interface BootstrapDirective {
  profile: BootstrapProfile;
  mode: BootstrapMode;
  bucketName: string;
  privacyProof: R2PrivacyProof;
}

/**
 * Strict parse of a bootstrap directive carried in step args:
 * { profile, mode, bucketName, privacyProof }. Unknown keys refuse; the proof
 * is structurally re-validated (kind/state/zero-exposure anchors) and must
 * belong to the same bucket.
 */
export function parseBootstrapDirective(value: unknown): BootstrapResult<BootstrapDirective> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return refuse("INVALID_PROFILE", "bootstrap directive must be an object");
  }
  const raw = value as Record<string, unknown>;
  const allowed = ["profile", "mode", "bucketName", "privacyProof"];
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    return refuse("INVALID_PROFILE", `unknown bootstrap directive field(s): ${unknown.join(", ")}`);
  }
  const mode = raw["mode"];
  if (mode !== "fresh" && mode !== "resume" && mode !== "upgrade") {
    return refuse("INVALID_PROFILE", `bootstrap mode must be fresh|resume|upgrade, got "${String(mode)}"`);
  }
  const profileResult = validateBootstrapProfile(raw["profile"] as ConfigV3InstallPolicy);
  if (!profileResult.ok) return profileResult;
  const bucketName = raw["bucketName"];
  if (typeof bucketName !== "string" || !BUCKET_NAME_RE.test(bucketName)) {
    return refuse("INVALID_PROFILE", "bootstrap bucketName must be a valid R2 bucket name");
  }
  if (!validateBootstrapPrivacyProof(raw["privacyProof"])) {
    return refuse("INVALID_PROFILE", "bootstrap directive requires a structurally valid PRIVATE_VERIFIED proof");
  }
  if (raw["privacyProof"].bucketName !== bucketName) {
    return refuse("PRIVATE_PROOF_FAILED", "the privacy proof was issued for a different bucket");
  }
  return {
    ok: true,
    value: { profile: profileResult.value, mode, bucketName, privacyProof: raw["privacyProof"] },
  };
}

export interface BootstrapSecretPlan {
  /** `secret_text` bindings for THE SAME complete Worker version upload. */
  create: Array<{ type: "secret_text"; name: string; text: string }>;
  /** Names that will be uploaded (names only — values are never returned). */
  uploaded: string[];
}

export interface BootstrapSecretPlanInput {
  profile: BootstrapProfile;
  mode: BootstrapMode;
  existingSecretNames: readonly string[];
  /** Generator for the one-time root secret (injectable for tests). */
  generateRoot?: () => string;
}

/**
 * Plan the bootstrap secrets for the complete version upload:
 *   fresh  -> root secret (generated once, only when positively absent) + arm
 *   resume -> arm only (the existing root is inherited by the upload path)
 *   upgrade-> nothing (never rearm/rotate)
 * Upgrade never arms; fresh never regenerates a root; a root that already
 * exists is inherited, never overwritten (that would lock the Owner out).
 */
export function planBootstrapSecrets(
  input: BootstrapSecretPlanInput,
): BootstrapResult<BootstrapSecretPlan> {
  const { profile, mode } = input;
  const existing = new Set(input.existingSecretNames);
  if (mode === "upgrade") {
    return { ok: true, value: { create: [], uploaded: [] } };
  }
  if (mode === "resume" && !existing.has(profile.rootSecret)) {
    return refuse(
      "STATE_UNKNOWN",
      `resume requires the existing root secret "${profile.rootSecret}"; nothing was armed`,
    );
  }
  if (mode === "fresh" && existing.has(profile.rootSecret)) {
    return refuse(
      "STATE_UNKNOWN",
      `a root secret "${profile.rootSecret}" already exists although the state was read as fresh; nothing was armed`,
    );
  }
  const create: BootstrapSecretPlan["create"] = [];
  const uploaded: string[] = [];
  if (mode === "fresh") {
    const generate = input.generateRoot ?? (() => randomBase64Url(32));
    create.push({ type: "secret_text", name: profile.rootSecret, text: generate() });
    uploaded.push(profile.rootSecret);
  }
  if (!existing.has(profile.armSecret)) {
    create.push({ type: "secret_text", name: profile.armSecret, text: profile.armValue });
    uploaded.push(profile.armSecret);
  }
  return { ok: true, value: { create, uploaded } };
}

// ---------------------------------------------------------------------------
// Client-backed runner (provider reads through the typed client only)
// ---------------------------------------------------------------------------

export interface BootstrapClientPort {
  listSecrets(scriptName: string): Promise<ReadonlyArray<{ name: string }>>;
  getR2Bucket(bucketName: string): Promise<unknown>;
}

function errorKind(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && typeof (error as { kind?: unknown }).kind === "string") {
    return (error as { kind: string }).kind;
  }
  return undefined;
}

/**
 * Runner over the typed Cloudflare client. `objectExists` requires an R2
 * Objects LIST with exact key/prefix whose OAuth grant is only decidable live
 *: until a verified implementation is injected, the default throwing
 * implementation keeps the inspect UNVERIFIED_OAUTH (never "absent").
 */
export function clientBootstrapRunner(
  client: BootstrapClientPort,
  options?: { objectExists?: (bucketName: string, key: string) => Promise<boolean> },
): BootstrapRunner {
  return {
    async secretNames(workerName) {
      try {
        const list = await client.listSecrets(workerName);
        return list.map((secret) => secret.name);
      } catch (error) {
        if (errorKind(error) === "not-found") return null;
        throw error;
      }
    },
    async bucketExists(bucketName) {
      try {
        await client.getR2Bucket(bucketName);
        return true;
      } catch (error) {
        if (errorKind(error) === "not-found") return false;
        throw error;
      }
    },
    objectExists:
      options?.objectExists ??
      (() => {
        throw new BootstrapObjectReadUnverifiedError(
          "R2 Object existence reads require a verified OAuth grant (R2 Objects LIST with exact key/prefix)",
        );
      }),
  };
}
