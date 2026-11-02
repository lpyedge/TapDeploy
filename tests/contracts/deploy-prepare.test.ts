import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { deriveSealKey } from "../../src/auth/keys.js";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";
import { prepareForm, sessionBinding } from "./login.js";

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

const ACTUAL = "a".repeat(64);
const configWith = (source: ConfigV3["source"], units: ConfigV3["units"] = []): ConfigV3 => ({ schemaVersion: 3, app: { id: "example/api", name: "API" }, source, capabilities: ["workers"], units: units.length ? units : [{ id: "api", kind: "worker", wrangler: "wrangler.jsonc" }] });
const sessionFor = async (config: ConfigV3) => ({ session: { nonce: "n", expiresAt: Date.now() + 60_000, ...(await sessionBinding(config)) } });
const send = (body: BodyInit, headers: Record<string, string> = {}) => {
  const app = new Hono(); attachDeployPrepareRoutes(app as never, { RUNTIME: "node" });
  return app.request("http://test/api/deploy/prepare", { method: "POST", headers, body });
};

describe("POST /api/deploy/prepare", () => {
  beforeEach(() => { for (const mock of [extractPrebuiltZip, buildPerUnitBundles, sealVerifiedReleaseContext, loadKey, authenticate]) mock.mockReset(); });

  it("denies before consuming an unauthenticated body", async () => {
    authenticate.mockResolvedValueOnce({ denied: new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }) });
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { reads++; return new Promise(() => {}); } });
    const app = new Hono(); attachDeployPrepareRoutes(app as never, { RUNTIME: "node" });
    const response = await app.request("http://test/api/deploy/prepare", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: stream, duplex: "half" } as RequestInit);
    // Hono's in-memory request adapter performs one pull while constructing the
    // Request. The route itself must not consume further chunks after auth
    // denies, which this bounded one-pull assertion captures.
    expect(response.status).toBe(401); expect(reads).toBeLessThanOrEqual(1);
  });

  it("rejects a pinned source hash mismatch before sealing", async () => {
    const config = configWith({ allowLocalZip: false, defaultUrl: "https://example.com/api.zip", expectedSha256: "e".repeat(64) });
    authenticate.mockResolvedValueOnce(await sessionFor(config));
    extractPrebuiltZip.mockResolvedValueOnce({ ok: true, errors: [], manifest: { archiveSha256: ACTUAL, manifestDigest: "m", entryCount: 1 } });
    buildPerUnitBundles.mockResolvedValueOnce({ ok: true, units: [], combinedUnitRootDigest: "m" });
    const response = await send(prepareForm(JSON.stringify(config), new Uint8Array([1])));
    expect(response.status).toBe(409); expect(sealVerifiedReleaseContext).not.toHaveBeenCalled();
  });

  it("seals only a verified archive identity", async () => {
    const config = configWith({ allowLocalZip: true, expectedSha256: ACTUAL });
    authenticate.mockResolvedValueOnce(await sessionFor(config));
    extractPrebuiltZip.mockResolvedValueOnce({ ok: true, errors: [], manifest: { archiveSha256: ACTUAL, manifestDigest: "m", entryCount: 1 } });
    buildPerUnitBundles.mockResolvedValueOnce({ ok: true, units: [], combinedUnitRootDigest: "m" });
    loadKey.mockResolvedValueOnce({}); sealVerifiedReleaseContext.mockResolvedValueOnce({ version: "v1", nonce: "x", ciphertext: "y" });
    const response = await send(prepareForm(JSON.stringify(config), new Uint8Array([1])));
    expect(response.status).toBe(200); expect(sealVerifiedReleaseContext).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ archiveSha256: ACTUAL, appId: "example/api", sourceKind: "local" }));
  });

  it("refuses a config other than the one the session was authorized for, before reading the ZIP", async () => {
    authenticate.mockResolvedValueOnce(await sessionFor(configWith({ allowLocalZip: true })));
    const other = configWith({ allowLocalZip: true }, [{ id: "api", kind: "worker", wrangler: "other/wrangler.jsonc" }]);
    const response = await send(prepareForm(JSON.stringify(other), new Uint8Array([1])));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "config_mismatch" });
    expect(extractPrebuiltZip).not.toHaveBeenCalled();
  });

  it("refuses a session without the source policy digest of its config", async () => {
    const config = configWith({ allowLocalZip: true });
    authenticate.mockResolvedValueOnce({ session: { nonce: "n", expiresAt: Date.now() + 60_000, configHash: (await sessionBinding(config)).configHash } });
    const response = await send(prepareForm(JSON.stringify(config), new Uint8Array([1])));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "SOURCE_POLICY_MISMATCH" });
    expect(extractPrebuiltZip).not.toHaveBeenCalled();
  });

  it("refuses a raw ZIP body and a form without both parts", async () => {
    const config = configWith({ allowLocalZip: true });
    authenticate.mockResolvedValue(await sessionFor(config));
    const raw = await send(new Uint8Array([1]), { "content-type": "application/zip" });
    expect(raw.status).toBe(415);
    expect(await raw.json()).toMatchObject({ error: "MULTIPART_REQUIRED" });
    const configOnly = new FormData(); configOnly.append("config", JSON.stringify(config));
    const missing = await send(configOnly);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "invalid_body" });
    expect(extractPrebuiltZip).not.toHaveBeenCalled();
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

  async function prepare(source: ConfigV3["source"], bytes: Uint8Array) {
    const outbound = vi.fn(async () => { throw new Error("prepare must not call out"); });
    vi.stubGlobal("fetch", outbound);
    extractPrebuiltZip.mockImplementation((await vi.importActual<typeof import("../../src/release/prebuilt-zip.js")>("../../src/release/prebuilt-zip.js")).extractPrebuiltZip);
    buildPerUnitBundles.mockImplementation((await vi.importActual<typeof import("../../src/release/per-unit-bundles.js")>("../../src/release/per-unit-bundles.js")).buildPerUnitBundles);
    sealVerifiedReleaseContext.mockImplementation((await vi.importActual<typeof import("../../src/core/planning/graph-execution-context.js")>("../../src/core/planning/graph-execution-context.js")).sealVerifiedReleaseContext);
    loadKey.mockResolvedValue(await deriveSealKey(crypto.randomUUID()));
    const config = configWith(source);
    authenticate.mockResolvedValueOnce(await sessionFor(config));
    const response = await send(prepareForm(JSON.stringify(config), bytes));
    return { response, body: (await response.json()) as { error?: string; releaseProof?: unknown; releaseSummary?: { archiveSha256: string; manifestDigest: string } }, outbound };
  }

  // Earlier tests in this file leave unconsumed one-shot results on the shared mocks.
  const resetMocks = () => { for (const mock of [extractPrebuiltZip, buildPerUnitBundles, sealVerifiedReleaseContext, loadKey, authenticate]) mock.mockReset(); };
  beforeEach(resetMocks);
  afterEach(() => { vi.unstubAllGlobals(); resetMocks(); });

  it("Local ZIP and a pinned URL ZIP with the same bytes yield the same archive and manifest identity", async () => {
    const local = await prepare({ allowLocalZip: true }, archive);
    const pinned = await prepare({ allowLocalZip: false, defaultUrl: "https://example.com/api.zip", expectedSha256: sha256(archive) }, archive);
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
    const { response, body, outbound } = await prepare({ allowLocalZip: false, defaultUrl: "https://example.com/api.zip", expectedSha256: sha256(archive) }, tampered);
    expect(response.status).toBe(409);
    expect(body.error).toBe("SOURCE_POLICY_MISMATCH");
    expect(body.releaseProof).toBeUndefined();
    expect(sealVerifiedReleaseContext).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("a config that forbids local ZIPs without a pinned hash is refused before any verification", async () => {
    const { response, body, outbound } = await prepare({ allowLocalZip: false, defaultUrl: "https://example.com/api.zip" }, archive);
    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_config");
    expect(extractPrebuiltZip).not.toHaveBeenCalled();
    expect(sealVerifiedReleaseContext).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("garbage bytes are refused before any proof", async () => {
    const garbage = await prepare({ allowLocalZip: true }, new Uint8Array([1, 2, 3, 4]));
    expect(garbage.response.status).toBe(400);
    expect(garbage.body.error).toBe("INVALID_PREBUILT_ZIP");
    expect(sealVerifiedReleaseContext).not.toHaveBeenCalled();
  });
});
