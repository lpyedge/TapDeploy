// Cloudflare Pages direct-upload contract. These tests drive the real
// typed client + deploy wizard against the documented wire shapes (static JSON
// fixtures), then exercise the Pages plan + deploy-step path. They verify:
//   - Pages project create/get parse the documented project shape.
//   - Pages upload-token returns a short-lived JWT (never the OAuth token).
//   - Pages deployment create is a multipart request (manifest + _worker.bundle).
//   - The Pages deploy plan + steps run against the Pages-only sequence.
//
// Regression oracle: a Pages release must never reuse the Workers
// scripts/versions API and must reject Cron / Worker-secret declarations
// before any mutation.

import { describe, expect, it } from "vitest";
import { createCloudflareClient } from "../../src/cloudflare/client/index.js";
import { fixtureFetcher } from "./cloudflare-fixtures.js";
import { pagesAssetHash, buildPagesManifest } from "../../src/cloudflare/pages/manifest.js";
it("Pages URLs are relative to the approved assets directory, not ZIP prefixes", () => {
  const bytes = new TextEncoder().encode("home");
  expect(buildPagesManifest([{ path: "site/index.html", bytes, size: 4, sha256: "a".repeat(64) }], "site")).toEqual({ "/index.html": pagesAssetHash("site/index.html", bytes) });
  expect(() => buildPagesManifest([{ path: "outside/index.html", bytes, size: 4, sha256: "a".repeat(64) }], "site")).toThrow(/outside/);
});
import { approvedPagesAssets, ensurePagesProject, startPagesAssetUpload, createPagesDeployment, postcheckPagesDeployment, rejectUnsupportedPagesResources, validatePagesDeploymentPayload } from "../../src/core/deploy/pages.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";

const ACCOUNT = "a".repeat(32);

// the approved Pages asset identity used by the positive/deploy tests.
const HASH_INDEX = "a".repeat(32);
const SHA_INDEX = "a".repeat(64);

function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
    .then((digest) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

function spec(pages?: DeploySpec["cloudflare"]["pages"]): DeploySpec {
  return {
    schemaVersion: 1,
    project: { id: "example/static-site", version: "1.0.0" },
    assets: [
      { path: "index.html", size: 12, sha256: SHA_INDEX, pagesHash: HASH_INDEX },
    ],
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
      ...(pages ? { pages } : {}),
    },
    wrangler: {
      name: "my-pages-app",
      main: "",
      compatibility_date: "2026-10-10",
      r2_buckets: [],
      crons: [],
    },
    targetKind: "pages",
  };
}

function snapshot(projectExists: boolean): TargetSnapshot {
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
    pagesProjectExists: projectExists,
    pagesActiveDeploymentId: projectExists ? "deployment-id-1" : undefined,
  } as TargetSnapshot;
}

const PAGES_SPEC = spec({ projectName: "my-pages-app" });

describe("pages asset hash + manifest", () => {
  it("computes the BLAKE3(base64(contents)+extension) 32-hex Pages upload hash", () => {
    const contents = new TextEncoder().encode("<!doctype html>");
    // `index.html` -> extension "html", no dot.
    const hash = pagesAssetHash("index.html", contents);
    // Independently pinned using Wrangler's Node blake3-wasm implementation:
    // hash(Buffer.from('<!doctype html>').toString('base64') + 'html').
    expect(hash).toBe("9a43f62b308ef20fc63d0b5eab6dbd1a");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    // Same bytes, same path extension -> deterministic.
    expect(pagesAssetHash("index.html", contents)).toBe(hash);
  });

  it("builds a rooted-path -> hash manifest and fails closed on duplicate paths", () => {
    const bytes = new TextEncoder().encode("<!doctype html>");
    const manifest = buildPagesManifest([
      { path: "index.html", size: bytes.length, sha256: "a".repeat(64), bytes },
    ]);
    expect(Object.keys(manifest)).toEqual(["/index.html"]);
    expect(manifest["/index.html"]).toMatch(/^[0-9a-f]{32}$/);
    expect(() =>
      buildPagesManifest([
        { path: "index.html", size: bytes.length, sha256: "a".repeat(64), bytes },
        { path: "index.html", size: bytes.length, sha256: "a".repeat(64), bytes },
      ]),
    ).toThrow(/duplicate Pages asset path/);
  });
});

describe("pages client contract", () => {
  it("creates a Pages project (POST /pages/projects) and parses the project", async () => {
    const { fn } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const project = await client.createPagesProject({ name: "my-pages-app" });
    expect(project.id).toBe("project-id-1");
    expect(project.name).toBe("my-pages-app");
    expect(project.production_branch).toBe("main");
  });

  it("gets a Pages project (GET /pages/projects/{name})", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const project = await client.getPagesProject("my-pages-app");
    expect(project.id).toBe("project-id-1");
    expect(project.domains).toContain("example.com");
    const call = log.find((l) => l.url.includes("/pages/projects/my-pages-app") && !l.url.includes("upload-token"));
    expect(call).toBeDefined();
  });

  it("resolves the upload-token JWT (GET .../upload-token)", async () => {
    const { fn } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const { jwt } = await client.getPagesUploadToken("my-pages-app");
    expect(jwt).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("creates a Pages deployment via multipart and parses the deployment", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const form = new FormData();
    form.append("manifest", JSON.stringify({ "/index.html": "a".repeat(32) }));
    const deployment = await client.createPagesDeployment("my-pages-app", form);
    expect(deployment.id).toBe("deployment-id-2");
    expect(deployment.environment).toBe("production");
    const call = log.find((l) => l.init.method === "POST" && l.url.includes("/deployments"));
    expect(call).toBeDefined();
  });

  it("lists and gets Pages deployments", async () => {
    const { fn } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const deployments = await client.listPagesDeployments("my-pages-app");
    expect(deployments).toHaveLength(1);
    const deployment = await client.getPagesDeployment("my-pages-app", "deployment-id-2");
    expect(deployment.latest_stage?.status).toBe("success");
  });
});

describe("pages deploy steps", () => {
  it("creates the project on a fresh install and preserves an existing one", async () => {
    let project = { id: "project-id", name: "my-pages-app" };
    const writes: string[] = [];
    const client = createCloudflareClient({ accessToken: "tok", fetcher: async (_input, init) => {
      if (init?.method !== "GET") {
        writes.push(init?.method ?? "GET");
        const body = JSON.parse(String(init?.body));
        expect(body.deployment_configs.production.compatibility_date).toBe("2026-10-10");
        project = { ...project, ...body };
      }
      return Response.json({ success: true, result: project });
    } }).withAccount(ACCOUNT);
    const fresh = await ensurePagesProject(client, PAGES_SPEC, snapshot(false));
    expect((fresh as { ok: boolean; result: { action: string } }).result.action).toBe("create");
    const existing = await ensurePagesProject(client, PAGES_SPEC, { ...snapshot(true), pagesProjectId: "project-id" });
    expect((existing as { ok: boolean; result: { action: string } }).result.action).toBe("preserve");
    expect(writes).toEqual(["POST"]);
  });

  it("resolves the upload JWT for the browser", async () => {
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fixtureFetcher().fn }).withAccount(ACCOUNT);
    const step = await startPagesAssetUpload(client, PAGES_SPEC);
    expect((step as { result: { jwt: string } }).result.jwt).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("creates the Pages deployment with a validated manifest", async () => {
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fixtureFetcher().fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, PAGES_SPEC, {
      manifest: { "/index.html": "a".repeat(32) },
    });
    expect((step as { result: { deploymentId: string } }).result.deploymentId).toBe("deployment-id-2");
  });

  it("rejects a malformed manifest and unsupported Pages resources", async () => {
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fixtureFetcher().fn }).withAccount(ACCOUNT);
    const bad = await createPagesDeployment(client, PAGES_SPEC, {
      manifest: { "/index.html": "not-a-hash" },
    });
    expect((bad as { ok: false; error: { kind: string } }).error.kind).toBe("invalid-manifest");
    const withCron: DeploySpec = {
      ...PAGES_SPEC,
      cloudflare: { ...PAGES_SPEC.cloudflare, cron: ["*/5 * * * *"] },
    };
    const refused = rejectUnsupportedPagesResources(withCron);
    expect(refused?.ok).toBe(false);
    expect((refused as { ok: false; error: { kind: string } }).error.kind).toBe("unsupported-pages-resource");
  });

  it("postchecks a successful deployment", async () => {
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fixtureFetcher().fn }).withAccount(ACCOUNT);
    const step = await postcheckPagesDeployment(client, PAGES_SPEC, "deployment-id-2");
    expect((step as { result: { succeeded: boolean } }).result.succeeded).toBe(true);
  });
});

// (BF-PAGES-06): the Pages deployment payload must correspond to the
// plan-approved release BEFORE any provider write. A malicious client may hold
// the correct approved planDigest (the spec below) while submitting altered
// args: extra/missing asset, changed path, arbitrary/changed 32-hex upload hash,
// or changed/missing/undeclared _worker.js bundle bytes all fail closed.
describe("pages deploy payload binding", () => {
  function uniqueSpec(overrides?: Partial<DeploySpec>): DeploySpec {
    return structuredClone({ ...PAGES_SPEC, ...overrides });
  }

  function fixtureSpec(): DeploySpec {
    const spec = uniqueSpec();
    spec.assets.forEach((a) => {
      a.pagesHash = HASH_INDEX;
    });
    return spec;
  }

  function deploymentWrites(log: { url: string; init: RequestInit }[]): number {
    return log.filter((l) => l.init.method === "POST" && l.url.includes("/deployments")).length;
  }

  it("accepts the approved static-only payload (positive)", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, fixtureSpec(), {
      manifest: { "/index.html": HASH_INDEX },
    });
    expect((step as { ok: boolean }).ok).toBe(true);
    expect((step as { result: { deploymentId: string } }).result.deploymentId).toBe("deployment-id-2");
    expect(deploymentWrites(log)).toBe(1);
  });

  it("rejects an extra asset not in the approved release (malicious)", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, fixtureSpec(), {
      manifest: { "/index.html": HASH_INDEX, "/extra.js": "c".repeat(32) },
    });
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("invalid-manifest");
    expect(deploymentWrites(log)).toBe(0);
  });

  it("rejects a missing approved asset (malicious)", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, fixtureSpec(), {
      manifest: { "/other.html": "d".repeat(32) },
    });
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("invalid-manifest");
    expect(deploymentWrites(log)).toBe(0);
  });

  it("rejects a changed path that is not in the approved asset set (malicious)", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, fixtureSpec(), {
      manifest: { "/index2.html": HASH_INDEX },
    });
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("invalid-manifest");
    expect(deploymentWrites(log)).toBe(0);
  });

  it("rejects an arbitrary/changed 32-hex upload hash for an approved path (malicious)", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, fixtureSpec(), {
      manifest: { "/index.html": "b".repeat(32) },
    });
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("invalid-manifest");
    const detail = (step as { ok: false; error: { detail: string } }).error.detail;
    expect(detail).toContain("does not match the approved release");
    expect(deploymentWrites(log)).toBe(0);
  });

  it("fails closed when an approved asset has no publisher-declared pagesHash", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const spec = uniqueSpec();
    spec.assets = [{ path: "index.html", size: 12, sha256: SHA_INDEX }];
    const step = await createPagesDeployment(client, spec, {
      manifest: { "/index.html": HASH_INDEX },
    });
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("invalid-manifest");
    expect((step as { ok: false; error: { detail: string } }).error.detail).toContain("pagesHash");
    expect(deploymentWrites(log)).toBe(0);
  });

  it("accepts the approved bundle payload and binds the decoded bytes (positive _worker.js)", async () => {
    const bundle = new TextEncoder().encode("export default { fetch() {} };");
    const sha256 = await sha256HexFromBytes(bundle);
    const spec = uniqueSpec();
    spec.workerBundle = { path: "_worker.js", size: bundle.length, sha256 };
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const check = await validatePagesDeploymentPayload(spec, {
      manifest: { "/index.html": HASH_INDEX },
      workerBundleB64: bytesToBase64(bundle),
    });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.bundleBytes).toEqual(bundle);
    }
    const step = await createPagesDeployment(client, spec, {
      manifest: { "/index.html": HASH_INDEX },
      workerBundleB64: bytesToBase64(bundle),
    });
    expect((step as { ok: boolean }).ok).toBe(true);
    expect(deploymentWrites(log)).toBe(1);
    // Exact multipart: the deployment POST carries the manifest + the
    // `_worker.bundle` file part (name + module MIME) with the approved bytes,
    // and no call in the whole log touches a Workers script/version route.
    const call = log.find((l) => l.init.method === "POST" && l.url.includes("/deployments"))!;
    expect(call.url).toContain(`/accounts/${ACCOUNT}/pages/projects/my-pages-app/deployments`);
    expect(log.every((l) => !l.url.includes("/workers/"))).toBe(true);
    const form = call.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get("manifest")))).toEqual({ "/index.html": HASH_INDEX });
    const part = form.get("_worker.bundle") as File;
    expect(part).toBeInstanceOf(Blob);
    expect(part.name).toBe("_worker.bundle");
    expect(part.type).toBe("application/javascript+module");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bundle);
  });

  it("rejects bundle bytes that differ from the approved release artifact (malicious)", async () => {
    const approved = new TextEncoder().encode("export default { fetch() { return 0; } };");
    const sha256 = await sha256HexFromBytes(approved);
    const spec = uniqueSpec();
    spec.workerBundle = { path: "_worker.js", size: approved.length, sha256 };
    const tampered = new TextEncoder().encode("export default { fetch() { throw 1; } };".padEnd(approved.length, " "));
    expect(tampered.length).toBe(approved.length);
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, spec, {
      manifest: { "/index.html": HASH_INDEX },
      workerBundleB64: bytesToBase64(tampered),
    });
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("artifact-mismatch");
    expect(deploymentWrites(log)).toBe(0);
  });

  it("rejects a bundle when the approved release declares no _worker.js", async () => {
    const bundle = new TextEncoder().encode("export default {};");
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, fixtureSpec(), {
      manifest: { "/index.html": HASH_INDEX },
      workerBundleB64: bytesToBase64(bundle),
    });
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("invalid-args");
    expect(deploymentWrites(log)).toBe(0);
  });

  it("rejects an approved _worker.js bundle that is omitted from the deploy request", async () => {
    const bundle = new TextEncoder().encode("export default { fetch() {} };");
    const sha256 = await sha256HexFromBytes(bundle);
    const spec = uniqueSpec();
    spec.workerBundle = { path: "_worker.js", size: bundle.length, sha256 };
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, spec, {
      manifest: { "/index.html": HASH_INDEX },
    });
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("invalid-args");
    expect(deploymentWrites(log)).toBe(0);
  });

  it("rejects an empty manifest when the approved release has assets", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, fixtureSpec(), { manifest: {} });
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("invalid-manifest");
    expect(deploymentWrites(log)).toBe(0);
  });

  it("allows an empty manifest only for a _worker.js-only release (no assets)", async () => {
    const bundle = new TextEncoder().encode("export default {};");
    const sha256 = await sha256HexFromBytes(bundle);
    const spec = uniqueSpec();
    spec.assets = [];
    spec.workerBundle = { path: "_worker.js", size: bundle.length, sha256 };
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, spec, {
      manifest: {},
      workerBundleB64: bytesToBase64(bundle),
    });
    expect((step as { ok: boolean }).ok).toBe(true);
    expect(deploymentWrites(log)).toBe(1);
  });

  it("keeps rejecting a malformed (non-32-hex) manifest even with a correct approved spec", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, fixtureSpec(), {
      manifest: { "/index.html": "not-a-hash" },
    });
    expect((step as { ok: false; error: { kind: string } }).error.kind).toBe("invalid-manifest");
    expect(deploymentWrites(log)).toBe(0);
  });
});

// Pages deployment control files are never static assets. `_worker.js`
// rides the separate `_worker.bundle` part; `_redirects` / `_headers` /
// `_routes.json` / `functions/` are not carried by this release, so a release or
// a browser payload that would ship one as a static file fails closed before any
// provider write instead of being silently dropped or mis-shipped.
describe("pages control-file protocol guards", () => {
  function payloadSpec(): DeploySpec {
    const clone = structuredClone(PAGES_SPEC);
    clone.assets.forEach((asset) => {
      asset.pagesHash = HASH_INDEX;
    });
    return clone;
  }

  function deploymentWrites(log: { url: string; init: RequestInit }[]): number {
    return log.filter((l) => l.init.method === "POST" && l.url.includes("/deployments")).length;
  }

  it("refuses control files at the asset-manifest root; nested names stay normal files", () => {
    const bytes = new TextEncoder().encode("x");
    for (const name of ["_worker.js", "_redirects", "_headers", "_routes.json", "functions/index.js"]) {
      expect(() =>
        buildPagesManifest(
          [{ path: `dist/${name}`, size: bytes.length, sha256: "a".repeat(64), bytes }],
          "dist",
        ),
      ).toThrow(/control file/);
    }
    const nested = buildPagesManifest(
      [{ path: "dist/blog/_redirects", size: bytes.length, sha256: "a".repeat(64), bytes }],
      "dist",
    );
    expect(Object.keys(nested)).toEqual(["/blog/_redirects"]);
  });

  it("refuses a browser manifest that declares a control path before any write", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const step = await createPagesDeployment(client, payloadSpec(), {
      manifest: { "/index.html": HASH_INDEX, "/_redirects": "e".repeat(32) },
    });
    const failed = step as { ok: false; error: { kind: string; detail: string } };
    expect(failed.ok).toBe(false);
    expect(failed.error.kind).toBe("invalid-manifest");
    expect(failed.error.detail).toContain("control");
    expect(deploymentWrites(log)).toBe(0);
  });

  it("refuses an approved release that maps an asset to a control path before any write", async () => {
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({ accessToken: "tok", fetcher: fn }).withAccount(ACCOUNT);
    const spec = payloadSpec();
    spec.wrangler.assets = { directory: "dist" };
    spec.assets = [
      { path: "dist/_worker.js", size: 12, sha256: SHA_INDEX, pagesHash: HASH_INDEX },
    ];
    const approved = approvedPagesAssets(spec);
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect(approved.detail).toContain("control");
    }
    const step = await createPagesDeployment(client, spec, {
      manifest: { "/_worker.js": HASH_INDEX },
    });
    const failed = step as { ok: false; error: { kind: string; detail: string } };
    expect(failed.ok).toBe(false);
    expect(failed.error.kind).toBe("invalid-manifest");
    expect(failed.error.detail).toContain("control");
    expect(deploymentWrites(log)).toBe(0);
  });
});
