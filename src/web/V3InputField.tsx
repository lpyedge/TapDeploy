// One declared input as a form control chosen by its type, with its label,
// description and validation message.

import type { DeclaredInput } from "./config-inputs.js";
import { inputError } from "./config-inputs.js";
import { inputRequiredIn, type InputMode } from "../manifest/input-validation.js";

export interface V3InputFieldProps {
  def: DeclaredInput;
  mode: InputMode;
  value: string;
  onChange: (value: string) => void;
}

function Control({ def, value, onChange }: Omit<V3InputFieldProps, "mode">) {
  const id = `v3-input-${def.key}`;
  const options = def.options ?? [];
  switch (def.type) {
    case "select":
      return (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} data-testid={id}>
          <option value="">Select…</option>
          {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
        </select>
      );
    case "multiselect": {
      const chosen = value === "" ? [] : value.split(",");
      // Keep the declared order whatever order the boxes are ticked in.
      const toggle = (optionValue: string, checked: boolean) =>
        onChange(options.map((option) => String(option.value)).filter((item) => (item === optionValue ? checked : chosen.includes(item))).join(","));
      return (
        <div className="flex flex-col gap-1" role="group" aria-label={def.label} data-testid={id}>
          {options.map((option) => (
            <label key={String(option.value)} className="inline-flex items-center gap-2">
              <input type="checkbox" checked={chosen.includes(String(option.value))} onChange={(e) => toggle(String(option.value), e.target.checked)} data-testid={`${id}-${String(option.value)}`} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      );
    }
    case "boolean":
      return <input id={id} type="checkbox" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "")} data-testid={id} />;
    default:
      return (
        <input
          id={id}
          type={def.type === "integer" || def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
          value={value}
          placeholder={def.placeholder ?? ""}
          onChange={(e) => onChange(e.target.value)}
          data-testid={id}
        />
      );
  }
}

export function V3InputField({ def, mode, value, onChange }: V3InputFieldProps) {
  const problem = inputError(def, mode, value);
  return (
    <div className="field">
      <label htmlFor={`v3-input-${def.key}`}>{def.label}{inputRequiredIn(def, mode) ? " (required)" : ""}</label>
      <Control def={def} value={value} onChange={onChange} />
      {def.description && <p className="meta">{def.description}</p>}
      {mode === "upgrade" && <p className="meta">Leave empty to keep the current value.</p>}
      {problem && <p className="error" data-testid={`v3-input-${def.key}-error`}>{problem}</p>}
    </div>
  );
}
