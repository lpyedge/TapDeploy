import type { Hono } from "hono";
import type { AppEnv, TapDeployEnv } from "../app.js";
import { authenticate } from "../session-guard.js";
import { loadKey } from "./auth.js";
import { extractPrebuiltZip } from "../../release/prebuilt-zip.js";
import { sealVerifiedReleaseContext } from "../../core/planning/graph-execution-context.js";
import { buildPerUnitBundles } from "../../release/per-unit-bundles.js";
import { releaseResourceNames } from "../../core/planning/resource-names.js";

export const MAX_VERIFIED_ZIP_COMPRESSED = 8 * 1024 * 1024;
const MAX_VERIFIED_ZIP_EXPANDED = 24 * 1024 * 1024;

export async function readBoundedPrepareZip(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_VERIFIED_ZIP_COMPRESSED) { await reader.cancel(); return null; } chunks.push(value); } }
  catch { return null; } finally { reader.releaseLock(); }
  const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
}

export function attachDeployPrepareRoutes(app: Hono<AppEnv>, env: TapDeployEnv): void {
  app.post("/api/deploy/prepare", async (c) => {
    // This must remain before any body read/allocation.
    const auth = await authenticate(c, env); if ("denied" in auth) return auth.denied;
    if (c.req.header("content-type")?.split(";", 1)[0] !== "application/zip") return c.json({ error: "ZIP_CONTENT_TYPE_REQUIRED" }, 415);
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_VERIFIED_ZIP_COMPRESSED) return c.json({ error: "SERVER_ZIP_VERIFY_LIMIT", limit: MAX_VERIFIED_ZIP_COMPRESSED }, 413);
    const bytes = await readBoundedPrepareZip(c.req.raw.body);
    if (!bytes) return c.json({ error: "SERVER_ZIP_VERIFY_LIMIT", limit: MAX_VERIFIED_ZIP_COMPRESSED }, 413);
    const policy = auth.session.sourcePolicy;
    if (!policy || !Array.isArray(policy.units)) return c.json({ error: "SOURCE_POLICY_MISMATCH" }, 409);
    const result = await extractPrebuiltZip(bytes, { maxArchiveBytes: MAX_VERIFIED_ZIP_COMPRESSED, allowResourceOnly: policy?.units.every((unit) => unit.kind === "resources") === true, bounds: { maxTotalUncompressed: MAX_VERIFIED_ZIP_EXPANDED, maxPerFile: 8 * 1024 * 1024, maxFiles: 1024, maxCompressionRatio: 100, maxPathDepth: 16 } });
    if (!result.ok || !result.manifest) return c.json({ error: "INVALID_PREBUILT_ZIP", detail: result.errors[0] }, 400);
    // A browser-selected archive cannot establish URL provenance.  Configs that
    // forbid local archives must have a pinned archive hash before this route
    // can issue a proof; a later server fetch may provide a stronger policy.
    if (policy.allowLocalZip === false && !policy.expectedSha256) return c.json({ error: "SOURCE_ORIGIN_UNATTESTED" }, 403);
    if (policy.expectedSha256 && policy.expectedSha256 !== result.manifest.archiveSha256) return c.json({ error: "SOURCE_POLICY_MISMATCH" }, 409);
    const policyDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(policy)));
    const sourcePolicyDigest = [...new Uint8Array(policyDigest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const perUnit = await buildPerUnitBundles(result, { resourceOnlyUnitIds: policy.units.filter((unit) => unit.kind === "resources").map((unit) => unit.id), unitDeclarations: policy.units });
    if (!perUnit.ok) return c.json({ error: "INVALID_PER_UNIT_RELEASE", detail: perUnit.errors[0] }, 400);
    const key = await loadKey(env);
    const proof = await sealVerifiedReleaseContext(key, { kind: "tapdeploy-verified-prebuilt-release/v1", nonce: auth.session.nonce, configHash: auth.session.configHash ?? "unbound", appId: policy.appId, sourceKind: policy.allowLocalZip ? "local" : "url-pinned", sourcePolicyDigest, archiveSha256: result.manifest.archiveSha256, manifestDigest: result.manifest.manifestDigest, expiresAt: auth.session.expiresAt, units: (perUnit.units ?? []).map((unit) => ({ ...unit })), combinedUnitRootDigest: perUnit.combinedUnitRootDigest ?? result.manifest.manifestDigest });
    c.header("cache-control", "no-store");
    // Nonsecret per-unit identity summary so the Configure step can prefill
    // operator-editable names (e.g. workerName) from the sealed release. The
    // sealed proof stays authoritative; these names are display defaults only.
    const unitSummary = (perUnit.units ?? []).map((unit) => {
      const canonical = (unit.canonicalWrangler ?? {}) as { kind?: unknown; name?: unknown; hyperdrive?: unknown };
      const kind = canonical.kind === "worker" || canonical.kind === "pages" ? canonical.kind : "resources";
      const name = typeof canonical.name === "string" && canonical.name ? canonical.name : unit.unitId;
      // Hyperdrive bindings need the operator to pick one of their own configs.
      const hyperdrive = Array.isArray(canonical.hyperdrive) ? canonical.hyperdrive.flatMap((entry) => typeof (entry as { binding?: unknown }).binding === "string" ? [(entry as { binding: string }).binding] : []) : [];
      return { unitId: unit.unitId, kind, name, ...(hyperdrive.length > 0 ? { hyperdrive } : {}) };
    });
    // The names the operator may change at install (and that upgrade reads
    // back from the live Worker's bindings).
    const resources = releaseResourceNames(perUnit.units ?? [], { units: policy.units, upgrade: { switchable: policy.switchable } });
    return c.json({ releaseProof: proof, releaseSummary: { archiveSha256: result.manifest.archiveSha256, manifestDigest: result.manifest.manifestDigest, entryCount: result.manifest.entryCount, units: unitSummary, resources } });
  });
}
