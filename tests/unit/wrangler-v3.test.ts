import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WRANGLER_V3_FIELD_MATRIX,
  WRANGLER_V3_INERT_FIELDS,
  WRANGLER_V3_SUPPORTED_FIELDS,
  WRANGLER_V3_UNSUPPORTED_FIELDS,
  normalizeWranglerV3,
  resolveZipRelativePath,
  type WranglerV3Result,
} from "../../src/manifest/wrangler-v3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../fixtures/prebuilt-v3/wrangler");

function fixture(name: string): string {
  return readFileSync(path.join(fixtures, name), "utf8");
}

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "demo",
    main: "worker/main.mjs",
    compatibility_date: "2026-10-10",
    ...overrides,
  });
}

function codes(result: WranglerV3Result): string[] {
  return result.issues.map((issue) => issue.code);
}

function fieldIssues(result: WranglerV3Result, field: string) {
  return result.issues.filter((issue) => issue.field === field);
}

describe("normalizeWranglerV3 — runbook 11 layouts", () => {
  it("normalizes the single-worker fixture (JSONC comments + trailing comma)", () => {
    const result = normalizeWranglerV3(fixture("single-worker.jsonc"));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    const cfg = result.config!;
    expect(cfg.kind).toBe("worker");
    expect(cfg.configPath).toBe("wrangler.jsonc");
    expect(cfg.baseDir).toBe("");
    expect(cfg.name).toBe("example-notes");
    expect(cfg.main).toBe("worker/main.mjs");
    expect(cfg.compatibility_date).toBe("2026-10-10");
    expect(cfg.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.routes).toEqual([
      { pattern: "notes.example.com", custom_domain: true },
    ]);
    expect(cfg.vars).toEqual({
      APP_NAME: "Example Notes",
      RETENTION_DAYS: 30,
      BETA: false,
    });
    expect(cfg.assets).toEqual({
      directory: "./public",
      directoryPath: "public",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*"],
    });
    expect(cfg.inertFields).toEqual(["$schema", "observability"]);
    expect(cfg.crons).toEqual([]);
    expect(cfg.ratelimits).toEqual([]);
    expect(cfg.workflows).toEqual([]);
    expect(cfg.durableObjects).toEqual([]);
    expect(cfg.migrations).toEqual([]);
    expect(cfg.services).toEqual([]);
    expect(cfg.rules).toEqual([]);
  });

  it("accepts a cron-only worker (no fetch handler, no routes)", () => {
    const result = normalizeWranglerV3(fixture("cron-only.jsonc"));
    expect(result.ok).toBe(true);
    expect(result.config!.kind).toBe("worker");
    expect(result.config!.main).toBe("worker/cron.mjs");
    expect(result.config!.crons).toEqual(["*/5 * * * *", "0 3 * * *"]);
    expect(result.config!.routes).toEqual([]);
    expect(result.config!.workers_dev).toBeUndefined();
  });

  it("normalizes a workflow carrier: workflows/DO/migrations/services/ratelimits", () => {
    const result = normalizeWranglerV3(fixture("workflow-stack.jsonc"));
    expect(result.ok).toBe(true);
    const cfg = result.config!;
    expect(cfg.ratelimits).toEqual([
      { name: "UPLOAD_LIMITER", namespace_id: "1001", limit: 100, period: 60 },
    ]);
    expect(cfg.workflows).toEqual([
      {
        name: "sync-workflow",
        binding: "SYNC_WORKFLOW",
        class_name: "SyncWorkflow",
      },
    ]);
    expect(cfg.durableObjects).toEqual([
      { name: "SYNC_STATE", class_name: "SyncState" },
    ]);
    expect(cfg.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["SyncState"] },
    ]);
    expect(cfg.services).toEqual([
      {
        binding: "AUTH_SERVICE",
        service: "auth-worker",
        environment: "production",
      },
    ]);
    expect(cfg.rules).toEqual([{ type: "CompiledWasm", globs: ["**/*.wasm"] }]);
    // Resources stay typed bindings; they are never flattened into vars.
    expect(cfg.vars).toBeUndefined();
  });

  it("normalizes a Pages config via pages_build_output_dir", () => {
    const result = normalizeWranglerV3(fixture("pages.jsonc"));
    expect(result.ok).toBe(true);
    expect(result.config!.kind).toBe("pages");
    expect(result.config!.pages_build_output_dir).toBe("public");
    expect(result.config!.main).toBeUndefined();
  });

  it("accepts a declared pages production_branch", () => {
    const result = normalizeWranglerV3(
      JSON.stringify({ name: "site", compatibility_date: "2026-10-10", pages_build_output_dir: "dist", production_branch: "staging" }),
    );
    expect(result.ok).toBe(true);
    expect(result.config!.production_branch).toBe("staging");
  });

  it("rejects an invalid pages production_branch instead of ignoring it", () => {
    for (const bad of ["", "has space", "x".repeat(129)]) {
      const result = normalizeWranglerV3(
        JSON.stringify({ name: "site", compatibility_date: "2026-10-10", pages_build_output_dir: "dist", production_branch: bad }),
      );
      expect(result.ok).toBe(false);
      expect(fieldIssues(result, "production_branch")[0]?.code).toBe("INVALID_SHAPE");
    }
  });
});

describe("normalizeWranglerV3 — unit-relative entry paths", () => {
  it("resolves main/assets relative to the config location and refuses escapes", () => {
    expect(resolveZipRelativePath("", "worker/main.mjs")).toBe("worker/main.mjs");
    expect(resolveZipRelativePath("units/api", "./worker/main.mjs")).toBe(
      "units/api/worker/main.mjs",
    );
    expect(resolveZipRelativePath("units/api", "../shared/main.mjs")).toBe(
      "units/shared/main.mjs",
    );
    expect(resolveZipRelativePath("", "a/../b.mjs")).toBe("b.mjs");
    expect(resolveZipRelativePath("", "../x.mjs")).toBeNull();
    expect(resolveZipRelativePath("", "a/../../x.mjs")).toBeNull();
    expect(resolveZipRelativePath("units/api", "../../../x.mjs")).toBeNull();
    expect(resolveZipRelativePath("", "/abs.mjs")).toBeNull();
    expect(resolveZipRelativePath("", "C:\\x.mjs")).toBeNull();
    expect(resolveZipRelativePath("", "a\\..\\b.mjs")).toBe("b.mjs");
  });

  it("resolves multi-unit main paths against the unit base", () => {
    const result = normalizeWranglerV3(config(), {
      configPath: "units/api/wrangler.jsonc",
    });
    expect(result.ok).toBe(true);
    expect(result.config!.baseDir).toBe("units/api");
    expect(result.config!.main).toBe("units/api/worker/main.mjs");

    // `..` may climb out of the unit directory but not out of the ZIP root.
    const toRoot = normalizeWranglerV3(config({ main: "../../evil.mjs" }), {
      configPath: "units/api/wrangler.jsonc",
    });
    expect(toRoot.ok).toBe(true);
    expect(toRoot.config!.main).toBe("evil.mjs");

    const escape = normalizeWranglerV3(config({ main: "../../../evil.mjs" }), {
      configPath: "units/api/wrangler.jsonc",
    });
    expect(escape.ok).toBe(false);
    expect(fieldIssues(escape, "main")[0]?.code).toBe("PATH_ESCAPES_UNIT");
  });

  it("refuses escaping assets.directory and pages_build_output_dir", () => {
    const assets = normalizeWranglerV3(
      config({ main: undefined, assets: { directory: "../../../public" } }),
    );
    expect(assets.ok).toBe(false);
    expect(fieldIssues(assets, "assets.directory")[0]?.code).toBe(
      "PATH_ESCAPES_UNIT",
    );

    const pages = normalizeWranglerV3(
      JSON.stringify({
        name: "site",
        pages_build_output_dir: "../../../public",
        compatibility_date: "2026-10-10",
      }),
    );
    expect(pages.ok).toBe(false);
    expect(fieldIssues(pages, "pages_build_output_dir")[0]?.code).toBe(
      "PATH_ESCAPES_UNIT",
    );
  });
});

describe("normalizeWranglerV3 — field matrix", () => {
  it("records reviewed inert fields ($schema/observability/build)", () => {
    const result = normalizeWranglerV3(
      config({
        $schema: "node_modules/wrangler/config-schema.json",
        observability: { enabled: true },
        build: { command: "npm run build", cwd: "." },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.config!.inertFields).toEqual([
      "$schema",
      "build",
      "observability",
    ]);
  });

  it("refuses legacy build.upload instead of ignoring it", () => {
    const result = normalizeWranglerV3(
      config({ build: { upload: { format: "service-worker" } } }),
    );
    expect(result.ok).toBe(false);
    expect(fieldIssues(result, "build.upload")[0]?.code).toBe(
      "UNSUPPORTED_WRANGLER_FEATURE",
    );
  });

  it("rejects unknown top-level fields instead of silently dropping them", () => {
    const result = normalizeWranglerV3(config({ mystery_field: 1 }));
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["UNKNOWN_WRANGLER_FIELD"]);
    expect(fieldIssues(result, "mystery_field")).toHaveLength(1);
    expect(result.config).toBeUndefined();
  });

  it("maps official-but-unimplemented fields to UNSUPPORTED_WRANGLER_FEATURE", () => {
    // Supersession: "queues" left this list (official producers/consumers
    // shape implemented); the remaining fields keep the behavior.
    for (const field of ["python_modules", "tail_consumers"]) {
      const result = normalizeWranglerV3(config({ [field]: [] }));
      expect(result.ok, field).toBe(false);
      const issue = fieldIssues(result, field)[0];
      expect(issue?.code, field).toBe("UNSUPPORTED_WRANGLER_FEATURE");
      expect(issue?.detail, field).toContain("not implemented");
    }
  });

  it("keeps the matrix internally consistent", () => {
    const seen = new Set<string>();
    for (const field of [
      ...WRANGLER_V3_SUPPORTED_FIELDS,
      ...WRANGLER_V3_INERT_FIELDS,
      ...WRANGLER_V3_UNSUPPORTED_FIELDS,
    ]) {
      expect(seen.has(field), `duplicate matrix entry ${field}`).toBe(false);
      seen.add(field);
    }
    expect(WRANGLER_V3_FIELD_MATRIX["durable_objects"]).toBe("supported");
    expect(WRANGLER_V3_FIELD_MATRIX["observability"]).toBe("inert");
    // Promoted the resource-binding families from the pending handoff.
    expect(WRANGLER_V3_FIELD_MATRIX["r2_buckets"]).toBe("supported");
    expect(WRANGLER_V3_FIELD_MATRIX["d1_databases"]).toBe("supported");
    expect(WRANGLER_V3_FIELD_MATRIX["kv_namespaces"]).toBe("supported");
    // Promoted queues (producers/consumers) from the pending handoff.
    expect(WRANGLER_V3_FIELD_MATRIX["queues"]).toBe("supported");
    expect(WRANGLER_V3_FIELD_MATRIX["not_a_wrangler_field"]).toBeUndefined();
  });
});

describe("normalizeWranglerV3 — entry validation", () => {
  it("fails TypeScript entry points with UNCOMPILED_ENTRYPOINT", () => {
    for (const main of ["worker/main.ts", "worker/main.tsx", "worker/main.mts"]) {
      const result = normalizeWranglerV3(config({ main }));
      expect(result.ok, main).toBe(false);
      expect(fieldIssues(result, "main")[0]?.code, main).toBe(
        "UNCOMPILED_ENTRYPOINT",
      );
    }
  });

  it("requires main to be a built ESM module (.js/.mjs)", () => {
    const wasm = normalizeWranglerV3(config({ main: "worker/engine.wasm" }));
    expect(wasm.ok).toBe(false);
    expect(fieldIssues(wasm, "main")[0]?.code).toBe("INVALID_SHAPE");

    const js = normalizeWranglerV3(config({ main: "./worker/main.js" }));
    expect(js.ok).toBe(true);
    expect(js.config!.main).toBe("worker/main.js");
  });

  it("requires main for worker configs and forbids it for Pages", () => {
    const missing = normalizeWranglerV3(
      JSON.stringify({ name: "demo", compatibility_date: "2026-10-10" }),
    );
    expect(missing.ok).toBe(false);
    expect(fieldIssues(missing, "main")[0]?.code).toBe("INVALID_SHAPE");

    const pagesMain = normalizeWranglerV3(
      JSON.stringify({
        name: "site",
        main: "worker/main.mjs",
        pages_build_output_dir: "./public",
        compatibility_date: "2026-10-10",
      }),
    );
    expect(pagesMain.ok).toBe(false);
    expect(fieldIssues(pagesMain, "main")[0]?.code).toBe("INVALID_SHAPE");
  });

  it("rejects assets on a Pages config", () => {
    const result = normalizeWranglerV3(
      JSON.stringify({
        name: "site",
        pages_build_output_dir: "./public",
        assets: { directory: "./public" },
        compatibility_date: "2026-10-10",
      }),
    );
    expect(result.ok).toBe(false);
    expect(fieldIssues(result, "assets")[0]?.code).toBe("INVALID_SHAPE");
  });

  it("requires a valid compatibility_date", () => {
    const missing = normalizeWranglerV3(JSON.stringify({ name: "demo", main: "a.mjs" }));
    expect(fieldIssues(missing, "compatibility_date")[0]?.code).toBe("INVALID_SHAPE");

    const malformed = normalizeWranglerV3(
      config({ compatibility_date: "2026/10/10" }),
    );
    expect(fieldIssues(malformed, "compatibility_date")[0]?.code).toBe(
      "INVALID_SHAPE",
    );
  });
});

describe("normalizeWranglerV3 — supported field shapes", () => {
  it("normalizes route strings and objects, and refuses unknown route keys", () => {
    const routes = normalizeWranglerV3(
      config({
        routes: [
          "example.com/*",
          { pattern: "api.example.com/*", custom_domain: false, zone_name: "example.com" },
        ],
      }),
    );
    expect(routes.ok).toBe(true);
    expect(routes.config!.routes).toEqual([
      { pattern: "example.com/*" },
      { pattern: "api.example.com/*", custom_domain: false, zone_name: "example.com" },
    ]);

    const unknown = normalizeWranglerV3(
      config({ routes: [{ pattern: "x.com/*", zone: "z" }] }),
    );
    expect(fieldIssues(unknown, "routes[0].zone")[0]?.code).toBe(
      "UNKNOWN_WRANGLER_FIELD",
    );

    const badPattern = normalizeWranglerV3(config({ routes: [{ custom_domain: true }] }));
    expect(fieldIssues(badPattern, "routes[0].pattern")[0]?.code).toBe(
      "INVALID_SHAPE",
    );
  });

  it("normalizes vars primitives and refuses structured values", () => {
    const nested = normalizeWranglerV3(
      config({ vars: { OBJECT: { a: 1 }, LIST: [1] } }),
    );
    expect(nested.ok).toBe(false);
    expect(fieldIssues(nested, "vars.OBJECT")[0]?.code).toBe("INVALID_SHAPE");
    expect(fieldIssues(nested, "vars.LIST")[0]?.code).toBe("INVALID_SHAPE");
  });

  it("validates triggers.crons with the shared cron grammar", () => {
    const unknown = normalizeWranglerV3(
      config({ triggers: { crons: ["0 * * * *"], schedules: [] } }),
    );
    expect(fieldIssues(unknown, "triggers.schedules")[0]?.code).toBe(
      "UNKNOWN_WRANGLER_FIELD",
    );

    const invalid = normalizeWranglerV3(
      config({ triggers: { crons: ["not a cron"] } }),
    );
    expect(fieldIssues(invalid, "triggers.crons[0]")[0]?.code).toBe(
      "INVALID_SHAPE",
    );
  });

  it("validates ratelimit shape (official simple.limit/simple.period)", () => {
    const badPeriod = normalizeWranglerV3(
      config({
        ratelimits: [
          { name: "L", namespace_id: "1001", simple: { limit: 10, period: 45 } },
        ],
      }),
    );
    expect(fieldIssues(badPeriod, "ratelimits[0].simple.period")[0]?.code).toBe(
      "INVALID_SHAPE",
    );

    const badLimit = normalizeWranglerV3(
      config({
        ratelimits: [
          { name: "L", namespace_id: "1001", simple: { limit: 1.5, period: 60 } },
        ],
      }),
    );
    expect(fieldIssues(badLimit, "ratelimits[0].simple.limit")[0]?.code).toBe(
      "INVALID_SHAPE",
    );

    const unknownKey = normalizeWranglerV3(
      config({
        ratelimits: [
          {
            name: "L",
            namespace_id: "1001",
            simple: { limit: 10, period: 60 },
            burst: 20,
          },
        ],
      }),
    );
    expect(fieldIssues(unknownKey, "ratelimits[0].burst")[0]?.code).toBe(
      "UNKNOWN_WRANGLER_FIELD",
    );
  });

  it("validates workflow bindings and unknown entry keys", () => {
    const unknown = normalizeWranglerV3(
      config({
        workflows: [
          { name: "w", binding: "W", class_name: "W", mystery: true },
        ],
      }),
    );
    expect(fieldIssues(unknown, "workflows[0].mystery")[0]?.code).toBe(
      "UNKNOWN_WRANGLER_FIELD",
    );

    const missingBinding = normalizeWranglerV3(
      config({ workflows: [{ name: "w", class_name: "W" }] }),
    );
    expect(fieldIssues(missingBinding, "workflows[0].binding")[0]?.code).toBe(
      "INVALID_SHAPE",
    );
  });

  it("refuses unknown migration keys and unsupported migrations", () => {
    const unknown = normalizeWranglerV3(
      config({ migrations: [{ tag: "v1", mystery_classes: ["A"] }] }),
    );
    expect(fieldIssues(unknown, "migrations[0].mystery_classes")[0]?.code).toBe(
      "UNKNOWN_WRANGLER_FIELD",
    );
    expect(unknown.config).toBeUndefined();

    const transferred = normalizeWranglerV3(
      config({ migrations: [{ tag: "v1", transferred_classes: [{ from: "A", to: "B" }] }] }),
    );
    expect(
      fieldIssues(transferred, "migrations[0].transferred_classes")[0]?.code,
    ).toBe("UNSUPPORTED_WRANGLER_FEATURE");

    const renamed = normalizeWranglerV3(
      config({
        migrations: [
          { tag: "v1", renamed_classes: [{ from: "A", to: "B" }] },
        ],
      }),
    );
    expect(renamed.ok).toBe(true);
    expect(renamed.config!.migrations[0]).toEqual({
      tag: "v1",
      renamed_classes: [{ from: "A", to: "B" }],
    });

    const badPair = normalizeWranglerV3(
      config({ migrations: [{ tag: "v1", renamed_classes: [{ from: "A" }] }] }),
    );
    expect(
      fieldIssues(badPair, "migrations[0].renamed_classes[0]")[0]?.code,
    ).toBe("INVALID_SHAPE");
  });

  it("validates durable object and service binding keys", () => {
    const doUnknown = normalizeWranglerV3(
      config({
        durable_objects: {
          bindings: [{ name: "D", class_name: "D", weird: true }],
        },
      }),
    );
    expect(
      fieldIssues(doUnknown, "durable_objects.bindings[0].weird")[0]?.code,
    ).toBe("UNKNOWN_WRANGLER_FIELD");

    const serviceUnknown = normalizeWranglerV3(
      config({ services: [{ binding: "S", service: "svc", retries: 3 }] }),
    );
    expect(fieldIssues(serviceUnknown, "services[0].retries")[0]?.code).toBe(
      "UNKNOWN_WRANGLER_FIELD",
    );
  });

  it("supports Text/Data/CompiledWasm rules and refuses bundling rules", () => {
    const ok = normalizeWranglerV3(
      config({
        rules: [
          { type: "Text", globs: ["**/*.txt"] },
          { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true },
        ],
      }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.config!.rules).toEqual([
      { type: "Text", globs: ["**/*.txt"] },
      { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true },
    ]);

    const esm = normalizeWranglerV3(
      config({ rules: [{ type: "ESModule", globs: ["**/*.js"] }] }),
    );
    expect(fieldIssues(esm, "rules[0].type")[0]?.code).toBe(
      "UNSUPPORTED_WRANGLER_FEATURE",
    );

    const bogus = normalizeWranglerV3(
      config({ rules: [{ type: "Magic", globs: ["**/*.bin"] }] }),
    );
    expect(fieldIssues(bogus, "rules[0].type")[0]?.code).toBe("INVALID_SHAPE");
  });

  it("refuses binding-name collisions across the env surface", () => {
    const cross = normalizeWranglerV3(
      config({
        workflows: [{ name: "w", binding: "SHARED", class_name: "W" }],
        services: [{ binding: "SHARED", service: "svc" }],
      }),
    );
    expect(cross.ok).toBe(false);
    expect(
      cross.issues.some(
        (i) => i.code === "INVALID_SHAPE" && i.detail.includes("already used"),
      ),
    ).toBe(true);

    const sameFamily = normalizeWranglerV3(
      config({
        workflows: [
          { name: "a", binding: "DUP", class_name: "A" },
          { name: "b", binding: "DUP", class_name: "B" },
        ],
      }),
    );
    expect(sameFamily.ok).toBe(false);

    const varCollision = normalizeWranglerV3(
      config({
        vars: { RATE: "1" },
        ratelimits: [
          { name: "RATE", namespace_id: "1001", simple: { limit: 5, period: 10 } },
        ],
      }),
    );
    expect(varCollision.ok).toBe(false);
  });

  it("is deterministic for identical input", () => {
    const source = fixture("workflow-stack.jsonc");
    const a = normalizeWranglerV3(source);
    const b = normalizeWranglerV3(source);
    expect(JSON.stringify(a.config)).toBe(JSON.stringify(b.config));
  });
});
