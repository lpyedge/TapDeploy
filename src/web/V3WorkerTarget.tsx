// "Install as": a new Worker or an upgrade of an existing one, with the
// Worker's name (typed for a new Worker, picked from the account for an
// upgrade). The name is always required; the server re-validates it.

import { Segmented } from "./Segmented.js";
import type { DeclaredInput } from "./config-inputs.js";
import { inputError } from "./config-inputs.js";
import type { InputMode } from "../manifest/input-validation.js";

export interface V3WorkerTargetProps {
  mode: InputMode;
  onMode: (mode: InputMode) => void;
  /** A flat Worker name can address exactly one Worker unit. */
  renameAllowed: boolean;
  /** The config's own `workerName` input, if any: constrains the name. */
  nameDef: DeclaredInput | undefined;
  name: string;
  onName: (name: string) => void;
  /** Live account Workers for the upgrade dropdown; null when unavailable (manual entry). */
  targets: ReadonlyArray<{ name: string }> | null;
  targetsLoading: boolean;
  targetsError: string | null;
  onSwitchToUpgrade: () => void;
}

export function workerNameError(nameDef: DeclaredInput | undefined, name: string): string | null {
  return inputError({ key: "workerName", type: "string", label: "Worker name", ...(nameDef?.validation ? { validation: nameDef.validation } : {}) }, "install", name);
}

export function V3WorkerTarget({ mode, onMode, renameAllowed, nameDef, name, onName, targets, targetsLoading, targetsError, onSwitchToUpgrade }: V3WorkerTargetProps) {
  // Upgrade picks from the account's Workers; without a list the name is typed.
  const choices = mode === "upgrade" && targets !== null && targets.length > 0 ? targets : null;
  const nameTaken = mode === "install" && renameAllowed && (targets ?? []).some((target) => target.name === name);
  const error = renameAllowed ? workerNameError(nameDef, name) : null;
  return (
    <div className="field">
      <label id="v3-target-label">Install as</label>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="v3-target-label">
        <Segmented
          name="v3-mode"
          label="Target"
          value={mode}
          onChange={onMode}
          options={[
            { value: "install", label: "New Worker", testId: "v3-mode-install" },
            { value: "upgrade", label: "Upgrade existing", testId: "v3-mode-upgrade" },
          ]}
        />
        {renameAllowed && (choices === null ? (
          <input
            id="v3-input-workerName"
            type="text"
            className="flex-1"
            aria-label="Worker name"
            value={name}
            placeholder={nameDef?.placeholder ?? "my-worker"}
            onChange={(e) => onName(e.target.value)}
            data-testid="v3-input-workerName"
          />
        ) : (
          <select
            id="v3-upgrade-target"
            className="flex-1"
            aria-label="Existing Worker to upgrade"
            value={name}
            onChange={(e) => onName(e.target.value)}
            data-testid="v3-upgrade-target"
            disabled={targetsLoading}
          >
            <option value="">{targetsLoading ? "Loading workers…" : "Select an existing Worker…"}</option>
            {(name !== "" && !choices.some((target) => target.name === name) ? [name] : []).concat(choices.map((target) => target.name)).map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        ))}
      </div>
      <p className="meta">{mode === "install" ? "Creates a new Worker with this name." : "Updates the live Worker in place; its settings, secrets and data are kept."} You review every change before anything is written.</p>
      {nameTaken && (
        <p className="warn-block mt-2 text-sm text-amber-900" data-testid="v3-name-taken">
          A Worker named <strong>{name}</strong> already exists in this account. New never changes a live Worker —{" "}
          <button type="button" className="link" onClick={() => onSwitchToUpgrade()} data-testid="v3-switch-to-upgrade">upgrade it instead</button> or choose another name.
        </p>
      )}
      {mode === "upgrade" && targetsError && <p className="meta">Could not list account Workers ({targetsError}); type the exact name instead.</p>}
      {nameDef?.description && <p className="meta">{nameDef.description}</p>}
      {error && <p className="error" data-testid="v3-input-workerName-error">{error}</p>}
    </div>
  );
}
