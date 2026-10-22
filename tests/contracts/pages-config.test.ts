import { describe, expect, it, vi } from "vitest";
import { ensurePagesProject } from "../../src/core/deploy/pages.js";
import type { CloudflareApiClient } from "../../src/cloudflare/client/client.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";
import { createCloudflareClient } from "../../src/cloudflare/client/client.js";
import { snapshotTarget } from "../../src/core/planning/snapshot.js";

function fixture(existing = false) {
  const spec: DeploySpec = { schemaVersion: 1, targetKind: "pages", project: { id: "config/pages", version: "1" }, assets: [], inputs: {}, wrangler: { name: "pages", compatibility_date: "2026-10-10", r2_buckets: [], crons: [] }, cloudflare: { workerName: "pages", pages: { projectName: "pages", vars: { MESSAGE: "approved" } }, r2: [{ binding: "BUCKET", bucketName: "bucket", createIfMissing: false }], d1: [{ binding: "DB", databaseName: "database", createIfMissing: false }], kv: [{ binding: "KV", namespaceName: "namespace", createIfMissing: false }], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {} } };
  const snapshot = { pagesProjectExists: existing, pagesProjectId: existing ? "p" : undefined, r2Buckets: [{ name: "bucket", id: "bucket" }], d1Databases: [{ name: "database", id: "db-id" }], kvNamespaces: [{ name: "namespace", id: "kv-id" }] } as TargetSnapshot;
  let project = { id: "p", name: "pages", deployment_configs: { production: { env_vars: { TAPDEPLOY_MANAGED_PROJECT: { type: "plain_text", value: "config/pages" }, OLD: { type: "plain_text", value: "preserved" } }, r2_buckets: { UNDECLARED: { name: "keep" } } }, preview: { env_vars: { PREVIEW: { type: "plain_text", value: "different" } } } } };
  const patch = vi.fn(async (_name, req) => {
    const production = { ...project.deployment_configs.production, ...req.deployment_configs?.production };
    production.env_vars = { ...project.deployment_configs.production.env_vars, ...req.deployment_configs?.production?.env_vars };
    project = { ...project, deployment_configs: { ...project.deployment_configs, ...req.deployment_configs, production } };
    return project;
  });
  const create = vi.fn(async req => { project = { ...project, ...req }; return project; });
  const client = { createPagesProject: create, updatePagesProject: patch, getPagesProject: vi.fn(async () => project) } as unknown as CloudflareApiClient;
  return { spec, snapshot, client, patch, create, project: () => project };
}
describe("Pages approved configuration", () => {
  it("new project receives exact resource identities and vars in both environments", async () => {
    const f = fixture();
    expect((await ensurePagesProject(f.client, f.spec, f.snapshot)).ok).toBe(true);
    const config = f.create.mock.calls[0]?.[0].deployment_configs;
    expect(config?.production).toMatchObject({ compatibility_date: "2026-10-10", env_vars: { MESSAGE: { type: "plain_text", value: "approved" } }, d1_databases: { DB: { id: "db-id" } }, kv_namespaces: { KV: { namespace_id: "kv-id" } }, r2_buckets: { BUCKET: { name: "bucket" } } });
    expect(config?.preview).toEqual(config?.production);
  });
  it("update merges production and leaves existing preview and undeclared bindings intact", async () => {
    const f = fixture(true);
    expect((await ensurePagesProject(f.client, f.spec, f.snapshot)).ok).toBe(true);
    expect(f.patch).toHaveBeenCalledOnce();
    expect(f.project().deployment_configs.preview.env_vars.PREVIEW.value).toBe("different");
    expect(f.project().deployment_configs.production.r2_buckets.UNDECLARED.name).toBe("keep");
    expect(f.project().deployment_configs.production.env_vars.OLD.value).toBe("preserved");
  });
  it("missing selected identity refuses before project mutation", async () => {
    const f = fixture();
    f.snapshot.d1Databases = [];
    expect((await ensurePagesProject(f.client, f.spec, f.snapshot)).ok).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.patch).not.toHaveBeenCalled();
  });
  it("creates prompt and generated secrets in both environments without echoing them", async () => {
    const f = fixture();
    f.spec.cloudflare.secrets = { PASSWORD: "prompt-on-install", GENERATED: "generate-once" };
    const result = await ensurePagesProject(f.client, f.spec, f.snapshot, { secrets: { PASSWORD: "synthetic-password", GENERATED: "must-ignore" } });
    expect(result.ok).toBe(true);
    const production = f.create.mock.calls[0]![0].deployment_configs.production;
    expect(production.env_vars.PASSWORD).toEqual({ type: "secret_text", value: "synthetic-password" });
    expect(production.env_vars.GENERATED.type).toBe("secret_text");
    expect(production.env_vars.GENERATED.value.length).toBeGreaterThan(16);
    expect(production.env_vars.GENERATED.value).not.toBe("must-ignore");
    expect(JSON.stringify(result)).not.toContain("synthetic-password");
    expect(JSON.stringify(result)).not.toContain(production.env_vars.GENERATED.value);
  });
  it("updates vars while omitting unreadable existing secrets from PATCH", async () => {
    const f = fixture(true);
    f.project().deployment_configs.production.env_vars.OLD = { type: "secret_text", value: "" };
    f.spec.cloudflare.secrets = { OLD: "prompt-on-install" };
    const result = await ensurePagesProject(f.client, f.spec, f.snapshot, { secrets: { OLD: "do-not-replace" } });
    expect(result.ok).toBe(true);
    const vars = f.patch.mock.calls[0]![1].deployment_configs.production.env_vars;
    expect(vars).toEqual({ MESSAGE: { type: "plain_text", value: "approved" } });
    expect(f.project().deployment_configs.production.env_vars.OLD.type).toBe("secret_text");
    expect(JSON.stringify(result)).not.toContain("do-not-replace");
  });
  it("missing prompt secret rejects the complete configuration before mutation", async () => {
    const f = fixture();
    f.spec.cloudflare.secrets = { PASSWORD: "prompt-on-install" };
    expect(await ensurePagesProject(f.client, f.spec, f.snapshot, { secrets: {} })).toMatchObject({ ok: false, error: { kind: "missing-secret" } });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.patch).not.toHaveBeenCalled();
  });
  it("accepts redacted Secret readback and refuses plaintext demotion", async () => {
    for (const type of ["secret_text", "plain_text"]) {
      const f = fixture();
      f.spec.cloudflare.secrets = { PASSWORD: "prompt-on-install" };
      vi.mocked(f.client.getPagesProject).mockImplementation(async () => {
        const project = structuredClone(f.project());
        for (const environment of ["production", "preview"] as const) {
          const vars = project.deployment_configs[environment].env_vars as Record<string, { type: string; value: string }>;
          if (vars.PASSWORD) vars.PASSWORD = { type, value: "" };
        }
        return project;
      });
      const result = await ensurePagesProject(f.client, f.spec, f.snapshot, { secrets: { PASSWORD: "synthetic" } });
      expect(result.ok).toBe(type === "secret_text");
      expect(JSON.stringify(result)).not.toContain("synthetic");
    }
  });
  it("unsupported AI resource refuses before project mutation", async () => {
    const f = fixture();
    f.spec.cloudflare.runtimeBindings = [{ binding: "AI", type: "ai" }];
    expect((await ensurePagesProject(f.client, f.spec, f.snapshot)).ok).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.patch).not.toHaveBeenCalled();
  });
  it("uses official project PATCH and preserves unmodeled returned configuration", async () => {
    const fetched = vi.fn(async (_url, init?: RequestInit) => {
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ deployment_configs: { production: { browsers: { BROWSER: {} } } } });
      return Response.json({ success: true, result: { id: "p", name: "pages", deployment_configs: { production: { browsers: { BROWSER: {} }, services: { OLD: { service: "preserved", environment: "production" } } } } } });
    });
    const client = createCloudflareClient({ accountId: "a".repeat(32), accessToken: "fake", fetcher: fetched });
    const project = await client.updatePagesProject("pages", { deployment_configs: { production: { browsers: { BROWSER: {} } } } });
    expect(project.deployment_configs?.production?.services).toEqual({ OLD: { service: "preserved", environment: "production" } });
  });
  it("configuration drift in readback fails instead of claiming success", async () => {
    const f = fixture();
    vi.mocked(f.client.getPagesProject).mockResolvedValue({ id: "p", name: "pages" });
    expect(await ensurePagesProject(f.client, f.spec, f.snapshot)).toMatchObject({ ok: false, error: { kind: "validation" } });
  });
  it("Pages snapshot gathers required selected resource inventories and never treats denied as empty", async () => {
    const client = { getPagesProject: vi.fn(async () => ({ id: "p", name: "pages" })), listR2Buckets: vi.fn(async () => [{ id: "bucket", name: "bucket" }]), listD1Databases: vi.fn(async () => [{ id: "db-id", name: "database" }]), listKvNamespaces: vi.fn(async () => [{ id: "kv-id", name: "namespace" }]) } as unknown as CloudflareApiClient;
    client.withAccount = () => client;
    const opts = { accountId: "a".repeat(32), workerName: "pages", targetKind: "pages" as const, needs: { domains: false, r2: true, d1: true, kv: true } };
    const snapshot = await snapshotTarget(client, opts);
    expect(snapshot.d1Databases).toEqual([{ name: "database", id: "db-id" }]);
    vi.mocked(client.listD1Databases).mockRejectedValue({ kind: "forbidden" });
    await expect(snapshotTarget(client, opts)).rejects.toMatchObject({ kind: "forbidden" });
  });
});
