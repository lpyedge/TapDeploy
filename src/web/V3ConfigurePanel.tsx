import type { ReactNode } from "react";
import { Segmented } from "./Segmented.js";

export interface DeclaredInputValidation {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

export interface DeclaredInput {
  key: string;
  type: string;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  options?: Array<{ label: string; value: string | number | boolean }>;
  validation?: DeclaredInputValidation;
}

/**
 * Declared non-secret config inputs for the configure stage. The server
 * re-validates everything; this is collection only and never persisted.
 */
export function declaredConfigInputs(configText: string): DeclaredInput[] {
  try {
    const parsed = JSON.parse(configText) as { inputs?: Array<Record<string, unknown>> };
    const list = Array.isArray(parsed.inputs) ? parsed.inputs : [];
    return list
      .filter((i) => i && typeof i === "object" && (i as { type?: unknown }).type !== "secret" && typeof (i as { key?: unknown }).key === "string")
      .map((i) => {
        const r = i as Record<string, unknown>;
        return {
          key: r.key as string,
          type: typeof r.type === "string" ? r.type : "string",
          label: typeof r.label === "string" && r.label ? r.label : (r.key as string),
          ...(typeof r.description === "string" ? { description: r.description } : {}),
          ...(typeof r.placeholder === "string" ? { placeholder: r.placeholder } : {}),
          required: (r.requiredWhen as string) !== "never",
          ...(Array.isArray(r.options) ? { options: (r.options as Array<Record<string, unknown>>).filter((o) => o && typeof o === "object").map((o) => ({ label: String(o.label ?? o.value), value: (o.value as string | number | boolean) ?? "" })) } : {}),
          ...(r.validation && typeof r.validation === "object" ? { validation: r.validation as { minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number } } : {}),
        };
      });
  } catch {
    return [];
  }
}

export function inputError(key: string, value: string, def: { required: boolean; validation?: DeclaredInputValidation }): string | null {
  if (value === "") return def.required ? "required" : null;
  const v = def.validation ?? {};
  if (typeof v.minLength === "number" && value.length < v.minLength) return `at least ${v.minLength} characters`;
  if (typeof v.maxLength === "number" && value.length > v.maxLength) return `at most ${v.maxLength} characters`;
  if (typeof v.pattern === "string") {
    try {
      if (!new RegExp(`^(?:${v.pattern})$`).test(value)) return "invalid format";
    } catch {
      return "invalid declared pattern";
    }
  }
  if (key === "workerName" && !/^[a-z0-9-]{1,63}$/.test(value)) return "lowercase letters, digits and dashes, max 63";
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
  visibleInputs: readonly DeclaredInput[];
  inputValues: Readonly<Record<string, string>>;
  onInputValue: (key: string, value: string) => void;
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
  upgradeTargets,
  upgradeTargetsLoading,
  upgradeTargetsError,
  onSwitchToUpgrade,
  extras,
  continueDisabled,
  onBack,
  onContinue,
}: V3ConfigurePanelProps) {
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
        {renameAllowed && inputError("workerName", inputValues.workerName ?? "", { required: true, validation: workerNameDef?.validation }) && (
          <p className="error" data-testid="v3-input-workerName-error">{inputError("workerName", inputValues.workerName ?? "", { required: true, validation: workerNameDef?.validation })}</p>
        )}
      </div>
      )}
      {workerUnitCount > 1 && (
        <p className="meta">This release has several worker units: names stay release-declared (a single rename cannot address one unit of several).</p>
      )}
      {visibleInputs.length === 0 && !renameAllowed && (
        <p className="meta" data-testid="v3-no-inputs">This config declares no operator inputs; the release names apply as-is.</p>
      )}
      {visibleInputs.map((def) => (
        <div className="field" key={def.key}>
          <label htmlFor={`v3-input-${def.key}`}>{def.label}{def.required ? " (required)" : ""}</label>
          {def.type === "select" && def.options ? (
            <select
              id={`v3-input-${def.key}`}
              value={inputValues[def.key] ?? ""}
              onChange={(e) => onInputValue(def.key, e.target.value)}
              data-testid={`v3-input-${def.key}`}
            >
              <option value="">Select…</option>
              {def.options.map((o, i) => (
                <option key={i} value={String(o.value)}>{o.label}</option>
              ))}
            </select>
          ) : def.type === "boolean" ? (
            <input
              id={`v3-input-${def.key}`}
              type="checkbox"
              checked={(inputValues[def.key] ?? "") === "true"}
              onChange={(e) => onInputValue(def.key, e.target.checked ? "true" : "")}
              data-testid={`v3-input-${def.key}`}
            />
          ) : (
            <input
              id={`v3-input-${def.key}`}
              type={def.type === "integer" || def.type === "number" ? "number" : "text"}
              value={inputValues[def.key] ?? ""}
              placeholder={def.placeholder ?? ""}
              onChange={(e) => onInputValue(def.key, e.target.value)}
              data-testid={`v3-input-${def.key}`}
            />
          )}
          {def.description && <p className="meta">{def.description}</p>}
          {inputError(def.key, inputValues[def.key] ?? "", def) && (
            <p className="error" data-testid={`v3-input-${def.key}-error`}>{inputError(def.key, inputValues[def.key] ?? "", def)}</p>
          )}
        </div>
      ))}
      {extras}
      <div className="actionbar">
        <button type="button" className="link text-sm" onClick={() => onBack()} data-testid="v3-back-to-source">Back</button>
        <button type="button" className="primary" disabled={continueDisabled} onClick={() => onContinue()} data-testid="v3-to-deploy">Review changes</button>
      </div>
    </>
  );
}
