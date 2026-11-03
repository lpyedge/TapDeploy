import { expect, it, vi } from "vitest";
import { postcheckPagesDeployment, ensurePagesProject } from "../../src/core/deploy/pages.js";
import type { CloudflareApiClient } from "../../src/cloudflare/client/client.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";
const spec = { project: { id: "owned-project" }, cloudflare: { pages: { projectName: "site" }, cron: [], secrets: {}, queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], r2: [], d1: [], kv: [] }, wrangler: { vars: {}, compatibility_date: "2026-10-10" } } as unknown as DeploySpec;
it("an earlier stage success is still pending, not deployment success", async () => {
  const client = { getPagesDeployment: vi.fn(async () => ({ id: "deployment", environment: "production", latest_stage: { name: "initialize", status: "success" } })) } as unknown as CloudflareApiClient;
  expect(await postcheckPagesDeployment(client, spec, "deployment")).toMatchObject({ ok: true, result: { succeeded: false, pending: true } });
});
it("Pages terminal failure/cancellation and preview identity are never success", async () => {
  for (const status of ["failure", "canceled"]) {
    const client = { getPagesDeployment: vi.fn(async () => ({ id: "deployment", environment: "production", latest_stage: { name: "deploy", status } })) } as unknown as CloudflareApiClient;
    expect(await postcheckPagesDeployment(client, spec, "deployment")).toMatchObject({ ok: true, result: { succeeded: false, pending: false, status } });
  }
  const preview = { getPagesDeployment: vi.fn(async () => ({ id: "deployment", environment: "preview", latest_stage: { name: "deploy", status: "success" } })) } as unknown as CloudflareApiClient;
  expect(await postcheckPagesDeployment(preview, spec, "deployment")).toMatchObject({ ok: false, error: { kind: "validation" } });
});
it("an unowned existing project is refused before any configuration write", async () => {
  const patch = vi.fn();
  const client = { getPagesProject: vi.fn(async () => ({ id: "project", name: "site", deployment_configs: {} })), updatePagesProject: patch } as unknown as CloudflareApiClient;
  const result = await ensurePagesProject(client, spec, { pagesProjectExists: true, pagesProjectId: "project" } as unknown as TargetSnapshot);
  expect(patch).not.toHaveBeenCalled();
  expect(result).toMatchObject({ ok: false, error: { kind: "wrong-project-owner" } });
});
it("the Pages postcheck requires every secret except an optional one left unset", async () => {
  const withSecrets = { ...spec, cloudflare: { ...spec.cloudflare, secrets: { API_KEY: "prompt-on-install", OWNER_PASSWORD: "optional" } } } as unknown as DeploySpec;
  const marker = { TAPDEPLOY_MANAGED_PROJECT: { type: "plain_text", value: "owned-project" } };
  const postcheck = (projectVars: Record<string, unknown>, deploymentVars: Record<string, unknown>) => {
    const client = {
      getPagesDeployment: vi.fn(async () => ({ id: "deployment", project_id: "project", environment: "production", latest_stage: { name: "deploy", status: "success" }, env_vars: { ...marker, ...deploymentVars } })),
      getPagesProject: vi.fn(async () => ({ id: "project", name: "site", deployment_configs: { production: { compatibility_date: "2026-10-10", env_vars: { ...marker, ...projectVars } } } })),
    } as unknown as CloudflareApiClient;
    return postcheckPagesDeployment(client, withSecrets, "deployment", { pagesProjectId: "project", r2Buckets: [], d1Databases: [], kvNamespaces: [] } as unknown as TargetSnapshot);
  };
  const secret = { type: "secret_text" };
  expect(await postcheck({ API_KEY: secret }, { API_KEY: secret })).toMatchObject({ ok: true, result: { succeeded: true } });
  expect(await postcheck({ API_KEY: secret, OWNER_PASSWORD: secret }, { API_KEY: secret, OWNER_PASSWORD: secret })).toMatchObject({ ok: true, result: { succeeded: true } });
  expect(await postcheck({}, {})).toMatchObject({ ok: false, error: { kind: "validation" } });
  expect(await postcheck({ API_KEY: secret, OWNER_PASSWORD: secret }, { API_KEY: secret })).toMatchObject({ ok: false, error: { kind: "validation" } });
});
