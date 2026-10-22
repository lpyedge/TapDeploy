import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { deriveSealKey } from "../../src/auth/keys.js";

const authenticate = vi.fn();
const loadKey = vi.fn();
const extractPrebuiltZip = vi.fn();
const sealVerifiedReleaseContext = vi.fn();
const buildPerUnitBundles = vi.fn();
vi.mock("../../src/api/session-guard.js", () => ({ authenticate }));
vi.mock("../../src/api/routes/auth.js", () => ({ loadKey }));
vi.mock("../../src/release/prebuilt-zip.js", () => ({ extractPrebuiltZip }));
vi.mock("../../src/core/planning/graph-execution-context.js", () => ({ sealVerifiedReleaseContext }));
vi.mock("../../src/release/per-unit-bundles.js", () => ({ buildPerUnitBundles }));
const { attachDeployPrepareRoutes } = await import("../../src/api/routes/deploy-prepare.js");

describe("POST /api/deploy/prepare", () => {
  it("denies before consuming an unauthenticated body", async () => {
    authenticate.mockResolvedValueOnce({ denied: new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }) });
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { reads++; return new Promise(() => {}); } });
    const app = new Hono(); attachDeployPrepareRoutes(app as never, { RUNTIME: "node" });
    const response = await app.request("http://test/api/deploy/prepare", { method: "POST", headers: { "content-type": "application/zip" }, body: stream, duplex: "half" } as RequestInit);
    // Hono's in-memory request adapter performs one pull while constructing the
    // Request. The route itself must not consume further chunks after auth
    // denies, which this bounded one-pull assertion captures.
    expect(response.status).toBe(401); expect(reads).toBeLessThanOrEqual(1);
  });

  it("rejects a pinned source hash mismatch before sealing", async () => {
    authenticate.mockResolvedValueOnce({ session: { nonce: "n", configHash: "c", expiresAt: Date.now() + 60_000, sourcePolicy: { allowLocalZip: false, expectedSha256: "expected", appId: "app", units: [] } } });
    extractPrebuiltZip.mockResolvedValueOnce({ ok: true, errors: [], manifest: { archiveSha256: "actual", manifestDigest: "m", entryCount: 1 } });
    buildPerUnitBundles.mockResolvedValueOnce({ ok: true, units: [], combinedUnitRootDigest: "m" });
    const app = new Hono(); attachDeployPrepareRoutes(app as never, { RUNTIME: "node" });
    const response = await app.request("http://test/api/deploy/prepare", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array([1]) });
    expect(response.status).toBe(409); expect(sealVerifiedReleaseContext).not.toHaveBeenCalled();
  });

  it("seals only a verified archive identity", async () => {
    authenticate.mockResolvedValueOnce({ session: { nonce: "n", configHash: "c", expiresAt: Date.now() + 60_000, sourcePolicy: { allowLocalZip: true, expectedSha256: "actual", appId: "app", units: [] } } });
    extractPrebuiltZip.mockResolvedValueOnce({ ok: true, errors: [], manifest: { archiveSha256: "actual", manifestDigest: "m", entryCount: 1 } });
    buildPerUnitBundles.mockResolvedValueOnce({ ok: true, units: [], combinedUnitRootDigest: "m" });
    loadKey.mockResolvedValueOnce({}); sealVerifiedReleaseContext.mockResolvedValueOnce({ version: "v1", nonce: "x", ciphertext: "y" });
    const app = new Hono(); attachDeployPrepareRoutes(app as never, { RUNTIME: "node" });
    const response = await app.request("http://test/api/deploy/prepare", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array([1]) });
    expect(response.status).toBe(200); expect(sealVerifiedReleaseContext).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ archiveSha256: "actual", appId: "app", sourceKind: "local" }));
  });
});

// (OFFLINE): the same sealed-prepare route over the REAL archive extractor,
// per-unit bundler and proof sealer; only the session lookup is stubbed. Any
// outbound call fails the test: prepare must never touch Cloudflare.
describe("POST /api/deploy/prepare over the real verification pipeline", () => {
  const archive = zipSync({
    "wrangler.jsonc": new TextEncoder().encode('{"name":"api","main":"worker/main.mjs","compatibility_date":"2026-10-17"}'),
    "worker/main.mjs": new TextEncoder().encode("export default { fetch() { return new Response('ok'); } };"),
  });
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const units = [{ id: "api", kind: "worker", wrangler: "wrangler.jsonc" }];

  async function prepare(policy: Record<string, unknown>, bytes: Uint8Array) {
    const outbound = vi.fn(async () => { throw new Error("prepare must not call out"); });
    vi.stubGlobal("fetch", outbound);
    extractPrebuiltZip.mockImplementation((await vi.importActual<typeof import("../../src/release/prebuilt-zip.js")>("../../src/release/prebuilt-zip.js")).extractPrebuiltZip);
    buildPerUnitBundles.mockImplementation((await vi.importActual<typeof import("../../src/release/per-unit-bundles.js")>("../../src/release/per-unit-bundles.js")).buildPerUnitBundles);
    sealVerifiedReleaseContext.mockImplementation((await vi.importActual<typeof import("../../src/core/planning/graph-execution-context.js")>("../../src/core/planning/graph-execution-context.js")).sealVerifiedReleaseContext);
    loadKey.mockResolvedValue(await deriveSealKey(crypto.randomUUID()));
    authenticate.mockResolvedValueOnce({ session: { nonce: "n", configHash: "c", expiresAt: Date.now() + 60_000, sourcePolicy: { appId: "example/api", units, ...policy } } });
    const app = new Hono(); attachDeployPrepareRoutes(app as never, { RUNTIME: "node" });
    const response = await app.request("http://test/api/deploy/prepare", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(bytes) });
    return { response, body: (await response.json()) as { error?: string; releaseProof?: unknown; releaseSummary?: { archiveSha256: string; manifestDigest: string } }, outbound };
  }

  // Earlier tests in this file leave unconsumed one-shot results on the shared mocks.
  const resetMocks = () => { for (const mock of [extractPrebuiltZip, buildPerUnitBundles, sealVerifiedReleaseContext, loadKey, authenticate]) mock.mockReset(); };
  beforeEach(resetMocks);
  afterEach(() => { vi.unstubAllGlobals(); resetMocks(); });

  it("Local ZIP and a pinned URL ZIP with the same bytes yield the same archive and manifest identity", async () => {
    const local = await prepare({ allowLocalZip: true }, archive);
    const pinned = await prepare({ allowLocalZip: false, expectedSha256: sha256(archive) }, archive);
    expect(local.response.status, JSON.stringify(local.body)).toBe(200);
    expect(pinned.response.status, JSON.stringify(pinned.body)).toBe(200);
    expect(local.body.releaseSummary?.archiveSha256).toBe(sha256(archive));
    expect(pinned.body.releaseSummary).toEqual(local.body.releaseSummary);
    expect(local.body.releaseProof).toBeDefined();
    expect(local.outbound).not.toHaveBeenCalled();
    expect(pinned.outbound).not.toHaveBeenCalled();
  });

  it("a pinned hash that does not match the bytes issues no proof and makes no outbound call", async () => {
    const tampered = zipSync({ "wrangler.jsonc": new TextEncoder().encode('{"name":"api","main":"worker/main.mjs","compatibility_date":"2026-10-17"}'), "worker/main.mjs": new TextEncoder().encode("export default { fetch() { return new Response('evil'); } };") });
    const { response, body, outbound } = await prepare({ allowLocalZip: false, expectedSha256: sha256(archive) }, tampered);
    expect(response.status).toBe(409);
    expect(body.error).toBe("SOURCE_POLICY_MISMATCH");
    expect(body.releaseProof).toBeUndefined();
    expect(sealVerifiedReleaseContext).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("a config that forbids local ZIPs without a pinned hash cannot be satisfied by browser bytes", async () => {
    const { response, body, outbound } = await prepare({ allowLocalZip: false }, archive);
    expect(response.status).toBe(403);
    expect(body.error).toBe("SOURCE_ORIGIN_UNATTESTED");
    expect(sealVerifiedReleaseContext).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("garbage bytes and a wrong content type are refused before any proof", async () => {
    const garbage = await prepare({ allowLocalZip: true }, new Uint8Array([1, 2, 3, 4]));
    expect(garbage.response.status).toBe(400);
    expect(garbage.body.error).toBe("INVALID_PREBUILT_ZIP");
    expect(sealVerifiedReleaseContext).not.toHaveBeenCalled();
  });
});
