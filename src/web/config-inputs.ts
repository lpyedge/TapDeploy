// The inputs a config declares, read for the Configure form. The server already
// validated the config text; the defaults here only keep a hand-edited or
// partial text from breaking the form.

import { inputAskedIn, inputOptions, inputPatternProblem, inputProblem, type InputMode } from "../manifest/input-validation.js";
import type { ConfigV3Input } from "../manifest/config-v3.js";

/** A declared input as the form shows it: options already have labels. */
export type DeclaredInput = Omit<ConfigV3Input, "options"> & { options?: Array<{ label: string; value: string | number | boolean }> };

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
  const problem = inputProblem(def, mode, value) ?? inputPatternProblem(def, value);
  if (problem !== null || value === "") return problem;
  if (def.key === "workerName" && !/^[a-z0-9-]{1,63}$/.test(value)) return "lowercase letters, digits and dashes, max 63";
  return null;
}
