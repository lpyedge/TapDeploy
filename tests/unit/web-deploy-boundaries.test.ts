// The sealed-graph runner must stay independent of the UI and of any step
// driver (dependency direction: deploy-shared <- graph-upload <- graph-deploy-runner).
// The legacy V1/V2 step driver (deploy.ts) was deleted in ; the first case
// keeps it from coming back as a dependency.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const importsOf = (file: string): string[] => {
  const text = readFileSync(new URL(`../../src/web/${file}`, import.meta.url), "utf8");
  return [...text.matchAll(/from "(\.[^"]+)"/g)].map((match) => match[1]!).filter((target) => target.startsWith("./"));
};

describe("web deploy module boundaries", () => {
  it.each(["graph-deploy-runner.ts", "graph-upload.ts", "deploy-shared.ts"])("%s never imports the legacy driver or the UI", (file) => {
    const local = importsOf(file);
    expect(local, file).not.toContain("./deploy.js");
    expect(local.filter((target) => /App|Panel|Shell|DeployProgress/.test(target)), file).toEqual([]);
  });

  it("the shared helpers depend on nothing local", () => {
    expect(importsOf("deploy-shared.ts")).toEqual([]);
  });

  it("the upload module does not import the runner (no cycle)", () => {
    expect(importsOf("graph-upload.ts")).not.toContain("./graph-deploy-runner.js");
  });
});
