// fail-closed ESM export scanner unit contract. The class-export gate
// (per-unit-bundles) seals a Workflow carrier only on provable exports, so the
// scanner must approve exact forms, ignore non-export lookalikes, and refuse
// (never guess) on anything it cannot fully classify.
import { describe, expect, it } from "vitest";
import { reachableEsmExports, scanEsmExports } from "../../src/release/esm-exports.js";

describe("scanEsmExports", () => {
  it("approves direct declaration forms and ignores the default export", () => {
    const scanned = scanEsmExports([
      "export class WF { async run() {} }",
      "export function helper() {}",
      "export async function bg() {}",
      "export const K = 1;",
      "let L = 2; export { L };",
      "export default { fetch() { return new Response(\"ok\"); } };",
      "export default class AlsoDefault {}",
    ].join("\n"));
    expect(scanned.inconclusive).toBe(false);
    expect(scanned.names).toEqual(["K", "L", "WF", "bg", "helper"]);
  });

  it("handles list exports, aliases and string names exactly", () => {
    const scanned = scanEsmExports('const a = 1; const b = 2; export { a, b as C, a as "quoted", "bare", "s" as Y };');
    expect(scanned.inconclusive).toBe(false);
    // `a as "quoted"` contributes no identifier; `"s" as Y` exports Y.
    expect(scanned.names).toEqual(["C", "Y", "a"]);
  });

  it("treats destructured exports as contributing nothing", () => {
    const scanned = scanEsmExports("export const { x } = { x: 1 }; export const [y] = [1];");
    expect(scanned.inconclusive).toBe(false);
    expect(scanned.names).toEqual([]);
  });

  it("ignores export lookalikes in property access, strings, comments and templates", () => {
    const scanned = scanEsmExports([
      "const o = {}; o.export = 1; foo?.export;",
      'const s = "export class Fake {}";',
      "// export const Ghost = 1;",
      "/* export function Phantom() {} */",
      "const t = `export const Template = 1;`;",
      "const re = /export (class|const) R/;",
      "export const Real = 1;",
    ].join("\n"));
    expect(scanned.inconclusive).toBe(false);
    expect(scanned.names).toEqual(["Real"]);
  });

  it("records star and named re-exports without claiming their names", () => {
    const scanned = scanEsmExports('export * from "./impl.mjs"; export { WF } from "./wf.mjs"; export * as ns from "./ns.mjs";');
    expect(scanned.inconclusive).toBe(false);
    expect(scanned.starFrom).toEqual(["./impl.mjs"]);
    expect(scanned.names).toEqual(["ns"]);
    expect(scanned.namedFrom).toEqual([{ names: ["WF"], specifier: "./wf.mjs" }]);
  });

  it("is inconclusive on unknown forms and unterminated input", () => {
    // A bare star specifier parses but never resolves: the refusal surfaces in
    // reachableEsmExports (covered below), not at single-module scan level.
    expect(scanEsmExports('export * from "bare-specifier";').starFrom).toEqual(["bare-specifier"]);
    expect(scanEsmExports("export const x = `unterminated;").inconclusive).toBe(true);
    expect(scanEsmExports("export /* unterminated").inconclusive).toBe(true);
    expect(scanEsmExports("export async x() {}").inconclusive).toBe(true);
    expect(scanEsmExports("export { x as };").inconclusive).toBe(true);
  });
});

describe("reachableEsmExports", () => {
  const sources = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("resolves direct and chained exports", () => {
    const reachable = reachableEsmExports("worker/main.mjs", sources({
      "worker/main.mjs": 'export { WF } from "./wf.mjs"; export const K = 1;',
      "worker/wf.mjs": "export class WF { async run() {} }",
    }));
    expect(reachable).toEqual({ ok: true, names: new Set(["K", "WF"]) });
  });

  it("resolves star chains with extension probing", () => {
    const reachable = reachableEsmExports("main.mjs", sources({
      "main.mjs": 'export * from "./sub/impl";',
      "sub/impl.mjs": "export function WF() {}",
    }));
    expect(reachable).toEqual({ ok: true, names: new Set(["WF"]) });
  });

  it("refuses a barrel vouching for a class its target lacks", () => {
    const reachable = reachableEsmExports("main.mjs", sources({
      "main.mjs": 'export { WF } from "./impl.mjs";',
      "impl.mjs": "export class Other {}",
    }));
    expect(reachable.ok).toBe(false);
  });

  it("refuses unresolvable and bare re-export targets", () => {
    expect(reachableEsmExports("main.mjs", sources({ "main.mjs": 'export * from "./missing.mjs";' })).ok).toBe(false);
    expect(reachableEsmExports("main.mjs", sources({ "main.mjs": 'export * from "some-package";' })).ok).toBe(false);
    expect(reachableEsmExports("main.mjs", sources({ "main.mjs": 'export { WF } from "./missing.mjs";' })).ok).toBe(false);
  });

  it("refuses an ambiguous name arriving via two different star sources", () => {
    const reachable = reachableEsmExports("main.mjs", sources({
      "main.mjs": 'export * from "./a.mjs"; export * from "./b.mjs";',
      "a.mjs": "export class WF {}",
      "b.mjs": "export class WF {}",
    }));
    expect(reachable.ok).toBe(true);
    // Ambiguous at link time: claimed by neither.
    expect(reachable.names.has("WF")).toBe(false);
    // ...and a barrel re-export of the ambiguous name is unverifiable.
    const chained = reachableEsmExports("top.mjs", sources({
      "top.mjs": 'export { WF } from "./mid.mjs";',
      "mid.mjs": 'export * from "./a.mjs"; export * from "./b.mjs";',
      "a.mjs": "export class WF {}",
      "b.mjs": "export class WF {}",
    }));
    expect(chained.ok).toBe(false);
  });

  it("lets an explicit name shadow a star source", () => {
    const reachable = reachableEsmExports("main.mjs", sources({
      "main.mjs": 'export * from "./a.mjs"; export class WF {}',
      "a.mjs": "export class WF {}",
    }));
    expect(reachable).toEqual({ ok: true, names: new Set(["WF"]) });
  });

  it("terminates on re-export cycles without false approval", () => {
    const reachable = reachableEsmExports("a.mjs", sources({
      "a.mjs": 'export { B } from "./b.mjs";',
      "b.mjs": 'export { A } from "./a.mjs";',
    }));
    expect(reachable.ok).toBe(false);
  });
});
