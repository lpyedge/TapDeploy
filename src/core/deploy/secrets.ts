// Worker secret lifecycle. Secrets are declared in the manifest with a policy;
// the browser supplies prompt-on-install values only at first install and the
// server securely generates generate-once values. The invariants: an existing
// secret is never overwritten (strict inherit, upgrades retain without reentry),
// a declared secret that cannot be satisfied fails closed, and an inherited
// secret must reference the currently deployed version — never merely the
// latest uploaded one. Values are never logged or returned.

import type { DeploySpec, SecretPolicy } from "../deploy-spec.js";
import type { TargetSnapshot } from "../planning/types.js";
import { randomBase64Url } from "../../auth/crypto.js";
import {
  planBootstrapSecrets,
  validateBootstrapPrivacyProof,
  type BootstrapDirective,
} from "./bootstrap-profile.js";
import { stepFail, stepOk, toStepFailure, type DeployStepOutcome } from "./bindings.js";
import type { DeployStepContext } from "./steps.js";

export type SecretActionKind = "create" | "preserve" | "fail";

export type SecretActionReason =
  | "install-create"
  | "exists-preserve"
  | "missing-value"
  | "preserve-only-absent";

export interface SecretAction {
  name: string;
  policy: SecretPolicy;
  action: SecretActionKind;
  reason: SecretActionReason;
}

// Pure: decide each declared secret's fate from the live secret names and the
// browser-supplied first-install values. Existing secrets are always preserved
// (upgrades retain without reentry or rotation). generate-once never needs a
// browser value: the server generates it. prompt-on-install requires a value
// only when the secret does not yet exist. preserve-only fails when absent.
export function resolveSecretActions(
  spec: DeploySpec,
  snapshot: TargetSnapshot,
  providedValues: Record<string, unknown>,
): SecretAction[] {
  const existing = new Set(snapshot.secretNames);
  const actions: SecretAction[] = [];
  for (const [name, policy] of Object.entries(spec.cloudflare.secrets)) {
    if (existing.has(name)) {
      actions.push({ name, policy, action: "preserve", reason: "exists-preserve" });
      continue;
    }
    if (policy === "preserve-only") {
      actions.push({ name, policy, action: "fail", reason: "preserve-only-absent" });
      continue;
    }
    // generate-once is server-generated; no browser value required.
    // A supplied value for it is ignored (never trusted for creation).
    if (policy === "generate-once") {
      actions.push({ name, policy, action: "create", reason: "install-create" });
      continue;
    }
    const value = providedValues[name];
    if (typeof value !== "string" || value.length === 0) {
      actions.push({ name, policy, action: "fail", reason: "missing-value" });
      continue;
    }
    actions.push({ name, policy, action: "create", reason: "install-create" });
  }
  return actions;
}

export interface InheritCheckInput {
  deployedVersionId?: string;
  latestVersionId?: string;
  inheritedFromVersionId?: string;
}

export type InheritCheck =
  | { ok: true }
  | { ok: false; reason: "inherit-source-not-deployed"; detail: string };

// An inherited secret is only safe when its source version is the one currently
// serving traffic. Inheriting from the newest uploaded (but not deployed)
// version is exactly the mismatch that must fail closed.
export function checkSecretInheritance(input: InheritCheckInput): InheritCheck {
  const { inheritedFromVersionId } = input;
  if (inheritedFromVersionId === undefined) {
    return { ok: true };
  }
  if (
    input.deployedVersionId !== undefined &&
    inheritedFromVersionId === input.deployedVersionId
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "inherit-source-not-deployed",
    detail: `Cannot inherit a secret from version ${inheritedFromVersionId}: it is not the currently deployed version (${input.deployedVersionId ?? "none"})`,
  };
}

function asValueMap(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export interface ApplySecretsResult {
  secrets: { name: string; action: "create" | "preserve" }[];
}

// Secrets must be part of the same immutable upload as the approved code.
// Script endpoints cannot choose a historical inheritance source. Exact-ID
// bindings select the Workers resource adapter, never legacy script inheritance.
// an optional bootstrap directive merges the limited profile's planned
// secrets (root once on fresh, arm on fresh/resume) into the SAME version
// bindings — but only with a structurally valid PRIVATE_VERIFIED proof, and
// never colliding with declared secrets or reserved binding names. There is no
// standalone Secret PUT path anywhere.
export function prepareSecretBindings(ctx: DeployStepContext, provided: unknown, bootstrap?: BootstrapDirective):
  | { ok: true; bindings: Array<Record<string, unknown>> }
  | { ok: false; failure: DeployStepOutcome } {
  const existing = ctx.snapshot.secretNames ?? [];
  const active = ctx.snapshot.activeDeploymentVersionIds?.[0];
  if (existing.length && (!active || ctx.snapshot.activeDeploymentVersionIds.length !== 1 || !ctx.snapshot.activeBindings || existing.some(name => !ctx.snapshot.activeBindings!.some(b => b.name === name && (b.type === "secret_text" || b.type === "secret_key"))))) return { ok: false, failure: stepFail("inherit-source-unavailable", "exact active secret inventory is unavailable; no version was uploaded") };
  const values = asValueMap(provided ?? {});
  if (!values) return { ok: false, failure: stepFail("invalid-args", "secrets must be an object") };
  // only declared names can be supplied. An injected undeclared name is
  // refused before any provider read or write (never silently dropped, never
  // bound).
  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(ctx.spec.cloudflare.secrets, name)) {
      return { ok: false, failure: stepFail("invalid-args", `undeclared secret "${name}" is not in the approved release`) };
    }
  }
  const actions = resolveSecretActions(ctx.spec, { ...ctx.snapshot, secretNames: existing }, values);
  const failed = actions.find(a => a.action === "fail");
  if (failed) return { ok: false, failure: stepFail("missing-secret", `secret "${failed.name}" cannot be satisfied (${failed.reason})`) };
  const createBindings = actions.filter(a => a.action === "create").map(a => ({
    type: "secret_text", name: a.name,
    text: a.policy === "generate-once" ? randomBase64Url(32) : values[a.name],
  }));
  if (bootstrap) {
    // Arming is only ever planned with a PRIVATE_VERIFIED proof (re-validated
    // here even though the step-arg parser already checked it).
    if (!validateBootstrapPrivacyProof(bootstrap.privacyProof)) {
      return { ok: false, failure: stepFail("bootstrap-refused", "PRIVATE_PROOF_FAILED: arming requires a structurally valid PRIVATE_VERIFIED proof") };
    }
    const plan = planBootstrapSecrets({
      profile: bootstrap.profile,
      mode: bootstrap.mode,
      existingSecretNames: existing,
    });
    if (!plan.ok) {
      return { ok: false, failure: stepFail("bootstrap-refused", `${plan.refusal.code}: ${plan.refusal.detail}`) };
    }
    const reservedNames = new Set<string>([
      ...Object.keys(ctx.spec.wrangler.vars ?? {}),
      ...[ctx.spec.cloudflare.r2, ctx.spec.cloudflare.d1, ctx.spec.cloudflare.kv, ctx.spec.cloudflare.queues, ctx.spec.cloudflare.hyperdrive, ctx.spec.cloudflare.vectorize, ctx.spec.cloudflare.secretsStore, ctx.spec.cloudflare.runtimeBindings].flatMap(bindings => bindings.map(binding => binding.binding).filter((name): name is string => typeof name === "string")),
      ...(ctx.spec.assets.length ? [ctx.spec.wrangler.assets?.binding ?? "ASSETS"] : []),
    ]);
    for (const binding of plan.value.create) {
      if (createBindings.some(b => b.name === binding.name) || Object.prototype.hasOwnProperty.call(ctx.spec.cloudflare.secrets, binding.name)) {
        return { ok: false, failure: stepFail("bootstrap-refused", `INVALID_PROFILE: bootstrap secret "${binding.name}" collides with a declared install secret`) };
      }
      if (reservedNames.has(binding.name)) {
        return { ok: false, failure: stepFail("bootstrap-refused", `INVALID_PROFILE: bootstrap secret "${binding.name}" collides with a reserved binding name`) };
      }
      createBindings.push(binding);
    }
  }
  return { ok: true, bindings: [...existing.map(name => ({ type: "inherit", name, version_id: active })), ...createBindings] };
}

// Attach the declared secrets that do not yet exist. Never overwrites an
// existing secret, even if a value was supplied for it. generate-once values
// are securely generated server-side (WebCrypto, never returned or logged);
// prompt-on-install values come from the browser-supplied first-install map.
// This step is verification/preserve-only: all creation must happen in
// the same multipart upload as code. Separate Secret PUT creates a different
// version and is never used here. A direct/retried
// call against a never-created worker fails closed (worker-missing) instead of
// 404ing mid-write.
export async function applySecrets(
  ctx: DeployStepContext,
  args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  // absent optionals are a successful no-op, not a failure.
  if (Object.keys(ctx.spec.cloudflare.secrets).length === 0) {
    return stepOk({ skipped: true, secrets: [] } satisfies { skipped: true; secrets: ApplySecretsResult["secrets"] });
  }
  const provided = asValueMap(args.secrets);
  if (provided === null) {
    return stepFail("invalid-args", "apply-secrets requires secrets: object");
  }
  // only declared names can be supplied, even to this verify-only
  // step. An injected undeclared name is refused before any read.
  for (const name of Object.keys(provided)) {
    if (!Object.hasOwn(ctx.spec.cloudflare.secrets, name)) {
      return stepFail("invalid-args", `undeclared secret "${name}" is not in the approved release`);
    }
  }

  if (args.inheritFromVersionId !== undefined) {
    const inherit = checkSecretInheritance({
      deployedVersionId: ctx.snapshot.activeDeploymentVersionIds[0],
      latestVersionId: ctx.snapshot.latestVersionId,
      inheritedFromVersionId:
        typeof args.inheritFromVersionId === "string"
          ? args.inheritFromVersionId
          : undefined,
    });
    if (!inherit.ok) {
      return stepFail("inherit-source-unavailable", inherit.detail);
    }
  }

  const actions = resolveSecretActions(ctx.spec, ctx.snapshot, provided);
  const failed = actions.find((a) => a.action === "fail");
  if (failed) {
    return stepFail(
      "missing-secret",
      `secret "${failed.name}" cannot be satisfied (${failed.reason})`,
    );
  }

  // never write a secret into a script that does not exist. The install
  // order runs apply-secrets after create-worker, so a legitimate install always has a
  // Worker here; a direct/retried call against a never-created Worker (or a
  // worker deleted out-of-band between plan and step) must fail closed instead of
  // 404ing mid-write. Preserve-only resolutions stay write-free and untouched.
  if (actions.some((a) => a.action === "create") && !ctx.snapshot.workerExists) {
    return stepFail(
      "worker-missing",
      "cannot create secrets: the target Worker does not exist (create-worker must run first)",
    );
  }

  if (actions.some(a => a.action === "create")) {
    return stepFail("missing-secret", "required secrets must be included with code in the upload; separate Secret PUT is disabled");
  }
  try {
    const secrets: ApplySecretsResult["secrets"] = [];
    for (const action of actions) {
      if (action.action === "preserve") {
        secrets.push({ name: action.name, action: "preserve" });
      }
    }
    return stepOk({ secrets } satisfies ApplySecretsResult);
  } catch (error) {
    return toStepFailure(error);
  }
}
