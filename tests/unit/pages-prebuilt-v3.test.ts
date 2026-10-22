// Pages prebuilt V3 parity oracles.
//
// A Pages release is deployed ENTIRELY through the Pages API: static assets ride
// the Pages asset manifest, an optional prebuilt `_worker.js` (advanced
// functions) rides the `_worker.bundle` multipart part, and no Workers
// script/version route is ever used for a Pages target. The V3 prebuilt
// pipeline supplies the input identity (normalized wrangler config + verified
// ZIP -> assets-only bundle); this file proves the Pages-side protocol against
// those inputs with exact-URL mocks: static-only manifests, deployment
// control-file refusal, the `_worker.bundle` multipart, pending/canceled/foreign
// deployment reconciliation, wrong-API rejection, prewrite refusal of
// unsupported resource families, and the fixed JWT-scoped asset upload
// endpoints.
//
// Oracle coverage from the task text: static only, `_worker.js`,
// pending/canceled/foreign deployment, asset path, wrong API rejection.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

import { normalizeWranglerV3 } from "../../src/manifest/wrangler-v3.js";
import { extractPrebuiltZip } from "../../src/release/prebuilt-zip.js";
import { buildDeployBundle } from "../../src/release/deploy-bundle.js";
import {
  buildPagesManifest,
  pagesAssetHash,
  pagesControlFileAtRoot,
  toPagesAssetPath,
} from "../../src/cloudflare/pages/manifest.js";
import {
  checkPagesMissingHashes,
  uploadPagesAssets,
  upsertPagesHashes,
} from "../../src/cloudflare/pages/upload.js";
import { createCloudflareClient } from "../../src/cloudflare/client/index.js";
import {
  approvedPagesAssets,
  createPagesDeployment,
  postcheckPagesDeployment,
  rejectUnsupportedPagesResources,
  validatePagesDeploymentPayload,
} from "../../src/core/deploy/pages.js";
import { executeDeployStep, isDeployStepForTarget } from "../../src/core/deploy/steps.js";
import type { DeployStepContext } from "../../src/core/deploy/steps.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";

const enc = new TextEncoder();
const ACCOUNT = "a".repeat(32);
const HASH_INDEX = "a".repeat(32);

const PAGES_WRANGLER =
  '{ "name": "site", "compatibility_date": "2026-10-10", "pages_build_output_dir": "dist" }';

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

// An exact-URL recording fetcher: every call is captured and answered by the
// supplied handler, so a test can assert both the URL family and the body
// without any real network access.
function recorder(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href);
    const request = init ?? {};
    calls.push({ url: href, init: request });
    return Promise.resolve(handler(url, request));
  };
  return { fn, calls };
}

function envelope(result: unknown): Response {
  return Response.json({ success: true, result });
}

function apiClient(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
}

function pagesSpec(): DeploySpec {
  return {
    schemaVersion: 1,
    project: { id: "example/static-site", version: "1.0.0" },
    assets: [],
    inputs: { projectName: "my-pages-app" },
    cloudflare: {
      workerName: "",
      r2: [],
      d1: [],
      kv: [],
      queues: [],
      hyperdrive: [],
      vectorize: [],
      secretsStore: [],
      runtimeBindings: [],
      cron: [],
      secrets: {},
      pages: { projectName: "my-pages-app" },
    },
    wrangler: {
      name: "my-pages-app",
      compatibility_date: "2026-10-10",
      r2_buckets: [],
      crons: [],
    },
    targetKind: "pages",
  };
}

function snapshot(): TargetSnapshot {
  return {
    accountId: ACCOUNT,
    workerName: "my-pages-app",
    workerExists: false,
    versions: [],
    activeDeploymentVersionIds: [],
    r2Buckets: [],
    d1Databases: [],
    kvNamespaces: [],
    queues: [],
    hyperdriveConfigs: [],
    vectorizeIndexes: [],
    secretsStores: [],
    secretsStoreSecrets: [],
    secretNames: [],
    scheduleCrons: [],
    rateLimitCount: 0,
    pagesProjectExists: false,
  } as TargetSnapshot;
}

function pagesZip(extra: Record<string, string> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "wrangler.jsonc": enc.encode(PAGES_WRANGLER),
    "dist/index.html": enc.encode("<html>site</html>"),
    "dist/assets/app.js": enc.encode("console.log('app');"),
    // A NESTED `_redirects` is a normal static file; only the output root name
    // is reserved.
    "dist/blog/_redirects": enc.encode("/old /new 301"),
  };
  for (const [name, content] of Object.entries(extra)) {
    files[name] = enc.encode(content);
  }
  return zipSync(files, { level: 6 });
}

describe("V3 Pages config projection", () => {
  it("accepts a Pages config without any main module via pages_build_output_dir", () => {
    const result = normalizeWranglerV3(PAGES_WRANGLER);
    expect(result.ok).toBe(true);
    const config = result.config!;
    expect(config.kind).toBe("pages");
    expect(config.main).toBeUndefined();
    expect(config.pages_build_output_dir).toBe("dist");
    expect(config.assets).toBeUndefined();
  });

  it("refuses main+pages_build_output_dir, assets, and escaping output dirs", () => {
    const both = normalizeWranglerV3(
      '{ "name": "site", "compatibility_date": "2026-10-10", "main": "worker/main.mjs", "pages_build_output_dir": "dist" }',
    );
    expect(both.ok).toBe(false);
    expect(both.issues.map((issue) => [issue.code, issue.field])).toContainEqual([
      "INVALID_SHAPE",
      "main",
    ]);

    const withAssets = normalizeWranglerV3(
      '{ "name": "site", "compatibility_date": "2026-10-10", "pages_build_output_dir": "dist", "assets": { "directory": "dist" } }',
    );
    expect(withAssets.ok).toBe(false);
    expect(withAssets.issues.map((issue) => [issue.code, issue.field])).toContainEqual([
      "INVALID_SHAPE",
      "assets",
    ]);

    const escaping = normalizeWranglerV3(
      '{ "name": "site", "compatibility_date": "2026-10-10", "pages_build_output_dir": "../dist" }',
    );
    expect(escaping.ok).toBe(false);
    expect(escaping.issues.map((issue) => [issue.code, issue.field])).toContainEqual([
      "PATH_ESCAPES_UNIT",
      "pages_build_output_dir",
    ]);
  });
});

describe("prebuilt Pages ZIP becomes an assets-only identity", () => {
  it("builds the pages bundle from the verified ZIP and roots the manifest at the output dir", async () => {
    const extracted = await extractPrebuiltZip(pagesZip());
    expect(extracted.ok).toBe(true);
    const built = await buildDeployBundle(extracted);
    expect(built.ok).toBe(true);
    const bundle = built.bundle!;
    expect(bundle.targetKind).toBe("pages");
    expect(bundle.mainModule).toBeUndefined();
    expect(bundle.modules).toEqual([]);
    expect(bundle.assetsDirectory).toBe("dist");
    expect(bundle.assets.map((asset) => asset.path)).toEqual([
      "dist/assets/app.js",
      "dist/blog/_redirects",
      "dist/index.html",
    ]);

    const byPath = new Map(extracted.files!.map((file) => [file.path, file]));
    const refs = ["dist/assets/app.js", "dist/blog/_redirects", "dist/index.html"].map(
      (path) => byPath.get(path)!,
    );
    const manifest = buildPagesManifest(refs, bundle.assetsDirectory);
    expect(manifest).toEqual({
      "/assets/app.js": pagesAssetHash("dist/assets/app.js", byPath.get("dist/assets/app.js")!.bytes),
      "/blog/_redirects": pagesAssetHash("dist/blog/_redirects", byPath.get("dist/blog/_redirects")!.bytes),
      "/index.html": pagesAssetHash("dist/index.html", byPath.get("dist/index.html")!.bytes),
    });
  });

  it("refuses a control file at the output root instead of hashing it as a static asset", async () => {
    const extracted = await extractPrebuiltZip(pagesZip({ "dist/_worker.js": "export default {};" }));
    const built = await buildDeployBundle(extracted);
    // The bundle classifies files under the output dir as assets; the 
    // manifest layer then refuses the reserved root-level control name.
    expect(built.ok).toBe(true);
    const file = built.bundle!.assets.find((asset) => asset.path === "dist/_worker.js")!;
    expect(file).toBeDefined();
    expect(() =>
      buildPagesManifest(
        [{ path: file.path, size: file.size, sha256: file.sha256, bytes: enc.encode("export default {};") }],
        built.bundle!.assetsDirectory,
      ),
    ).toThrow(/control file/);
  });
});

describe("Pages asset paths and control-name identification", () => {
  it("roots paths relative to the output dir and refuses escaping files", () => {
    expect(toPagesAssetPath("dist/index.html", "dist")).toBe("/index.html");
    expect(toPagesAssetPath("dist/blog/post.html", "./dist/")).toBe("/blog/post.html");
    expect(() => toPagesAssetPath("other/index.html", "dist")).toThrow(/outside/);
  });

  it("reserves only root-level control names; nested names are normal files", () => {
    expect(pagesControlFileAtRoot("/_worker.js")).toBe("_worker.js");
    expect(pagesControlFileAtRoot("/_redirects")).toBe("_redirects");
    expect(pagesControlFileAtRoot("/_headers")).toBe("_headers");
    expect(pagesControlFileAtRoot("/_routes.json")).toBe("_routes.json");
    expect(pagesControlFileAtRoot("/functions/index.js")).toBe("functions");
    expect(pagesControlFileAtRoot("/blog/_redirects")).toBeUndefined();
    expect(pagesControlFileAtRoot("/sub/functions/index.js")).toBeUndefined();
    expect(pagesControlFileAtRoot("/index.html")).toBeUndefined();
  });
});

describe("deploy payload binding from the prebuilt identity", () => {
  it("binds the approved static identity computed from the prebuilt bytes", async () => {
    const bytes = enc.encode("<html>site</html>");
    const spec = pagesSpec();
    spec.wrangler.assets = { directory: "dist" };
    spec.assets = [
      {
        path: "dist/index.html",
        size: bytes.length,
        sha256: sha256Hex(bytes),
        pagesHash: pagesAssetHash("dist/index.html", bytes),
      },
    ];
    const approved = approvedPagesAssets(spec);
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.value).toEqual([
        {
          path: "/index.html",
          sha256: sha256Hex(bytes),
          size: bytes.length,
          pagesHash: pagesAssetHash("dist/index.html", bytes),
        },
      ]);
    }
    const check = await validatePagesDeploymentPayload(spec, {
      manifest: { "/index.html": pagesAssetHash("dist/index.html", bytes) },
    });
    expect(check.ok).toBe(true);
  });

  it("refuses a manifest or approved asset that declares a control path before any write", async () => {
    const { fn, calls } = recorder(() => envelope({}));
    const client = apiClient(fn);
    const spec = pagesSpec();
    spec.wrangler.assets = { directory: "dist" };
    spec.assets = [
      { path: "dist/index.html", size: 1, sha256: "a".repeat(64), pagesHash: HASH_INDEX },
    ];

    const manifestRefused = await createPagesDeployment(client, spec, {
      manifest: { "/index.html": HASH_INDEX, "/_routes.json": "b".repeat(32) },
    });
    const failed = manifestRefused as { ok: false; error: { kind: string; detail: string } };
    expect(failed.ok).toBe(false);
    expect(failed.error.kind).toBe("invalid-manifest");
    expect(failed.error.detail).toContain("control");

    const approved = approvedPagesAssets({
      ...spec,
      assets: [{ path: "dist/_worker.js", size: 1, sha256: "a".repeat(64), pagesHash: HASH_INDEX }],
    });
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect(approved.detail).toContain("control");
    }

    expect(calls).toEqual([]);
  });
});

describe("_worker.js advanced functions use the Pages multipart API", () => {
  function deploymentHandler() {
    return (url: URL, init: RequestInit): Response => {
      if (url.pathname.endsWith("/deployments") && init.method === "POST") {
        return envelope({
          id: "deployment-id-9",
          project_name: "my-pages-app",
          environment: "production",
          url: "https://my-pages-app.pages.dev",
          latest_stage: { name: "deploy", status: "queued" },
        });
      }
      return envelope({});
    };
  }

  it("ships a prebuilt _worker.js as the _worker.bundle part and never touches the Workers API", async () => {
    const bundle = enc.encode("export default { fetch() { return new Response('ok'); } };");
    const spec = pagesSpec();
    spec.wrangler.assets = { directory: "dist" };
    spec.assets = [
      { path: "dist/index.html", size: 1, sha256: "a".repeat(64), pagesHash: HASH_INDEX },
    ];
    spec.workerBundle = { path: "_worker.js", size: bundle.length, sha256: sha256Hex(bundle) };

    const { fn, calls } = recorder(deploymentHandler());
    const step = await createPagesDeployment(apiClient(fn), spec, {
      manifest: { "/index.html": HASH_INDEX },
      workerBundleB64: bytesToBase64(bundle),
    });
    expect((step as { ok: boolean }).ok).toBe(true);
    expect((step as { result: { deploymentId: string } }).result.deploymentId).toBe(
      "deployment-id-9",
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.init.method).toBe("POST");
    expect(call.url).toContain(`/accounts/${ACCOUNT}/pages/projects/my-pages-app/deployments`);
    expect(calls.every((recorded) => !recorded.url.includes("/workers/"))).toBe(true);

    const form = call.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get("manifest")))).toEqual({ "/index.html": HASH_INDEX });
    const part = form.get("_worker.bundle") as File;
    expect(part).toBeInstanceOf(Blob);
    expect(part.name).toBe("_worker.bundle");
    expect(part.type).toBe("application/javascript+module");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bundle);
  });

  it("allows a _worker.js-only Pages release with an empty manifest", async () => {
    const bundle = enc.encode("export default {};");
    const spec = pagesSpec();
    spec.workerBundle = { path: "_worker.js", size: bundle.length, sha256: sha256Hex(bundle) };
    const { fn, calls } = recorder(deploymentHandler());
    const step = await createPagesDeployment(apiClient(fn), spec, {
      manifest: {},
      workerBundleB64: bytesToBase64(bundle),
    });
    expect((step as { ok: boolean }).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("pending/canceled/foreign deployments are never success", () => {
  function postcheckClient(
    stage: { name: string; status: string },
    overrides: Record<string, unknown> = {},
  ) {
    return recorder((url) => {
      if (url.pathname.endsWith("/deployments/deployment-id-9")) {
        return envelope({
          id: "deployment-id-9",
          project_name: "my-pages-app",
          environment: "production",
          url: "https://my-pages-app.pages.dev",
          latest_stage: stage,
          ...overrides,
        });
      }
      return envelope({});
    });
  }

  it("keeps a queued/running deployment pending, never success", async () => {
    for (const status of ["queued", "running"]) {
      const { fn } = postcheckClient({ name: "deploy", status });
      const step = await postcheckPagesDeployment(apiClient(fn), pagesSpec(), "deployment-id-9");
      const result = (step as { ok: true; result: { succeeded: boolean; pending: boolean; status: string } })
        .result;
      expect(result.succeeded).toBe(false);
      expect(result.pending).toBe(true);
      expect(result.status).toBe(status);
    }
  });

  it("keeps a canceled deployment terminal and not success", async () => {
    const { fn } = postcheckClient({ name: "deploy", status: "canceled" });
    const step = await postcheckPagesDeployment(apiClient(fn), pagesSpec(), "deployment-id-9");
    const result = (step as { ok: true; result: { succeeded: boolean; pending: boolean } }).result;
    expect(result.succeeded).toBe(false);
    expect(result.pending).toBe(false);
  });

  it("rejects a foreign environment or mismatched deployment identity", async () => {
    const preview = postcheckClient({ name: "deploy", status: "success" }, { environment: "preview" });
    const a = await postcheckPagesDeployment(apiClient(preview.fn), pagesSpec(), "deployment-id-9");
    expect((a as { ok: false; error: { kind: string } }).error.kind).toBe("validation");

    const wrongId = postcheckClient({ name: "deploy", status: "success" }, { id: "deployment-id-other" });
    const b = await postcheckPagesDeployment(apiClient(wrongId.fn), pagesSpec(), "deployment-id-9");
    expect((b as { ok: false; error: { kind: string } }).error.kind).toBe("validation");

    const foreignProject = postcheckClient(
      { name: "deploy", status: "success" },
      { project_name: "other-app" },
    );
    const c = await postcheckPagesDeployment(apiClient(foreignProject.fn), pagesSpec(), "deployment-id-9");
    expect((c as { ok: false; error: { kind: string } }).error.kind).toBe("validation");
  });
});

describe("wrong API rejection", () => {
  it("refuses Workers steps for a Pages target and Pages steps for Workers", () => {
    for (const step of [
      "create-worker",
      "create-version",
      "activate",
      "register-assets",
      "complete-assets",
      "postcheck",
      "apply-secrets",
    ] as const) {
      expect(isDeployStepForTarget("pages", step)).toBe(false);
    }
    for (const step of [
      "pages-create-project",
      "pages-register-assets",
      "pages-deploy",
      "pages-postcheck",
    ] as const) {
      expect(isDeployStepForTarget("pages", step)).toBe(true);
      expect(isDeployStepForTarget("workers", step)).toBe(false);
    }
  });

  it("refuses to execute a Workers step for a Pages spec before any provider call", async () => {
    const { fn, calls } = recorder(() => envelope({}));
    const ctx: DeployStepContext = {
      client: apiClient(fn),
      accountId: ACCOUNT,
      workerName: "my-pages-app",
      spec: pagesSpec(),
      snapshot: snapshot(),
      accessToken: "tok",
    };
    const step = await executeDeployStep("create-worker", ctx, {});
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("step-not-applicable");
    expect(calls).toEqual([]);
  });
});

describe("asset upload endpoints are JWT-scoped and exact", () => {
  it("drives check-missing/upload/upsert-hashes over the fixed asset endpoints", async () => {
    const bytes = enc.encode("<html>site</html>");
    const hash = pagesAssetHash("index.html", bytes);
    const { fn, calls } = recorder((url) => {
      if (url.pathname === "/client/v4/pages/assets/check-missing") return envelope([hash]);
      if (url.pathname === "/client/v4/pages/assets/upload") return envelope(null);
      if (url.pathname === "/client/v4/pages/assets/upsert-hashes") return envelope(null);
      return envelope({});
    });
    const opts = { jwt: "upload-jwt", fetcher: fn };
    await expect(checkPagesMissingHashes([hash], opts)).resolves.toEqual([hash]);
    await uploadPagesAssets([{ hash, bytes, contentType: "text/html" }], opts);
    await upsertPagesHashes([hash], opts);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/client/v4/pages/assets/check-missing",
      "/client/v4/pages/assets/upload",
      "/client/v4/pages/assets/upsert-hashes",
    ]);
    for (const call of calls) {
      expect(call.url).not.toContain("/accounts/");
      expect(new Headers(call.init.headers as HeadersInit).get("authorization")).toBe(
        "Bearer upload-jwt",
      );
    }
    const uploadBody = JSON.parse(String(calls[1]!.init.body)) as Array<Record<string, unknown>>;
    expect(uploadBody).toEqual([
      {
        key: hash,
        value: bytesToBase64(bytes),
        metadata: { contentType: "text/html" },
        base64: true,
      },
    ]);
  });

  it("maps a 401 to token-expired without any OAuth fallback", async () => {
    const { fn, calls } = recorder(() => new Response("no", { status: 401 }));
    await expect(checkPagesMissingHashes([HASH_INDEX], { jwt: "expired", fetcher: fn })).rejects.toMatchObject(
      { kind: "token-expired" },
    );
    expect(calls).toHaveLength(1);
  });
});

describe("unsupported Pages resource families fail prewrite", () => {
  it("refuses cron/queues/hyperdrive/vectorize/secrets-store/AI before any provider write", async () => {
    const families: Array<Partial<DeploySpec["cloudflare"]>> = [
      { cron: ["*/5 * * * *"] },
      { queues: [{ binding: "Q", queueName: "q", createIfMissing: false }] },
      { hyperdrive: [{ binding: "H", configName: "h", createIfMissing: false }] },
      { vectorize: [{ binding: "V", indexName: "idx", createIfMissing: false }] },
      { secretsStore: [{ binding: "S", storeName: "s", createIfMissing: false }] },
      { runtimeBindings: [{ type: "ai", binding: "AI" }] },
    ];
    for (const override of families) {
      const spec = pagesSpec();
      spec.cloudflare = { ...spec.cloudflare, ...override };
      expect(
        (rejectUnsupportedPagesResources(spec) as { error: { kind: string } }).error.kind,
      ).toBe("unsupported-pages-resource");
      const { fn, calls } = recorder(() => envelope({}));
      const step = await createPagesDeployment(apiClient(fn), spec, { manifest: {} });
      expect((step as { ok: false; error: { kind: string } }).error.kind).toBe(
        "unsupported-pages-resource",
      );
      expect(calls).toEqual([]);
    }

    // R2/D1/KV and browser rendering stay supported for Pages.
    const allowed = pagesSpec();
    allowed.cloudflare = {
      ...allowed.cloudflare,
      r2: [{ binding: "R", bucketName: "b", createIfMissing: false }],
      d1: [{ binding: "D", databaseName: "d", createIfMissing: false }],
      kv: [{ binding: "K", namespaceName: "n", createIfMissing: false }],
      runtimeBindings: [{ type: "browser-rendering", binding: "B" }],
    };
    expect(rejectUnsupportedPagesResources(allowed)).toBeUndefined();
  });
});
