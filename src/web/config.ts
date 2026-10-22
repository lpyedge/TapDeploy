// Browser-side config fetch for the entry step. A config address must be HTTPS
// and not a private host; the body is size-bounded before it is read. Nothing
// is validated here beyond that: the server validates the Config V3 text
// authoritatively when authorization starts and again at prepare/plan. There is
// NO server proxy: a CORS refusal surfaces as an error and the operator can
// paste the JSON instead.

import { validateConfigUrl } from "../core/config-entry.js";
import { CONFIG_V3_MAX_BYTES as CONFIG_MAX_BYTES } from "../manifest/config-v3.js";
import { DownloadRefusedError, fetchBounded } from "./lib/guarded-fetch.js";

const CONFIG_FETCH_TIMEOUT_MS = 15_000;

class ConfigError extends Error {
  readonly kind = "config-error";
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.field = field;
  }
}

export async function fetchConfigText(rawUrl: string): Promise<string> {
  const validated = validateConfigUrl(rawUrl);
  if (!validated.ok) {
    throw new ConfigError(validated.error ?? "invalid config URL", "$source.url");
  }
  try {
    const bytes = await fetchBounded(rawUrl, {
      maxBytes: CONFIG_MAX_BYTES,
      accept: "application/json",
      timeoutMs: CONFIG_FETCH_TIMEOUT_MS,
      label: "config",
      checkFinalUrl: (url) => (validateConfigUrl(url).ok ? null : "config redirected to a disallowed URL"),
    });
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof DownloadRefusedError) throw new ConfigError(error.message, error.field);
    throw error;
  }
}
