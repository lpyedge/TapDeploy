// What the plan request's `inputs` and `suppliedSecrets` mean for one release:
// checked against the config and the mode, then turned into Worker variables,
// secret policies and the operator's Worker name. Pure: no provider reads.

import { isPrimitiveInputValue, type PrimitiveInputValue, type SecretPolicy } from "../deploy-spec.js";
import type { ConfigV3 } from "../../manifest/config-v3.js";
import { inputAskedIn, inputProblem, inputRequiredIn, type InputMode } from "../../manifest/input-validation.js";

type Checked<T> = { ok: true; value: T } | { ok: false; detail: string };

function primitiveInputs(
  raw: Record<string, unknown> | undefined,
): Record<string, PrimitiveInputValue> {
  const out: Record<string, PrimitiveInputValue> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (isPrimitiveInputValue(v)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * The declared non-secret inputs the operator supplied, checked against the
 * mode and the config's rules. `workerName` is the operator-renamable Worker
 * identity (see preparedGraphInputs): always allowed through, validated there.
 * An input the mode does not ask for is refused rather than dropped, so a
 * stale form cannot overwrite a value the publisher keeps on upgrade.
 */
export function normalizeV3Inputs(config: ConfigV3, raw: Record<string, unknown> | undefined, mode: InputMode): { ok: true; inputs: Record<string, PrimitiveInputValue> } | { ok: false; detail: string } {
  const supplied = primitiveInputs(raw);
  const declared = (config.inputs ?? []).filter((input) => input.type !== "secret" && input.key !== "workerName");
  const inputs: Record<string, PrimitiveInputValue> = {};
  if (supplied.workerName !== undefined) inputs.workerName = supplied.workerName;
  for (const input of declared) {
    const value = supplied[input.key];
    if (value === undefined) {
      if (inputRequiredIn(input, mode)) return { ok: false, detail: `inputs.${input.key} is required` };
      continue;
    }
    if (!inputAskedIn(input, mode)) return { ok: false, detail: `inputs.${input.key} is not asked on ${mode}` };
    const problem = inputProblem(input, mode, String(value));
    if (problem) return { ok: false, detail: `inputs.${input.key}: ${problem}` };
    inputs[input.key] = value;
  }
  return { ok: true, inputs };
}

/**
 * The declared secrets the operator gives a value that they would not get by
 * default: an optional one they filled in, or an existing one they replace.
 * Names only; the values ride the deploy steps. A secret the mode does not ask
 * for (generated, or kept on upgrade) is refused, so a stale form cannot
 * overwrite what the publisher keeps.
 */
export function suppliedSecrets(config: ConfigV3, raw: unknown, mode: InputMode): { ok: true; names: Set<string> } | { ok: false; detail: string } {
  if (raw === undefined) return { ok: true, names: new Set() };
  if (!Array.isArray(raw) || raw.some((name) => typeof name !== "string")) return { ok: false, detail: "suppliedSecrets must be a list of names" };
  const askable = new Set((config.inputs ?? []).filter((input) => input.type === "secret" && !input.generate && inputAskedIn(input, mode)).map((input) => input.key));
  for (const name of raw as string[]) if (!askable.has(name)) return { ok: false, detail: `suppliedSecrets: "${name}" is not a secret this app asks for on ${mode}` };
  return { ok: true, names: new Set(raw as string[]) };
}

/** Declared non-secret inputs become Worker plain-text variables named by their key (`workerName` stays the Worker's name). */
export function inputVars(config: ConfigV3, inputs: Record<string, PrimitiveInputValue>): Record<string, string | number | boolean> {
  const vars: Record<string, string | number | boolean> = {};
  for (const input of config.inputs ?? []) {
    const value = inputs[input.key];
    if (input.type === "secret" || input.key === "workerName" || value === undefined) continue;
    vars[input.key] = input.type === "integer" || input.type === "number" ? Number(value) : input.type === "boolean" ? value === true || value === "true" : String(value);
  }
  return vars;
}

/**
 * Secret policy per declared secret input. The key doubles as the Worker
 * binding name (validated binding-safe). A required secret is prompt-on-install
 * (kept when it exists, created with the operator's value when it does not);
 * an optional one left empty is never set. Values are never projected here:
 * they travel per-step in args.secrets and are never sealed.
 */
export function declaredSecretPolicies(config: ConfigV3, supplied: ReadonlySet<string>): Record<string, SecretPolicy> {
  const policies: Record<string, SecretPolicy> = {};
  for (const input of config.inputs ?? []) {
    if (input.type === "secret" && typeof input.key === "string" && input.key.length > 0) {
      policies[input.key] = input.generate ? "generate-once" : supplied.has(input.key) ? "supplied" : input.required === false ? "optional" : "prompt-on-install";
    }
  }
  return policies;
}

/**
 * Operator-renamable Worker identity. The release wrangler name is only a
 * publisher default: on install the operator always sets the target name
 * (prefilled from the release), and upgrade means entering an existing name.
 * A declared non-secret `workerName` input adds its length limits here (its
 * pattern runs in the browser only, see input-validation.ts); the
 * Cloudflare-safe baseline always applies. Validation is server-side and
 * fail-closed; multi-executable releases keep release names (a flat input
 * cannot address one unit of several).
 */
export function workerNameOverride(config: ConfigV3, inputs: Record<string, PrimitiveInputValue>): Checked<string | undefined> {
  const raw = inputs.workerName;
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, detail: "inputs.workerName must be a string" };
  const declared = (config.inputs ?? []).find((input) => input.type !== "secret" && input.key === "workerName");
  const validation = declared?.validation ?? {};
  if (typeof validation.minLength === "number" && raw.length < validation.minLength) return { ok: false, detail: `inputs.workerName is shorter than minLength ${validation.minLength}` };
  if (typeof validation.maxLength === "number" && raw.length > validation.maxLength) return { ok: false, detail: `inputs.workerName exceeds maxLength ${validation.maxLength}` };
  if (!/^[a-z0-9-]{1,63}$/.test(raw)) return { ok: false, detail: "inputs.workerName must match ^[a-z0-9-]{1,63}$" };
  return { ok: true, value: raw };
}

