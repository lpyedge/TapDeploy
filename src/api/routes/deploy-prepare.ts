import type { Hono } from "hono";
import type { AppEnv, TapDeployEnv } from "../app.js";
import { authenticate } from "../session-guard.js";
import { loadKey } from "./auth.js";
import { RELEASE_MAX_BYTES } from "../../core/upload-limits.js";
import { summarizePrebuiltRelease, verifyPrebuiltRelease } from "../../release/verify-prebuilt-release.js";
import { sealVerifiedReleaseContext } from "../../core/planning/graph-execution-context.js";

export async function readBoundedPrepareZip(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > RELEASE_MAX_BYTES) { await reader.cancel(); return null; } chunks.push(value); } }
  catch { return null; } finally { reader.releaseLock(); }
  const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
}

export function attachDeployPrepareRoutes(app: Hono<AppEnv>, env: TapDeployEnv): void {
  app.post("/api/deploy/prepare", async (c) => {
    // This must remain before any body read/allocation.
    const auth = await authenticate(c, env); if ("denied" in auth) return auth.denied;
    if (c.req.header("content-type")?.split(";", 1)[0] !== "application/zip") return c.json({ error: "ZIP_CONTENT_TYPE_REQUIRED" }, 415);
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > RELEASE_MAX_BYTES) return c.json({ error: "SERVER_ZIP_VERIFY_LIMIT", limit: RELEASE_MAX_BYTES }, 413);
    const bytes = await readBoundedPrepareZip(c.req.raw.body);
    if (!bytes) return c.json({ error: "SERVER_ZIP_VERIFY_LIMIT", limit: RELEASE_MAX_BYTES }, 413);
    const policy = auth.session.sourcePolicy;
    if (!policy || !Array.isArray(policy.units)) return c.json({ error: "SOURCE_POLICY_MISMATCH" }, 409);
    const verified = await verifyPrebuiltRelease(bytes, policy);
    if (!verified.ok) return c.json(verified.body, verified.status);
    const policyDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(policy)));
    const sourcePolicyDigest = [...new Uint8Array(policyDigest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const { manifest, perUnit } = verified;
    const key = await loadKey(env);
    const proof = await sealVerifiedReleaseContext(key, { kind: "tapdeploy-verified-prebuilt-release/v1", nonce: auth.session.nonce, configHash: auth.session.configHash ?? "unbound", appId: policy.appId, sourceKind: policy.allowLocalZip ? "local" : "url-pinned", sourcePolicyDigest, archiveSha256: manifest.archiveSha256, manifestDigest: manifest.manifestDigest, expiresAt: auth.session.expiresAt, units: (perUnit.units ?? []).map((unit) => ({ ...unit })), combinedUnitRootDigest: perUnit.combinedUnitRootDigest ?? manifest.manifestDigest });
    c.header("cache-control", "no-store");
    return c.json({ releaseProof: proof, releaseSummary: summarizePrebuiltRelease(verified, policy) });
  });
}
