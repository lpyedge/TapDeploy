import type { Hono } from "hono";
import type { AppEnv, TapDeployEnv } from "../app.js";
import { authenticate } from "../session-guard.js";
import { loadKey } from "./auth.js";
import { RELEASE_MAX_BYTES } from "../../core/upload-limits.js";
import { CONFIG_V3_MAX_BYTES } from "../../manifest/config-v3.js";
import { bindConfigToSession } from "../../core/config-envelope.js";
import { sourcePolicyDigest, sourcePolicyFromConfig } from "../../auth/oauth-tx.js";
import { readBoundedBody } from "../read-bounded-body.js";
import { summarizePrebuiltRelease, verifyPrebuiltRelease } from "../../release/verify-prebuilt-release.js";
import { sealVerifiedReleaseContext } from "../../core/planning/graph-execution-context.js";

const BODY_READ_DEADLINE_MS = 60_000;
// The ZIP, the config text and the multipart framing around them.
const PREPARE_MAX_BODY_BYTES = RELEASE_MAX_BYTES + CONFIG_V3_MAX_BYTES + 16 * 1024;

// multipart/form-data: `config` (the config text this session was authorized
// for) and `release` (the ZIP). The session carries only the digest of the
// config's source policy, so the policy is rebuilt from the config, which must
// hash to the session's config before any byte of the ZIP is examined.
export function attachDeployPrepareRoutes(app: Hono<AppEnv>, env: TapDeployEnv): void {
  app.post("/api/deploy/prepare", async (c) => {
    // This must remain before any body read/allocation.
    const auth = await authenticate(c, env); if ("denied" in auth) return auth.denied;
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.split(";", 1)[0]!.trim().toLowerCase() !== "multipart/form-data") return c.json({ error: "MULTIPART_REQUIRED", detail: "send the config text and the release ZIP as multipart/form-data" }, 415);
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > PREPARE_MAX_BODY_BYTES) return c.json({ error: "SERVER_ZIP_VERIFY_LIMIT", limit: RELEASE_MAX_BYTES }, 413);
    const read = await readBoundedBody(c.req.raw.body, PREPARE_MAX_BODY_BYTES, BODY_READ_DEADLINE_MS);
    if (!read.ok) {
      if (read.reason === "too_large") return c.json({ error: "SERVER_ZIP_VERIFY_LIMIT", limit: RELEASE_MAX_BYTES }, 413);
      return read.reason === "timeout"
        ? c.json({ error: "request_timeout", detail: "the ZIP did not arrive in time" }, 408)
        : c.json({ error: "invalid_body", detail: "request body could not be read" }, 400);
    }
    let form: FormData;
    try {
      form = await new Response(read.bytes as BodyInit, { headers: { "content-type": contentType } }).formData();
    } catch {
      return c.json({ error: "invalid_body", detail: "request body is not valid multipart/form-data" }, 400);
    }
    const configText = form.get("config");
    const release = form.get("release");
    if (typeof configText !== "string" || release === null || typeof release === "string") return c.json({ error: "invalid_body", detail: "the request needs the config text and the release ZIP" }, 400);
    if (release.size > RELEASE_MAX_BYTES) return c.json({ error: "SERVER_ZIP_VERIFY_LIMIT", limit: RELEASE_MAX_BYTES }, 413);
    const bound = await bindConfigToSession({ sessionConfigHash: auth.session.configHash, configText });
    if (!bound.ok) return c.json({ error: bound.error, detail: bound.detail }, bound.error === "config_mismatch" ? 409 : 400);
    const policy = sourcePolicyFromConfig(bound.config);
    const policyDigest = await sourcePolicyDigest(policy);
    if (policyDigest !== auth.session.sourcePolicyDigest) return c.json({ error: "SOURCE_POLICY_MISMATCH" }, 409);
    const verified = await verifyPrebuiltRelease(new Uint8Array(await release.arrayBuffer()), policy);
    if (!verified.ok) return c.json(verified.body, verified.status);
    const { manifest, perUnit } = verified;
    const key = await loadKey(env);
    const proof = await sealVerifiedReleaseContext(key, { kind: "tapdeploy-verified-prebuilt-release/v1", nonce: auth.session.nonce, configHash: bound.configHash, appId: policy.appId, sourceKind: policy.allowLocalZip ? "local" : "url-pinned", sourcePolicyDigest: policyDigest, archiveSha256: manifest.archiveSha256, manifestDigest: manifest.manifestDigest, expiresAt: auth.session.expiresAt, units: (perUnit.units ?? []).map((unit) => ({ ...unit })), combinedUnitRootDigest: perUnit.combinedUnitRootDigest ?? manifest.manifestDigest });
    c.header("cache-control", "no-store");
    return c.json({ releaseProof: proof, releaseSummary: summarizePrebuiltRelease(verified, policy) });
  });
}
