import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUTPUT, generateConfigValidator } from "../../scripts/generate-config-validator.mjs";

describe("precompiled config validator", () => {
  it("matches the JSON Schema (run `npm run generate:validator` after editing the schema)", async () => {
    expect(readFileSync(OUTPUT, "utf8")).toBe(await generateConfigValidator());
  });

  it("is self-contained: no imports, no runtime code generation", () => {
    const code = readFileSync(OUTPUT, "utf8");
    expect(code).not.toMatch(/^import /m);
    expect(code).not.toMatch(/new Function\(|\beval\(/);
  });
});
