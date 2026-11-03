// Documentation links and package.json script targets must point at files that
// exist; a dangling reference is a dead document or a dead command.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? markdownFiles(path) : path.endsWith(".md") ? [path] : [];
  });
}

describe("documentation links", () => {
  const files = [join(root, "README.md"), join(root, "README.zh-TW.md"), ...markdownFiles(join(root, "docs"))];

  it.each(files.map((file) => [file.slice(root.length + 1), file]))("%s has no dangling relative link", (_name, file) => {
    const text = readFileSync(file as string, "utf8").replace(/```[\s\S]*?```/g, "");
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!).filter((target) => !/^(https?:|mailto:|#)/.test(target));
    const missing = targets.filter((target) => !existsSync(resolve(dirname(file as string), target.split("#")[0]!)));
    expect(missing).toEqual([]);
  });

  // Publishers' READMEs load the deploy button from this repository on GitHub,
  // so a file such an address names must stay where it is.
  it("GitHub addresses of this repository's files point at files that exist", () => {
    const paths = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/https:\/\/(?:raw\.githubusercontent\.com\/lpyedge\/TapDeploy\/master|github\.com\/lpyedge\/TapDeploy\/(?:blob|raw|tree)\/master)\/([^\s)"'`#]+)/g)].map((match) => match[1]!));
    expect(paths).toContain("src/web/public/button.svg");
    expect(paths.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });
});

describe("package.json scripts", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts as Record<string, string>;

  it.each(Object.entries(scripts))("%s only runs files that exist", (_name, command) => {
    const paths = [...command.matchAll(/(?:^|\s)((?:scripts|packaging|src|tests)\/[\w./-]+\.(?:mjs|mts|ts|js))/g)].map((match) => match[1]!);
    expect(paths.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });
});
