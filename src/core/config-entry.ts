// Config URL host policy, shared across Workers, Node and the browser.
//
// A user supplies `tapdeploy.config.json` by file, paste, or URL BEFORE OAuth.
// The browser fetches a config URL itself (CORS may fail; the UI offers paste or
// upload instead — there is no server proxy). This module only decides which
// URLs may be fetched (configs and release ZIPs); bounded parsing lives in
// `parseConfigV3Text`.

import { isPrivateHost } from "../release/url.js";

const URL_MAX = 2048;

export interface ConfigUrlResult {
  ok: boolean;
  error?: string;
  host?: string;
}

/**
 * Public HTTPS URL policy for anything the browser fetches (a config or a
 * release ZIP): HTTPS only, no credentials, not a private/local host, not
 * oversized. `what` names the URL in error messages.
 */
export function checkPublicHttpsUrl(raw: string, what: "config" | "release"): ConfigUrlResult {
  if (typeof raw !== "string" || raw.length > URL_MAX) {
    return { ok: false, error: "URL is not a valid string or is too long" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `malformed ${what} URL` };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: `${what} URL must use https` };
  }
  if (url.username || url.password) {
    return { ok: false, error: `${what} URL must not embed credentials` };
  }
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    return { ok: false, error: `${what} URL must not target a private/local host` };
  }
  return { ok: true, host };
}

/** Validate a config source URL before the browser fetches it. */
export function validateConfigUrl(raw: string): ConfigUrlResult {
  return checkPublicHttpsUrl(raw, "config");
}
