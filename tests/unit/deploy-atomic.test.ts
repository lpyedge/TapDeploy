import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { executeDeployStep, type DeployStepContext, versionMessage } from "../../src/core/deploy/steps.js";
import type { CloudflareApiClient } from "../../src/cloudflare/client/client.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";
import { VersionSemantics } from "../fixtures/cloudflare/version-semantics.js";

const code = "export default {fetch(){return new Response('ok')}}";
function context() {
  const provider = new VersionSemantics(true);
  const spec: DeploySpec = {
    schemaVersion: 1, project: { id: "atomic/app", version: "1" }, targetKind: "workers",
    worker: { path: "worker.mjs", size: Buffer.byteLength(code), sha256: createHash("sha256").update(code).digest("hex") },
    assets: [], inputs: {}, wrangler: { name: "atomic", main: "worker.mjs", compatibility_date: "2026-10-10", r2_buckets: [], crons: [] },
    cloudflare: { workerName: "atomic", r2: [], d1: [], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: { PASSWORD: "prompt-on-install", JWT: "generate-once" } },
  };
  const snapshot: TargetSnapshot = { accountId: "a".repeat(32), workerName: "atomic", workerExists: false, versions: [], activeDeploymentVersionIds: [], r2Buckets: [], d1Databases: [], kvNamespaces: [], queues: [], hyperdriveConfigs: [], vectorizeIndexes: [], secretsStores: [], secretsStoreSecrets: [], secretNames: [], scheduleCrons: [], rateLimitCount: 0 };
  const client = {
    createWorker: vi.fn(async (_name, req) => {
      const bindings = Object.fromEntries((req.metadata.bindings ?? []).filter((b: Record<string, unknown>) => b.type === "secret_text").map((b: Record<string, unknown>) => [b.name, b.text]));
      provider.upload(bindings, true);
      // Official script PUT id is a script name, NOT a version id.
      return { id: "atomic" };
    }),
    listDeployments: vi.fn(async () => [{ id: "deployment", versions: [{ version_id: provider.active, percentage: 100 }] }]),
    listVersions: vi.fn(async () => provider.versions.map(v => ({ id: v.id, message: versionMessage(spec) })).reverse()),
    updateSecret: vi.fn(async (_name, name, text) => { provider.secret(name, text); return { name, type: "secret_text" }; }),
  } as unknown as CloudflareApiClient;
  const ctx: DeployStepContext = { client, spec, snapshot, accountId: snapshot.accountId, workerName: "atomic", accessToken: "fake" };
  return { provider, ctx };
}
describe("complete first upload", () => {
  it.each(["before-upload", "after-upload", "read-versions", "read-deployments"])("%s fault never exposes an incomplete first configuration", async fault => {
    const { provider, ctx } = context();
    const error = Object.assign(new Error("synthetic fault"), { kind: "network" });
    const upload = vi.mocked(ctx.client.createWorker).getMockImplementation()!;
    if (fault.includes("upload")) vi.mocked(ctx.client.createWorker).mockImplementation(async (...args) => {
      if (fault === "before-upload") throw error;
      await upload(...args);
      throw error;
    });
    if (fault === "read-versions") vi.mocked(ctx.client.listVersions).mockRejectedValue(error);
    if (fault === "read-deployments") vi.mocked(ctx.client.listDeployments).mockRejectedValue(error);
    const result = await executeDeployStep("create-worker", ctx, { scriptB64: Buffer.from(code).toString("base64"), secrets: { PASSWORD: "fake-password" } });
    expect(result.ok).toBe(false);
    expect(provider.served).toHaveLength(fault === "before-upload" ? 0 : 1);
    expect(provider.served.every(v => v.PASSWORD === "fake-password" && !!v.JWT)).toBe(true);
    expect(ctx.client.updateSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("fake-password");
  });
  it.each(["before-version", "after-version", "before-activation", "after-activation"])("%s upgrade fault retains old secrets and only complete configurations", async fault => {
    const { provider, ctx } = context();
    const old = provider.upload({ PASSWORD: "old-password", JWT: "old-token" }, true);
    const latest = provider.upload({ PASSWORD: "must-not-inherit", JWT: "wrong-token" });
    Object.assign(ctx.snapshot, { workerExists: true, activeDeploymentId: "deployment", activeDeploymentVersionIds: [old], latestVersionId: latest, secretNames: ["PASSWORD", "JWT"], activeBindings: [{ name: "PASSWORD", type: "secret_text" }, { name: "JWT", type: "secret_text" }] });
    ctx.spec.cloudflare.secrets.NEW_TOKEN = "generate-once";
    const error = Object.assign(new Error("synthetic fault"), { kind: "network" });
    ctx.client.createVersion = vi.fn(async (_name, request) => {
      if (fault === "before-version") throw error;
      const bindings: Record<string, string> = {};
      for (const binding of request.metadata.bindings ?? []) bindings[String(binding.name)] = binding.type === "inherit" ? provider.versions.find(v => v.id === binding.version_id)!.bindings[String(binding.name)]! : String(binding.text);
      const id = provider.upload(bindings);
      if (fault === "after-version") throw error;
      return { id };
    });
    ctx.client.createDeployment = vi.fn(async (_name, request) => {
      if (fault === "before-activation") throw error;
      provider.deploy(request.versions[0]!.version_id!);
      if (fault === "after-activation") throw error;
      return { id: "cutover", script_id: "atomic", author_id: "fake", versions: request.versions };
    });
    const created = await executeDeployStep("create-version", ctx, { scriptB64: Buffer.from(code).toString("base64"), secrets: { PASSWORD: "ignored-replacement" } });
    if (fault.includes("version")) expect(created.ok).toBe(false);
    else {
      expect(created.ok).toBe(true);
      const id = (created as { result: { versionId: string } }).result.versionId;
      expect((await executeDeployStep("activate", ctx, { versionId: id })).ok).toBe(false);
    }
    expect(provider.active).toBe(fault === "after-activation" ? provider.versions.at(-1)!.id : old);
    expect(provider.served.every(v => v.PASSWORD === "old-password" && v.JWT === "old-token")).toBe(true);
    if (fault === "after-activation") expect(provider.served.at(-1)!.NEW_TOKEN).toBeTruthy();
    expect(ctx.client.updateSecret).not.toHaveBeenCalled();
  });
  it("never serves an incomplete prompted/generated secret configuration and resolves real version id", async () => {
    const { provider, ctx } = context();
    const result = await executeDeployStep("create-worker", ctx, { scriptB64: Buffer.from(code).toString("base64"), secrets: { PASSWORD: "fake-password" } });
    expect(result.ok).toBe(true);
    expect(provider.served.every(v => v.PASSWORD === "fake-password" && !!v.JWT)).toBe(true);
    expect(result).toMatchObject({ ok: true, result: { versionId: "v1" } });
    expect(JSON.stringify(result)).not.toContain("fake-password");
    expect(ctx.client.updateSecret).not.toHaveBeenCalled();
  });
  it("missing password fails before script upload", async () => {
    const { ctx } = context();
    const result = await executeDeployStep("create-worker", ctx, { scriptB64: Buffer.from(code).toString("base64") });
    expect(result.ok).toBe(false);
    expect(ctx.client.createWorker).not.toHaveBeenCalled();
  });
  it("uploads the exact verified module bytes instead of silently replacing invalid UTF8", async () => {
    const { ctx } = context();
    const bytes = Uint8Array.from([...new TextEncoder().encode("export default {}; // "), 255]);
    ctx.spec.worker!.size = bytes.length;
    ctx.spec.worker!.sha256 = createHash("sha256").update(bytes).digest("hex");
    const result = await executeDeployStep("create-worker", ctx, { scriptB64: Buffer.from(bytes).toString("base64"), secrets: { PASSWORD: "fake-password" } });
    expect(result.ok).toBe(true);
    expect(vi.mocked(ctx.client.createWorker).mock.calls[0]![1].mainModule.content).toEqual(bytes);
  });
  it("new password and plaintext bindings cannot share a name in the first upload", async () => {
    const { ctx } = context();
    ctx.spec.wrangler.vars = { PASSWORD: "not-secret" };
    expect(await executeDeployStep("create-worker", ctx, { scriptB64: Buffer.from(code).toString("base64"), secrets: { PASSWORD: "fake-password" } })).toMatchObject({ ok: false, error: { kind: "binding-conflict" } });
    expect(ctx.client.createWorker).not.toHaveBeenCalled();
  });
  it("refuses an upgrade with existing secrets before any preparation writes", async () => {
    const { ctx } = context();
    ctx.snapshot.workerExists = true;
    ctx.snapshot.secretNames = ["OLD_UNDECLARED_SECRET"];
    const result = await executeDeployStep("create-r2-buckets", ctx, {});
    expect(result).toMatchObject({ ok: false, error: { kind: "inherit-source-unavailable" } });
    expect(ctx.client.createWorker).not.toHaveBeenCalled();
    expect(ctx.client.updateSecret).not.toHaveBeenCalled();
  });
  it("an ambiguous serving deployment stops rather than using the script name as a version", async () => {
    const { ctx } = context();
    vi.mocked(ctx.client.listDeployments).mockResolvedValue([]);
    const result = await executeDeployStep("create-worker", ctx, { scriptB64: Buffer.from(code).toString("base64"), secrets: { PASSWORD: "fake-password" } });
    expect(result).toMatchObject({ ok: false, error: { kind: "wrong-version" } });
  });
});
