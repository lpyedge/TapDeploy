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
  /**
   * required: a value must be entered (nothing to keep). optional: may be left
   * empty, and then it is not set. kept: the Worker has it; it stays unless the
   * user chooses to change it.
   */
  kind: "required" | "optional" | "kept";
  /** Upgrade: the target Worker has no secret of this name. */
  missing: boolean;
}

/**
 * The secrets Configure shows. Install: every entered one, required unless the
 * config says `required: false`. Upgrade: one the target Worker lacks (by its
 * live secret names, or because the last plan creates it) is asked like on
 * install, except that an optional one marked `upgradeKeep` is not asked again
 * (left unset); one the Worker has is kept, and offered for change only when
 * not marked `upgradeKeep`. `existing` is null while the target's secrets are
 * unknown.
 */
export function secretRows(configText: string, mode: InputMode, existing: readonly string[] | null, planCreates: readonly string[]): SecretRow[] {
  return declaredSecrets(configText).filter((def) => !def.generate).flatMap((def): SecretRow[] => {
    const asked = def.required === false ? "optional" : "required";
    if (mode === "install") return [{ def, kind: asked, missing: false }];
    const missing = (existing !== null && !existing.includes(def.key)) || planCreates.includes(def.key);
    if (missing) return asked === "required" || inputAskedIn(def, "upgrade") ? [{ def, kind: asked, missing: true }] : [];
    return inputAskedIn(def, "upgrade") ? [{ def, kind: "kept", missing: false }] : [];
  });
}

/** What is wrong with a typed secret value, or null (an empty value is "not entered yet", reported separately). */
export function secretValueProblem(def: DeclaredInput, value: string): string | null {
  return value === "" ? null : inputValueProblem(def, value) ?? inputPatternProblem(def, value);
}

/** Whether every value Configure holds is acceptable: required and changed ones entered, all of them valid. */
export function secretsReady(rows: readonly SecretRow[], changing: readonly string[], values: Readonly<Record<string, string>>): boolean {
  return rows.every((row) => {
    const value = values[row.def.key] ?? "";
    const needed = row.kind === "required" || (row.kind === "kept" && changing.includes(row.def.key));
    if (needed && value === "") return false;
    return row.kind === "kept" && !changing.includes(row.def.key) ? true : secretValueProblem(row.def, value) === null;
  });
}

/**
 * The secrets the plan request names as getting a value they would not get by
 * default: an optional one filled in, a kept one the user changes. A required
 * one is created with its value anyway, so it is not listed.
 */
export function suppliedSecretNames(rows: readonly SecretRow[], changing: readonly string[], values: Readonly<Record<string, string>>): string[] {
  return rows.filter((row) => (row.kind === "optional" && (values[row.def.key] ?? "") !== "") || (row.kind === "kept" && changing.includes(row.def.key))).map((row) => row.def.key);
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
