// What the Configure step turns into: the units a domain or Hyperdrive choice
// addresses, whether every required choice is made, and the plan request. Pure,
// so the form component only wires state to it.

import type { DomainsEnvelope, GraphPlanRequest } from "./api.js";
import type { DeclaredInput } from "./config-inputs.js";
import { domainRequest, type HttpUnit, type RecordsByZone, type UnitDomainDraft } from "./domain-choices.js";
import { requestNames, type NameRow } from "./name-choices.js";
import type { V3MachineSnapshot } from "./v3-flow-machine.js";

type ReleaseUnit = V3MachineSnapshot["releaseUnits"][number];

export interface HyperdriveUnit {
  unitId: string;
  /** The Worker the bindings belong to, as it will be named. */
  target: string;
  bindings: readonly string[];
}

/** A Worker keeps the operator's name when it is renamable; a Pages site takes its chosen project name. */
function targetName(unit: ReleaseUnit, renameAllowed: boolean, workerName: string, names: readonly NameRow[]): string {
  if (unit.kind === "worker" && renameAllowed && workerName) return workerName;
  return unit.kind === "pages" ? names.find((row) => row.key === `pages:${unit.unitId}`)?.value || unit.name : unit.name;
}

/** The units a custom domain can be bound to. */
export function httpUnitsFor(units: readonly ReleaseUnit[], renameAllowed: boolean, workerName: string, names: readonly NameRow[]): HttpUnit[] {
  return units.flatMap((unit) => unit.kind === "worker" || unit.kind === "pages"
    ? [{ unitId: unit.unitId, kind: unit.kind, target: targetName(unit, renameAllowed, workerName, names) }]
    : []);
}

/** The units whose Hyperdrive bindings the operator must point at one of their configurations. */
export function hyperdriveUnitsFor(units: readonly ReleaseUnit[], renameAllowed: boolean, workerName: string): HyperdriveUnit[] {
  return units.flatMap((unit) => (unit.hyperdrive ?? []).length > 0
    ? [{ unitId: unit.unitId, target: targetName(unit, renameAllowed, workerName, []), bindings: unit.hyperdrive ?? [] }]
    : []);
}

export type HyperdriveChoices = Readonly<Record<string, Readonly<Record<string, string>>>>;

export function hyperdriveReady(units: readonly HyperdriveUnit[], choices: HyperdriveChoices): boolean {
  return units.every((unit) => unit.bindings.every((binding) => (choices[unit.unitId]?.[binding] ?? "") !== ""));
}

/**
 * The inputs sent with the plan request. Empty values are omitted: an untouched
 * optional input must not become an (invalid) empty override server-side. The
 * Worker name is sent whenever it is set.
 */
export function planInputs(renameAllowed: boolean, values: Readonly<Record<string, string>>, shown: readonly DeclaredInput[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  if (renameAllowed && (values.workerName ?? "") !== "") inputs.workerName = values.workerName as string;
  for (const def of shown) {
    const value = values[def.key] ?? "";
    if (value !== "") inputs[def.key] = value;
  }
  return inputs;
}

export interface PlanRequestInput {
  accountId: string;
  releaseProof: unknown;
  configText: string;
  inputs: Record<string, string | number | boolean>;
  mode: "install" | "upgrade";
  httpUnits: readonly HttpUnit[];
  domainDrafts: Readonly<Record<string, UnitDomainDraft>>;
  domainFacts: DomainsEnvelope | null;
  recordsByZone: RecordsByZone;
  hyperdriveUnits: readonly HyperdriveUnit[];
  hyperdriveChoices: HyperdriveChoices;
  names: readonly NameRow[];
  replacedSecrets: readonly string[];
  paidRiskConfirmed: boolean;
}

export function buildPlanRequest(input: PlanRequestInput): GraphPlanRequest {
  const domains = domainRequest(input.httpUnits, input.domainDrafts, input.domainFacts, input.recordsByZone);
  const names = requestNames(input.names);
  return {
    accountId: input.accountId,
    releaseProof: input.releaseProof,
    config: { text: input.configText },
    ...(Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
    mode: input.mode,
    ...(domains ? { domains } : {}),
    ...(input.hyperdriveUnits.length > 0
      ? { bindings: Object.fromEntries(input.hyperdriveUnits.map((unit) => [unit.unitId, { hyperdrive: { ...(input.hyperdriveChoices[unit.unitId] ?? {}) } }])) }
      : {}),
    ...(names ? { names } : {}),
    ...(input.mode === "upgrade" && input.replacedSecrets.length > 0 ? { replaceSecrets: [...input.replacedSecrets] } : {}),
    paidRiskConfirmed: input.paidRiskConfirmed,
  };
}
