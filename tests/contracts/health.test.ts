import { describe, expect, it } from "vitest";
import { createApp, SUPPORTED_SCHEMA_VERSION } from "../../src/api/app.js";

const runtimeEnvs = [
  { name: "node", env: { RUNTIME: "node" as const } },
  { name: "workers", env: { RUNTIME: "workers" as const } },
];

describe("api health contract", () => {
  for (const { name, env } of runtimeEnvs) {
    it(`serves /api/health on ${name} runtime`, async () => {
      const app = createApp(env);
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.runtime).toBe(name);
      expect(body.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
    });
  }
});
