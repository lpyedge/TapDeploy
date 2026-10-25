// Repository-level guarantee outside the deploy flow: what the Docker build context excludes.

import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

it("the Docker build context excludes environment files, Wrangler state and keys at any depth", () => {
  const ignore = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8").split("\n");
  for (const pattern of ["**/.env*", "**/.dev.vars*", "**/.wrangler", "**/.npmrc", "**/.netrc", "**/*.pem", "**/*.key", "**/id_rsa", "**/id_ed25519"]) expect(ignore).toContain(pattern);
});
