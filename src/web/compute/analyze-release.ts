// The Worker's verification step as a pure function, so Node tests run the exact
// code the browser Worker runs: the production verification sequence plus the
// bounded summary the Release step shows. `files` stay inside the Worker.

import type { ExtractedFile } from "../../release/zip.js";
import { summarizePrebuiltRelease, verifyPrebuiltRelease, type PrebuiltReleasePolicy, type PrebuiltReleaseRefusal, type ReleaseSummary } from "../../release/verify-prebuilt-release.js";

export type ReleaseVerdict = { ok: true; summary: ReleaseSummary; files: ExtractedFile[] } | ({ ok: false } & PrebuiltReleaseRefusal);

export async function analyzeRelease(bytes: Uint8Array, policy: PrebuiltReleasePolicy, engine: { pagesHash?: (path: string, bytes: Uint8Array) => string } = {}): Promise<ReleaseVerdict> {
  const verified = await verifyPrebuiltRelease(bytes, policy, engine);
  if (!verified.ok) return verified;
  return { ok: true, summary: summarizePrebuiltRelease(verified, policy), files: verified.files };
}
