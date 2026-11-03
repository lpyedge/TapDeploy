// Configure step. What the user must answer comes first (the Worker, required
// inputs, Hyperdrive); everything optional sits in collapsed sections that show
// their current state and open on demand.

import type { ReactNode } from "react";
import { Disclosure } from "./Disclosure.js";
import { Spinner } from "./Spinner.js";
import { inputError, type DeclaredInput } from "./config-inputs.js";
import { V3InputField } from "./V3InputField.js";
import { V3WorkerTarget, type V3WorkerTargetProps } from "./V3WorkerTarget.js";
import { secretValueProblem, type SecretRow } from "./secret-choices.js";
import { inputRequiredIn, type InputMode } from "../manifest/input-validation.js";

type V3ModeIntent = InputMode;

export interface V3ConfigurePanelProps {
  /** Label of the sealed release source and its prepared units (names are release-declared). */
  sourceLabel: string;
  releaseUnits: ReadonlyArray<{ unitId: string; kind: string; name: string }>;
  workerUnitCount: number;
  showModeToggle: boolean;
  modeIntent: V3ModeIntent;
  onModeIntent: (mode: V3ModeIntent) => void;
  /** A flat Worker name can address exactly one Worker unit. */
  renameAllowed: boolean;
  workerNameDef: DeclaredInput | undefined;
  /** The non-secret inputs this mode asks for. */
  visibleInputs: readonly DeclaredInput[];
  inputValues: Readonly<Record<string, string>>;
  onInputValue: (key: string, value: string) => void;
  /** The declared secrets this mode asks for: required ones, and (upgrade) ones kept unless the user changes them. */
  secretRows: readonly SecretRow[];
  /** Upgrade: the kept secrets the user chose to change. */
  replacedSecrets: readonly string[];
  onReplaceSecret: (key: string, replace: boolean) => void;
  secretValues: Readonly<Record<string, string>>;
  onSecretValue: (key: string, value: string) => void;
  upgradeTargets: V3WorkerTargetProps["targets"];
  upgradeTargetsLoading: boolean;
  upgradeTargetsError: string | null;
  onSwitchToUpgrade: () => void;
  /** Choices that must be made (Hyperdrive), shown with the required inputs. */
  required?: ReactNode;
  /** Optional choices (resource names, custom domains), each a collapsed section. */
  optional?: ReactNode;
  /** Whether `optional` renders anything, so the "Optional" heading is not left empty. */
  hasOptional?: boolean;
  /** Computed by the flow from busy, input validity and the machine (can PLAN_READY). */
  continueDisabled: boolean;
  /** The plan is being made: planning reads the live account, which takes a few seconds. */
  planning: boolean;
  onBack: () => void;
  onContinue: () => void;
}

const UNIT_LABEL: Record<string, string> = { pages: "Pages site", resources: "Account resources", worker: "Worker" };

function ReleaseSummary({ sourceLabel, units }: { sourceLabel: string; units: V3ConfigurePanelProps["releaseUnits"] }) {
  return (
    <div className="release-summary" data-testid="v3-configure">
      <p className="m-0 flex items-center gap-2"><span className="badge badge-create">Verified</span><span className="break-all">{sourceLabel}</span></p>
      <ul className="unit-chips">
        {units.map((unit) => (
          <li key={unit.unitId} className="chip">
            {UNIT_LABEL[unit.kind] ?? "Worker"}
            {unit.name ? <strong>{unit.name}</strong> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function optionalInputsSummary(mode: InputMode, setCount: number, total: number, replaced: number): string {
  const parts = [`${setCount} of ${total} set`];
  if (replaced > 0) parts.push(`${replaced} secret${replaced === 1 ? "" : "s"} to change`);
  return mode === "upgrade" ? `${parts.join(", ")} · empty keeps the current value` : parts.join(", ");
}

function SecretField({ def, value, onChange, note }: { def: DeclaredInput; value: string; onChange: (value: string) => void; note?: string }) {
  const problem = secretValueProblem(def, value);
  return (
    <div className="field">
      <label htmlFor={`v3-secret-${def.key}`}>{def.label}</label>
      <input id={`v3-secret-${def.key}`} type="password" autoComplete="new-password" value={value} placeholder={def.placeholder ?? ""} onChange={(e) => onChange(e.target.value)} data-testid={`v3-secret-${def.key}`} />
      {note && <p className="meta" data-testid={`v3-secret-${def.key}-note`}>{note}</p>}
      {def.description && <p className="meta">{def.description}</p>}
      {problem && <p className="error" data-testid={`v3-secret-${def.key}-error`}>{problem}</p>}
    </div>
  );
}

const SECRET_NOTE = "Secret values are sent only with the Worker upload: never with the plan, never stored in this page.";

export function V3ConfigurePanel(props: V3ConfigurePanelProps) {
  const { modeIntent, visibleInputs, inputValues, onInputValue, secretRows, replacedSecrets, secretValues, onSecretValue } = props;
  const requiredInputs = visibleInputs.filter((def) => inputRequiredIn(def, modeIntent));
  const optionalInputs = visibleInputs.filter((def) => !inputRequiredIn(def, modeIntent));
  const requiredSecrets = secretRows.filter((row) => row.required);
  const keptSecrets = secretRows.filter((row) => !row.required);
  const hasOptionalInputs = optionalInputs.length + keptSecrets.length > 0;
  const setCount = optionalInputs.filter((def) => (inputValues[def.key] ?? "") !== "").length;
  const optionalInvalid = optionalInputs.some((def) => inputError(def, modeIntent, inputValues[def.key] ?? "") !== null)
    || keptSecrets.some((row) => replacedSecrets.includes(row.def.key) && secretValueProblem(row.def, secretValues[row.def.key] ?? "") !== null);
  const noInputs = visibleInputs.length === 0 && !props.renameAllowed && secretRows.length === 0;
  const field = (def: DeclaredInput) => (
    <V3InputField key={def.key} def={def} mode={modeIntent} value={inputValues[def.key] ?? ""} onChange={(value) => onInputValue(def.key, value)} />
  );
  const secretField = (row: SecretRow) => (
    <SecretField
      key={row.def.key}
      def={row.def}
      value={secretValues[row.def.key] ?? ""}
      onChange={(value) => onSecretValue(row.def.key, value)}
      {...(row.missing ? { note: `This Worker has no ${row.def.label} yet, so there is no current value to keep.` } : {})}
    />
  );
  return (
    <fieldset disabled={props.planning} className="m-0 min-w-0 border-0 p-0">
      <ReleaseSummary sourceLabel={props.sourceLabel} units={props.releaseUnits} />
      {props.showModeToggle && (
        <V3WorkerTarget
          mode={modeIntent}
          onMode={props.onModeIntent}
          renameAllowed={props.renameAllowed}
          nameDef={props.workerNameDef}
          name={inputValues.workerName ?? ""}
          onName={(name) => onInputValue("workerName", name)}
          targets={props.upgradeTargets}
          targetsLoading={props.upgradeTargetsLoading}
          targetsError={props.upgradeTargetsError}
          onSwitchToUpgrade={props.onSwitchToUpgrade}
        />
      )}
      {props.workerUnitCount > 1 && (
        <p className="meta">This release has several worker units: names stay release-declared (a single rename cannot address one unit of several).</p>
      )}
      {noInputs && <p className="meta" data-testid="v3-no-inputs">This config declares no operator inputs; the release names apply as-is.</p>}
      {requiredInputs.map(field)}
      {requiredSecrets.length > 0 && (
        <div data-testid="v3-secrets-required">
          {requiredSecrets.map(secretField)}
          <p className="meta">{SECRET_NOTE}</p>
        </div>
      )}
      {props.required}
      {(hasOptionalInputs || props.hasOptional) && <h3 className="section-label">Optional</h3>}
      {hasOptionalInputs && (
        <Disclosure
          testId="v3-optional-inputs"
          title={modeIntent === "upgrade" ? "Settings" : "Optional settings"}
          summary={optionalInputsSummary(modeIntent, setCount, optionalInputs.length, keptSecrets.filter((row) => replacedSecrets.includes(row.def.key)).length)}
          forceOpen={optionalInvalid}
        >
          {optionalInputs.map(field)}
          {keptSecrets.length > 0 && (
            <div className="field" data-testid="v3-secrets-change">
              <label>Secrets</label>
              <p className="meta">Kept as they are today unless you choose to change one.</p>
              {keptSecrets.map(({ def }) => (
                <div key={def.key}>
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={replacedSecrets.includes(def.key)} onChange={(e) => props.onReplaceSecret(def.key, e.target.checked)} data-testid={`v3-secret-change-${def.key}`} />
                    <span>Change {def.label}</span>
                  </label>
                  {replacedSecrets.includes(def.key) && <SecretField def={{ ...def, label: `New ${def.label}` }} value={secretValues[def.key] ?? ""} onChange={(value) => onSecretValue(def.key, value)} />}
                </div>
              ))}
              {replacedSecrets.length > 0 && <p className="meta">{SECRET_NOTE}</p>}
            </div>
          )}
        </Disclosure>
      )}
      {props.optional}
      <div className="actionbar">
        <button type="button" className="link text-sm" onClick={() => props.onBack()} data-testid="v3-back-to-source">Back</button>
        <button type="button" className="primary" disabled={props.continueDisabled} aria-busy={props.planning} onClick={() => props.onContinue()} data-testid="v3-to-deploy">
          {props.planning ? <><Spinner />Checking with Cloudflare…</> : "Review changes"}
        </button>
      </div>
      {props.planning && <p className="meta" role="status" data-testid="v3-planning">Reading your account to build the plan. This can take up to a minute; nothing is written yet.</p>}
    </fieldset>
  );
}
