// The sealed-graph wizard advances only through the machine's transition
// table: release -> configure -> deploy -> done. Illegal jumps throw instead
// of silently rendering a stale plan.
import { describe, expect, it } from "vitest";
import { pagesAssetHash } from "../../src/cloudflare/pages/manifest.js";
import { createSourceStore } from "../../src/web/compute/source-store.js";
import { V3FlowMachine } from "../../src/web/v3-flow-machine.js";

const source = { blob: new Blob([new Uint8Array([1])]), access: createSourceStore([], async () => pagesAssetHash), label: "release.zip" };

describe("V3FlowMachine scheduler hints", () => {
  const hints = { version: 1, topoOrder: ["a"], dependencies: [] };
  const toDeploy = () => {
    const m = new V3FlowMachine();
    m.setCoverage(true);
    m.setSource(source, "proof", [{ unitId: "main", kind: "worker", name: "api" }]);
    m.setInputs({}, "install");
    return m;
  };
  it("keeps the plan's hints for the deploy step and drops them with the plan", () => {
    const m = toDeploy();
    m.setPlan({ graphPlan: { units: [] }, executionContext: "ctx", approval: "appr", schedulerHints: hints });
    expect(m.snapshot().schedulerHints).toEqual(hints);
    m.backToConfigure();
    expect(m.snapshot().schedulerHints).toBeNull();
  });
  it("has no hints when the plan carried none", () => {
    const m = toDeploy();
    m.setPlan({ graphPlan: { units: [] }, executionContext: "ctx", approval: "appr" });
    expect(m.snapshot().schedulerHints).toBeNull();
  });
});

describe("V3FlowMachine", () => {
  it("walks release -> configure -> deploy -> done in order", () => {
    const m = new V3FlowMachine();
    expect(m.snapshot().stage).toBe("release");
    expect(() => m.setPlan({ graphPlan: {}, executionContext: {}, approval: {} })).toThrow();
    m.setCoverage(true);
    m.setSource(source, "proof", [{ unitId: "main", kind: "worker", name: "api" }]);
    expect(m.snapshot().stage).toBe("configure");
    expect(m.snapshot().releaseUnits).toEqual([{ unitId: "main", kind: "worker", name: "api" }]);
    m.setInputs({ workerName: "renamed" }, "upgrade");
    expect(m.snapshot().inputs).toEqual({ workerName: "renamed" });
    expect(m.snapshot().modeIntent).toBe("upgrade");
    m.setPlan({ graphPlan: { units: [] }, executionContext: "ctx", approval: "appr" });
    expect(m.snapshot().stage).toBe("deploy");
    expect(m.snapshot().graphPlan).toEqual({ units: [] });
    m.startDeploy();
    expect(m.snapshot().deployRunning).toBe(true);
    expect(() => m.startDeploy()).toThrow();
    expect(m.snapshot().stage).toBe("deploy");
    m.finishDeploy({ ok: true, verifiedReceipts: 3 });
    const done = m.snapshot();
    expect(done.stage).toBe("done");
    expect(done.deployOk).toBe(true);
    expect(done.deployRunning).toBe(false);
    expect(done.verifiedReceipts).toBe(3);
  });

  it("refuses deploy without a sealed plan", () => {
    const m = new V3FlowMachine();
    m.setCoverage(true);
    expect(() => m.startDeploy()).toThrow();
  });

  it("refuses plan without a sealed release", () => {
    const m = new V3FlowMachine();
    m.setCoverage(true);
    expect(m.can("PLAN_READY")).toBe(false);
    expect(() => m.setPlan({ graphPlan: {}, executionContext: {}, approval: {} })).toThrow();
  });

  it("mismatch always returns to release with an emptied cache", () => {
    const m = new V3FlowMachine();
    m.setCoverage(true);
    m.setSource(source, "proof", [{ unitId: "main", kind: "worker", name: "api" }]);
    m.setInputs({ workerName: "x" }, "install");
    m.setCoverage(false, "stale grant");
    const snap = m.snapshot();
    expect(snap.stage).toBe("release");
    expect(snap.coverage).toBe("mismatch");
    expect(snap.coverageNote).toBe("stale grant");
    expect(snap.source).toBeNull();
    expect(snap.releaseProof).toBeNull();
    expect(snap.inputs).toEqual({});
    expect(snap.graphPlan).toBeNull();
  });

  it("back to configure keeps the release and inputs but drops the plan", () => {
    const m = new V3FlowMachine();
    m.setCoverage(true);
    m.setSource(source, "proof", []);
    m.setInputs({ workerName: "x" }, "install");
    m.setPlan({ graphPlan: { units: [] }, executionContext: "ctx", approval: "appr" });
    m.backToConfigure();
    const snap = m.snapshot();
    expect(snap.stage).toBe("configure");
    expect(snap.releaseProof).toBe("proof");
    expect(snap.inputs).toEqual({ workerName: "x" });
    expect(snap.graphPlan).toBeNull();
  });

  it("reset clears everything for a new config", () => {
    const m = new V3FlowMachine();
    m.setCoverage(true);
    m.setSource(source, "proof", []);
    m.reset();
    const snap = m.snapshot();
    expect(snap.stage).toBe("release");
    expect(snap.coverage).toBe("checking");
    expect(snap.source).toBeNull();
  });
});
