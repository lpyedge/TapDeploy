// The Wrangler plan adapters are pure (plan-time only): they may not reach the
// provider client, the effectful resource steps or the step engine.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../src/core/deploy/wrangler-binding-plan.ts", import.meta.url), "utf8");
const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);

describe("wrangler-binding-plan boundary", () => {
  it("imports no step engine, effectful steps, secrets or provider client", () => {
    expect(specifiers.filter((specifier) => /^\.\/(bindings|steps|secrets|pages|domains)\.js$/.test(specifier))).toEqual([]);
    expect(specifiers.filter((specifier) => /cloudflare\/client/.test(specifier))).toEqual([]);
  });
});
