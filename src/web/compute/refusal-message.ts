// What the operator reads when the Worker refuses the ZIP before anything is
// uploaded. The codes are the server's (the Worker runs the same checks); this only
// says what they mean for the file in front of the operator. Anything not named
// here keeps the generic "CODE; detail" rendering.

import { formatBytes } from "../lib/guarded-fetch.js";
import type { PrebuiltReleaseRefusal } from "../../release/verify-prebuilt-release.js";
import { RELEASE_MAX_BYTES } from "../../core/upload-limits.js";

export function releaseRefusalMessage(refusal: PrebuiltReleaseRefusal, context: { bytes: number; expectedSha256?: string | undefined }): string | null {
  switch (refusal.body.error) {
    case "SERVER_ZIP_VERIFY_LIMIT":
      return `This ZIP is ${formatBytes(context.bytes)}; the installer can verify up to ${formatBytes(RELEASE_MAX_BYTES)}. Nothing was uploaded.`;
    case "SOURCE_POLICY_MISMATCH":
      return context.expectedSha256
        ? `This is not the release the publisher pinned: its SHA-256 does not match ${context.expectedSha256.slice(0, 12)}… from the config. Download it again from the publisher's link. Nothing was uploaded.`
        : null;
    case "SOURCE_ORIGIN_UNATTESTED":
      return "This config only accepts the publisher's own download link, so a ZIP from this computer cannot be verified. Use the download link. Nothing was uploaded.";
    default:
      return null;
  }
}
