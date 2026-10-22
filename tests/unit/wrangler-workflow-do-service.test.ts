// Oracle: Workflow / durable-object /
// service carrier projection.
//
// Spec coverage:
//  - declared workflows[] project to the official provider version-metadata
//    binding {name, type:"workflow", workflow_name, class_name, script_name?};
//    a prebuilt Worker class export needs no HTTP fetch root and is never
//    rejected for lacking one (the resolver claims no fetch requirement and the
//    upload path never inspects module exports);
//  - direct schedules (official string | string[]) are normalized with the
//    official semantics and carried as explicit deployment intent — they never
//    ride the version metadata; implements applying them (apply-workflows)
//    through the Workflows API after the carrier version is active;
//  - official but unimplemented workflow fields (limits / concurrency /
//    default_retention) are refused instead of silently dropped; unknown keys
//    stay hard errors;
//  - external workflow definitions (script_name of another Worker) are refused
//    until ownership can be verified;
//  - service bindings may only target units with a verified identity in this
//    release; every other target fails closed (no partial plan, no dropped
//    binding);
//  - durable_objects / migrations plan only the strictly-bound subset
//    (own script, exported class, pure new-class migrations with exact binding
//    cover, unique tags); renames/deletes, foreign scripts, environments,
//    empty entries, duplicate tags and uncovered classes fail the whole plan
//    before any provider write with exact codes — nothing is modeled
//    partially and destructive history never auto-executes.
//
// Provider mocks: the workflow upload case exercises the real client multipart
// encoder with a captured fetcher (metadata + module parts) — "metadata is
// actually uploaded", not merely typed. Live readback (Workflows API schedules,
// DO lifecycle) stays UNVERIFIED.

import { describe, expect, it } from "vitest";

import {
  createCloudflareClient,
  type Fetcher,
} from "../../src/cloudflare/client/index.js";
import type { VersionMetadata } from "../../src/cloudflare/models/workers.js";
import {
  planWranglerCarrierActions,
  type WranglerCarrierPlanResult,
  type WranglerCarrierProjection,
} from "../../src/core/deploy/wrangler-binding-plan.js";
import { resolveDeploymentUnits } from "../../src/core/planning/deployment-units.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import {
  normalizeWranglerV3,
  type WranglerV3Config,
} from "../../src/manifest/wrangler-v3.js";
import { JS_MODULE_MIME } from "../../src/release/deploy-bundle.js";

const ACCOUNT_ID = "a".repeat(32);
const MAIN_NAME = "worker/main.mjs";
const SCRIPT_NAME = "sync-carrier";
const SCHEDULE_NOTE =
  "workflow schedules are applied through the Workflows API (apply-workflows) after the carrier version is active; they never ride the version metadata";

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: SCRIPT_NAME,
    main: MAIN_NAME,
    compatibility_date: "2026-10-10",
    ...overrides,
  });
}

function parseConfig(overrides: Record<string, unknown> = {}): WranglerV3Config {
  const result = normalizeWranglerV3(config(overrides));
  if (!result.ok || !result.config) {
    throw new Error(`config should normalize: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

function carrierProjection(cfg: WranglerV3Config): WranglerCarrierProjection {
  return {
    workflows: cfg.workflows,
    durableObjects: cfg.durableObjects,
    migrations: cfg.migrations,
    services: cfg.services,
  };
}

function planCarrier(cfg: WranglerV3Config): WranglerCarrierPlanResult {
  return planWranglerCarrierActions(carrierProjection(cfg), {
    scriptName: SCRIPT_NAME,
    verifiedServiceTargets: [SCRIPT_NAME],
  });
}

interface CapturedCall {
  url: string;
  method: string;
  body: unknown;
}

function captureClient(): { log: CapturedCall[]; client: ReturnType<typeof createCloudflareClient> } {
  const log: CapturedCall[] = [];
  const fetcher: Fetcher = async (input, init) => {
    log.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
    return Response.json({ success: true, result: { id: "version-1", number: 1, resources: {} } });
  };
  return {
    log,
    client: createCloudflareClient({ accessToken: "fake-token", accountId: ACCOUNT_ID, fetcher }),
  };
}

async function partText(form: FormData, name: string): Promise<string> {
  const part = form.get(name);
  if (!(part instanceof Blob)) throw new Error(`multipart part "${name}" is missing`);
  return part.text();
}

describe("workflow carrier projection", () => {
  it("projects workflows to the exact provider metadata binding, R2 alongside", () => {
    const cfg = parseConfig({
      workflows: [{ name: "sync-workflow", binding: "SYNC_WORKFLOW", class_name: "SyncWorkflow" }],
      r2_buckets: [{ binding: "FILES", bucket_name: "sync-files" }],
    });
    // The R2 declaration is untouched by the workflow projection.
    expect(cfg.r2Buckets.map((bucket) => [bucket.binding, bucket.bucketName])).toEqual([
      ["FILES", "sync-files"],
    ]);
    const planned = planCarrier(cfg);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.metadata).toEqual([
      {
        name: "SYNC_WORKFLOW",
        type: "workflow",
        workflow_name: "sync-workflow",
        class_name: "SyncWorkflow",
      },
    ]);
    expect(planned.plan.workflows).toEqual([
      {
        binding: "SYNC_WORKFLOW",
        workflowName: "sync-workflow",
        className: "SyncWorkflow",
        schedules: [],
        metadata: {
          name: "SYNC_WORKFLOW",
          type: "workflow",
          workflow_name: "sync-workflow",
          class_name: "SyncWorkflow",
        },
      },
    ]);
    expect(planned.plan.notes).toEqual([]);
  });

  it("resolves a workflow + R2 carrier with no HTTP root and no exposure edges", () => {
    const spec: DeploySpec = {
      schemaVersion: 1,
      project: { id: "fixture/t09", version: "0.1.0" },
      worker: { path: MAIN_NAME, size: 10, sha256: "a".repeat(64) },
      assets: [],
      inputs: {},
      cloudflare: {
        workerName: SCRIPT_NAME,
        r2: [{ binding: "FILES", bucketName: "sync-files", createIfMissing: true }],
        d1: [],
        kv: [],
        queues: [],
        hyperdrive: [],
        vectorize: [],
        secretsStore: [],
        runtimeBindings: [],
        cron: [],
        secrets: {},
      },
      wrangler: {
        name: SCRIPT_NAME,
        main: MAIN_NAME,
        compatibility_date: "2026-10-10",
        r2_buckets: [],
        crons: [],
      },
      targetKind: "workers",
    };
    const plan = resolveDeploymentUnits(spec);
    expect(plan.ok).toBe(true);
    // A prebuilt carrier class is enough: no fetch handler is required, and
    // nothing invents an HTTP exposure for it.
    expect(plan.units[0]!.requiresHttpRoot).toBe(false);
    expect(plan.exposures).toEqual([]);
    expect(plan.resources.map((resource) => [resource.id, resource.disposition])).toEqual([
      ["r2:sync-files", "create-if-missing"],
    ]);
    expect(plan.bindings.map((binding) => [binding.resourceId, binding.binding])).toEqual([
      ["r2:sync-files", "FILES"],
    ]);
  });

  it("uploads the workflow binding through the real multipart encoder (no fetch export)", async () => {
    const cfg = parseConfig({
      workflows: [
        {
          name: "sync-workflow",
          binding: "SYNC_WORKFLOW",
          class_name: "SyncWorkflow",
          schedules: "*/5 * * * *",
        },
      ],
    });
    const planned = planCarrier(cfg);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // The module exports a Workflow class only; there is no fetch handler and
    // the upload path must not care.
    const mainSource = "export class SyncWorkflow { async run() { return 1; } }\n";
    const metadata: VersionMetadata = {
      main_module: MAIN_NAME,
      compatibility_date: "2026-10-10",
      bindings: [
        { type: "r2_bucket", name: "FILES", bucket_name: "sync-files" },
        ...planned.plan.metadata,
      ],
    };
    const { log, client } = captureClient();
    await client.createVersion(SCRIPT_NAME, {
      metadata,
      mainModule: { name: MAIN_NAME, content: mainSource, contentType: JS_MODULE_MIME },
    });
    expect(log).toHaveLength(1);
    expect(log[0]!.method).toBe("POST");
    expect(log[0]!.url).toContain(
      `/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/versions`,
    );
    const form = log[0]!.body;
    expect(form).toBeInstanceOf(FormData);
    expect([...(form as FormData).keys()].sort()).toEqual(["metadata", MAIN_NAME].sort());
    const uploaded = JSON.parse(await partText(form as FormData, "metadata")) as VersionMetadata;
    expect(uploaded).toEqual({
      main_module: MAIN_NAME,
      compatibility_date: "2026-10-10",
      bindings: [
        { type: "r2_bucket", name: "FILES", bucket_name: "sync-files" },
        {
          name: "SYNC_WORKFLOW",
          type: "workflow",
          workflow_name: "sync-workflow",
          class_name: "SyncWorkflow",
        },
      ],
    });
    expect(await partText(form as FormData, MAIN_NAME)).toBe(mainSource);
  });

  it("normalizes direct schedules and carries them as explicit deployment intent", () => {
    const cfg = parseConfig({
      workflows: [
        { name: "hourly", binding: "HOURLY", class_name: "HourlyWorkflow", schedules: "0 * * * *" },
        {
          name: "daily",
          binding: "DAILY",
          class_name: "DailyWorkflow",
          schedules: ["0 3 * * *", "30 3 * * *"],
        },
      ],
    });
    expect(cfg.workflows.map((workflow) => workflow.schedules)).toEqual([
      ["0 * * * *"],
      ["0 3 * * *", "30 3 * * *"],
    ]);
    const planned = planCarrier(cfg);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.workflows.map((workflow) => workflow.schedules)).toEqual([
      ["0 * * * *"],
      ["0 3 * * *", "30 3 * * *"],
    ]);
    // Schedules never ride the version metadata (official behavior): the plan
    // records them explicitly and names the unimplemented apply step.
    expect(planned.plan.metadata.every((entry) => !("schedules" in entry))).toBe(true);
    expect(planned.plan.notes).toEqual([SCHEDULE_NOTE]);
  });

  it("refuses invalid schedule shapes with the official semantics", () => {
    const cases: Array<[unknown, string]> = [
      ["", "must not be an empty string"],
      [[], "must not be an empty array"],
      [["ok", ""], "must not contain empty strings"],
      [[1], "non-empty array of strings"],
      [42, "non-empty string"],
    ];
    for (const [schedules, detail] of cases) {
      const result = normalizeWranglerV3(
        config({ workflows: [{ name: "w", binding: "W", class_name: "W", schedules }] }),
      );
      expect(result.ok).toBe(false);
      const issue = result.issues.find((entry) => entry.field === "workflows[0].schedules");
      expect(issue?.code).toBe("INVALID_SHAPE");
      expect(issue?.detail).toContain(detail);
    }
  });

  it("refuses unimplemented official workflow fields and unknown keys", () => {
    for (const key of ["limits", "concurrency", "default_retention"]) {
      const result = normalizeWranglerV3(
        config({ workflows: [{ name: "w", binding: "W", class_name: "W", [key]: {} }] }),
      );
      expect(result.ok).toBe(false);
      const issue = result.issues.find((entry) => entry.field === `workflows[0].${key}`);
      expect(issue?.code).toBe("UNSUPPORTED_WRANGLER_FEATURE");
      expect(issue?.detail).toContain("refusing to ignore");
    }
    const unknown = normalizeWranglerV3(
      config({ workflows: [{ name: "w", binding: "W", class_name: "W", mystery: true }] }),
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.issues.find((entry) => entry.field === "workflows[0].mystery")?.code).toBe(
      "UNKNOWN_WRANGLER_FIELD",
    );
  });

  it("refuses workflows defined by another Worker, keeps this script's own", () => {
    const external = parseConfig({
      workflows: [
        { name: "shared", binding: "SHARED", class_name: "Shared", script_name: "other-worker" },
      ],
    });
    expect(external.workflows[0]!.script_name).toBe("other-worker");
    const refused = planCarrier(external);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.issues.map((issue) => issue.code)).toEqual(["UNSUPPORTED_EXTERNAL_WORKFLOW"]);
    expect("plan" in refused).toBe(false);

    const own = parseConfig({
      workflows: [
        { name: "own", binding: "OWN", class_name: "Own", script_name: SCRIPT_NAME },
      ],
    });
    const allowed = planCarrier(own);
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.plan.metadata).toEqual([
      {
        name: "OWN",
        type: "workflow",
        workflow_name: "own",
        class_name: "Own",
        script_name: SCRIPT_NAME,
      },
    ]);
  });
});

describe("service binding identity", () => {
  it("projects service bindings to verified targets, forwarded verbatim", () => {
    const cfg = parseConfig({
      workflows: [{ name: "sync-workflow", binding: "SYNC_WORKFLOW", class_name: "SyncWorkflow" }],
      services: [
        { binding: "SELF_RPC", service: SCRIPT_NAME, entrypoint: "SyncEntrypoint" },
        {
          binding: "AUTH",
          service: SCRIPT_NAME,
          environment: "production",
          props: { role: "auth" },
        },
      ],
    });
    const planned = planCarrier(cfg);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // Workflow bindings first, then service bindings, in declaration order.
    expect(planned.plan.metadata).toEqual([
      {
        name: "SYNC_WORKFLOW",
        type: "workflow",
        workflow_name: "sync-workflow",
        class_name: "SyncWorkflow",
      },
      { name: "SELF_RPC", type: "service", service: SCRIPT_NAME, entrypoint: "SyncEntrypoint" },
      {
        name: "AUTH",
        type: "service",
        service: SCRIPT_NAME,
        environment: "production",
        props: { role: "auth" },
      },
    ]);
  });

  it("fails closed on service targets without a verified identity in this release", () => {
    const cfg = parseConfig({ services: [{ binding: "AUTH", service: "auth-worker" }] });
    const planned = planCarrier(cfg);
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.issues.map((issue) => issue.code)).toEqual([
      "UNSUPPORTED_SERVICE_BINDING_TARGET",
    ]);
    expect(planned.issues[0]!.detail).toContain("auth-worker");
    expect("plan" in planned).toBe(false);
  });

  it("refuses the dev-only remote switch and malformed props on services", () => {
    const remote = normalizeWranglerV3(
      config({ services: [{ binding: "A", service: "x", remote: true }] }),
    );
    expect(remote.ok).toBe(false);
    expect(remote.issues.find((issue) => issue.field === "services[0].remote")?.code).toBe(
      "UNSUPPORTED_WRANGLER_FEATURE",
    );
    const props = normalizeWranglerV3(
      config({ services: [{ binding: "A", service: "x", props: ["nope"] }] }),
    );
    expect(props.ok).toBe(false);
    expect(props.issues.find((issue) => issue.field === "services[0].props")?.code).toBe(
      "INVALID_SHAPE",
    );
  });
});

describe("durable objects plan only the strictly-bound subset, veto the rest before any write", () => {
  it("plans a new class with exact binding cover and forwards the migration verbatim", () => {
    const cfg = parseConfig({
      durable_objects: { bindings: [{ name: "SYNC_STATE", class_name: "SyncState" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["SyncState"] }],
    });
    const planned = planCarrier(cfg);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.durableObjects).toEqual([{
      binding: "SYNC_STATE",
      className: "SyncState",
      metadata: { name: "SYNC_STATE", type: "durable_object_namespace", class_name: "SyncState" },
    }]);
    expect(planned.plan.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["SyncState"] }]);
    expect(planned.plan.notes.join(" ")).toContain("no migration interpreter");
  });

  it.each([
    ["renamed class", { durable_objects: { bindings: [{ name: "S", class_name: "B" }] }, migrations: [{ tag: "v1", new_classes: ["A"], renamed_classes: [{ from: "A", to: "B" }] }] }, "DO_MIGRATION_DESTRUCTIVE"],
    ["deleted class", { durable_objects: { bindings: [{ name: "S", class_name: "A" }] }, migrations: [{ tag: "v1", new_classes: ["A"], deleted_classes: ["Old"] }] }, "DO_MIGRATION_DESTRUCTIVE"],
    ["tag-only entry", { durable_objects: { bindings: [{ name: "S", class_name: "A" }] }, migrations: [{ tag: "v1" }] }, "DO_MIGRATION_EMPTY"],
    ["duplicate tag", { durable_objects: { bindings: [{ name: "S", class_name: "A" }] }, migrations: [{ tag: "v1", new_classes: ["A"] }, { tag: "v1", new_classes: ["A"] }] }, "DO_MIGRATION_TAG_CONFLICT"],
    ["foreign script", { durable_objects: { bindings: [{ name: "S", class_name: "A", script_name: "someone-else" }] }, migrations: [{ tag: "v1", new_classes: ["A"] }] }, "UNSUPPORTED_EXTERNAL_DO"],
    ["environment", { durable_objects: { bindings: [{ name: "S", class_name: "A", environment: "preview" }] }, migrations: [{ tag: "v1", new_classes: ["A"] }] }, "UNSUPPORTED_DO_ENVIRONMENT"],
    ["bound class without migration", { durable_objects: { bindings: [{ name: "S", class_name: "A" }] }, migrations: [{ tag: "v1", new_classes: ["B"] }] }, "DO_CLASS_UNMIGRATED"],
    ["migrated class without binding", { durable_objects: { bindings: [{ name: "S", class_name: "A" }] }, migrations: [{ tag: "v1", new_classes: ["A", "Orphan"] }] }, "DO_CLASS_UNBOUND"],
    ["migration without binding", { migrations: [{ tag: "v1", new_classes: ["Ghost"] }] }, "DO_CLASS_UNBOUND"],
    ["binding without migration", { durable_objects: { bindings: [{ name: "S", class_name: "Ghost" }] } }, "DO_CLASS_UNMIGRATED"],
  ])("vetoes %s with an exact code and no partial plan", (_label, overrides, code) => {
    const cfg = parseConfig(overrides as Record<string, unknown>);
    const planned = planCarrier(cfg);
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.issues.map((issue) => issue.code)).toContain(code);
    // No plan exists to partially apply: the whole release fails closed.
    expect("plan" in planned).toBe(false);
  });
});
