// The prebuilt-release verification sequence shared by the authenticated
// /api/deploy/prepare route (the only place a release proof is issued) and the
// browser compute Worker (early feedback only, never authority). One pure
// implementation means the browser can neither accept what the server rejects
// nor drift from its error codes.

import { RELEASE_MAX_BYTES } from "../core/upload-limits.js";
import { releaseResourceNames, type ReleaseResourceName } from "../core/planning/resource-names.js";
import { buildPerUnitBundles, type PerUnitBundlesResult } from "./per-unit-bundles.js";
import { extractPrebuiltZip, type PrebuiltZipFile, type PrebuiltZipManifest } from "./prebuilt-zip.js";

const MAX_VERIFIED_ZIP_EXPANDED = 24 * 1024 * 1024;

/** What a config requires of its release (`sourcePolicyFromConfig`, src/auth/oauth-tx.ts). */
export interface PrebuiltReleasePolicy {
  defaultUrl?: string;
  allowLocalZip: boolean;
  expectedSha256?: string;
  appId: string;
  units: Array<{ id: string; kind: "worker" | "pages" | "resources"; wrangler?: string; resources?: Array<{ kind: string; name: string; upgradeKeep: boolean }> }>;
}

export interface PrebuiltReleaseRefusal {
  status: 400 | 403 | 409 | 413;
  body: { error: string; detail?: string; limit?: number };
}

export type PrebuiltReleaseVerification =
  | { ok: true; manifest: PrebuiltZipManifest; files: PrebuiltZipFile[]; perUnit: PerUnitBundlesResult }
  | ({ ok: false } & PrebuiltReleaseRefusal);

export async function verifyPrebuiltRelease(bytes: Uint8Array, policy: PrebuiltReleasePolicy, engine: { pagesHash?: (path: string, bytes: Uint8Array) => string } = {}): Promise<PrebuiltReleaseVerification> {
  if (bytes.byteLength > RELEASE_MAX_BYTES) return { ok: false, status: 413, body: { error: "SERVER_ZIP_VERIFY_LIMIT", limit: RELEASE_MAX_BYTES } };
  const result = await extractPrebuiltZip(bytes, { maxArchiveBytes: RELEASE_MAX_BYTES, allowResourceOnly: policy.units.every((unit) => unit.kind === "resources") === true, bounds: { maxTotalUncompressed: MAX_VERIFIED_ZIP_EXPANDED, maxPerFile: 8 * 1024 * 1024, maxFiles: 1024, maxCompressionRatio: 100, maxPathDepth: 16 } });
  if (!result.ok || !result.manifest) return { ok: false, status: 400, body: { error: "INVALID_PREBUILT_ZIP", detail: result.errors[0] } };
  // A browser-selected archive cannot establish URL provenance.  Configs that
  // forbid local archives must have a pinned archive hash before a proof can be
  // issued; a later server fetch may provide a stronger policy.
  if (policy.allowLocalZip === false && !policy.expectedSha256) return { ok: false, status: 403, body: { error: "SOURCE_ORIGIN_UNATTESTED" } };
  if (policy.expectedSha256 && policy.expectedSha256 !== result.manifest.archiveSha256) return { ok: false, status: 409, body: { error: "SOURCE_POLICY_MISMATCH" } };
  const perUnit = await buildPerUnitBundles(result, { resourceOnlyUnitIds: policy.units.filter((unit) => unit.kind === "resources").map((unit) => unit.id), unitDeclarations: policy.units, ...(engine.pagesHash ? { pagesHash: engine.pagesHash } : {}) });
  if (!perUnit.ok) return { ok: false, status: 400, body: { error: "INVALID_PER_UNIT_RELEASE", detail: perUnit.errors[0] } };
  if (perUnit.units?.some((unit) => unit.canonicalWrangler.kind === "worker" && unit.canonicalWrangler.assets)) {
    return { ok: false, status: 409, body: { error: "WORKER_ASSETS_UNSUPPORTED", detail: "Worker static assets are disabled: uploaded byte integrity is not verified. Use a static Pages site or a Worker without static assets." } };
  }
  return { ok: true, manifest: result.manifest, files: result.files ?? [], perUnit };
}

interface ReleaseUnitSummary {
  unitId: string;
  kind: "worker" | "pages" | "resources";
  name: string;
  hyperdrive?: string[];
}

export interface ReleaseSummary {
  archiveSha256: string;
  manifestDigest: string;
  entryCount: number;
  units: ReleaseUnitSummary[];
  resources: ReleaseResourceName[];
}

// Nonsecret per-unit identity summary so the Configure step can prefill
// operator-editable names (e.g. workerName) from the verified release. The
// sealed proof stays authoritative; these names are display defaults only.
export function summarizePrebuiltRelease(verified: Extract<PrebuiltReleaseVerification, { ok: true }>, policy: PrebuiltReleasePolicy): ReleaseSummary {
  const perUnitUnits = verified.perUnit.units ?? [];
  const units = perUnitUnits.map((unit): ReleaseUnitSummary => {
    const canonical = (unit.canonicalWrangler ?? {}) as { kind?: unknown; name?: unknown; hyperdrive?: unknown };
    const kind = canonical.kind === "worker" || canonical.kind === "pages" ? canonical.kind : "resources";
    const name = typeof canonical.name === "string" && canonical.name ? canonical.name : unit.unitId;
    // Hyperdrive bindings need the operator to pick one of their own configs.
    const hyperdrive = Array.isArray(canonical.hyperdrive) ? canonical.hyperdrive.flatMap((entry) => typeof (entry as { binding?: unknown }).binding === "string" ? [(entry as { binding: string }).binding] : []) : [];
    return { unitId: unit.unitId, kind, name, ...(hyperdrive.length > 0 ? { hyperdrive } : {}) };
  });
  // The names the operator may change at install (and that upgrade reads back
  // from the live Worker's bindings).
  const resources = releaseResourceNames(perUnitUnits, policy);
  return { archiveSha256: verified.manifest.archiveSha256, manifestDigest: verified.manifest.manifestDigest, entryCount: verified.manifest.entryCount, units, resources };
}
