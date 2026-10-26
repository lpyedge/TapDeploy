import { describe, expect, it } from "vitest";
import { blockedByPrerequisite, parseSchedulerHints } from "../../src/web/graph-scheduler.js";

const units = ["a", "b", "c"];
const valid = { version: 1, topoOrder: ["c", "b", "a"], dependencies: [{ dependent: "a", dependency: "b" }, { dependent: "b", dependency: "c" }] };

describe("parseSchedulerHints", () => {
  it("accepts well-formed hints for the plan's units", () => {
    expect(parseSchedulerHints(valid, units)).toEqual(valid);
    expect(parseSchedulerHints({ version: 1, topoOrder: [], dependencies: [] }, [])).toEqual({ version: 1, topoOrder: [], dependencies: [] });
  });
  it.each([
    ["missing", undefined],
    ["null", null],
    ["missing units", { version: 1, topoOrder: [], dependencies: [] }],
    ["a string", "hints"],
    ["wrong version", { ...valid, version: 2 }],
    ["topoOrder not an array", { ...valid, topoOrder: "c,b,a" }],
    ["non-string unit in topoOrder", { ...valid, topoOrder: ["c", 1, "a"] }],
    ["duplicate unit in topoOrder", { ...valid, topoOrder: ["c", "c", "a"] }],
    ["unknown unit in topoOrder", { ...valid, topoOrder: ["c", "b", "zzz"] }],
    ["dependencies not an array", { ...valid, dependencies: {} }],
    ["edge naming an unknown unit", { ...valid, dependencies: [{ dependent: "a", dependency: "zzz" }] }],
    ["edge naming a unit missing from topoOrder", { ...valid, topoOrder: ["c", "b"], dependencies: [{ dependent: "a", dependency: "b" }] }],
    ["self edge", { ...valid, dependencies: [{ dependent: "a", dependency: "a" }] }],
    ["duplicate edge", { ...valid, dependencies: [valid.dependencies[0], valid.dependencies[0]] }],
    ["cycle", { version: 1, topoOrder: ["a", "b"], dependencies: [{ dependent: "a", dependency: "b" }, { dependent: "b", dependency: "a" }] }],
    ["order contradicting an edge", { ...valid, topoOrder: ["a", "b", "c"] }],
    ["edge with non-string ends", { ...valid, dependencies: [{ dependent: 1, dependency: "b" }] }],
    ["null edge", { ...valid, dependencies: [null] }],
  ])("refuses %s before dispatch", (_name, raw) => {
    expect(parseSchedulerHints(raw, units)).toBeNull();
  });
});

describe("blockedByPrerequisite", () => {
  const hints = parseSchedulerHints(valid, units)!;
  const act = (unitId: string, resource: string, action: string, phase: string) => ({ unitId, resource, action, phase });
  const create = (unitId: string) => act(unitId, "worker", "create", "create-worker");

  it("blocks a unit while any unit it depends on has pending work", () => {
    expect(blockedByPrerequisite(create("a"), [act("b", "deployment", "create", "activate")], hints)).toBe(true);
    expect(blockedByPrerequisite(create("a"), [create("a"), act("c", "worker", "create", "create-worker")], hints)).toBe(false);
    expect(blockedByPrerequisite(create("b"), [act("c", "worker", "create", "create-worker")], hints)).toBe(true);
  });
  it("does not block a unit with no dependencies, or when its dependencies are done", () => {
    expect(blockedByPrerequisite(create("c"), [create("a"), create("b")], hints)).toBe(false);
    expect(blockedByPrerequisite(create("a"), [], hints)).toBe(false);
  });
  it("orders a unit's own actions the way the step route requires", () => {
    const bucket = act("a", "r2", "create", "create-r2-buckets");
    const worker = create("a");
    const activate = act("a", "deployment", "create", "activate");
    const postcheck = act("a", "worker", "create", "postcheck");
    expect(blockedByPrerequisite(worker, [worker, bucket, activate], hints)).toBe(true);
    expect(blockedByPrerequisite(worker, [worker, activate], hints)).toBe(false);
    expect(blockedByPrerequisite(activate, [worker, activate], hints)).toBe(true);
    expect(blockedByPrerequisite(activate, [activate], hints)).toBe(false);
    expect(blockedByPrerequisite(postcheck, [postcheck, activate], hints)).toBe(true);
    expect(blockedByPrerequisite(act("a", "static-assets", "create", "register-assets"), [bucket], hints)).toBe(false);
  });
  it("orders a Pages unit the way the step route requires (project, then assets, then the deployment)", () => {
    const project = act("a", "pages-project", "create", "pages-create-project");
    const assets = act("a", "static-assets", "update", "pages-register-assets");
    const deploy = act("a", "deployment", "create", "pages-deploy");
    // The plan lists the deployment before its assets (seen live): the deployment must still wait for them.
    expect(blockedByPrerequisite(deploy, [deploy, assets], hints)).toBe(true);
    expect(blockedByPrerequisite(deploy, [deploy, project, assets], hints)).toBe(true);
    expect(blockedByPrerequisite(assets, [deploy, assets, project], hints)).toBe(true);
    expect(blockedByPrerequisite(assets, [deploy, assets], hints)).toBe(false);
    expect(blockedByPrerequisite(deploy, [deploy], hints)).toBe(false);
    expect(blockedByPrerequisite(project, [deploy, assets, project], hints)).toBe(false);
  });
  it("never blocks on an action the browser would not dispatch", () => {
    expect(blockedByPrerequisite(create("a"), [act("b", "worker", "preserve", "create-worker")], hints)).toBe(false);
  });
});
