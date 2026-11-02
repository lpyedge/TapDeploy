// Config V3 inputs: which ones a mode asks for, and whether a value is valid.
//
// The browser uses this to guide the user and the server re-runs it on the
// plan request, so one definition decides what a declared input accepts.
// Values arrive as strings (a multiselect joins its choices with commas).
// The one exception is `validation.pattern`: a publisher's regular expression
// can backtrack exponentially on a crafted value, so only the browser runs it
// (`inputPatternProblem`). The server never evaluates a config's regex on
// request input; the value only lands in the operator's own Worker.

import type { ConfigV3Input } from "./config-v3.js";

export type InputMode = "install" | "upgrade";

type ModeFields = Pick<ConfigV3Input, "required" | "upgradeKeep">;
type ValueRule = Pick<ConfigV3Input, "type" | "options" | "validation">;

/** Install asks for every input; upgrade skips the ones the publisher keeps (`upgradeKeep`). */
export function inputAskedIn(input: ModeFields, mode: InputMode): boolean {
  return mode === "install" || input.upgradeKeep !== true;
}

/** Required at install only: on upgrade an empty value keeps what is deployed. */
export function inputRequiredIn(input: ModeFields, mode: InputMode): boolean {
  return mode === "install" && input.required !== false;
}

/** The choices of a select / multiselect, each with a label and a value. */
export function inputOptions(input: Pick<ConfigV3Input, "options">): Array<{ label: string; value: string | number | boolean }> {
  return (input.options ?? []).map((option) => (typeof option === "object" ? { label: option.label || String(option.value), value: option.value } : { label: String(option), value: option }));
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The problem with `value` for this input, or null when it is acceptable (an
 * empty value is not checked here). Everything but the declared pattern: this is
 * what the server enforces.
 */
export function inputValueProblem(rule: ValueRule, value: string): string | null {
  const v = rule.validation ?? {};
  const optionValues = inputOptions(rule).map((option) => String(option.value));
  switch (rule.type) {
    case "integer":
      if (!/^-?\d+$/.test(value)) return "a whole number";
      break;
    case "number":
      if (value.trim() === "" || !Number.isFinite(Number(value))) return "a number";
      break;
    case "boolean":
      if (value !== "true" && value !== "false") return "true or false";
      break;
    case "date":
      if (!isCalendarDate(value)) return "a date as YYYY-MM-DD";
      break;
    case "select":
      if (!optionValues.includes(value)) return "one of the listed options";
      break;
    case "multiselect": {
      const chosen = value.split(",");
      if (new Set(chosen).size !== chosen.length || chosen.some((item) => !optionValues.includes(item))) return "only the listed options";
      break;
    }
    default:
      break;
  }
  if (rule.type === "integer" || rule.type === "number") {
    if (typeof v.minimum === "number" && Number(value) < v.minimum) return `at least ${v.minimum}`;
    if (typeof v.maximum === "number" && Number(value) > v.maximum) return `at most ${v.maximum}`;
  }
  if (typeof v.minLength === "number" && value.length < v.minLength) return `at least ${v.minLength} characters`;
  if (typeof v.maxLength === "number" && value.length > v.maxLength) return `at most ${v.maxLength} characters`;
  if (v.values && !v.values.map(String).includes(value)) return "one of the allowed values";
  return null;
}

/** Browser only: the declared pattern must match the whole value (see the note at the top). */
export function inputPatternProblem(rule: ValueRule, value: string): string | null {
  const pattern = rule.validation?.pattern;
  if (typeof pattern !== "string" || value === "") return null;
  try {
    return new RegExp(`^(?:${pattern})$`).test(value) ? null : "invalid format";
  } catch {
    return "invalid declared pattern";
  }
}

/** `required` when empty and needed; otherwise the value problem, if any. */
export function inputProblem(input: ModeFields & ValueRule, mode: InputMode, value: string): string | null {
  if (value === "") return inputRequiredIn(input, mode) ? "required" : null;
  return inputValueProblem(input, value);
}
