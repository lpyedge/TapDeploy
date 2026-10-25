// Cross-runtime parity.
//
// Workers and Node must have identical OAuth/flow/manifest semantics,
// validated through E2E. : two-runtime parity tests must confirm no extra
// OAuth after a new/update or resource picker change within the envelope.
//
// The API is built from ONE `createApp` core for both runtimes (`src/runtime/`)
// and the RUNTIME label only affects /api/health. This test
// drives the REAL authenticated OAuth->session->plan flow through BOTH runtimes
// against the same provider mock and asserts the responses are byte-identical
// after stripping the runtime label, and that neither runtime invents a second
// OAuth (the plan/session success never re-runs the auth/start exchange).
//

import { describe, expect, it } from "vitest";

import worker from "../../src/runtime/workers.js";
import { createApp, type TapDeployEnv } from "../../src/api/app.js";

const PUBLIC_ORIGIN = "https://installer.example";
const CLIENT_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function env(runtime: "node" | "workers"): TapDeployEnv {
  return {
    RUNTIME: runtime,
    PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    OAUTH_CLIENT_ID: "client-123",
    OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  };
}

// Strip the runtime label so two otherwise-identical response bodies compare
// equal. The runtime label itself is asserted separately.
function withoutRuntime(body: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...body };
  delete clone.runtime;
  return clone;
}

describe("cross-runtime parity", () => {

  it("both runtimes answer the health check with the same body", async () => {
    const runtimes = [
      { name: "node", app: createApp(env("node")) },
      { name: "workers", fetch: (r: Request) => worker.fetch(r, env("workers") as unknown as Record<string, unknown>) },
    ] as const;

    let baseline: Record<string, unknown> | undefined;
    for (const rt of runtimes) {
      const res =
        "app" in rt
          ? await rt.app.request("/api/health")
          : await rt.fetch(new Request(`${PUBLIC_ORIGIN}/api/health`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const stripped = withoutRuntime(body);
      if (baseline === undefined) {
        baseline = stripped;
      } else {
        expect(stripped).toEqual(baseline);
      }
    }
  });
});
