// Small helpers shared by the deploy runner (graph-deploy-runner.ts) and the
// UI: the step state vocabulary, the guard for a verified deployment URL, and
// UI-safe error text.

export type DeployStepState = "pending" | "running" | "waiting" | "done" | "error";

// Only an https *.pages.dev / *.workers.dev address built from provider-read
// values is ever shown as the deployment link; anything else is dropped, never guessed.
export function verifiedDeploymentUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (url.hostname.endsWith(".pages.dev") || url.hostname.endsWith(".workers.dev")) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// Extract a human, redacted message from any thrown value. A deploy step may
// reject with a plain OBJECT (e.g. the browser asset uploader throws an
// `{ kind, detail }` record, not an Error); `String(object)` would otherwise
// surface the useless "[object Object]". Prefer the most specific text available.
export function safeErrorMessage(input: unknown): string {
  const message = errorText(input);
  // Never echo upstream detail or opaque tokens into the error surface. A token
  // is a long run that mixes letters and digits (ids, JWT segments, keys) or a
  // very long unbroken alphanumeric run; plain words and step/error names such as
  // "invalid-response" stay readable.
  return message.replace(/(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{24,}/g, "[redacted]");
}

function errorText(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof Error) {
    return input.message || input.name || "error";
  }
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const detail =
      typeof record.detail === "string"
        ? record.detail
        : typeof record.message === "string"
          ? record.message
          : typeof record.error === "string"
            ? record.error
            : undefined;
    if (detail && kind) {
      return `${detail} (${kind})`;
    }
    if (detail) {
      return detail;
    }
    if (kind) {
      return kind;
    }
    const issues = Array.isArray(record.issues)
      ? record.issues.filter((i): i is string => typeof i === "string")
      : [];
    if (issues.length > 0) {
      return issues.join("; ");
    }
    try {
      const json = JSON.stringify(input);
      if (json && json !== "{}") {
        return json;
      }
    } catch {
      // fall through to a generic message
    }
    return "unknown error";
  }
  return String(input);
}
