// Queues + Cron + Rate Limits.
//
// Spec coverage:
//  - official Wrangler queues.producers/consumers parsing (the old simplified
//    [{binding,queue}] shape is refused, never reinterpreted), producer vs
//    consumer roles, explicit refusals for deprecated/dev-only/unapplied
//    tenant fields, duplicate-target and env-name collision rules;
//  - cron-only and queue-only layouts without any HTTP route/exposure;
//  - ratelimits[] -> Worker metadata binding projection with namespace
//    uniqueness and counters-ownership classification (no account resource is
//    ever created);
//  - queue consumer request mapping (official seconds -> max_wait_time_ms)
//    and the producer Worker binding shape.
//
// Provider mocks: none needed here (all functions are pure). Live rate-limit
// readback shape stays ; the client-facing idempotency contract lives in
// tests/contracts/deploy-queue-progress.test.ts.

import { describe, expect, it } from "vitest";

import {
  WRANGLER_V3_FIELD_MATRIX,
  normalizeWranglerV3,
  type WranglerV3Result,
} from "../../src/manifest/wrangler-v3.js";
import {
  consumerRequestFor,
} from "../../src/cloudflare/resources/queues.js";
import { planRateLimitBindings } from "../../src/cloudflare/resources/rate-limits.js";
import { ResourceConflictError } from "../../src/cloudflare/resources/types.js";
import { resolveDeploymentUnits } from "../../src/core/planning/deployment-units.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";

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

describe("queues.producers/consumers parsing", () => {
  it("parses the official producers/consumers shape with distinguishable roles", () => {
    const result = normalizeWranglerV3(
      config({
        queues: {
          producers: [{ binding: "EVENTS", queue: "events" }],
          consumers: [
            {
              queue: "jobs",
              type: "worker",
              max_batch_size: 5,
              max_batch_timeout: 30,
              max_retries: 2,
              max_concurrency: 4,
              retry_delay: 10,
              dead_letter_queue: "jobs-dlq",
            },
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.config!.queueProducers).toEqual([
      { binding: "EVENTS", queue: "events" },
    ]);
    expect(result.config!.queueConsumers).toEqual([
      {
        queue: "jobs",
        type: "worker",
        max_batch_size: 5,
        max_batch_timeout: 30,
        max_retries: 2,
        max_concurrency: 4,
        retry_delay: 10,
        dead_letter_queue: "jobs-dlq",
      },
    ]);
  });

  it("defaults consumer type to worker and accepts zero retries / explicit unlimited concurrency", () => {
    const result = normalizeWranglerV3(
      config({
        queues: {
          consumers: [
            { queue: "a" },
            { queue: "b", max_retries: 0 },
            { queue: "c", max_concurrency: null },
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.config!.queueConsumers).toEqual([
      { queue: "a", type: "worker" },
      { queue: "b", type: "worker", max_retries: 0 },
      { queue: "c", type: "worker", max_concurrency: null },
    ]);
  });

  it("accepts a queue declared in both arrays (production + consumption on one queue)", () => {
    const result = normalizeWranglerV3(
      config({
        queues: {
          producers: [{ binding: "PIPE", queue: "pipe" }],
          consumers: [{ queue: "pipe" }],
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.config!.queueProducers).toEqual([
      { binding: "PIPE", queue: "pipe" },
    ]);
    expect(result.config!.queueConsumers).toEqual([
      { queue: "pipe", type: "worker" },
    ]);
  });

  it("defaults to empty arrays when queues is absent", () => {
    const result = normalizeWranglerV3(config());
    expect(result.ok).toBe(true);
    expect(result.config!.queueProducers).toEqual([]);
    expect(result.config!.queueConsumers).toEqual([]);
    expect(WRANGLER_V3_FIELD_MATRIX["queues"]).toBe("supported");
  });

  it("refuses the simplified [{binding,queue}] list instead of reinterpreting it", () => {
    const result = normalizeWranglerV3(
      config({ queues: [{ binding: "JOBS", queue: "jobs" }] }),
    );
    expect(result.ok).toBe(false);
    expect(fieldIssues(result, "queues")[0]?.code).toBe("INVALID_SHAPE");
    expect(fieldIssues(result, "queues")[0]?.detail).toContain(
      "not the official shape",
    );
  });

  it("refuses malformed queues containers and entries", () => {
    const nonObject = normalizeWranglerV3(config({ queues: [] }));
    expect(fieldIssues(nonObject, "queues")[0]?.code).toBe("INVALID_SHAPE");

    const listProducers = normalizeWranglerV3(
      config({ queues: { producers: { binding: "A" } } }),
    );
    expect(fieldIssues(listProducers, "queues.producers")[0]?.code).toBe(
      "INVALID_SHAPE",
    );

    const scalarEntry = normalizeWranglerV3(
      config({ queues: { producers: ["A"], consumers: ["jobs"] } }),
    );
    expect(fieldIssues(scalarEntry, "queues.producers[0]")[0]?.code).toBe(
      "INVALID_SHAPE",
    );
    expect(fieldIssues(scalarEntry, "queues.consumers[0]")[0]?.code).toBe(
      "INVALID_SHAPE",
    );

    const unknownContainerKey = normalizeWranglerV3(
      config({ queues: { producer: [] } }),
    );
    expect(fieldIssues(unknownContainerKey, "queues.producer")[0]?.code).toBe(
      "UNKNOWN_WRANGLER_FIELD",
    );
  });

  it("refuses deprecated/dev-only producer fields explicitly", () => {
    const deprecated = normalizeWranglerV3(
      config({
        queues: { producers: [{ binding: "A", queue: "q", delivery_delay: 5 }] },
      }),
    );
    expect(
      fieldIssues(deprecated, "queues.producers[0].delivery_delay")[0]?.code,
    ).toBe("UNSUPPORTED_WRANGLER_FEATURE");

    const remote = normalizeWranglerV3(
      config({
        queues: { producers: [{ binding: "A", queue: "q", remote: true }] },
      }),
    );
    expect(fieldIssues(remote, "queues.producers[0].remote")[0]?.code).toBe(
      "UNSUPPORTED_WRANGLER_FEATURE",
    );

    const unknown = normalizeWranglerV3(
      config({ queues: { producers: [{ binding: "A", queue: "q", mystery: 1 }] } }),
    );
    expect(fieldIssues(unknown, "queues.producers[0].mystery")[0]?.code).toBe(
      "UNKNOWN_WRANGLER_FIELD",
    );
  });

  it("refuses consumer visibility_timeout_ms (never applied by the official upload) and unknown keys", () => {
    const vis = normalizeWranglerV3(
      config({
        queues: { consumers: [{ queue: "jobs", visibility_timeout_ms: 30000 }] },
      }),
    );
    expect(
      fieldIssues(vis, "queues.consumers[0].visibility_timeout_ms")[0]?.code,
    ).toBe("UNSUPPORTED_WRANGLER_FEATURE");

    const unknown = normalizeWranglerV3(
      config({ queues: { consumers: [{ queue: "jobs", burst: 3 }] } }),
    );
    expect(fieldIssues(unknown, "queues.consumers[0].burst")[0]?.code).toBe(
      "UNKNOWN_WRANGLER_FIELD",
    );
  });

  it("requires producer binding+queue and consumer queue", () => {
    const noBinding = normalizeWranglerV3(
      config({ queues: { producers: [{ queue: "q" }] } }),
    );
    expect(fieldIssues(noBinding, "queues.producers[0].binding")[0]?.code).toBe(
      "INVALID_SHAPE",
    );

    const noQueue = normalizeWranglerV3(
      config({ queues: { producers: [{ binding: "A" }] } }),
    );
    expect(fieldIssues(noQueue, "queues.producers[0].queue")[0]?.code).toBe(
      "INVALID_SHAPE",
    );
    expect(fieldIssues(noQueue, "queues.producers[0].queue")[0]?.detail).toContain(
      "refuses to guess",
    );

    const consumerNoQueue = normalizeWranglerV3(
      config({ queues: { consumers: [{ type: "worker" }] } }),
    );
    expect(
      fieldIssues(consumerNoQueue, "queues.consumers[0].queue")[0]?.code,
    ).toBe("INVALID_SHAPE");
  });

  it("refuses non-worker consumer types", () => {
    const result = normalizeWranglerV3(
      config({ queues: { consumers: [{ queue: "jobs", type: "http_pull" }] } }),
    );
    expect(result.ok).toBe(false);
    expect(fieldIssues(result, "queues.consumers[0].type")[0]?.code).toBe(
      "INVALID_SHAPE",
    );
  });

  it("refuses non-integer or out-of-range consumer settings", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ max_batch_size: 0 }, "queues.consumers[0].max_batch_size"],
      [{ max_batch_size: 1.5 }, "queues.consumers[0].max_batch_size"],
      [{ max_batch_timeout: -1 }, "queues.consumers[0].max_batch_timeout"],
      [{ max_retries: -1 }, "queues.consumers[0].max_retries"],
      [{ retry_delay: 2.5 }, "queues.consumers[0].retry_delay"],
      [{ max_concurrency: 0 }, "queues.consumers[0].max_concurrency"],
      [{ dead_letter_queue: "" }, "queues.consumers[0].dead_letter_queue"],
    ];
    for (const [entry, field] of cases) {
      const result = normalizeWranglerV3(
        config({ queues: { consumers: [{ queue: "jobs", ...entry }] } }),
      );
      expect(result.ok, JSON.stringify(entry)).toBe(false);
      expect(fieldIssues(result, field)[0]?.code, field).toBe("INVALID_SHAPE");
    }
  });

  it("fails duplicate producer targets and duplicate consumer queues, but allows producer+consumer pairs", () => {
    const dupProducers = normalizeWranglerV3(
      config({
        queues: {
          producers: [
            { binding: "A", queue: "jobs" },
            { binding: "B", queue: "jobs" },
          ],
        },
      }),
    );
    expect(dupProducers.ok).toBe(false);
    expect(fieldIssues(dupProducers, "queues.producers")[0]?.code).toBe(
      "INVALID_SHAPE",
    );
    expect(fieldIssues(dupProducers, "queues.producers")[0]?.detail).toContain(
      "cannot be two bindings",
    );

    const dupConsumers = normalizeWranglerV3(
      config({ queues: { consumers: [{ queue: "jobs" }, { queue: "jobs" }] } }),
    );
    expect(dupConsumers.ok).toBe(false);
    expect(fieldIssues(dupConsumers, "queues.consumers[1].queue")[0]?.code).toBe(
      "INVALID_SHAPE",
    );
  });

  it("joins the shared environment-binding name surface", () => {
    const r2Collision = normalizeWranglerV3(
      config({
        r2_buckets: [{ binding: "FILES", bucket_name: "files" }],
        queues: { producers: [{ binding: "FILES", queue: "files" }] },
      }),
    );
    expect(r2Collision.ok).toBe(false);
    expect(codes(r2Collision)).toContain("INVALID_SHAPE");
    expect(
      r2Collision.issues.some((issue) =>
        issue.detail.includes('already used by r2_buckets bucket "files"'),
      ),
    ).toBe(true);

    const ratelimitCollision = normalizeWranglerV3(
      config({
        ratelimits: [
          { name: "UPLOAD_LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } },
        ],
        queues: { producers: [{ binding: "UPLOAD_LIMITER", queue: "uploads" }] },
      }),
    );
    expect(ratelimitCollision.ok).toBe(false);
    expect(
      ratelimitCollision.issues.some((issue) =>
        issue.detail.includes('already used by ratelimits namespace "1001"'),
      ),
    ).toBe(true);
  });
});

describe("Cron-only / Queue-only without HTTP", () => {
  it("accepts a cron-only worker with zero routes and no workers.dev", () => {
    const result = normalizeWranglerV3(
      config({
        main: "worker/cron.mjs",
        triggers: { crons: ["*/5 * * * *", "0 3 * * *"] },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.config!.crons).toEqual(["*/5 * * * *", "0 3 * * *"]);
    expect(result.config!.routes).toEqual([]);
    expect(result.config!.workers_dev).toBeUndefined();
    expect(result.config!.queueProducers).toEqual([]);
    expect(result.config!.queueConsumers).toEqual([]);
  });

  it("accepts a queue-only worker with zero routes", () => {
    const result = normalizeWranglerV3(
      config({
        main: "worker/queue.mjs",
        queues: {
          producers: [{ binding: "EVENTS", queue: "events" }],
          consumers: [{ queue: "jobs" }],
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.config!.routes).toEqual([]);
    expect(result.config!.crons).toEqual([]);
  });

  it("resolves cron+queue triggers with no HTTP root and no exposure edges", () => {
    const spec: DeploySpec = {
      schemaVersion: 1,
      project: { id: "fixture/t08", version: "0.1.0" },
      worker: { path: "worker/main.mjs", size: 10, sha256: "a".repeat(64) },
      assets: [],
      inputs: {},
      cloudflare: {
        workerName: "tapdeploy-t08",
        r2: [],
        d1: [],
        kv: [],
        queues: [
          { binding: "JOBS", queueName: "jobs", createIfMissing: false, role: "consumer" },
          { binding: "EVENTS", queueName: "events", createIfMissing: true, role: "producer" },
        ],
        hyperdrive: [],
        vectorize: [],
        secretsStore: [],
        runtimeBindings: [],
        cron: ["*/5 * * * *"],
        secrets: {},
      },
      wrangler: {
        name: "tapdeploy-t08",
        main: "worker/main.mjs",
        compatibility_date: "2026-10-01",
        r2_buckets: [],
        crons: [],
      },
      targetKind: "workers",
    };
    const plan = resolveDeploymentUnits(spec);
    expect(plan.ok).toBe(true);
    expect(plan.units[0]!.requiresHttpRoot).toBe(false);
    expect(plan.exposures).toEqual([]);
    expect(plan.triggers.map((trigger) => trigger.id)).toEqual([
      "cron:*/5 * * * *",
      "queue-consumer:jobs",
    ]);
    // The producer binds; the consumer only registers a trigger. Neither
    // implies an HTTP route.
    expect(plan.bindings.map((binding) => [binding.resourceId, binding.binding])).toEqual([
      ["queue:events", "EVENTS"],
      ["queue:jobs", "JOBS"],
    ]);
  });
});

describe("ratelimit binding projection (no account resource)", () => {
  it("projects declared ratelimits to exact Worker metadata bindings", () => {
    const plan = planRateLimitBindings(
      [
        { name: "UPLOAD_LIMITER", namespace_id: "1001", limit: 100, period: 60 },
        { name: "API_LIMITER", namespace_id: "1002", limit: 10, period: 10 },
      ],
      [],
    );
    expect(plan.bindings).toEqual([
      {
        name: "UPLOAD_LIMITER",
        type: "ratelimit",
        namespace_id: "1001",
        simple: { limit: 100, period: 60 },
      },
      {
        name: "API_LIMITER",
        type: "ratelimit",
        namespace_id: "1002",
        simple: { limit: 10, period: 10 },
      },
    ]);
    expect(plan.preserved).toEqual([]);
    expect(plan.added).toEqual(["UPLOAD_LIMITER", "API_LIMITER"]);
  });

  it("refuses negative period and empty namespace declarations", () => {
    const badPeriod = normalizeWranglerV3(
      config({
        ratelimits: [
          { name: "A", namespace_id: "1001", simple: { limit: 10, period: 45 } },
        ],
      }),
    );
    expect(badPeriod.ok).toBe(false);
    expect(fieldIssues(badPeriod, "ratelimits[0].simple.period")[0]?.code).toBe(
      "INVALID_SHAPE",
    );

    const zeroPeriod = normalizeWranglerV3(
      config({
        ratelimits: [
          { name: "A", namespace_id: "1001", simple: { limit: 10, period: 0 } },
        ],
      }),
    );
    expect(fieldIssues(zeroPeriod, "ratelimits[0].simple.period")[0]?.code).toBe(
      "INVALID_SHAPE",
    );

    const emptyNamespace = normalizeWranglerV3(
      config({
        ratelimits: [
          { name: "A", namespace_id: "", simple: { limit: 10, period: 60 } },
        ],
      }),
    );
    expect(emptyNamespace.ok).toBe(false);
    expect(
      fieldIssues(emptyNamespace, "ratelimits[0].namespace_id")[0]?.code,
    ).toBe("INVALID_SHAPE");

    const accepted = normalizeWranglerV3(
      config({
        ratelimits: [
          { name: "A", namespace_id: "1001", simple: { limit: 10, period: 10 } },
        ],
      }),
    );
    expect(accepted.ok).toBe(true);
  });

  it("classifies preserved counters by live settings readback and keeps declaration order", () => {
    const plan = planRateLimitBindings(
      [
        { name: "UPLOAD_LIMITER", namespace_id: "1001", limit: 100, period: 60 },
        { name: "API_LIMITER", namespace_id: "1002", limit: 10, period: 10 },
      ],
      [{ name: "API_LIMITER" }, { name: "RETIRED_LIMITER" }],
    );
    expect(plan.preserved).toEqual(["API_LIMITER"]);
    expect(plan.added).toEqual(["UPLOAD_LIMITER"]);
    // The preserved binding keeps its declared namespace identity.
    expect(plan.bindings[1]!.namespace_id).toBe("1002");
  });

  it("refuses shared namespace_id and duplicate names (counters ownership)", () => {
    const parser = normalizeWranglerV3(
      config({
        ratelimits: [
          { name: "A", namespace_id: "1001", simple: { limit: 10, period: 60 } },
          { name: "B", namespace_id: "1001", simple: { limit: 20, period: 60 } },
        ],
      }),
    );
    expect(parser.ok).toBe(false);
    expect(fieldIssues(parser, "ratelimits")[0]?.detail).toContain(
      "counters ownership",
    );

    expect(() =>
      planRateLimitBindings(
        [
          { name: "A", namespace_id: "1001", limit: 10, period: 60 },
          { name: "B", namespace_id: "1001", limit: 20, period: 60 },
        ],
        [],
      ),
    ).toThrow(ResourceConflictError);

    expect(() =>
      planRateLimitBindings(
        [
          { name: "A", namespace_id: "1001", limit: 10, period: 60 },
          { name: "A", namespace_id: "1002", limit: 20, period: 60 },
        ],
        [],
      ),
    ).toThrow(ResourceConflictError);
  });

  it("refuses non-positive limits/periods at the projection boundary", () => {
    expect(() =>
      planRateLimitBindings(
        [{ name: "A", namespace_id: "1001", limit: 0, period: 60 }],
        [],
      ),
    ).toThrow(ResourceConflictError);
    expect(() =>
      planRateLimitBindings(
        [{ name: "A", namespace_id: "1001", limit: 10, period: 1.5 }],
        [],
      ),
    ).toThrow(ResourceConflictError);
  });
});

describe("provider projections for queues", () => {
  it("maps a declared consumer to the official provider request (seconds -> ms)", () => {
    const request = consumerRequestFor(
      {
        queue: "jobs",
        type: "worker",
        max_batch_size: 5,
        max_batch_timeout: 30,
        max_retries: 2,
        max_concurrency: 4,
        retry_delay: 10,
        dead_letter_queue: "jobs-dlq",
      },
      "app",
    );
    expect(request).toEqual({
      script_name: "app",
      dead_letter_queue: "jobs-dlq",
      settings: {
        batch_size: 5,
        max_wait_time_ms: 30000,
        max_retries: 2,
        max_concurrency: 4,
        retry_delay: 10,
      },
    });
  });

  it("sends nothing the release did not declare (bare consumer; null concurrency)", () => {
    expect(consumerRequestFor({ queue: "jobs", type: "worker" }, "app")).toEqual({
      script_name: "app",
    });
    expect(
      consumerRequestFor({ queue: "jobs", type: "worker", max_concurrency: null }, "app"),
    ).toEqual({ script_name: "app" });
  });
});
