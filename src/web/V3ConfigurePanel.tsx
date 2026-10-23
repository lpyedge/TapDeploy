import type { ReactNode } from "react";
import { Segmented } from "./Segmented.js";
import { inputAskedIn, inputOptions, inputProblem, inputRequiredIn, type InputMode } from "../manifest/input-validation.js";
import type { ConfigV3Input } from "../manifest/config-v3.js";

/** A declared input as the form shows it: options already have labels. */
export type DeclaredInput = Omit<ConfigV3Input, "options"> & { options?: Array<{ label: string; value: string | number | boolean }> };

// The config text was already validated by the server; defaults only keep a
// hand-edited or partial text from breaking the form.
function parseInputs(configText: string): DeclaredInput[] {
  try {
    const parsed = JSON.parse(configText) as { inputs?: Array<Record<string, unknown>> };
    return (Array.isArray(parsed.inputs) ? parsed.inputs : []).flatMap((raw) => {
      if (raw === null || typeof raw !== "object" || typeof raw.key !== "string") return [];
      const input: DeclaredInput = {
        key: raw.key,
        type: (typeof raw.type === "string" ? raw.type : "string") as DeclaredInput["type"],
        label: typeof raw.label === "string" && raw.label ? raw.label : raw.key,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        ...(typeof raw.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
        ...(raw.required === false ? { required: false } : {}),
        ...(raw.upgradeKeep === true ? { upgradeKeep: true } : {}),
        ...(raw.generate === true ? { generate: true } : {}),
        ...(Array.isArray(raw.options) ? { options: inputOptions({ options: raw.options as ConfigV3Input["options"] }) } : {}),
        ...(raw.validation && typeof raw.validation === "object" ? { validation: raw.validation as DeclaredInput["validation"] } : {}),
      };
      return [input];
    });
  } catch {
    return [];
  }
}

/** The declared non-secret config inputs (the config text was already validated by the server). */
export function declaredConfigInputs(configText: string): DeclaredInput[] {
  return parseInputs(configText).filter((input) => input.type !== "secret");
}

/** The declared secret inputs. */
export function declaredSecrets(configText: string): DeclaredInput[] {
  return parseInputs(configText).filter((input) => input.type === "secret");
}

/** The declared secrets the user may replace on upgrade: the ones they enter (not generated) that upgrade asks for. */
export function changeableSecrets(configText: string): DeclaredInput[] {
  return declaredSecrets(configText).filter((input) => !input.generate && inputAskedIn(input, "upgrade"));
}

/** What is wrong with the value of an input for this mode, or null. `workerName` also has the Cloudflare name rule. */
export function inputError(def: DeclaredInput, mode: InputMode, value: string): string | null {
  const problem = inputProblem(def, mode, value);
  if (problem !== null || value === "") return problem;
  if (def.key === "workerName" && !/^[a-z0-9-]{1,63}$/.test(value)) return "lowercase letters, digits and dashes, max 63";
  return null;
}

export type V3ModeIntent = "install" | "upgrade";

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
  /** Upgrade: secrets the user may replace, and the ones chosen so far (the new value is asked on the review step). */
  secretsToChange: readonly DeclaredInput[];
  replacedSecrets: readonly string[];
  onReplaceSecret: (key: string, replace: boolean) => void;
  /** Live account Workers for the upgrade dropdown; null when unavailable (manual entry). */
  upgradeTargets: ReadonlyArray<{ name: string }> | null;
  upgradeTargetsLoading: boolean;
  upgradeTargetsError: string | null;
  onSwitchToUpgrade: () => void;
  /** Account-resource and custom-domain choices (rendered after the inputs). */
  extras?: ReactNode;
  /** Computed by the flow from busy, input validity and the machine (can PLAN_READY). */
  continueDisabled: boolean;
  onBack: () => void;
  onContinue: () => void;
}

/** Configure step: inline New | Upgrade with the Worker name control, then declared inputs. */
export function V3ConfigurePanel({
  sourceLabel,
  releaseUnits,
  workerUnitCount,
  showModeToggle,
  modeIntent,
  onModeIntent,
  renameAllowed,
  workerNameDef,
  visibleInputs,
  inputValues,
  onInputValue,
  secretsToChange,
  replacedSecrets,
  onReplaceSecret,
  upgradeTargets,
  upgradeTargetsLoading,
  upgradeTargetsError,
  onSwitchToUpgrade,
  extras,
  continueDisabled,
  onBack,
  onContinue,
}: V3ConfigurePanelProps) {
  const workerNameError = renameAllowed ? inputError({ key: "workerName", type: "string", label: "Worker name", ...(workerNameDef?.validation ? { validation: workerNameDef.validation } : {}) }, "install", inputValues.workerName ?? "") : null;
  return (
    <>
      <div className="release-summary" data-testid="v3-configure">
        <p className="m-0 flex items-center gap-2"><span className="badge badge-create">Verified</span><span className="break-all">{sourceLabel}</span></p>
        <ul className="unit-chips">
          {releaseUnits.map((unit) => (
            <li key={unit.unitId} className="chip">
              {unit.kind === "pages" ? "Pages site" : unit.kind === "resources" ? "Account resources" : "Worker"}
              {unit.name ? <strong>{unit.name}</strong> : null}
            </li>
          ))}
        </ul>
      </div>
      {showModeToggle && (
      <div className="field">
        <label id="v3-target-label">Install as</label>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="v3-target-label">
          <Segmented
            name="v3-mode"
            label="Target"
            value={modeIntent}
            onChange={onModeIntent}
            options={[
              { value: "install", label: "New Worker", testId: "v3-mode-install" },
              { value: "upgrade", label: "Upgrade existing", testId: "v3-mode-upgrade" },
            ]}
          />
          {renameAllowed && (modeIntent === "install" || upgradeTargets === null || upgradeTargets.length === 0 ? (
            <input
              id="v3-input-workerName"
              type="text"
              className="flex-1"
              aria-label="Worker name"
              value={inputValues.workerName ?? ""}
              placeholder={workerNameDef?.placeholder ?? "my-worker"}
              onChange={(e) => onInputValue("workerName", e.target.value)}
              data-testid="v3-input-workerName"
            />
          ) : (
            <select
              id="v3-upgrade-target"
              className="flex-1"
              aria-label="Existing Worker to upgrade"
              value={inputValues.workerName ?? ""}
              onChange={(e) => onInputValue("workerName", e.target.value)}
              data-testid="v3-upgrade-target"
              disabled={upgradeTargetsLoading}
            >
              <option value="">{upgradeTargetsLoading ? "Loading workers…" : "Select an existing Worker…"}</option>
              {(() => {
                const names = upgradeTargets.map((t) => t.name);
                const current = inputValues.workerName ?? "";
                const options = current !== "" && !names.includes(current) ? [current, ...names] : names;
                return options.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ));
              })()}
            </select>
          ))}
        </div>
        <p className="meta">{modeIntent === "install" ? "Creates a new Worker with this name." : "Updates the live Worker in place; its settings, secrets and data are kept."} You review every change before anything is written.</p>
        {modeIntent === "install" && renameAllowed && (upgradeTargets ?? []).some((target) => target.name === (inputValues.workerName ?? "")) && (
          <p className="warn-block mt-2 text-sm text-amber-900" data-testid="v3-name-taken">
            A Worker named <strong>{inputValues.workerName}</strong> already exists in this account. New never changes a live Worker —{" "}
            <button type="button" className="link" onClick={() => onSwitchToUpgrade()} data-testid="v3-switch-to-upgrade">upgrade it instead</button> or choose another name.
          </p>
        )}
        {modeIntent === "upgrade" && upgradeTargetsError && (
          <p className="meta">Could not list account Workers ({upgradeTargetsError}); type the exact name instead.</p>
        )}
        {workerNameDef?.description && <p className="meta">{workerNameDef.description}</p>}
        {renameAllowed && workerNameError && (
          <p className="error" data-testid="v3-input-workerName-error">{workerNameError}</p>
        )}
      </div>
      )}
      {workerUnitCount > 1 && (
        <p className="meta">This release has several worker units: names stay release-declared (a single rename cannot address one unit of several).</p>
      )}
      {visibleInputs.length === 0 && !renameAllowed && (modeIntent !== "upgrade" || secretsToChange.length === 0) && (
        <p className="meta" data-testid="v3-no-inputs">This config declares no operator inputs; the release names apply as-is.</p>
      )}
      {visibleInputs.map((def) => {
        const id = `v3-input-${def.key}`;
        const value = inputValues[def.key] ?? "";
        const problem = inputError(def, modeIntent, value);
        const chosen = value === "" ? [] : value.split(",");
        return (
          <div className="field" key={def.key}>
            <label htmlFor={id}>{def.label}{inputRequiredIn(def, modeIntent) ? " (required)" : ""}</label>
            {def.type === "select" && def.options ? (
              <select id={id} value={value} onChange={(e) => onInputValue(def.key, e.target.value)} data-testid={id}>
                <option value="">Select…</option>
                {def.options.map((o, i) => (
                  <option key={i} value={String(o.value)}>{o.label}</option>
                ))}
              </select>
            ) : def.type === "multiselect" && def.options ? (
              <div className="flex flex-col gap-1" role="group" aria-label={def.label} data-testid={id}>
                {def.options.map((o) => (
                  <label key={String(o.value)} className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={chosen.includes(String(o.value))}
                      onChange={(e) => onInputValue(def.key, def.options!.map((option) => String(option.value)).filter((item) => (item === String(o.value) ? e.target.checked : chosen.includes(item))).join(","))}
                      data-testid={`${id}-${String(o.value)}`}
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            ) : def.type === "boolean" ? (
              <input id={id} type="checkbox" checked={value === "true"} onChange={(e) => onInputValue(def.key, e.target.checked ? "true" : "")} data-testid={id} />
            ) : (
              <input
                id={id}
                type={def.type === "integer" || def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
                value={value}
                placeholder={def.placeholder ?? ""}
                onChange={(e) => onInputValue(def.key, e.target.value)}
                data-testid={id}
              />
            )}
            {def.description && <p className="meta">{def.description}</p>}
            {modeIntent === "upgrade" && !inputRequiredIn(def, "upgrade") && <p className="meta">Leave empty to keep the current value.</p>}
            {problem && <p className="error" data-testid={`${id}-error`}>{problem}</p>}
          </div>
        );
      })}
      {modeIntent === "upgrade" && secretsToChange.length > 0 && (
        <div className="field" data-testid="v3-secrets-change">
          <label>Secrets</label>
          <p className="meta">Kept as they are today unless you choose to change one; you enter the new value on the next step.</p>
          {secretsToChange.map((def) => (
            <label key={def.key} className="inline-flex items-center gap-2">
              <input type="checkbox" checked={replacedSecrets.includes(def.key)} onChange={(e) => onReplaceSecret(def.key, e.target.checked)} data-testid={`v3-secret-change-${def.key}`} />
              <span>Change {def.label}</span>
            </label>
          ))}
        </div>
      )}
      {extras}
      <div className="actionbar">
        <button type="button" className="link text-sm" onClick={() => onBack()} data-testid="v3-back-to-source">Back</button>
        <button type="button" className="primary" disabled={continueDisabled} onClick={() => onContinue()} data-testid="v3-to-deploy">Review changes</button>
      </div>
    </>
  );
}
