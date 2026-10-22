import { expect, it } from "vitest";
import { executeDeployStep, type DeployStepContext } from "../../src/core/deploy/steps.js";

it("postcheck never reports split traffic as a completed cutover", async () => {
  const ctx = {
    workerName: "app",
    spec: { assets: [], wrangler: { vars: {} }, cloudflare: { r2: [], d1: [], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], secrets: {} } },
    snapshot: { secretNames: [], deployedBindings: {} },
    client: {
      listDeployments: async () => [{ id: "deployment", versions: [{ version_id: "approved", percentage: 10 }, { version_id: "foreign", percentage: 90 }] }],
      listVersions: async () => [{ id: "approved" }],
    },
  } as unknown as DeployStepContext;
  const result = await executeDeployStep("postcheck", ctx, { expectedVersionId: "approved" });
  expect(result).toMatchObject({ ok: true, result: { deployed: false } });
});

it("takeover between snapshot and activation cannot be overwritten", async () => {
  let writes = 0;
  const ctx = {
    workerName: "app", snapshot: { secretNames: [], activeDeploymentId: "approved-base" },
    spec: { project: { id: "app/ours", version: "1" } },
    client: {
      listVersions: async () => [{ id: "approved" }],
      listDeployments: async () => [{ id: "foreign-cutover", versions: [{ version_id: "foreign", percentage: 100 }] }],
      createDeployment: async () => { writes++; return { id: "overwrite" }; },
    },
  } as unknown as DeployStepContext;
  const result = await executeDeployStep("activate", ctx, { versionId: "approved" });
  expect(result.ok).toBe(false);
  expect(writes).toBe(0);
});
