import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfigV3Entry } from "../../src/manifest/config-v3.js";

// Every config example in the documentation must pass the same validation the
// server applies, so the docs cannot drift from the schema.
function configExamples(file: string): unknown[] {
  const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const blocks = [...text.matchAll(/```jsonc?\n([\s\S]*?)```/g)].map((match) => match[1]!.replace(/\s\/\/ [^\n]*$/gm, ""));
  return blocks.map((block) => JSON.parse(block) as unknown).filter((value) => typeof value === "object" && value !== null && "schemaVersion" in value);
}

describe("documentation config examples", () => {
  it.each(["README.md", "README.zh-TW.md", "docs/publishing.md"])("%s", (file) => {
    const examples = configExamples(file);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(validateConfigV3Entry(example).errors).toEqual([]);
  });
});
