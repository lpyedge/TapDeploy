import { expect, it } from "vitest";
import { prepareSecretBindings } from "../../src/core/deploy/secrets.js";
import type { DeployStepContext } from "../../src/core/deploy/steps.js";
const active = "00000000-0000-4000-8000-000000000001";
const ctx = { spec: { cloudflare: { secrets: { PASSWORD: "prompt-on-install" } } }, snapshot: { secretNames: ["PASSWORD", "UNDECLARED"], activeDeploymentVersionIds: [active], latestVersionId: "00000000-0000-4000-8000-000000000002", activeBindings: [{ name: "PASSWORD", type: "secret_text" }, { name: "UNDECLARED", type: "secret_key" }] } } as unknown as DeployStepContext;
it("preserves declared and undeclared active secrets without reading values or using latest", () => {
  expect(prepareSecretBindings(ctx, { PASSWORD: "must-not-overwrite" })).toEqual({ ok: true, bindings: [{ type: "inherit", name: "PASSWORD", version_id: active }, { type: "inherit", name: "UNDECLARED", version_id: active }] });
});
it("unverified and split inheritance fails closed", () => {
  for (const snapshot of [{ ...ctx.snapshot, activeBindings: undefined }, { ...ctx.snapshot, activeDeploymentVersionIds: [active, "foreign"] }]) {
    expect(prepareSecretBindings({ ...ctx, snapshot }, {}).ok).toBe(false);
  }
});
