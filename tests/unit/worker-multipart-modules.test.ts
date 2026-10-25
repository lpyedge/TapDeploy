import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCloudflareClient, type Fetcher } from "../../src/cloudflare/client/client.js";
import { executeDeployStep, versionMessage, type DeployStepContext } from "../../src/core/deploy/steps.js";
import {
  encodeVersionModuleParts,
  WORKER_UPLOAD_MAX_ENCODED_BYTES,
  WORKER_UPLOAD_MAX_MODULES,
  WORKER_UPLOAD_MAX_TOTAL_BYTES,
  type VersionCreateRequest,
} from "../../src/cloudflare/models/workers.js";
import type { DeployBundle, DeployBundleModule } from "../../src/release/deploy-bundle.js";

const JS_MODULE_MIME = "application/javascript+module";
const WASM_MODULE_MIME = "application/wasm";
import type { CloudflareApiClient } from "../../src/cloudflare/client/index.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";

const ACCOUNT_ID = "a".repeat(32);
const SCRIPT = "modules-app";
const MAIN_NAME = "worker/main.mjs";
const CHUNK_NAME = "worker/chunks/helper.mjs";
const WASM_NAME = "worker/engine.wasm";
const ACTIVE_VERSION = "00000000-0000-4000-8000-000000000001";

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// The trailing non-UTF-8 bytes make a text round-trip observable: TextDecoder
// maps 0xff/0xde/0x80 to U+FFFD, so exact-byte equality proves the wire path
// never decoded binary module content as text (FAIL oracle).
const encoder = new TextEncoder();
const mainBytes = concat(
  encoder.encode('export default { async fetch() { return new Response(WASM); } };'),
  Uint8Array.from([0xff, 0xfe]),
);
const chunkBytes = concat(encoder.encode("export const helper = 1;"), Uint8Array.from([0x80, 0x81]));
const wasmBytes = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xde, 0xad, 0xff, 0x7f]);

function versionRequest(overrides: Partial<VersionCreateRequest> = {}): VersionCreateRequest {
  return {
    metadata: {
      main_module: MAIN_NAME,
      compatibility_date: "2026-10-10",
      annotations: { "workers/message": "modules fixture" },
    },
    mainModule: { name: MAIN_NAME, content: mainBytes, contentType: JS_MODULE_MIME },
    additionalModules: [
      { name: CHUNK_NAME, content: chunkBytes, contentType: JS_MODULE_MIME },
      { name: WASM_NAME, content: wasmBytes, contentType: WASM_MODULE_MIME },
    ],
    ...overrides,
  };
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
  return { log, client: createCloudflareClient({ accessToken: "fake-token", accountId: ACCOUNT_ID, fetcher }) };
}

async function partBytes(form: FormData, name: string): Promise<Uint8Array> {
  const part = form.get(name);
  if (!(part instanceof Blob)) throw new Error(`multipart part "${name}" is missing`);
  return new Uint8Array(await part.arrayBuffer());
}

async function assertModuleParts(entry: CapturedCall): Promise<void> {
  expect(entry.body).toBeInstanceOf(FormData);
  const form = entry.body as FormData;
  const metadata = form.get("metadata");
  expect(metadata).toBeInstanceOf(Blob);
  expect(JSON.parse(await (metadata as Blob).text())).toMatchObject({ main_module: MAIN_NAME });
  expect([...form.keys()].sort()).toEqual(["metadata", MAIN_NAME, CHUNK_NAME, WASM_NAME].sort());
  const mainPart = form.get(MAIN_NAME);
  expect(mainPart).toBeInstanceOf(File);
  expect((mainPart as File).name).toBe(MAIN_NAME);
  expect((mainPart as Blob).type).toBe(JS_MODULE_MIME);
  expect(await partBytes(form, MAIN_NAME)).toEqual(mainBytes);
  expect((form.get(CHUNK_NAME) as Blob).type).toBe(JS_MODULE_MIME);
  expect(await partBytes(form, CHUNK_NAME)).toEqual(chunkBytes);
  expect((form.get(WASM_NAME) as Blob).type).toBe(WASM_MODULE_MIME);
  expect(await partBytes(form, WASM_NAME)).toEqual(wasmBytes);
}

describe("version upload: multipart ESM/chunk/Wasm parts (client encoder)", () => {
  it("createWorker (initial PUT) uploads one part per module with exact bytes, names and MIME", async () => {
    const { log, client } = captureClient();
    await client.createWorker(SCRIPT, versionRequest());
    expect(log).toHaveLength(1);
    expect(log[0]!.method).toBe("PUT");
    expect(log[0]!.url).toContain(`/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT}`);
    expect(log[0]!.url).not.toContain("/versions");
    await assertModuleParts(log[0]!);
  });

  it("createVersion (upgrade POST) uses the identical encoder and matching main_module", async () => {
    const { log, client } = captureClient();
    await client.createVersion(SCRIPT, versionRequest());
    expect(log).toHaveLength(1);
    expect(log[0]!.method).toBe("POST");
    expect(log[0]!.url).toContain(`/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT}/versions`);
    await assertModuleParts(log[0]!);
  });

  it("Wasm arrives as binary bytes; a TextDecoder round-trip would have corrupted it", async () => {
    const { log, client } = captureClient();
    await client.createVersion(SCRIPT, versionRequest());
    const bytes = await partBytes(log[0]!.body as FormData, WASM_NAME);
    expect(bytes).toEqual(wasmBytes);
    expect(bytes.includes(0xff)).toBe(true);
    expect([...bytes.slice(8, 12)]).toEqual([0xde, 0xad, 0xff, 0x7f]);
  });

  it("refuses a module payload over the bounded upload budget before contacting the provider", async () => {
    const { log, client } = captureClient();
    const request = versionRequest({
      additionalModules: [
        { name: CHUNK_NAME, content: new Uint8Array(Math.ceil(WORKER_UPLOAD_MAX_TOTAL_BYTES / 2)), contentType: JS_MODULE_MIME },
        { name: WASM_NAME, content: new Uint8Array(Math.floor(WORKER_UPLOAD_MAX_TOTAL_BYTES / 2) + 2), contentType: WASM_MODULE_MIME },
      ],
    });
    await expect(client.createVersion(SCRIPT, request)).rejects.toMatchObject({
      kind: "invalid-response",
      message: expect.stringContaining("upload budget") as string,
    });
    expect(log).toHaveLength(0);
  });

  it("refuses an unbounded module count", async () => {
    const { log, client } = captureClient();
    const modules = Array.from({ length: WORKER_UPLOAD_MAX_MODULES }, (_, index) => ({
      name: `worker/chunk-${index}.mjs`,
      content: "export {};",
      contentType: JS_MODULE_MIME,
    }));
    await expect(client.createVersion(SCRIPT, versionRequest({ additionalModules: modules }))).rejects.toMatchObject({
      kind: "invalid-response",
      message: expect.stringContaining("module count") as string,
    });
    expect(log).toHaveLength(0);
  });

  const unsafe: Array<[string, Partial<VersionCreateRequest>]> = [
    ["a traversal module name", { additionalModules: [{ name: "../escape.mjs", content: "x", contentType: JS_MODULE_MIME }] }],
    ["an absolute module name", { additionalModules: [{ name: "/absolute.mjs", content: "x", contentType: JS_MODULE_MIME }] }],
    ["a backslash module name", { additionalModules: [{ name: "worker\\escape.mjs", content: "x", contentType: JS_MODULE_MIME }] }],
    ["a dot path segment", { additionalModules: [{ name: "worker/./escape.mjs", content: "x", contentType: JS_MODULE_MIME }] }],
    ["a duplicate of the main module", { additionalModules: [{ name: MAIN_NAME, content: "x", contentType: JS_MODULE_MIME }] }],
    ["an unsupported module type", { additionalModules: [{ name: "worker/readme.txt", content: "x", contentType: "text/plain" }] }],
    ["Wasm supplied as text", { additionalModules: [{ name: WASM_NAME, content: "not-binary", contentType: WASM_MODULE_MIME }] }],
    ["a content type that contradicts the extension", { additionalModules: [{ name: WASM_NAME, content: wasmBytes, contentType: JS_MODULE_MIME }] }],
  ];
  for (const [label, override] of unsafe) {
    it(`refuses ${label}`, async () => {
      const { log, client } = captureClient();
      await expect(client.createVersion(SCRIPT, versionRequest(override))).rejects.toMatchObject({ kind: "invalid-response" });
      expect(log).toHaveLength(0);
    });
  }

  it("keeps the encoder MIME types equal to the release constants", () => {
    const encoded = encodeVersionModuleParts(versionRequest());
    expect(encoded.ok).toBe(true);
    expect(encoded.parts.map((part) => part.mime)).toEqual([JS_MODULE_MIME, JS_MODULE_MIME, WASM_MODULE_MIME]);
  });

  it("inherited JSON version upload carries the same module set as base64 without corrupting binary", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = createCloudflareClient({ accessToken: "fake", accountId: ACCOUNT_ID, fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "GET" && url.pathname.endsWith("/workers/workers")) {
        return Response.json({ success: true, result: [{ id: "immutable-id", name: SCRIPT }] });
      }
      if (init?.method === "GET" && url.pathname.endsWith("/workers/workers/immutable-id")) {
        return Response.json({ success: true, result: { id: "immutable-id", name: SCRIPT } });
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ success: true, result: { id: "prepared-1" } });
    } });
    const result = await client.createVersion(SCRIPT, versionRequest({
      metadata: { main_module: MAIN_NAME, bindings: [{ type: "inherit", name: "PASSWORD", version_id: ACTIVE_VERSION }] },
    }));
    expect(result.id).toBe("prepared-1");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.bindings).toEqual([{ type: "inherit", name: "PASSWORD", version_id: ACTIVE_VERSION }]);
    const modules = bodies[0]!.modules as Array<{ name: string; content_type: string; content_base64: string }>;
    expect(modules.map((module) => module.name)).toEqual([MAIN_NAME, CHUNK_NAME, WASM_NAME]);
    expect(modules.map((module) => module.content_type)).toEqual([JS_MODULE_MIME, JS_MODULE_MIME, WASM_MODULE_MIME]);
    expect(Uint8Array.from(Buffer.from(modules[0]!.content_base64, "base64"))).toEqual(mainBytes);
    expect(Uint8Array.from(Buffer.from(modules[1]!.content_base64, "base64"))).toEqual(chunkBytes);
    expect(Uint8Array.from(Buffer.from(modules[2]!.content_base64, "base64"))).toEqual(wasmBytes);
  });
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bundleFor(): DeployBundle {
  return {
    schemaVersion: 1,
    appName: SCRIPT,
    targetKind: "workers",
    mainModule: MAIN_NAME,
    modules: [
      { name: MAIN_NAME, kind: "esm", mime: JS_MODULE_MIME, size: mainBytes.length, sha256: sha256Hex(mainBytes) },
      { name: CHUNK_NAME, kind: "esm", mime: JS_MODULE_MIME, size: chunkBytes.length, sha256: sha256Hex(chunkBytes) },
      { name: WASM_NAME, kind: "wasm", mime: WASM_MODULE_MIME, size: wasmBytes.length, sha256: sha256Hex(wasmBytes) },
    ].sort((a, b) => (a.name < b.name ? -1 : 1)) as DeployBundleModule[],
    assets: [],
    config: { path: "wrangler.jsonc", size: 2, sha256: "0".repeat(64) },
    source: { archiveBytes: 1, archiveSha256: "1".repeat(64), manifestDigest: "2".repeat(64) },
    wranglerEffectiveHash: "3".repeat(64),
    bundleDigest: "4".repeat(64),
  };
}

// The prebuilt path carries no legacy `spec.worker`; the bundle alone is the
// module identity, so any use of the legacy artifact would fail this fixture.
function specFor(): DeploySpec {
  return {
    schemaVersion: 1,
    project: { id: "modules/app", version: "1.0.0" },
    assets: [],
    inputs: {},
    cloudflare: { workerName: SCRIPT, r2: [], d1: [], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {} },
    wrangler: { name: SCRIPT, main: "./worker/main.mjs", compatibility_date: "2026-10-10", r2_buckets: [], crons: [] },
    targetKind: "workers",
  };
}

function context(bundle?: DeployBundle): DeployStepContext {
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
    accountId: ACCOUNT_ID,
    workerName: SCRIPT,
    spec: specFor(),
    ...(bundle ? { bundle } : {}),
    snapshot: {
      accountId: ACCOUNT_ID,
      workerName: SCRIPT,
      workerExists: false,
      versions: [],
      activeDeploymentId: undefined,
    } as unknown as DeployStepContext["snapshot"],
    accessToken: "tok-1",
  };
}

function uploadArgs(): Record<string, unknown> {
  return {
    scriptB64: Buffer.from(mainBytes).toString("base64"),
    additionalModules: [
      { name: CHUNK_NAME, contentB64: Buffer.from(chunkBytes).toString("base64") },
      { name: WASM_NAME, contentB64: Buffer.from(wasmBytes).toString("base64") },
    ],
  };
}

describe("version upload: step adapter verifies the approved bundle module set", () => {
  it("create-worker verifies the full set byte-for-byte and keeps the ownership marker proof", async () => {
    const ctx = context(bundleFor());
    (ctx.client.createWorker as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "version-1", number: 1 });
    (ctx.client.listDeployments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "dep-1", versions: [{ version_id: "version-1", percentage: 100 }] },
    ]);
    (ctx.client.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "version-1", number: 1, message: versionMessage(ctx.spec) },
    ]);
    const outcome = await executeDeployStep("create-worker", ctx, uploadArgs());
    expect(outcome).toEqual({ ok: true, result: { versionId: "version-1", number: 1 } });
    const request = (ctx.client.createWorker as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      metadata: { main_module: string; annotations?: Record<string, string> };
      mainModule: { name: string; content: Uint8Array };
      additionalModules?: Array<{ name: string; content: Uint8Array; contentType: string }>;
    };
    expect(request.metadata.main_module).toBe(MAIN_NAME);
    expect(request.metadata.annotations?.["workers/message"]).toBe(versionMessage(ctx.spec));
    expect(request.mainModule.name).toBe(MAIN_NAME);
    expect(request.mainModule.content).toEqual(mainBytes);
    expect(request.additionalModules?.map((module) => module.name)).toEqual([CHUNK_NAME, WASM_NAME]);
    expect(request.additionalModules?.[0]?.content).toEqual(chunkBytes);
    expect(request.additionalModules?.[1]?.content).toEqual(wasmBytes);
    expect(request.additionalModules?.[1]?.contentType).toBe(WASM_MODULE_MIME);
  });

  it("create-version sends the same verified module set for an upgrade", async () => {
    const ctx = context(bundleFor());
    (ctx.client.createVersion as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "version-2", number: 2 });
    const outcome = await executeDeployStep("create-version", ctx, uploadArgs());
    expect(outcome).toEqual({ ok: true, result: { versionId: "version-2", number: 2 } });
    const request = (ctx.client.createVersion as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      metadata: { main_module: string };
      mainModule: { name: string; content: Uint8Array };
      additionalModules?: Array<{ name: string; content: Uint8Array }>;
    };
    expect(request.metadata.main_module).toBe(MAIN_NAME);
    expect(request.mainModule.name).toBe(MAIN_NAME);
    expect(request.mainModule.content).toEqual(mainBytes);
    expect(request.additionalModules?.map((module) => module.name)).toEqual([CHUNK_NAME, WASM_NAME]);
    expect(request.additionalModules?.[1]?.content).toEqual(wasmBytes);
  });

  it("an ambiguous first serving version does not pass the ownership proof", async () => {
    const ctx = context(bundleFor());
    (ctx.client.createWorker as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "version-1", number: 1 });
    (ctx.client.listDeployments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "dep-1", versions: [{ version_id: "version-1", percentage: 100 }] },
    ]);
    (ctx.client.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "version-1", number: 1, message: "someone-else/v9" },
    ]);
    const outcome = await executeDeployStep("create-worker", ctx, uploadArgs());
    expect(outcome).toMatchObject({ ok: false, error: { kind: "wrong-version" } });
  });

  it("tampered and incomplete module sets fail before any provider call", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["a flipped Wasm byte", (() => {
        const flipped = new Uint8Array(wasmBytes);
        flipped[8] = (flipped[8] ?? 0) ^ 0x01;
        return {
          scriptB64: Buffer.from(mainBytes).toString("base64"),
          additionalModules: [
            { name: CHUNK_NAME, contentB64: Buffer.from(chunkBytes).toString("base64") },
            { name: WASM_NAME, contentB64: Buffer.from(flipped).toString("base64") },
          ],
        };
      })(), "HASH_DRIFT"],
      ["a missing approved module", {
        scriptB64: Buffer.from(mainBytes).toString("base64"),
        additionalModules: [{ name: WASM_NAME, contentB64: Buffer.from(wasmBytes).toString("base64") }],
      }, "MISSING_MODULE"],
      ["an undeclared extra module", {
        scriptB64: Buffer.from(mainBytes).toString("base64"),
        additionalModules: [
          { name: CHUNK_NAME, contentB64: Buffer.from(chunkBytes).toString("base64") },
          { name: WASM_NAME, contentB64: Buffer.from(wasmBytes).toString("base64") },
          { name: "worker/extra.mjs", contentB64: Buffer.from("x").toString("base64") },
        ],
      }, "UNDECLARED_MODULE"],
    ];
    for (const [label, args, expectedCode] of cases) {
      const ctx = context(bundleFor());
      const outcome = await executeDeployStep("create-worker", ctx, args);
      expect(outcome.ok, label).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.kind, label).toBe("artifact-mismatch");
        expect(outcome.error.detail, label).toContain(expectedCode);
      }
      expect(ctx.client.createWorker, label).not.toHaveBeenCalled();
    }
  });

  it("additional modules are refused without an approved bundle identity", async () => {
    const ctx = context();
    const outcome = await executeDeployStep("create-version", ctx, uploadArgs());
    expect(outcome).toMatchObject({ ok: false, error: { kind: "invalid-args" } });
    expect(ctx.client.createVersion).not.toHaveBeenCalled();
  });

  it("the encoded payload budget is enforced before decode or provider access", async () => {
    const ctx = context(bundleFor());
    const outcome = await executeDeployStep("create-version", ctx, {
      scriptB64: Buffer.from(mainBytes).toString("base64"),
      additionalModules: [{ name: CHUNK_NAME, contentB64: "A".repeat(WORKER_UPLOAD_MAX_ENCODED_BYTES) }],
    });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "payload-too-large" } });
    expect(ctx.client.createVersion).not.toHaveBeenCalled();
  });
});
