// The source policy rebuilt from the config text the operator authorized, so
// the Worker can refuse a bad ZIP before it is uploaded. The server stays
// authoritative: it derives the same policy from the same config at
// /api/deploy/prepare and re-verifies the ZIP there.

import { sourcePolicyFromConfig } from "../../auth/oauth-tx.js";
import { parseConfigV3Text, type ConfigV3 } from "../../manifest/config-v3.js";
import type { PrebuiltReleasePolicy } from "../../release/verify-prebuilt-release.js";

export function releasePolicyFromConfigText(text: string): PrebuiltReleasePolicy | null {
  const parsed = parseConfigV3Text(text);
  if (!parsed.ok) return null;
  const config = parsed.value as ConfigV3;
  if (typeof config?.app?.id !== "string" || typeof config.source !== "object" || config.source === null) return null;
  return sourcePolicyFromConfig(config);
}
