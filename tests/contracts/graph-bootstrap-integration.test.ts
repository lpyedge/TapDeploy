import { expect, it } from "vitest";
import { clientBootstrapRunner, decideBootstrapMode, inspectBootstrapTarget, validateBootstrapProfile } from "../../src/core/deploy/bootstrap-profile.js";

it("fails closed rather than treating unverified Owner object access as absence", async () => {
  const profile = validateBootstrapProfile({ kind: "private-r2-owner-bootstrap/v1", unitId: "api", r2Binding: "DATA", rootSecret: "ROOT", armSecret: "SETUP_ARMED", armValue: "yes", ownerKey: "owner.json", markerKey: "marker", initialPasswordKey: "initial-password" });
  expect(profile.ok).toBe(true); if (!profile.ok) return;
  const runner = clientBootstrapRunner({ listSecrets: async () => [], getR2Bucket: async () => ({}) } as never);
  const inspected = await inspectBootstrapTarget(runner, { workerName: "api", bucketName: "private-data", profile: profile.value });
  expect(inspected).toMatchObject({ ok: false, refusal: { code: "UNVERIFIED_OAUTH" } });
});

// the verified existence reads feed the limited state table exactly; a
// marked-but-ownerless bucket is a refusal (never a silent "fresh").
it("derives fresh/resume/upgrade/refusals from verified existence reads only", async () => {
  const profile = validateBootstrapProfile({ kind: "private-r2-owner-bootstrap/v1", unitId: "api", r2Binding: "DATA", rootSecret: "ROOT", armSecret: "SETUP_ARMED", armValue: "yes", ownerKey: "owner.json", markerKey: "marker", initialPasswordKey: "initial-password" });
  expect(profile.ok).toBe(true); if (!profile.ok) return;
  const inspect = async (secrets: string[] | null, objects: string[]) => {
    const runner = {
      secretNames: async () => secrets,
      bucketExists: async () => true,
      objectExists: async (_bucketName: string, key: string) => objects.includes(key),
    };
    const inspected = await inspectBootstrapTarget(runner, { workerName: "api", bucketName: "private-data", profile: profile.value });
    expect(inspected.ok).toBe(true); if (!inspected.ok) throw new Error("inspection failed");
    return decideBootstrapMode(inspected.value);
  };
  expect(await inspect([], [])).toMatchObject({ ok: true, value: { mode: "fresh" } });
  expect(await inspect(["ROOT"], [])).toMatchObject({ ok: true, value: { mode: "resume" } });
  expect(await inspect(["ROOT"], ["owner.json"])).toMatchObject({ ok: true, value: { mode: "upgrade" } });
  // marker without owner: a started-but-unfinished install refuses (never fresh)
  expect(await inspect([], ["marker"])).toMatchObject({ ok: false, refusal: { code: "RECOVERY_REQUIRED" } });
  // owner without root: a reset would lock the Owner out
  expect(await inspect([], ["owner.json"])).toMatchObject({ ok: false, refusal: { code: "ROOT_MISSING" } });
});
