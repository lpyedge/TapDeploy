// Secret values: which ones the Configure step asks for, and which ones an
// approved plan still needs. Values are typed once, in Configure, held in
// memory and sent only with the Worker upload; the plan request never carries
// one. Generated secrets are made by the server and never shown.

import type { GraphPlan } from "./api.js";
import { declaredSecrets, type DeclaredInput } from "./config-inputs.js";
import { inputAskedIn, inputPatternProblem, inputValueProblem, type InputMode } from "../manifest/input-validation.js";

/** One declared secret in the Configure step. */
export interface SecretRow {
  def: DeclaredInput;
  /** A value must be entered: a new install, or a Worker that has no such secret yet. */
  required: boolean;
  /** Upgrade: the target Worker has no secret of this name. */
  missing: boolean;
}

/**
 * The secrets Configure shows. Install: every entered one, required. Upgrade:
 * one the target Worker lacks (by its live secret names, or because the last
 * plan creates it) is required; one it has is kept unless the user chooses to
 * change it, which upgrade offers only for a secret not marked `upgradeKeep`.
 * `existing` is null while the target's secrets are unknown.
 */
export function secretRows(configText: string, mode: InputMode, existing: readonly string[] | null, planCreates: readonly string[]): SecretRow[] {
  return declaredSecrets(configText).filter((def) => !def.generate).flatMap((def): SecretRow[] => {
    if (mode === "install") return [{ def, required: true, missing: false }];
    const missing = (existing !== null && !existing.includes(def.key)) || planCreates.includes(def.key);
    if (missing) return [{ def, required: true, missing: true }];
    return inputAskedIn(def, "upgrade") ? [{ def, required: false, missing: false }] : [];
  });
}

/** What is wrong with a typed secret value, or null (an empty value is "not entered yet", reported separately). */
export function secretValueProblem(def: DeclaredInput, value: string): string | null {
  return value === "" ? null : inputValueProblem(def, value) ?? inputPatternProblem(def, value);
}

/** The rows that need a value now: required ones and the ones the user chose to change. */
export function secretsAwaitingValue(rows: readonly SecretRow[], changing: readonly string[]): SecretRow[] {
  return rows.filter((row) => row.required || changing.includes(row.def.key));
}

export interface SecretNeed {
  name: string;
  label: string;
  /** The declared input: its validation rules apply to the value. */
  input: DeclaredInput;
  /** The plan creates it (the target has none yet); otherwise it replaces the live value. */
  create: boolean;
}

/**
 * The secret values the approved plan needs (secret create / update diffs
 * joined with the declared inputs; generated ones are server-made). The server
 * re-validates what it can and refuses a missing value before any write.
 */
export function secretNeedsFor(configText: string, graphPlan: GraphPlan | null): SecretNeed[] {
  const declared = new Map(declaredSecrets(configText).map((input) => [input.key, input]));
  const wanted = new Map((graphPlan?.units ?? []).flatMap((unit) => unit.diffs ?? []).filter((diff) => diff.resource === "secret" && (diff.action === "create" || diff.action === "update") && typeof diff.name === "string").map((diff) => [diff.name as string, diff.action === "create"] as const));
  return [...wanted].flatMap(([name, create]) => {
    const input = declared.get(name) ?? { key: name, type: "secret" as const, label: name, required: false };
    return !input.generate ? [{ name, label: input.label, input, create }] : [];
  });
}

/** The plan's needs that have no valid value yet: entered in Configure, never on the review. */
export function unmetSecretNeeds(needs: readonly SecretNeed[], values: Readonly<Record<string, string>>): SecretNeed[] {
  return needs.filter((need) => (values[need.name] ?? "") === "" || secretValueProblem(need.input, values[need.name] ?? "") !== null);
}
