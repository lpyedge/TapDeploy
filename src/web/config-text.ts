// Address-only reads of the config text for display and routing. Not
// validation: the server validates the config authoritatively at OAuth start
// and at every prepare/plan boundary.

function parse(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The app id of a v3 config, or null when the text is not one. */
export function v3AppId(text: string): string | null {
  const config = parse(text);
  if (config?.schemaVersion !== 3) return null;
  const id = record(config.app)?.id;
  return typeof id === "string" && id ? id : null;
}

/** The app's display name, falling back to its id. */
export function appDisplayName(text: string, fallback: string): string {
  const name = record(parse(text)?.app)?.name;
  return typeof name === "string" && name ? name : fallback;
}

/** The release ZIP address the config suggests, or "". */
export function defaultSourceUrl(text: string): string {
  const url = record(parse(text)?.source)?.defaultUrl;
  return typeof url === "string" ? url : "";
}
