// The source policy the server holds in the session, rebuilt from the config
// text the operator authorized so the Worker can refuse a bad ZIP before it is
// uploaded. The server's session copy stays authoritative: it validated this
// same config at OAuth start and re-verifies the ZIP at /api/deploy/prepare.

import { sourcePolicyUnits } from "../../auth/oauth-tx.js";
import { parseConfigV3Text, type ConfigV3 } from "../../manifest/config-v3.js";
import type { PrebuiltReleasePolicy } from "../../release/verify-prebuilt-release.js";

export function releasePolicyFromConfigText(text: string): PrebuiltReleasePolicy | null {
  const parsed = parseConfigV3Text(text);
  if (!parsed.ok) return null;
  const config = parsed.value as ConfigV3;
  if (typeof config?.app?.id !== "string" || typeof config.source !== "object" || config.source === null) return null;
  return {
    ...(config.source.defaultUrl !== undefined ? { defaultUrl: config.source.defaultUrl } : {}),
    allowLocalZip: config.source.allowLocalZip ?? true,
    ...(config.source.expectedSha256 !== undefined ? { expectedSha256: config.source.expectedSha256 } : {}),
    appId: config.app.id,
    units: sourcePolicyUnits(config),
  };
}
