import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  uploadAssetBucket,
  planUploadBatches,
  splitBucketsForUpload,
  DEFAULT_MAX_PARTS_PER_BATCH,
  assetUploadHash,
  buildAssetUploadManifest,
  toRootedAssetPath,
} from "../../src/cloudflare/assets/index.js";
import {
  executeDeployStep,
  versionMessage,
  assetUploadManifest,
  type DeployStepContext,
} from "../../src/core/deploy/steps.js";
import { TAPDEPLOY_MANAGED_MARKER } from "../../src/core/planning/digest.js";
import { makeCloudflareError } from "../../src/cloudflare/client/errors.js";
import type { CloudflareApiClient } from "../../src/cloudflare/client/index.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";

const WORKER_CONTENT = 'export default { async fetch() { return new Response("ok"); } }';
const ACCOUNT = "a".repeat(32);

function specWithAsset(): DeploySpec {
  return {
    schemaVersion: 1,
    project: { id: "fixture/t", version: "1.0.0" },
    worker: {
      path: "worker/main.mjs",
      size: 63,
      sha256: "af82af348889623e28f49bef23efa24e5944760a66cabffe603c786e5ac0a2e2",
    },
    assets: [
      { path: "assets/index.html", size: 29, sha256: "bc8d1e8b17cf75c1d88bf37a8fafa9d0ad3aa45f687f583e93816f833f4c5c41", workersHash: "b".repeat(32) },
    ],
    inputs: {},
    cloudflare: { workerName: "tapdeploy-t", r2: [], d1: [], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {} },
    wrangler: {
      name: "tapdeploy-t",
      main: "./worker/main.mjs",
      compatibility_date: "2026-10-10",
      r2_buckets: [],
      crons: [],
    },
    targetKind: "workers",
  };
}

function specWithoutAsset(): DeploySpec {
  return { ...specWithAsset(), assets: [] };
}

function context(overrides: Partial<DeployStepContext> = {}): DeployStepContext {
  const client = {
    listVersions: vi.fn(),
    listDeployments: vi.fn(),
    getSchedules: vi.fn(),
    createVersion: vi.fn(),
    createWorker: vi.fn(),
    createDeployment: vi.fn(),
    updateSchedules: vi.fn(),
    updateSecret: vi.fn(),
  } as unknown as CloudflareApiClient;
  return {
    client,
    accountId: ACCOUNT,
    workerName: "tapdeploy-t",
    spec: specWithoutAsset(),
    snapshot: {
      accountId: ACCOUNT,
      workerName: "tapdeploy-t",
      workerExists: false,
      versions: [],
      activeDeploymentId: undefined,
    } as unknown as DeployStepContext["snapshot"],
    accessToken: "tok-1",
    ...overrides,
  };
}

function sha(content: string): { hex: string; size: number } {
  return {
    hex: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
  };
}

describe("versionMessage / assetUploadManifest (official)", () => {
  it("serializes approved boolean run_worker_first instead of silently discarding it", async () => {
    const ctx = context({ spec: specWithAsset() });
    ctx.spec.wrangler.assets = { directory: "./assets", binding: "ASSETS", run_worker_first: true };
    ctx.spec.worker!.sha256 = sha(WORKER_CONTENT).hex;
    ctx.spec.worker!.size = sha(WORKER_CONTENT).size;
    vi.mocked(ctx.client.createVersion).mockResolvedValue({ id: "prepared" });
    const result = await executeDeployStep("create-version", ctx, { scriptB64: btoa(WORKER_CONTENT), assetJwt: "trusted-core-token" });
    expect(result.ok).toBe(true);
    expect(vi.mocked(ctx.client.createVersion).mock.calls[0]![1].metadata.assets?.config?.run_worker_first).toBe(true);
  });
  it("embeds the installer marker in the version message", () => {
    expect(versionMessage(specWithAsset())).toContain(TAPDEPLOY_MANAGED_MARKER);
    expect(versionMessage(specWithAsset())).toContain("fixture/t");
    expect(versionMessage(specWithAsset())).toContain("1.0.0");
  });

  it("builds a rooted manifest with 32-hex hashes distinct from integrity SHA", async () => {
    const manifest = await assetUploadManifest(specWithAsset());
    const keys = Object.keys(manifest);
    expect(keys).toEqual(["/assets/index.html"]);
    const entry = manifest["/assets/index.html"]!;
    expect(entry.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.hash).not.toBe("bc8d1e8b17cf75c1d88bf37a8fafa9d0ad3aa45f687f583e93816f833f4c5c41");
    expect(entry.size).toBe(29);
  });

  it("roots paths and derives stable 32-hex identifiers", async () => {
    expect(toRootedAssetPath("assets/a.html")).toBe("/assets/a.html");
    expect(toRootedAssetPath("/assets/a.html")).toBe("/assets/a.html");
    const h1 = await assetUploadHash("/assets/a.html", new TextEncoder().encode("abc"));
    const h2 = await assetUploadHash("/assets/a.html", new TextEncoder().encode("abc"));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{32}$/);
    const built = await buildAssetUploadManifest([
      { path: "assets/a.html", size: 3, sha256: "b".repeat(64), workersHash: h1 },
    ]);
    expect(Object.keys(built)).toEqual(["/assets/a.html"]);
  });
});

describe("planUploadBatches / splitBucketsForUpload", () => {
  it("chunks missing hashes into capped batches", () => {
    const hashes = Array.from({ length: 130 }, (_, i) => `h-${i}`);
    const batches = planUploadBatches(hashes, 64);
    expect(batches.length).toBe(3);
    expect(batches[0]!.length).toBe(64);
    expect(batches[1]!.length).toBe(64);
    expect(batches[2]!.length).toBe(2);
  });

  it("uses the documented default cap", () => {
    expect(DEFAULT_MAX_PARTS_PER_BATCH).toBe(64);
  });

  it("deduplicates hashes", () => {
    expect(planUploadBatches(["a", "a", "b", "b"], 2)).toEqual([["a", "b"]]);
  });

  it("rejects an invalid batch cap", () => {
    expect(() => planUploadBatches(["a"], 0)).toThrow(/positive integer/);
    expect(() => planUploadBatches(["a"], -1)).toThrow(/positive integer/);
  });

  it("preserves official buckets grouping while deduping", () => {
    const h1 = "a".repeat(32);
    const h2 = "b".repeat(32);
    expect(splitBucketsForUpload([[h1, h2], [h2]], 64)).toEqual([[h1, h2]]);
  });
});

describe("uploadAssetBucket (official account endpoint)", () => {
  const H1 = "a".repeat(32);
  const H2 = "b".repeat(32);

  function files() {
    return new Map([
      [H1, { hash: H1, bytes: new Uint8Array([1, 2, 3]), contentType: "text/html" }],
      [H2, { hash: H2, bytes: new Uint8Array([4]), contentType: "text/css" }],
    ]);
  }

  it("POSTs multipart/base64 to the account upload URL with the JWT", async () => {
    const fetched = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, result: { jwt: "complete-1" } }), { status: 200 }),
    );
    const res = await uploadAssetBucket(ACCOUNT, [H1], files(), {
      jwt: "upload-jwt-1",
      fetcher: fetched as typeof fetch,
    });
    expect(res.completionJwt).toBe("complete-1");
    expect(fetched).toHaveBeenCalledTimes(1);
    const call = fetched.mock.calls[0] as unknown as [string | URL, RequestInit | undefined];
    const [input, init] = call;
    expect(String(input)).toContain(`/accounts/${ACCOUNT}/workers/assets/upload?base64=true`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer upload-jwt-1");
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it("maps a 401 to token-expired and does not retry", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 401 }));
    const err = await uploadAssetBucket(ACCOUNT, [H1], files(), {
      jwt: "jwt-expired",
      fetcher: fetched as typeof fetch,
    }).then(
      () => null,
      (e: unknown) => e as { kind?: string },
    );
    expect(err?.kind).toBe("token-expired");
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("maps a 403 to forbidden", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 403 }));
    const err = await uploadAssetBucket(ACCOUNT, [H1], files(), {
      jwt: "jwt-forbidden",
      fetcher: fetched as typeof fetch,
    }).then(
      () => null,
      (e: unknown) => e as { kind?: string },
    );
    expect(err?.kind).toBe("forbidden");
  });

  it("retries a rate-limit then succeeds, honoring retry-after", async () => {
    let calls = 0;
    const fetched = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 429, headers: { "retry-after": "3" } });
      }
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    });
    await uploadAssetBucket(ACCOUNT, [H1], files(), {
      jwt: "jwt-rl",
      maxAttempts: 3,
      fetcher: fetched as typeof fetch,
    });
    expect(calls).toBe(2);
  });

  it("fails after exhausting attempts with the last error", async () => {
    const fetched = vi.fn(
      async () => new Response(null, { status: 429, headers: { "retry-after": "2" } }),
    );
    const err = await uploadAssetBucket(ACCOUNT, [H1], files(), {
      jwt: "jwt-rl2",
      maxAttempts: 2,
      fetcher: fetched as typeof fetch,
    }).then(
      () => null,
      (e: unknown) => e as { kind?: string; retryAfterSeconds?: number },
    );
    expect(err?.kind).toBe("rate-limited");
    expect(err?.retryAfterSeconds).toBe(2);
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-32-hex hash before any fetch", async () => {
    const fetched = vi.fn(async () => new Response(null, { status: 200 }));
    const err = await uploadAssetBucket(ACCOUNT, ["not-hex"], files(), {
      jwt: "x",
      fetcher: fetched as typeof fetch,
    }).then(
      () => null,
      (e: unknown) => e as { kind?: string },
    );
    expect(err?.kind).toBe("invalid-response");
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe("executeDeployStep: create-version (multipart)", () => {
  it("rejects bytes that do not match the confirmed artifact", async () => {
    const { hex } = sha(WORKER_CONTENT);
    const ctx = context({
      spec: {
        ...specWithoutAsset(),
        worker: { path: "worker/main.mjs", size: 999, sha256: hex },
      },
    });
    const outcome = await executeDeployStep(
      "create-version",
      ctx,
      { scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"), assetJwt: "jwt" },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("artifact-mismatch");
    }
    expect(ctx.client.createVersion).not.toHaveBeenCalled();
  });

  it("rejects a tampered base64 payload before any partial match", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const ctx = context({
      spec: { ...specWithoutAsset(), worker: { path: "w", size, sha256: hex } },
    });
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: "aGVsbG8=",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("artifact-mismatch");
    }
    expect(ctx.client.createVersion).not.toHaveBeenCalled();
  });

  it("creates the version with multipart metadata including main_module", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const ctx = context({
      spec: { ...specWithoutAsset(), worker: { path: "worker/main.mjs", size, sha256: hex } },
    });
    (ctx.client.createVersion as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "version-9",
      number: 1,
    });
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome).toEqual({ ok: true, result: { versionId: "version-9", number: 1 } });
    expect(ctx.client.createVersion).toHaveBeenCalledWith(
      "tapdeploy-t",
      expect.objectContaining({
        metadata: expect.objectContaining({
          main_module: "worker.mjs",
          compatibility_date: "2026-10-10",
          annotations: expect.objectContaining({
            "workers/message": expect.stringContaining(TAPDEPLOY_MANAGED_MARKER) as string,
          }),
        }),
        mainModule: expect.objectContaining({ name: "worker.mjs" }),
      }),
    );
    // No assets in the spec -> no assets JWT in metadata.
    const req = (ctx.client.createVersion as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      metadata: { assets?: unknown };
    };
    expect(req.metadata).not.toHaveProperty("assets");
  });

  it("attaches the completion jwt when the release has assets", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const ctx = context({
      spec: {
        ...specWithAsset(),
        worker: { path: "worker/main.mjs", size, sha256: hex },
      },
    });
    (ctx.client.createVersion as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "version-10",
      number: 2,
    });
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
      assetJwt: "complete-jwt",
    });
    expect(outcome.ok).toBe(true);
    expect(ctx.client.createVersion).toHaveBeenCalledWith(
      "tapdeploy-t",
      expect.objectContaining({
        metadata: expect.objectContaining({
          main_module: "worker.mjs",
          assets: expect.objectContaining({ jwt: "complete-jwt" }),
        }),
      }),
    );
  });

  it("requires assetJwt for an assets release", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const ctx = context({
      spec: {
        ...specWithAsset(),
        worker: { path: "worker/main.mjs", size, sha256: hex },
      },
    });
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("invalid-args");
    }
    expect(ctx.client.createVersion).not.toHaveBeenCalled();
  });

  it("carries R2, plain-text vars, compat date/flags into version metadata", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const base = specWithoutAsset();
    const ctx = context({
      spec: {
        ...base,
        worker: { path: "worker/main.mjs", size, sha256: hex },
        wrangler: {
          name: "tapdeploy-t",
          main: "./worker/main.mjs",
          compatibility_date: "2026-10-10",
          compatibility_flags: ["nodejs_compat"],
          r2_buckets: [{ binding: "FILES", bucket_name: "my-bucket" }],
          crons: [],
          vars: { API_URL: "https://example.invalid", RETRIES: 3 },
        },
      },
    });
    (ctx.client.createVersion as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "version-11",
      number: 3,
    });
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome.ok).toBe(true);
    const req = (ctx.client.createVersion as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      metadata: {
        compatibility_date?: string;
        compatibility_flags?: string[];
        bindings?: Array<Record<string, unknown>>;
      };
    };
    expect(req.metadata.compatibility_date).toBe("2026-10-10");
    expect(req.metadata.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(req.metadata.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "r2_bucket", name: "FILES", bucket_name: "my-bucket" }),
        expect.objectContaining({ type: "plain_text", name: "API_URL", text: "https://example.invalid" }),
        expect.objectContaining({ type: "plain_text", name: "RETRIES", text: "3" }),
      ]),
    );
  });

  it("carries D1 + KV binding ids into version metadata, resolved from live snapshot", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const base = specWithoutAsset();
    const ctx = context({
      spec: {
        ...base,
        worker: { path: "worker/main.mjs", size, sha256: hex },
        cloudflare: {
          workerName: "tapdeploy-t",
          r2: [],
          d1: [{ binding: "DB", databaseName: "my-db", createIfMissing: true }],
          kv: [{ binding: "KV", namespaceName: "my-ns", createIfMissing: true }],
          queues: [],
          hyperdrive: [],
          vectorize: [],
          secretsStore: [],
          runtimeBindings: [],
          cron: [],
          secrets: {},
        },
        wrangler: {
          name: "tapdeploy-t",
          main: "./worker/main.mjs",
          compatibility_date: "2026-10-10",
          r2_buckets: [],
          d1_databases: [{ binding: "DB", database_name: "my-db" }],
          kv_namespaces: [{ binding: "KV", id: "" }],
          crons: [],
        },
      },
      snapshot: {
        accountId: ACCOUNT,
        workerName: "tapdeploy-t",
        workerExists: false,
        versions: [],
        activeDeploymentVersionIds: [],
        d1Databases: [{ name: "my-db", id: "db-id-1" }],
        kvNamespaces: [{ name: "my-ns", id: "ns-id-1" }],
      } as unknown as DeployStepContext["snapshot"],
    });
    (ctx.client.createVersion as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "version-12",
      number: 4,
    });
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome.ok).toBe(true);
    const req = (ctx.client.createVersion as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      metadata: { bindings?: Array<Record<string, unknown>> };
    };
    expect(req.metadata.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "d1", name: "DB", id: "db-id-1" }),
        expect.objectContaining({ type: "kv_namespace", name: "KV", namespace_id: "ns-id-1" }),
      ]),
    );
  });

  it("carries Queue producer + Hyperdrive binding ids into version metadata, resolved from live snapshot", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const base = specWithoutAsset();
    const ctx = context({
      spec: {
        ...base,
        worker: { path: "worker/main.mjs", size, sha256: hex },
        cloudflare: {
          workerName: "tapdeploy-t",
          r2: [],
          d1: [],
          kv: [],
          queues: [{ binding: "Q", queueName: "my-queue", createIfMissing: true, role: "producer" }],
          hyperdrive: [{ binding: "HD", configName: "my-hd", createIfMissing: true }],
          vectorize: [],
          secretsStore: [],
          runtimeBindings: [],
          cron: [],
          secrets: {},
        },
        wrangler: {
          ...base.wrangler,
          queues: [{ binding: "Q", queue_name: "my-queue", role: "producer" }],
          hyperdrive: [{ binding: "HD", id: "" }],
        },
      },
      snapshot: {
        accountId: ACCOUNT,
        workerName: "tapdeploy-t",
        workerExists: false,
        versions: [],
        activeDeploymentId: undefined,
        r2Buckets: [],
        d1Databases: [],
        kvNamespaces: [],
        queues: [{ name: "my-queue", id: "queue-id-1" }],
        hyperdriveConfigs: [{ name: "my-hd", id: "hd-id-1" }],
        secretNames: [],
        scheduleCrons: [],
        rateLimitCount: 0,
      } as unknown as DeployStepContext["snapshot"],
    });
    (ctx.client.createVersion as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "version-13",
      number: 5,
    });
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome.ok).toBe(true);
    const req = (ctx.client.createVersion as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      metadata: { bindings?: Array<Record<string, unknown>> };
    };
    expect(req.metadata.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "queue", name: "Q", queue_name: "my-queue" }),
        expect.objectContaining({ type: "hyperdrive", name: "HD", id: "hd-id-1" }),
      ]),
    );
  });

  it("carries Vectorize + Secrets Store binding ids into version metadata, resolved from live snapshot", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const base = specWithoutAsset();
    const ctx = context({
      spec: {
        ...base,
        worker: { path: "worker/main.mjs", size, sha256: hex },
        cloudflare: {
          workerName: "tapdeploy-t",
          r2: [],
          d1: [],
          kv: [],
          queues: [],
          hyperdrive: [],
          vectorize: [{ binding: "VZ", indexName: "my-index", createIfMissing: true }],
          secretsStore: [
            {
              binding: "SECRETS",
              storeName: "my-store",
              createIfMissing: true,
              secretName: "api-token",
              secretCreateIfMissing: true,
            },
          ],
          runtimeBindings: [],
          cron: [],
          secrets: {},
        },
        wrangler: {
          ...base.wrangler,
          vectorize: [{ binding: "VZ", index_name: "my-index" }],
          secrets_store_secrets: [
            { binding: "SECRETS", store_id: "", secret_name: "api-token" },
          ],
        },
      },
      snapshot: {
        accountId: ACCOUNT,
        workerName: "tapdeploy-t",
        workerExists: false,
        versions: [],
        activeDeploymentId: undefined,
        r2Buckets: [],
        d1Databases: [],
        kvNamespaces: [],
        queues: [],
        hyperdriveConfigs: [],
        vectorizeIndexes: [{ name: "my-index", id: "vz-id-1" }],
        secretsStores: [{ name: "my-store", id: "store-id-1" }],
        secretsStoreSecrets: [
          { secretName: "api-token", id: "secret-id-1", store_id: "store-id-1" },
        ],
        secretNames: [],
        scheduleCrons: [],
        rateLimitCount: 0,
      } as unknown as DeployStepContext["snapshot"],
    });
    (ctx.client.createVersion as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "version-15",
      number: 7,
    });
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome.ok).toBe(true);
    const req = (ctx.client.createVersion as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      metadata: { bindings?: Array<Record<string, unknown>> };
    };
    expect(req.metadata.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "vectorize", name: "VZ", index_name: "my-index" }),
        expect.objectContaining({
          type: "secrets_store_secret",
          name: "SECRETS",
          store_id: "store-id-1",
          secret_name: "api-token",
        }),
      ]),
    );
  });

  it("carries AI + Browser Rendering runtime bindings into version metadata, with no resource identity", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const base = specWithoutAsset();
    const ctx = context({
      spec: {
        ...base,
        worker: { path: "worker/main.mjs", size, sha256: hex },
        cloudflare: {
          workerName: "tapdeploy-t",
          r2: [],
          d1: [],
          kv: [],
          queues: [],
          hyperdrive: [],
          vectorize: [],
          secretsStore: [],
          runtimeBindings: [
            { binding: "AI", type: "ai" },
            { binding: "BROWSER", type: "browser-rendering" },
          ],
          cron: [],
          secrets: {},
        },
        wrangler: {
          ...base.wrangler,
          ai: [{ binding: "AI" }],
          browser: [{ binding: "BROWSER" }],
        },
      },
      snapshot: {
        accountId: ACCOUNT,
        workerName: "tapdeploy-t",
        workerExists: false,
        versions: [],
        activeDeploymentId: undefined,
      } as unknown as DeployStepContext["snapshot"],
    });
    (ctx.client.createVersion as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "version-16",
      number: 8,
    });
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome.ok).toBe(true);
    const req = (ctx.client.createVersion as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      metadata: { bindings?: Array<Record<string, unknown>> };
    };
    // Runtime bindings emit the official binding shapes and carry NO account
    // resource identity (no bucket_name/index_name/store_id/secret_name/etc).
    expect(req.metadata.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ai", name: "AI" }),
        expect.objectContaining({ type: "browser", name: "BROWSER" }),
      ]),
    );
    const ai = req.metadata.bindings!.find((b) => b.type === "ai")!;
    expect(Object.keys(ai).sort()).toEqual(["name", "type"]);
    const br = req.metadata.bindings!.find((b) => b.type === "browser")!;
    expect(Object.keys(br).sort()).toEqual(["name", "type"]);
  });

  it("a consumer-role queue binding does NOT emit a Worker version binding", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const base = specWithoutAsset();
    const ctx = context({
      spec: {
        ...base,
        worker: { path: "worker/main.mjs", size, sha256: hex },
        cloudflare: {
          workerName: "tapdeploy-t",
          r2: [],
          d1: [],
          kv: [],
          queues: [{ binding: "CQ", queueName: "my-queue", createIfMissing: true, role: "consumer" }],
          hyperdrive: [],
          vectorize: [],
          secretsStore: [],
          runtimeBindings: [],
          cron: [],
          secrets: {},
        },
        wrangler: {
          ...base.wrangler,
          queues: [{ binding: "CQ", queue_name: "my-queue", role: "consumer" }],
        },
      },
      snapshot: {
        accountId: ACCOUNT,
        workerName: "tapdeploy-t",
        workerExists: false,
        versions: [],
        activeDeploymentId: undefined,
        queues: [{ name: "my-queue", id: "queue-id-1" }],
        hyperdriveConfigs: [],
      } as unknown as DeployStepContext["snapshot"],
    });
    (ctx.client.createVersion as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "version-14",
      number: 6,
    });
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome.ok).toBe(true);
    const req = (ctx.client.createVersion as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      metadata: { bindings?: Array<Record<string, unknown>> };
    };
    const queueBindings = (req.metadata.bindings ?? []).filter((b) => b["type"] === "queue");
    expect(queueBindings).toHaveLength(0);
  });
});

describe("executeDeployStep: create-worker (official PUT scripts/{name})", () => {
  it("is a no-op when the worker already exists", async () => {
    const ctx = context({
      snapshot: {
        accountId: ACCOUNT,
        workerName: "tapdeploy-t",
        workerExists: true,
        versions: [],
        activeDeploymentId: undefined,
      } as unknown as DeployStepContext["snapshot"],
    });
    const outcome = await executeDeployStep(
      "create-worker",
      ctx,
      { scriptB64: Buffer.from(WORKER_CONTENT).toString("base64") },
    );
    expect(outcome).toEqual({ ok: true, result: { skipped: true } });
    expect(ctx.client.createWorker).not.toHaveBeenCalled();
  });

  it("rejects bytes that do not match the confirmed artifact", async () => {
    const { hex } = sha(WORKER_CONTENT);
    const ctx = context({
      spec: {
        ...specWithoutAsset(),
        worker: { path: "worker/main.mjs", size: 999, sha256: hex },
      },
    });
    const outcome = await executeDeployStep("create-worker", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("artifact-mismatch");
    }
    expect(ctx.client.createWorker).not.toHaveBeenCalled();
  });

  it("rejects a tampered base64 payload before any partial match", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const ctx = context({
      spec: { ...specWithoutAsset(), worker: { path: "w", size, sha256: hex } },
    });
    const outcome = await executeDeployStep("create-worker", ctx, {
      scriptB64: "aGVsbG8=",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("artifact-mismatch");
    }
    expect(ctx.client.createWorker).not.toHaveBeenCalled();
  });

  it("requires a non-empty scriptB64", async () => {
    const ctx = context();
    const outcome = await executeDeployStep("create-worker", ctx, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("invalid-args");
    }
    expect(ctx.client.createWorker).not.toHaveBeenCalled();
  });

  it("creates the worker with module metadata including main_module", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const ctx = context({
      spec: { ...specWithoutAsset(), worker: { path: "worker/main.mjs", size, sha256: hex } },
    });
    (ctx.client.createWorker as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "tapdeploy-t",
    });
    (ctx.client.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "version-1", number: 1, message: versionMessage(ctx.spec) }]);
    (ctx.client.listDeployments as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "d1", versions: [{ version_id: "version-1", percentage: 100 }] }]);
    const outcome = await executeDeployStep("create-worker", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome).toEqual({ ok: true, result: { versionId: "version-1", number: 1 } });
    expect(ctx.client.createWorker).toHaveBeenCalledWith(
      "tapdeploy-t",
      expect.objectContaining({
        metadata: expect.objectContaining({
          main_module: "worker.mjs",
          compatibility_date: "2026-10-10",
          annotations: expect.objectContaining({
            "workers/message": expect.stringContaining(TAPDEPLOY_MANAGED_MARKER) as string,
          }),
        }),
        mainModule: expect.objectContaining({ name: "worker.mjs" }),
      }),
    );
    // No assets in the spec -> no assets JWT in metadata.
    const req = (ctx.client.createWorker as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      metadata: { assets?: unknown };
    };
    expect(req.metadata).not.toHaveProperty("assets");
  });

  it("attaches the completion jwt when the release has assets", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const ctx = context({
      spec: {
        ...specWithAsset(),
        worker: { path: "worker/main.mjs", size, sha256: hex },
      },
    });
    (ctx.client.createWorker as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "tapdeploy-t",
    });
    (ctx.client.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "version-2", number: 1, message: versionMessage(ctx.spec) }]);
    (ctx.client.listDeployments as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "d2", versions: [{ version_id: "version-2", percentage: 100 }] }]);
    const outcome = await executeDeployStep("create-worker", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
      assetJwt: "complete-jwt",
    });
    expect(outcome.ok).toBe(true);
    expect(ctx.client.createWorker).toHaveBeenCalledWith(
      "tapdeploy-t",
      expect.objectContaining({
        metadata: expect.objectContaining({
          main_module: "worker.mjs",
          assets: expect.objectContaining({ jwt: "complete-jwt" }),
        }),
      }),
    );
  });

  it("surfaces an upstream failure as a step failure", async () => {
    const { hex, size } = sha(WORKER_CONTENT);
    const ctx = context({
      spec: { ...specWithoutAsset(), worker: { path: "worker/main.mjs", size, sha256: hex } },
    });
    (ctx.client.createWorker as ReturnType<typeof vi.fn>).mockRejectedValue(
      makeCloudflareError(
        new Response(null, { status: 409 }),
        { success: false, errors: [{ code: 10000, message: "script conflict" }] },
      ),
    );
    const outcome = await executeDeployStep("create-worker", ctx, {
      scriptB64: Buffer.from(WORKER_CONTENT).toString("base64"),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("conflict");
    }
  });
});

describe("executeDeployStep: apply-secrets (first-install ordering)", () => {
  function secretSpec(): DeploySpec {
    return {
      ...specWithoutAsset(),
      cloudflare: {
        ...specWithoutAsset().cloudflare,
        secrets: { API_TOKEN: "generate-once" },
      },
    };
  }

  it("fails closed on worker-missing before any create is written", async () => {
    const ctx = context({ spec: secretSpec() });
    ctx.snapshot.workerExists = false;
    const outcome = await executeDeployStep("apply-secrets", ctx, { secrets: {} });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "worker-missing" } });
    expect(ctx.client.updateSecret).not.toHaveBeenCalled();
  });

  it("rejects separate Secret PUT creation even when the Worker exists", async () => {
    const ctx = context({ spec: secretSpec() });
    ctx.snapshot.workerExists = true;
    (ctx.client.updateSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "API_TOKEN",
      type: "secret_text",
    });
    const outcome = await executeDeployStep("apply-secrets", ctx, { secrets: {} });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "missing-secret" } });
    expect(ctx.client.updateSecret).not.toHaveBeenCalled();
  });

  it("preserves an existing secret with no write even when the worker is absent", async () => {
    const ctx = context({ spec: secretSpec() });
    ctx.snapshot.workerExists = false;
    ctx.snapshot.secretNames = ["API_TOKEN"];
    const outcome = await executeDeployStep("apply-secrets", ctx, { secrets: {} });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toMatchObject({
        secrets: [{ name: "API_TOKEN", action: "preserve" }],
      });
    }
    expect(ctx.client.updateSecret).not.toHaveBeenCalled();
  });

  it("keeps the missing-value check ahead of the worker-missing guard", async () => {
    const ctx = context({
      spec: {
        ...secretSpec(),
        cloudflare: {
          ...secretSpec().cloudflare,
          secrets: { API_TOKEN: "prompt-on-install" },
        },
      },
    });
    ctx.snapshot.workerExists = false;
    const outcome = await executeDeployStep("apply-secrets", ctx, { secrets: {} });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "missing-secret" } });
    expect(ctx.client.updateSecret).not.toHaveBeenCalled();
  });
});

describe("executeDeployStep: activate (percentage)", () => {
  it("is idempotent: re-deploying the already-live version is a no-op", async () => {
    const ctx = context();
    (ctx.client.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "version-9", number: 1 },
    ]);
    (ctx.client.listDeployments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "dep-1",
        versions: [{ version_id: "version-9", percentage: 100 }],
      },
    ]);
    const outcome = await executeDeployStep("activate", ctx, { versionId: "version-9" });
    expect(outcome).toEqual({
      ok: true,
      result: { alreadyActive: true, deploymentId: "dep-1" },
    });
    expect(ctx.client.createDeployment).not.toHaveBeenCalled();
  });

  it("rejects an unknown version before any write", async () => {
    const ctx = context();
    (ctx.client.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "version-1", number: 1 },
    ]);
    (ctx.client.listDeployments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const outcome = await executeDeployStep("activate", ctx, { versionId: "version-0" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("wrong-version");
    }
    expect(ctx.client.createDeployment).not.toHaveBeenCalled();
  });

  it("creates a percentage deployment for the confirmed version", async () => {
    const ctx = context();
    (ctx.client.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "version-9", number: 1 },
    ]);
    (ctx.client.listDeployments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (ctx.client.createDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "dep-2",
      versions: [{ version_id: "version-9", percentage: 100 }],
    });
    const outcome = await executeDeployStep("activate", ctx, { versionId: "version-9" });
    expect(outcome).toEqual({
      ok: true,
      result: { alreadyActive: false, deploymentId: "dep-2" },
    });
    expect(ctx.client.createDeployment).toHaveBeenCalledWith("tapdeploy-t", {
      strategy: "percentage",
      versions: [{ version_id: "version-9", percentage: 100 }],
      annotations: expect.objectContaining({
        "workers/message": expect.stringContaining(TAPDEPLOY_MANAGED_MARKER) as string,
      }),
    });
  });

  it("surfaces an upstream 409 deploy conflict through the outcome", async () => {
    const ctx = context();
    (ctx.client.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "version-9", number: 1 },
    ]);
    (ctx.client.listDeployments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const conflict = makeCloudflareError(
      new Response(null, { status: 409 }),
      { success: false, errors: [{ code: 10000, message: "deployment conflict" }] },
    );
    (ctx.client.createDeployment as ReturnType<typeof vi.fn>).mockRejectedValue(conflict);
    const outcome = await executeDeployStep("activate", ctx, { versionId: "version-9" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("conflict");
    }
  });
});

describe("executeDeployStep: schedules, assets applicability, postcheck", () => {
  it("leaves cron schedules untouched when they already match the resolved spec", async () => {
    const ctx = context();
    ctx.spec.cloudflare.cron = ["0 1 * * *"];
    (ctx.client.getSchedules as ReturnType<typeof vi.fn>).mockResolvedValue({ crons: ["0 1 * * *"] });
    const outcome = await executeDeployStep("reconcile-schedules", ctx, {});
    expect(outcome).toEqual({
      ok: true,
      result: { unchanged: true, crons: ["0 1 * * *"] },
    });
    expect(ctx.client.updateSchedules).not.toHaveBeenCalled();
  });

  it("updates schedules when they differ, sorted-insensitively", async () => {
    const ctx = context();
    ctx.spec.cloudflare.cron = ["30 2 * * *"];
    (ctx.client.getSchedules as ReturnType<typeof vi.fn>).mockResolvedValue({ crons: ["0 1 * * *"] });
    (ctx.client.updateSchedules as ReturnType<typeof vi.fn>).mockResolvedValue({
      crons: ["30 2 * * *"],
    });
    const outcome = await executeDeployStep("reconcile-schedules", ctx, {});
    expect(outcome.ok).toBe(true);
    expect(ctx.client.updateSchedules).toHaveBeenCalledWith("tapdeploy-t", ["30 2 * * *"]);
  });

  it("preserves existing schedules when the release declares none (never clears)", async () => {
    const ctx = context();
    ctx.spec.cloudflare.cron = [];
    (ctx.client.getSchedules as ReturnType<typeof vi.fn>).mockResolvedValue({ crons: ["0 1 * * *"] });
    const outcome = await executeDeployStep("reconcile-schedules", ctx, {});
    expect(outcome).toEqual({
      ok: true,
      result: { unchanged: true, crons: ["0 1 * * *"] },
    });
    expect(ctx.client.updateSchedules).not.toHaveBeenCalled();
  });

  it("no-ops register-assets for a release with no assets", async () => {
    const outcome = await executeDeployStep("register-assets", context(), {});
    expect(outcome).toEqual({ ok: true, result: { skipped: true, buckets: [] } });
  });

  it("no-ops complete-assets for a release with no assets", async () => {
    const outcome = await executeDeployStep("complete-assets", context(), {
      completionJwt: "anything",
    });
    expect(outcome).toEqual({ ok: true, result: { skipped: true } });
  });

  it("obtains completion from the approved provider manifest, not the supplied browser JWT", async () => {
    const ctx = context({ spec: specWithAsset() });
    const startSession = vi.fn().mockResolvedValue({ jwt: "complete-jwt-1", buckets: [] });
    const okOutcome = await executeDeployStep("complete-assets", ctx, {
      completionJwt: "unrelated-browser-token",
    }, { startSession });
    expect(okOutcome).toEqual({ ok: true, result: { jwt: "complete-jwt-1" } });
    expect(startSession).toHaveBeenCalledOnce();
    startSession.mockResolvedValue({ jwt: "upload-token", buckets: [["missing-hash"]] });
    const bad = await executeDeployStep("complete-assets", ctx, {}, { startSession });
    expect(bad.ok).toBe(false);
  });

  it("passes a version through postcheck only when it is actually live", async () => {
    const ctx = context();
    (ctx.client.listDeployments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "dep-1", versions: [{ version_id: "version-9", percentage: 100 }] },
    ]);
    (ctx.client.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "version-9", number: 1 },
    ]);
    const okOutcome = await executeDeployStep("postcheck", ctx, {
      expectedVersionId: "version-9",
    });
    expect(okOutcome.ok).toBe(true);
    if (okOutcome.ok) {
      expect((okOutcome.result as { deployed: boolean }).deployed).toBe(true);
    }

    const badOutcome = await executeDeployStep("postcheck", ctx, {
      expectedVersionId: "version-0",
    });
    expect(badOutcome.ok).toBe(true);
    if (badOutcome.ok) {
      expect((badOutcome.result as { deployed: boolean }).deployed).toBe(false);
    }
  });

  it("postcheck also verifies the resulting bindings against the approved identities", async () => {
    const ctx = context();
    ctx.spec.cloudflare.r2 = [{ binding: "BUCKET", bucketName: "approved-bucket", createIfMissing: true }];
    (ctx.client.listDeployments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "dep-1", versions: [{ version_id: "version-9", percentage: 100 }] },
    ]);
    (ctx.client.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "version-9", number: 1 }]);

    ctx.snapshot.deployedBindings = { r2: { BUCKET: "approved-bucket" } };
    const matching = await executeDeployStep("postcheck", ctx, { expectedVersionId: "version-9" });
    expect(matching.ok && matching.result).toMatchObject({ deployed: true, bindingsVerified: true, bindingMismatches: [] });

    ctx.snapshot.deployedBindings = { r2: { BUCKET: "someone-elses-bucket" } };
    const rebound = await executeDeployStep("postcheck", ctx, { expectedVersionId: "version-9" });
    expect(rebound.ok && rebound.result).toMatchObject({
      deployed: true,
      bindingsVerified: false,
      bindingMismatches: ['r2 binding "BUCKET" resolves to someone-elses-bucket, expected approved-bucket'],
    });
  });
});
