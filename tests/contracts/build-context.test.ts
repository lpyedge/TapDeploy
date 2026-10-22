// Repository-level guarantees outside the deploy flow: what the resource
// catalog promises about deletion, and what the Docker build context excludes.

import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RESOURCE_SUPPORT_MATRIX } from "../../src/cloudflare/resources/index.js";
import { RESOURCE_MUTATION_MATRIX } from "../../src/cloudflare/resources/mutations.js";

it("capability metadata promises deletion only for operator-removed custom domains", () => {
  const removable = new Set(["worker-custom-domain", "pages-custom-domain"]);
  for (const row of RESOURCE_SUPPORT_MATRIX) expect(row.deletes, row.kind).toBe(removable.has(row.kind) ? "explicit" : "never");
  for (const row of RESOURCE_MUTATION_MATRIX) expect(row.operations.delete?.supported ?? false, row.kind).toBe(false);
});

it("the Docker build context excludes environment files, Wrangler state and keys at any depth", () => {
  const ignore = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8").split("\n");
  for (const pattern of ["**/.env*", "**/.dev.vars*", "**/.wrangler", "**/.npmrc", "**/.netrc", "**/*.pem", "**/*.key", "**/id_rsa", "**/id_ed25519"]) expect(ignore).toContain(pattern);
});
