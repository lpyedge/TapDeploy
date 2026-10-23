// prebuilt UI flow. Both ZIP sources (HTTPS URL, local file)
// converge on byte-identical prepare bodies; the plan forwards the
// server-issued proof opaquely; steps forward the sealed context/approval
// with rehashed action bytes and chained receipts; exactly one OAuth happens
// (zero here — the session is pre-authorized); the compiler is never
// involved; typed unsupported errors surface with zero step writes.
// Additions: resource-only success carries no invented address, Pages
// completes the JWT handoff with a verified address, failures name the
// stopped unit/phase with kept receipts, and the review/progress lists only
// approved actions. Provider + server-proof behavior is stubbed at the
// network layer; server authority itself is proven by
// tests/contracts/graph-e2e-hono.test.ts.

import { expect, test, type Page, type Route } from "@playwright/test";

import { buildValidZip } from "../unit/zip-builder.js";
import { graphActionsForPlan, graphPhaseForDiff, runGraphDeploy } from "../../src/web/graph-deploy-runner.js";
import {
  retainV3SourceBytes,
  v3ModuleBytes,
  v3UnitWorkerPaths,
  v3WorkerStepBytes,
} from "../../src/web/release.js";
import { doGraphStep, fetchGraphPlan, prepareReleaseZip } from "../../src/web/api.js";
import { assetUploadHash } from "../../src/cloudflare/assets/manifest.js";

const CSRF = "csrf-v3-fixture-0123456789";
const CODE = "export default { fetch() { return new Response('ok'); } };";
const WRANGLER = JSON.stringify({
  name: "api",
  main: "worker/main.mjs",
  compatibility_date: "2026-10-17",
  r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
});

const V3_CONFIG = {
  schemaVersion: 3,
  app: { id: "example/notes", name: "Notes" },
  source: { defaultUrl: "https://example.org/notes-release.zip", allowLocalZip: true },
  capabilities: ["workers", "r2"],
};
const V3_TEXT = JSON.stringify(V3_CONFIG);

function zipBytes(): Buffer {
  return Buffer.from(buildValidZip({ "wrangler.jsonc": WRANGLER, "worker/main.mjs": CODE }));
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function graphPlanBody() {
  return {
    authenticated: true,
    graphPlan: {
      ok: true,
      blocked: false,
      digest: "graph-digest",
      units: [
        {
          unitId: "main",
          kind: "worker",
          name: "api",
          requiresBundle: true,
          diffs: [
            { resource: "r2", action: "create", name: "media" },
            { resource: "worker", action: "create", name: "api" },
            { resource: "deployment", action: "create", name: "api" },
          ],
        },
      ],
      guards: [],
      cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
    },
    executionContext: "ctx-sealed",
    approval: "appr-sealed",
    bundleDigests: { main: "bd-main" },
  };
}

interface FlowMocks {
  prepareBodies: Buffer[];
  planBodies: Record<string, unknown>[];
  stepCalls: Record<string, unknown>[];
  authStarts: number;
  compilerRequests: string[];
  unexpectedApi: string[];
}

async function mockBase(page: Page, mocks: FlowMocks, sessionHash = "v3-session-config-hash"): Promise<{ accountId: string }> {
  // The session is pre-authorized; its hash is opaque to the V3 flow (the
  // server binds config identity, the browser only forwards the CSRF).
  const accountId = "a".repeat(32);
  const session = { authenticated: true, csrf: CSRF, accountId, configHash: sessionHash };
  await page.route("**/api/auth/session", (route) => json(route, session));
  await page.route("**/api/auth/start", (route) => {
    mocks.authStarts += 1;
    return json(route, { url: "https://example.org/oauth", configHash: session.configHash, scopes: [] });
  });
  await page.route("**/api/cloudflare/accounts", (route) =>
    json(route, { accounts: [{ id: accountId, name: "Acme" }] }),
  );
  // The App shell fetches target discovery on account select (V2 leftover
  // effect); the V3 flow never uses it. Stub it read-only so nothing escapes
  // to the dev proxy.
  await page.route("**/api/cloudflare/targets", (route) =>
    json(route, { accountId, workers: [], pages: [] }),
  );
  // Custom-domain discovery: no zones unless a test seeds them.
  await page.route("**/api/cloudflare/domains", (route) =>
    json(route, { accountId, zones: [], workerDomains: [], pagesDomains: {} }),
  );
  // Sealed-graph coverage probe: covered by default so the flow proceeds. A
  // changed config (different from the session's one-shot grant) must surface
  // re-authorization before any upload/plan instead of a late config_mismatch.
  await page.route("**/api/auth/check-config", (route) =>
    json(route, { ok: true, matches: true }),
  );
  // Passive observer only (never intercepts: a page.route catch-all would take
  // precedence over the mocks above and let /api calls fall through the vite
  // dev proxy). Records compiler pulls and any /api call that escaped above.
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/api/") && !url.includes("/api/auth/session") && !url.includes("/api/auth/check-config") && !url.includes("/api/cloudflare/accounts") && !url.includes("/api/cloudflare/targets") && !url.includes("/api/cloudflare/domains") && !url.includes("/api/cloudflare/hyperdrive") && !url.includes("/api/cloudflare/inventory") && !url.includes("/api/auth/start") && !url.includes("/api/deploy/prepare") && !url.includes("/api/deploy/plan") && !url.includes("/api/deploy/step") && !url.includes("/api/upload/assets")) {
      mocks.unexpectedApi.push(`${req.method()} ${url}`);
    }
    if (/\.wasm$|esbuild|compiler/i.test(url)) mocks.compilerRequests.push(url);
  });
  return { accountId };
}

async function mockV3Api(page: Page, mocks: FlowMocks, planStatus?: { status: number; body: unknown }): Promise<void> {
  await mockBase(page, mocks);
  await page.route("**/api/deploy/prepare", async (route) => {
    const req = route.request();
    const headers = req.headers();
    expect(headers["x-tapdeploy-csrf"]).toBe(CSRF);
    expect(headers["content-type"]).toContain("application/zip");
    mocks.prepareBodies.push(req.postDataBuffer() ?? Buffer.of());
    return json(route, {
      releaseProof: "proof-sealed",
      releaseSummary: { archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 2, units: [{ unitId: "main", kind: "worker", name: "api" }] },
    });
  });
  await page.route("**/api/deploy/plan", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    mocks.planBodies.push(body);
    if (planStatus) return json(route, planStatus.body, planStatus.status);
    return json(route, graphPlanBody());
  });
  await page.route("**/api/deploy/step", async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    mocks.stepCalls.push(body);
    const args = (body.args ?? {}) as Record<string, unknown>;
    const seen = new Set(((args.receipts ?? []) as unknown[]).map(String));
    const phase = String(body.phase ?? "");
    if (phase === "create-r2-buckets") {
      return json(route, { ok: true, result: {}, phaseReceipt: "r-r2" });
    }
    if (phase === "create-worker") {
      if (!seen.has("r-r2")) return json(route, { error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
      expect(body.executionContext).toBe("ctx-sealed");
      expect(body.approval).toBe("appr-sealed");
      expect(body.bundleDigest).toBe("bd-main");
      expect(Buffer.from(String((args as Record<string, unknown>).scriptB64), "base64").toString()).toBe(CODE);
      return json(route, { ok: true, result: { versionId: "v-1" }, phaseReceipt: "r-worker" });
    }
    if (phase === "activate") {
      if (!seen.has("r-worker") || (args as Record<string, unknown>).versionId !== "v-1") {
        return json(route, { error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
      }
      // The real server returns the Workers deployment id here; the driver
      // must not mistake it for a Pages deployment (no pages-postcheck for
      // worker-kind units — that used to end every worker deploy in
      // GRAPH_PHASE_MISMATCH).
      return json(route, { ok: true, result: { deploymentId: "dep-worker-1" }, phaseReceipt: "r-active" });
    }
    if (phase === "postcheck") {
      if (!seen.has("r-active")) return json(route, { error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
      return json(route, { ok: true, result: { deployed: true }, phaseReceipt: "r-post" });
    }
    return json(route, { error: "GRAPH_PHASE_MISMATCH" }, 409);
  });
}

async function pasteV3Config(page: Page, text: string = V3_TEXT): Promise<void> {
  await expect(page.getByTestId("config-step")).toBeVisible();
  await page.getByTestId("config-input").fill(text);
  await page.getByTestId("config-go").click();
  await expect(page.getByTestId("v3-flow")).toBeVisible();
}

function newMocks(): FlowMocks {
  return { prepareBodies: [], planBodies: [], stepCalls: [], authStarts: 0, compilerRequests: [], unexpectedApi: [] };
}

test.describe("prebuilt UI flow", () => {
  test("local ZIP reaches prepare bytes, proof-forwarded plan, and receipt-chained steps", async ({ page }) => {
    const mocks = newMocks();
    const zip = zipBytes();
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zip });
    await expect(page.getByTestId("v3-prepare")).toBeEnabled();
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    // Install-new worker name is always editable, prefilled from the release.
    await expect(page.getByTestId("v3-input-workerName")).toHaveValue("api");
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    // The review names exactly the approved diffs: no static 20-step spam.
    await expect(page.locator('[data-testid="v3-plan-review"] [data-diff="r2:create:media"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="v3-plan-review"] [data-diff="worker:create:api"]')).toHaveCount(1);
    await expect(page.getByTestId("v3-plan-review")).not.toContainText("register-assets");
    await expect(page.getByTestId("v3-plan-review")).not.toContainText("complete-assets");
    await expect(page.getByTestId("v3-plan-review")).not.toContainText("create-version");
    // The browser forwarded the server-issued proof opaquely, not a browser hash.
    expect(mocks.planBodies).toHaveLength(1);
    expect((mocks.planBodies[0] as Record<string, unknown>).releaseProof).toBe("proof-sealed");
    expect(((mocks.planBodies[0] as Record<string, unknown>).config as Record<string, unknown>).text).toBe(V3_TEXT);
    await page.getByTestId("v3-confirm-deploy").click();
    await expect(page.getByTestId("v3-result")).toContainText("Deployment succeeded");
    await expect(page.getByTestId("v3-result-no-url")).toBeVisible();
    await expect(page.getByTestId("v3-result-dashboard")).toHaveAttribute("href", /dash\.cloudflare\.com\/a{32}\/workers\/services\/view\/api/);
    // Exact prepare bytes, dependency retries, single OAuth, no compiler.
    expect(mocks.prepareBodies).toHaveLength(1);
    expect(mocks.prepareBodies[0]?.equals(zip)).toBe(true);
    const workerCalls = mocks.stepCalls.filter((call) => (call as Record<string, unknown>).phase === "create-worker");
    expect(workerCalls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.authStarts).toBe(0);
    expect(mocks.compilerRequests).toEqual([]);
    expect(mocks.unexpectedApi).toEqual([]);
    // One row per deployed item: the R2 bucket and the Worker (whose row covers
    // upload, activation and the postcheck).
    await expect(page.getByTestId("v3-status-main-r2-media")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("v3-status-main")).toHaveAttribute("data-state", "done");
    await expect(page.locator('[data-testid^="v3-status-"]')).toHaveCount(2);
    await expect(page.getByTestId("v3-status-main")).toContainText("verified");
    // A worker activate returns a Workers deployment id; the driver must never
    // route it into a Pages postcheck.
    const pagesPostchecks = mocks.stepCalls.filter((call) => (call as Record<string, unknown>).phase === "pages-postcheck");
    expect(pagesPostchecks).toEqual([]);
  });

  test("URL ZIP converges on identical prepare bytes", async ({ page }) => {
    const mocks = newMocks();
    const zip = zipBytes();
    await mockV3Api(page, mocks);
    await page.route("https://example.org/notes-release.zip", (route) =>
      route.fulfill({ status: 200, contentType: "application/zip", body: zip }),
    );
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-asset-url").fill("https://example.org/notes-release.zip");
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await expect(page.getByTestId("v3-input-workerName")).toHaveValue("api");
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect(mocks.prepareBodies).toHaveLength(1);
    expect(mocks.prepareBodies[0]?.equals(zip)).toBe(true);
    expect(mocks.authStarts).toBe(0);
    expect(mocks.compilerRequests).toEqual([]);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("release source is single-select: URL or file, prepare gated", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    // URL mode with an empty address keeps Prepare disabled.
    await page.getByTestId("v3-asset-url").fill("");
    await expect(page.getByTestId("v3-prepare")).toBeDisabled();
    // File mode without a chosen file keeps Prepare disabled too.
    await page.getByTestId("v3-source-file-mode").check();
    await expect(page.getByTestId("v3-prepare")).toBeDisabled();
    expect(mocks.prepareBodies).toEqual([]);
    expect(mocks.planBodies).toEqual([]);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("configure prefills the worker name and seals the operator edit plus upgrade intent", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    // Prepare reports the sealed release name so configure can prefill it.
    await page.unroute("**/api/deploy/prepare");
    await page.route("**/api/deploy/prepare", (route) =>
      json(route, {
        releaseProof: "proof-sealed",
        releaseSummary: { archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 2, units: [{ unitId: "main", kind: "worker", name: "release-fixed" }] },
      }),
    );
    const config = JSON.stringify({
      schemaVersion: 3,
      app: { id: "example/renamed", name: "Renamed" },
      source: { allowLocalZip: true },
      capabilities: ["workers"],
      inputs: [{ key: "workerName", type: "string", label: "Worker name", requiredWhen: "install", validation: { minLength: 3, maxLength: 63, pattern: "^[a-z0-9-]+$" } }],
    });
    await page.goto("/");
    await pasteV3Config(page, config);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    // Prefilled from the sealed release; the operator may still edit it.
    await expect(page.getByTestId("v3-input-workerName")).toHaveValue("release-fixed");
    // An invalid edit blocks with a message and never reaches plan.
    await page.getByTestId("v3-input-workerName").fill("Bad Name!");
    await expect(page.getByTestId("v3-input-workerName-error")).toBeVisible();
    await expect(page.getByTestId("v3-to-deploy")).toBeDisabled();
    expect(mocks.planBodies).toEqual([]);
    // A valid edit plus the upgrade intent is sealed into the plan request.
    await page.getByTestId("v3-input-workerName").fill("renamed-worker");
    await page.getByTestId("v3-mode-upgrade").check();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect(mocks.planBodies).toHaveLength(1);
    expect((mocks.planBodies[0] as Record<string, unknown>).inputs).toEqual({ workerName: "renamed-worker" });
    expect((mocks.planBodies[0] as Record<string, unknown>).mode).toBe("upgrade");
    expect(mocks.unexpectedApi).toEqual([]);
  });

  // OFFLINE: API is mocked; this proves UI behaviour only, not Cloudflare.
  test("configure binds a custom domain from the account's zones and asks before replacing a live record", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/deploy/prepare");
    await page.route("**/api/deploy/prepare", (route) =>
      json(route, {
        releaseProof: "proof-sealed",
        releaseSummary: { archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 2, units: [{ unitId: "main", kind: "worker", name: "web" }] },
      }),
    );
    const domainQueries: Array<Record<string, unknown>> = [];
    await page.unroute("**/api/cloudflare/domains");
    await page.route("**/api/cloudflare/domains", (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      domainQueries.push(body);
      return json(route, {
        accountId: "a".repeat(32),
        zones: ["example.com"],
        ...(body.zone === "example.com" ? { zone: "example.com", records: [{ name: "www.example.com", type: "A", content: "192.0.2.1" }] } : {}),
        workerDomains: [],
        pagesDomains: {},
      });
    });
    await page.goto("/");
    await pasteV3Config(page, V3_TEXT);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-domains")).toBeVisible();
    await page.getByTestId("v3-domain-bind-main").check();
    await expect(page.getByTestId("v3-to-deploy")).toBeDisabled();
    await page.getByTestId("v3-domain-zone-main").selectOption("example.com");
    await page.getByTestId("v3-domain-sub-main").fill("www");
    await expect(page.getByTestId("v3-domain-preview-main")).toContainText("https://www.example.com");
    // An existing record: the operator must confirm the replacement first.
    await expect(page.getByTestId("v3-domain-confirm-replace-main")).toBeVisible();
    await expect(page.getByTestId("v3-to-deploy")).toBeDisabled();
    await page.getByTestId("v3-domain-confirm-replace-main").check();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect((mocks.planBodies[0] as Record<string, unknown>).domains).toEqual({ main: { bind: [{ hostname: "www.example.com", zone: "example.com", replaceExisting: true }] } });
    expect(domainQueries.some((query) => query.zone === "example.com")).toBe(true);
    expect(mocks.unexpectedApi).toEqual([]);
  });
  // OFFLINE: API is mocked; this proves UI behaviour only, not Cloudflare.
  test("configure can pick an existing subdomain from a dropdown, confirming the replacement", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/deploy/prepare");
    await page.route("**/api/deploy/prepare", (route) =>
      json(route, {
        releaseProof: "proof-sealed",
        releaseSummary: { archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 2, units: [{ unitId: "main", kind: "worker", name: "web" }] },
      }),
    );
    const domainQueries: Array<Record<string, unknown>> = [];
    await page.unroute("**/api/cloudflare/domains");
    await page.route("**/api/cloudflare/domains", (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      domainQueries.push(body);
      return json(route, {
        accountId: "a".repeat(32),
        zones: ["example.com"],
        ...(body.zone === "example.com" ? { zone: "example.com", records: [{ name: "www.example.com", type: "A", content: "192.0.2.1" }] } : {}),
        workerDomains: [],
        pagesDomains: {},
      });
    });
    await page.goto("/");
    await pasteV3Config(page, V3_TEXT);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-domains")).toBeVisible();
    await page.getByTestId("v3-domain-bind-main").check();
    await expect(page.getByTestId("v3-to-deploy")).toBeDisabled();
    await page.getByTestId("v3-domain-mode-existing-main").check();
    await expect(page.getByTestId("v3-domain-existing-main")).toBeDisabled();
    await page.getByTestId("v3-domain-zone-main").selectOption("example.com");
    await page.getByTestId("v3-domain-existing-main").selectOption("www");
    await expect(page.getByTestId("v3-domain-preview-main")).toContainText("https://www.example.com");
    // An existing record: the operator must confirm the replacement first.
    await expect(page.getByTestId("v3-domain-confirm-replace-main")).toBeVisible();
    await expect(page.getByTestId("v3-domain-main")).toContainText("www.example.com will be bound to this Worker; what uses it today (DNS A → 192.0.2.1) may stop working");
    await expect(page.getByTestId("v3-to-deploy")).toBeDisabled();
    await page.getByTestId("v3-domain-confirm-replace-main").check();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect((mocks.planBodies[0] as Record<string, unknown>).domains).toEqual({ main: { bind: [{ hostname: "www.example.com", zone: "example.com", replaceExisting: true }] } });
    expect(domainQueries.some((query) => query.zone === "example.com")).toBe(true);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  // OFFLINE: API is mocked; this proves UI behaviour only, not Cloudflare.
  test("the billing confirmation stays visible and checked after the confirmed plan arrives, and can be withdrawn", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/deploy/plan");
    await page.route("**/api/deploy/plan", (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      mocks.planBodies.push(body);
      const confirmed = body.paidRiskConfirmed === true;
      const envelope = graphPlanBody();
      envelope.graphPlan.cost = { operations: [{ unitId: "main", resource: "r2", action: "create", name: "media" }], requiresConfirmation: true, confirmed, blockedUnknownCost: false } as typeof envelope.graphPlan.cost;
      envelope.graphPlan.blocked = !confirmed;
      envelope.graphPlan.guards = confirmed ? [] : [{ code: "paid-risk-unconfirmed", level: "block", detail: "confirm the billable operations" }] as typeof envelope.graphPlan.guards;
      return json(route, envelope);
    });
    await page.goto("/");
    await pasteV3Config(page, V3_TEXT);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-confirm-deploy")).toBeDisabled();
    await page.getByTestId("v3-paid-confirm").check();
    await expect(page.getByTestId("v3-confirm-deploy")).toBeEnabled();
    await expect(page.getByTestId("v3-paid-confirm")).toBeVisible();
    await expect(page.getByTestId("v3-paid-confirm")).toBeChecked();
    expect(mocks.planBodies.at(-1)?.paidRiskConfirmed).toBe(true);
    await page.getByTestId("v3-paid-confirm").uncheck();
    await expect(page.getByTestId("v3-confirm-deploy")).toBeDisabled();
    expect(mocks.planBodies.at(-1)?.paidRiskConfirmed).toBe(false);
  });

  // OFFLINE: API is mocked; this proves UI behaviour only, not Cloudflare.
  test("configure requires choosing the operator's Hyperdrive configuration for each declared binding", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/deploy/prepare");
    await page.route("**/api/deploy/prepare", (route) =>
      json(route, {
        releaseProof: "proof-sealed",
        releaseSummary: { archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 2, units: [{ unitId: "main", kind: "worker", name: "web", hyperdrive: ["DB"] }] },
      }),
    );
    const hyperdriveQueries: Array<Record<string, unknown>> = [];
    await page.route("**/api/cloudflare/hyperdrive", (route) => {
      hyperdriveQueries.push(route.request().postDataJSON() as Record<string, unknown>);
      return json(route, { configs: ["prod-db", "staging-db"] });
    });
    await page.goto("/");
    await pasteV3Config(page, V3_TEXT);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-hyperdrive")).toBeVisible();
    await expect(page.getByTestId("v3-to-deploy")).toBeDisabled();
    await page.getByTestId("v3-hyperdrive-main-DB").selectOption("staging-db");
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect((mocks.planBodies[0] as Record<string, unknown>).bindings).toEqual({ main: { hyperdrive: { DB: "staging-db" } } });
    expect(hyperdriveQueries).toEqual([{ accountId: "a".repeat(32) }]);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("upgrade picks an existing worker from the account dropdown", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/cloudflare/targets");
    await page.route("**/api/cloudflare/targets", (route) =>
      json(route, { accountId: "a".repeat(32), workers: [{ name: "live-one" }, { name: "live-two" }], pages: [] }),
    );
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    // Install mode shows no dropdown; upgrade mode lists live workers.
    await expect(page.getByTestId("v3-upgrade-target")).toHaveCount(0);
    await page.getByTestId("v3-mode-upgrade").check();
    await expect(page.getByTestId("v3-upgrade-target")).toBeVisible();
    await page.getByTestId("v3-upgrade-target").selectOption("live-two");
    await expect(page.getByTestId("v3-upgrade-target")).toHaveValue("live-two");
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect(mocks.planBodies).toHaveLength(1);
    expect((mocks.planBodies[0] as Record<string, unknown>).inputs).toEqual({ workerName: "live-two" });
    expect((mocks.planBodies[0] as Record<string, unknown>).mode).toBe("upgrade");
    expect(mocks.unexpectedApi).toEqual([]);
  });

  // OFFLINE: API is mocked; this proves UI behaviour only, not Cloudflare.
  test("install names each resource (release suggestion first); upgrade keeps what the Worker binds unless switchable", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/deploy/prepare");
    await page.route("**/api/deploy/prepare", (route) =>
      json(route, {
        releaseProof: "proof-sealed",
        releaseSummary: {
          archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 2,
          units: [{ unitId: "main", kind: "worker", name: "api" }],
          resources: [
            { key: "r2:media", kind: "r2", name: "media", bindings: [{ unitId: "main", binding: "MEDIA" }] },
            { key: "r2:cache", kind: "r2", name: "cache", bindings: [{ unitId: "main", binding: "CACHE" }], switchable: true },
          ],
        },
      }),
    );
    await page.unroute("**/api/cloudflare/targets");
    await page.route("**/api/cloudflare/targets", (route) => json(route, { accountId: "a".repeat(32), workers: [{ name: "api" }], pages: [] }));
    const inventoryQueries: Array<Record<string, unknown>> = [];
    await page.route("**/api/cloudflare/inventory", (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      inventoryQueries.push(body);
      return json(route, { accountId: "a".repeat(32), names: { r2: ["live-media", "media", "live-cache"] }, ...(body.worker ? { bindings: [{ binding: "MEDIA", kind: "r2", name: "live-media" }, { binding: "CACHE", kind: "r2", name: "live-cache" }] } : {}) });
    });
    await page.goto("/");
    await pasteV3Config(page, V3_TEXT);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    // Install: editable, prefilled from the release; an existing name is reused.
    await expect(page.getByTestId("v3-name-r2-media")).toHaveValue("media");
    await expect(page.getByTestId("v3-names")).toContainText("it will be reused");
    await page.getByTestId("v3-name-r2-media").fill("photos");
    await page.getByTestId("v3-input-workerName").fill("api-two");
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect((mocks.planBodies.at(-1) as Record<string, unknown>).names).toEqual({ "r2:media": "photos" });
    // Upgrade: the Worker's binding decides, shown read-only; a resource the
    // config marks switchable stays editable, starting at today's binding.
    await page.getByTestId("v3-back-to-configure").click();
    await page.getByTestId("v3-mode-upgrade").check();
    await page.getByTestId("v3-upgrade-target").selectOption("api");
    await expect(page.getByTestId("v3-name-r2-media")).toBeDisabled();
    await expect(page.getByTestId("v3-name-r2-media")).toHaveValue("live-media");
    await expect(page.getByTestId("v3-name-r2-cache")).toBeEditable();
    await expect(page.getByTestId("v3-name-r2-cache")).toHaveValue("live-cache");
    await page.getByTestId("v3-name-r2-cache").fill("new-cache");
    await expect(page.getByTestId("v3-names")).toContainText("Will be created; the Worker switches to it.");
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect((mocks.planBodies.at(-1) as Record<string, unknown>).names).toEqual({ "r2:media": "live-media", "r2:cache": "new-cache" });
    expect(inventoryQueries.some((query) => query.worker === "api")).toBe(true);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("plan-time config refusal also routes back to re-authorization", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks, {
      status: 409,
      body: { error: "config_mismatch", detail: "the config differs" },
    });
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await page.getByTestId("v3-to-deploy").click();
    // The late 409 never strands the operator: it goes straight to sign-in.
    await expect.poll(() => mocks.authStarts, { timeout: 8000 }).toBe(1);
    expect(mocks.stepCalls).toEqual([]);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("unsupported plan error surfaces with zero step writes", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks, {
      status: 409,
      body: { error: "UNSUPPORTED_GRAPH_OPERATION", features: ["workflows"] },
    });
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-error")).toContainText("UNSUPPORTED_GRAPH_OPERATION");
    expect(mocks.stepCalls).toEqual([]);
    expect(mocks.authStarts).toBe(0);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("changed config triggers a fresh authorization on submit, before any upload or plan", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    // The session's one-shot grant covers a different config: submitting a
    // changed config goes straight to a fresh authorization — no upload,
    // no plan, no step, and no late config_mismatch.
    await page.unroute("**/api/auth/check-config");
    await page.route("**/api/auth/check-config", (route) =>
      json(route, { ok: true, matches: false, reason: "config_mismatch" }),
    );
    await page.goto("/");
    await page.getByTestId("config-input").fill(V3_TEXT);
    await page.getByTestId("config-go").click();
    // The submit redirects to Cloudflare for the new config's own consent,
    // with no intermediate Connect screen.
    await expect.poll(() => mocks.authStarts, { timeout: 8000 }).toBe(1);
    await expect(page.getByTestId("v3-flow")).toHaveCount(0);
    expect(mocks.prepareBodies).toEqual([]);
    expect(mocks.planBodies).toEqual([]);
    expect(mocks.stepCalls).toEqual([]);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("a stored config without a session goes straight to Cloudflare sign-in", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/auth/session");
    await page.route("**/api/auth/session", (route) => json(route, { authenticated: false }));
    await page.addInitScript((text) => {
      window.sessionStorage.setItem("tapdeploy.config.v3", JSON.stringify({ text, appId: "example/prebuilt", sourceLabel: "pasted config", storedAt: Date.now() }));
    }, V3_TEXT);
    await page.goto("/");
    await expect.poll(() => mocks.authStarts, { timeout: 8000 }).toBe(1);
    await expect(page.getByTestId("v3-flow")).toHaveCount(0);
    expect(mocks.prepareBodies).toEqual([]);
  });

  test("a V3 config behind a quick-link URL continues into the flow", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    const configUrl = "https://config.example.com/app.json";
    await page.route(configUrl, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: V3_TEXT }),
    );
    await page.goto(`/?config=${encodeURIComponent(configUrl)}`);
    await expect(page.getByTestId("v3-flow")).toBeVisible();
    expect(mocks.authStarts).toBe(0);
  });

  // OFFLINE: API is mocked; this proves UI behaviour only, not Cloudflare.
  test("a ?config= link without a session starts exactly one OAuth transaction and reaches no prepare, plan or step", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/auth/session");
    await page.route("**/api/auth/session", (route) => json(route, { authenticated: false }));
    const configUrl = "https://config.example.com/app.json";
    await page.route(configUrl, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: V3_TEXT }),
    );
    await page.goto(`/?config=${encodeURIComponent(configUrl)}`);
    await expect.poll(() => mocks.authStarts, { timeout: 8000 }).toBe(1);
    await page.waitForTimeout(1500);
    expect(mocks.authStarts).toBe(1);
    await expect(page.getByTestId("v3-flow")).toHaveCount(0);
    expect(mocks.prepareBodies).toEqual([]);
    expect(mocks.planBodies).toEqual([]);
    expect(mocks.stepCalls).toEqual([]);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("resource-only flow succeeds with no invented address", async ({ page }) => {
    const mocks = newMocks();
    const config = JSON.stringify({
      schemaVersion: 3,
      app: { id: "example/cache", name: "Cache" },
      source: { allowLocalZip: true },
      capabilities: ["r2", "kv"],
      units: [{ id: "resources", kind: "resources" }],
    });
    await mockBase(page, mocks);
    await page.route("**/api/deploy/prepare", (route) =>
      json(route, { releaseProof: "proof-r", releaseSummary: { archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 1 } }),
    );
    await page.route("**/api/deploy/plan", (route) =>
      json(route, {
        authenticated: true,
        graphPlan: {
          ok: true, blocked: false, digest: "g-r",
          units: [{ unitId: "resources", kind: "resource-only", name: "", requiresBundle: false, diffs: [
            { resource: "r2", action: "create", name: "media" },
            { resource: "kv", action: "create", name: "cache" },
          ] }],
          guards: [],
          cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
        },
        executionContext: "ctx-r", approval: "appr-r", bundleDigests: { resources: "bd-r" },
      }),
    );
    await page.route("**/api/deploy/step", (route) =>
      json(route, { ok: true, result: {}, phaseReceipt: `r-${String((route.request().postDataJSON() as Record<string, unknown>).phase)}` }),
    );
    await page.goto("/");
    await pasteV3Config(page, config);
    const zip = Buffer.from(buildValidZip({ "README.md": "resource release" }));
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zip });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await expect(page.getByTestId("v3-no-inputs")).toBeVisible();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    // No Worker, no website: the review names only approved resources.
    await expect(page.locator('[data-testid="v3-plan-review"] [data-diff="r2:create:media"]')).toHaveCount(1);
    await expect(page.getByTestId("v3-plan-review")).not.toContainText("worker");
    await page.getByTestId("v3-confirm-deploy").click();
    await expect(page.getByTestId("v3-result")).toContainText("Deployment succeeded");
    // Truthful result: success with receipts, but no address to open.
    await expect(page.getByTestId("v3-result")).not.toContainText("pages.dev");
    await expect(page.getByTestId("v3-result")).not.toContainText("workers.dev");
    await expect(page.getByTestId("v3-result-no-url")).toContainText("R2 bucket media");
    await expect(page.getByTestId("v3-result-dashboard")).toHaveAttribute("href", /dash\.cloudflare\.com/);
    await expect(page.getByTestId("v3-status-resources-r2-media")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("v3-status-resources-kv-cache")).toHaveAttribute("data-state", "done");
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("pages flow completes the asset handoff and shows the verified address", async ({ page }) => {
    const mocks = newMocks();
    const config = JSON.stringify({
      schemaVersion: 3,
      app: { id: "example/site", name: "Site" },
      source: { allowLocalZip: true },
      capabilities: ["pages"],
      units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }],
    });
    await mockBase(page, mocks);
    await page.route("**/api/deploy/prepare", (route) =>
      json(route, { releaseProof: "proof-p", releaseSummary: { archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 3 } }),
    );
    await page.route("**/api/deploy/plan", (route) =>
      json(route, {
        authenticated: true,
        graphPlan: {
          ok: true, blocked: false, digest: "g-p",
          units: [{ unitId: "site", kind: "pages-static", name: "site", requiresBundle: true, diffs: [
            { resource: "pages-project", action: "create", name: "site" },
            { resource: "static-assets", action: "create", name: "site" },
            { resource: "deployment", action: "create", name: "site" },
          ] }],
          guards: [],
          cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
        },
        executionContext: "ctx-p", approval: "appr-p", bundleDigests: { site: "bd-site" },
      }),
    );
    const uploaded: string[] = [];
    await page.route(/\/api\/upload\/assets/, async (route) => {
      const url = new URL(route.request().url());
      const target = url.searchParams.get("target");
      if (target === "pages-check-missing") {
        const body = route.request().postDataJSON() as { hashes?: unknown };
        uploaded.push("check-missing");
        return json(route, { result: Array.isArray(body.hashes) ? body.hashes : [] });
      }
      if (target === "pages-upload") {
        uploaded.push("upload");
        return json(route, { success: true });
      }
      uploaded.push("upsert");
      return json(route, { success: true });
    });
    await page.route("**/api/deploy/step", async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      mocks.stepCalls.push(body);
      const args = (body.args ?? {}) as Record<string, unknown>;
      const seen = new Set(((args.receipts ?? []) as unknown[]).map(String));
      const phase = String(body.phase ?? "");
      if (phase === "pages-create-project") return json(route, { ok: true, result: { id: "pages-site" }, phaseReceipt: "p-proj" });
      if (phase === "pages-register-assets") {
        if (!seen.has("p-proj")) return json(route, { error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
        return json(route, { ok: true, result: { jwt: "jwt-pages" }, phaseReceipt: "p-reg" });
      }
      if (phase === "pages-deploy") {
        if (!seen.has("p-proj") || !seen.has("p-reg")) return json(route, { error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
        const manifest = (args.manifest ?? {}) as Record<string, string>;
        expect(Object.keys(manifest).sort()).toEqual(["/app.js", "/index.html"]);
        return json(route, { ok: true, result: { deploymentId: "dep-1" }, phaseReceipt: "p-dep" });
      }
      if (phase === "pages-postcheck") {
        expect(args.deploymentId).toBe("dep-1");
        return json(route, { ok: true, result: { succeeded: true, url: "https://site.pages.dev" }, phaseReceipt: "p-post" });
      }
      return json(route, { error: "GRAPH_PHASE_MISMATCH" }, 409);
    });
    await page.goto("/");
    await pasteV3Config(page, config);
    const zip = Buffer.from(buildValidZip({
      "wrangler.jsonc": JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" }),
      "dist/index.html": "<h1>hi</h1>",
      "dist/app.js": "console.log(1)",
    }));
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zip });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await expect(page.getByTestId("v3-no-inputs")).toBeVisible();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    await page.getByTestId("v3-confirm-deploy").click();
    await expect(page.getByTestId("v3-result")).toContainText("Deployment succeeded");
    await expect(page.getByTestId("v3-result-url")).toContainText("Open site.pages.dev");
    await expect(page.getByTestId("v3-result-url")).toHaveAttribute("href", "https://site.pages.dev/");
    await expect(page.getByTestId("v3-result-dashboard")).toHaveAttribute("href", /dash\.cloudflare\.com/);
    // The browser performed the JWT handoff upload before the deployment.
    expect(uploaded).toEqual(["check-missing", "upload", "upsert"]);
    await expect(page.getByTestId("v3-status-site")).toHaveAttribute("data-state", "done");
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("failed action shows identity, receipts kept, and no silent success", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    // Fail the worker upload at the provider boundary.
    await page.unroute("**/api/deploy/step");
    await page.route("**/api/deploy/step", async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      mocks.stepCalls.push(body);
      const args = (body.args ?? {}) as Record<string, unknown>;
      const seen = new Set(((args.receipts ?? []) as unknown[]).map(String));
      const phase = String(body.phase ?? "");
      if (phase === "create-r2-buckets") return json(route, { ok: true, result: {}, phaseReceipt: "r-r2" });
      if (phase === "create-worker") {
        if (!seen.has("r-r2")) return json(route, { error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
        return json(route, { error: "upstream", upstream: "network" }, 502);
      }
      if (phase === "activate" || phase === "postcheck") {
        return json(route, { error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
      }
      return json(route, { error: "GRAPH_PHASE_MISMATCH" }, 409);
    });
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-source-file-mode").check();
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await expect(page.getByTestId("v3-input-workerName")).toHaveValue("api");
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    await page.getByTestId("v3-confirm-deploy").click();
    await expect(page.getByTestId("v3-result")).toContainText("Deployment did not complete");
    await expect(page.getByTestId("v3-failed-action")).toContainText("Upload Worker code (api)");
    await expect(page.getByTestId("v3-result")).toContainText("1 verified receipts");
    await expect(page.getByTestId("v3-result")).not.toContainText("Deployment succeeded");
    expect(mocks.authStarts).toBe(0);
  });
});

test.describe("bridge contracts (no browser)", () => {
  test("phase mapping is exact and fail-closed", () => {
    expect(graphPhaseForDiff("worker", "r2", "create")).toBe("create-r2-buckets");
    expect(graphPhaseForDiff("worker", "worker", "create")).toBe("create-worker");
    expect(graphPhaseForDiff("worker", "worker", "update")).toBe("create-version");
    expect(graphPhaseForDiff("worker", "deployment", "create")).toBe("activate");
    expect(graphPhaseForDiff("worker", "schedule", "create")).toBe("reconcile-schedules");
    // one worker static-assets action addresses the sealed register +
    // complete pair (first phase returned; the driver executes both inline).
    expect(graphPhaseForDiff("worker", "static-assets", "create")).toBe("register-assets");
    expect(graphPhaseForDiff("worker", "static-assets", "update")).toBe("register-assets");
    // one worker workers-dev action addresses the provider-verified
    // publish step (first phase returned; the driver executes it inline).
    expect(graphPhaseForDiff("worker", "workers-dev", "create")).toBe("publish-workers-dev");
    expect(graphPhaseForDiff("pages-static", "pages-project", "create")).toBe("pages-create-project");
    expect(graphPhaseForDiff("pages-static", "static-assets", "update")).toBe("pages-register-assets");
    expect(graphPhaseForDiff("pages-static", "deployment", "create")).toBe("pages-deploy");
    for (const [kind, resource, action] of [
      ["worker", "worker", "conflict"],
      ["worker", "hyperdrive", "update"],
      ["worker", "r2", "update"],
      ["pages-static", "deployment", "update"],
      ["worker", "mystery", "create"],
    ] as const) {
      expect(() => graphPhaseForDiff(kind, resource, action)).toThrow();
    }
  });

  test("plan expansion skips preserve and addresses every safe diff", () => {
    const actions = graphActionsForPlan({
      ok: true,
      blocked: false,
      digest: "d",
      units: [
        {
          unitId: "main",
          kind: "worker",
          name: "api",
          requiresBundle: true,
          diffs: [
            { resource: "r2", action: "create", name: "media" },
            { resource: "worker", action: "preserve", name: "api" },
            { resource: "worker", action: "create", name: "api" },
          ],
        },
      ],
      guards: [],
      cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
    });
    expect(actions.map((action) => action.phase)).toEqual(["create-r2-buckets", "create-worker"]);
    expect(actions[1]?.actionId).toContain("api");
    expect(actions[1]?.actionId).not.toBe(actions[0]?.actionId);
  });

  test("plan expansion refuses unsafe actions before any dispatch", () => {
    expect(() =>
      graphActionsForPlan({
        ok: true,
        blocked: false,
        digest: "d",
        units: [{ unitId: "m", kind: "worker", name: "w", requiresBundle: false, diffs: [{ resource: "worker", action: "detach", name: "w" }] }],
        guards: [],
        cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
      }),
    ).toThrow(/not safely dispatchable/);
  });

  test("retained bytes round-trip and re-encode exactly", async () => {
    const bytes = buildValidZip({ "wrangler.jsonc": WRANGLER, "worker/main.mjs": CODE });
    const source = await retainV3SourceBytes(bytes, "release.zip");
    expect(source.bytes).not.toBe(bytes);
    expect(Array.from(source.bytes)).toEqual(Array.from(bytes));
    expect(new TextDecoder().decode(v3ModuleBytes(source, "worker/main.mjs"))).toBe(CODE);
    expect(() => v3ModuleBytes(source, "worker/missing.mjs")).toThrow();
    const paths = v3UnitWorkerPaths(source, "wrangler.jsonc");
    expect(paths.main).toBe("worker/main.mjs");
    expect(paths.extras).toEqual([]);
    const step = v3WorkerStepBytes(source, paths.main, paths.extras);
    expect(Buffer.from(step.scriptB64, "base64").toString()).toBe(CODE);
    expect(step.additionalModules).toEqual([]);
  });

  test("clients send exact shapes and surface typed errors", async () => {
    const realFetch = globalThis.fetch;
    const seen: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      const url = String(input);
      if (url.endsWith("/api/deploy/prepare")) {
        return Response.json({ releaseProof: "p", releaseSummary: { archiveSha256: "a", manifestDigest: "b", entryCount: 1 } });
      }
      if (url.endsWith("/api/deploy/plan")) return Response.json({ error: "UNSUPPORTED_GRAPH_OPERATION" }, { status: 409 });
      return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
    }) as typeof fetch;
    try {
      const prepared = await prepareReleaseZip("csrf-x", new Uint8Array([1, 2, 3]));
      expect(prepared.releaseProof).toBe("p");
      expect(seen[0]?.url).toBe("/api/deploy/prepare");
      expect((seen[0]?.init.headers as Record<string, string>)["Content-Type"]).toBe("application/zip");
      expect((seen[0]?.init.headers as Record<string, string>)["x-tapdeploy-csrf"]).toBe("csrf-x");
      expect(Array.from(seen[0]?.init.body as Uint8Array)).toEqual([1, 2, 3]);
      // Non-2xx responses surface as typed failures, never silent fallbacks.
      await expect(fetchGraphPlan("csrf-x", { accountId: "a", releaseProof: "p", config: { text: V3_TEXT } })).rejects.toMatchObject({ kind: "UNSUPPORTED_GRAPH_OPERATION", status: 409 });
      await expect(doGraphStep("csrf-x", { accountId: "a", executionContext: "c", approval: "x", unitId: "m", actionId: "act", phase: "activate", step: "activate" })).rejects.toMatchObject({ kind: "GRAPH_DEPENDENCY_REQUIRED", status: 409 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("driver completes worker+r2 with dependency retries and exact version cutover", async () => {
    const bytes = buildValidZip({ "wrangler.jsonc": WRANGLER, "worker/main.mjs": CODE });
    const source = await retainV3SourceBytes(bytes, "release.zip");
    const phases: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String((init as RequestInit & { body?: string }).body)) as Record<string, unknown>;
      const args = (body.args ?? {}) as Record<string, unknown>;
      const seen = new Set(((args.receipts ?? []) as unknown[]).map(String));
      const phase = String(body.phase ?? "");
      phases.push(phase);
      if (phase === "create-r2-buckets") return Response.json({ ok: true, result: {}, phaseReceipt: "r-r2" });
      if (phase === "create-worker") {
        if (!seen.has("r-r2")) return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
        expect(body.bundleDigest).toBe("bd-main");
        expect(Buffer.from(String(args.scriptB64), "base64").toString()).toBe(CODE);
        return Response.json({ ok: true, result: { versionId: "v-1" }, phaseReceipt: "r-worker" });
      }
      if (phase === "activate") {
        if (!seen.has("r-worker") || args.versionId !== "v-1") return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
        return Response.json({ ok: true, result: {}, phaseReceipt: "r-active" });
      }
      if (phase === "postcheck") {
        if (!seen.has("r-active")) return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
        return Response.json({ ok: true, result: { deployed: true }, phaseReceipt: "r-post" });
      }
      return Response.json({ error: "GRAPH_PHASE_MISMATCH" }, { status: 409 });
    }) as typeof fetch;
    try {
      const statuses: string[] = [];
      const out = await runGraphDeploy({
        csrf: "c",
        accountId: "a",
        source,
        configText: JSON.stringify({ schemaVersion: 3, app: { id: "x", name: "X" }, source: {}, capabilities: ["workers", "r2"] }),
        releaseProof: "p",
        graphPlan: {
          ok: true, blocked: false, digest: "g",
          units: [{ unitId: "main", kind: "worker", name: "api", requiresBundle: true, diffs: [
            { resource: "r2", action: "create", name: "media" },
            { resource: "worker", action: "create", name: "api" },
            { resource: "deployment", action: "create", name: "api" },
          ] }],
          guards: [],
          cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
        },
        executionContext: "ctx",
        approval: "appr",
        bundleDigests: { main: "bd-main" },
        onStep: (status) => statuses.push(`${status.phase}:${status.state}`),
      });
      expect(out.ok).toBe(true);
      expect(out.receipts).toHaveLength(4);
      expect(phases.filter((phase) => phase === "create-worker")).toHaveLength(2);
      expect(statuses.filter((status) => status.endsWith(":done"))).toHaveLength(4);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("driver completes worker+assets pair with dependency retries and exact version cutover", async () => {
    const WRANGLER_ASSETS = JSON.stringify({
      name: "api",
      main: "worker/main.mjs",
      compatibility_date: "2026-10-17",
      assets: { directory: "public" },
    });
    const bytes = buildValidZip({
      "wrangler.jsonc": WRANGLER_ASSETS,
      "worker/main.mjs": CODE,
      "public/index.html": "<h1>hi</h1>",
      "public/app.js": "console.log(1)",
    });
    const source = await retainV3SourceBytes(bytes, "release.zip");
    const phases: string[] = [];
    const seenAssetJwt: unknown[] = [];
    // The stub registers the exact approved hashes of the retained source, so
    // the driver's upload leg exercises the real rehash-and-upload path.
    const approvedBuckets = [[
      await assetUploadHash("/index.html", new TextEncoder().encode("<h1>hi</h1>")),
      await assetUploadHash("/app.js", new TextEncoder().encode("console.log(1)")),
    ]];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/upload/assets")) {
        return Response.json({ ok: true, result: {} });
      }
      const body = JSON.parse(String((init as RequestInit & { body?: string }).body)) as Record<string, unknown>;
      const args = (body.args ?? {}) as Record<string, unknown>;
      const seen = new Set(((args.receipts ?? []) as unknown[]).map(String));
      const phase = String(body.phase ?? "");
      phases.push(phase);
      if (phase === "register-assets") {
        expect(body.unitId).toBe("main");
        return Response.json({ ok: true, result: { jwt: "sess-1", buckets: approvedBuckets }, phaseReceipt: "r-assets-reg" });
      }
      if (phase === "complete-assets") {
        if (!seen.has("r-assets-reg")) return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
        return Response.json({ ok: true, result: { jwt: "completion-1" }, phaseReceipt: "r-assets-comp" });
      }
      if (phase === "create-worker") {
        if (!seen.has("r-assets-comp")) return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
        seenAssetJwt.push(args.assetJwt);
        expect(args.assetJwt).toBe("completion-1");
        expect(Buffer.from(String(args.scriptB64), "base64").toString()).toBe(CODE);
        return Response.json({ ok: true, result: { versionId: "v-1" }, phaseReceipt: "r-worker" });
      }
      if (phase === "activate") {
        if (!seen.has("r-worker") || args.versionId !== "v-1") return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
        return Response.json({ ok: true, result: {}, phaseReceipt: "r-active" });
      }
      if (phase === "postcheck") {
        if (!seen.has("r-active")) return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
        return Response.json({ ok: true, result: { deployed: true }, phaseReceipt: "r-post" });
      }
      return Response.json({ error: "GRAPH_PHASE_MISMATCH" }, { status: 409 });
    }) as typeof fetch;
    try {
      const statuses: string[] = [];
      const out = await runGraphDeploy({
        csrf: "c",
        accountId: "a".repeat(32),
        source,
        configText: JSON.stringify({ schemaVersion: 3, app: { id: "x", name: "X" }, source: {}, capabilities: ["workers"] }),
        releaseProof: "p",
        graphPlan: {
          ok: true, blocked: false, digest: "g",
          units: [{ unitId: "main", kind: "worker", name: "api", requiresBundle: true, diffs: [
            { resource: "static-assets", action: "create", name: "api" },
            { resource: "worker", action: "create", name: "api" },
            { resource: "deployment", action: "create", name: "api" },
          ] }],
          guards: [],
          cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
        },
        executionContext: "ctx",
        approval: "appr",
        bundleDigests: { main: "bd-main" },
        onStep: (status) => statuses.push(`${status.phase}:${status.state}`),
      });
      expect(out.ok).toBe(true);
      // register + complete + worker + activate + postcheck receipts.
      expect(out.receipts).toHaveLength(5);
      expect(seenAssetJwt).toEqual(["completion-1"]);
      expect(statuses.filter((status) => status.endsWith(":done"))).toHaveLength(4);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("driver publishes workers.dev only from a verified provider result", async () => {
    const bytes = buildValidZip({ "wrangler.jsonc": WRANGLER, "worker/main.mjs": CODE });
    const source = await retainV3SourceBytes(bytes, "release.zip");
    const seenPublish: unknown[] = [];
    const realFetch = globalThis.fetch;
    const runWith = async (publishResult: Record<string, unknown>, extraDiffs: Array<{ resource: string; action: string; name: string }> = []) => {
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String((init as RequestInit & { body?: string }).body)) as Record<string, unknown>;
        const args = (body.args ?? {}) as Record<string, unknown>;
        const seen = new Set(((args.receipts ?? []) as unknown[]).map(String));
        const phase = String(body.phase ?? "");
        if (phase === "create-worker") {
          expect(body.bundleDigest).toBe("bd-main");
          // A url on any other step (e.g. a Pages deployment's hash address) is never the workers.dev address.
          return Response.json({ ok: true, result: { versionId: "v-1", url: "https://1a2b3c4d.other.pages.dev" }, phaseReceipt: "r-worker" });
        }
        if (phase === "activate") {
          if (!seen.has("r-worker") || args.versionId !== "v-1") return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
          // Real-server shape: a Workers deployment id that must never route
          // into a Pages postcheck for this worker-kind unit.
          return Response.json({ ok: true, result: { deploymentId: "dep-worker-1" }, phaseReceipt: "r-active" });
        }
        if (phase === "publish-workers-dev") {
          if (!seen.has("r-active")) return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
          seenPublish.push(args.publish);
          expect(args.publish).toBe(true);
          return Response.json({ ok: true, result: publishResult, phaseReceipt: "r-publish" });
        }
        if (phase === "postcheck") {
          if (!seen.has("r-active")) return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
          return Response.json({ ok: true, result: { deployed: true }, phaseReceipt: "r-post" });
        }
        if (phase === "reconcile-domains") {
          if (!seen.has("r-active")) return Response.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, { status: 409 });
          return Response.json({ ok: true, result: { attached: 1 }, phaseReceipt: "r-domain" });
        }
        return Response.json({ error: "GRAPH_PHASE_MISMATCH" }, { status: 409 });
      }) as typeof fetch;
      try {
        return await runGraphDeploy({
          csrf: "c",
          accountId: "a".repeat(32),
          source,
          configText: JSON.stringify({ schemaVersion: 3, app: { id: "x", name: "X" }, source: {}, capabilities: ["workers"] }),
          releaseProof: "p",
          graphPlan: {
            ok: true, blocked: false, digest: "g",
            units: [{ unitId: "main", kind: "worker", name: "api", requiresBundle: true, diffs: [
              { resource: "worker", action: "create", name: "api" },
              { resource: "deployment", action: "create", name: "api" },
              { resource: "workers-dev", action: "create", name: "api" },
              ...extraDiffs,
            ] }],
            guards: [],
            cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
          },
          executionContext: "ctx",
          approval: "appr",
          bundleDigests: { main: "bd-main" },
          onStep: () => undefined,
        });
      } finally {
        globalThis.fetch = realFetch;
      }
    };
    // Verified provider URL surfaces; the publish ran after activation.
    const published = await runWith({ published: true, url: "https://api.myaccount.workers.dev" });
    expect(published.ok).toBe(true);
    expect(published.urls).toEqual(["https://api.myaccount.workers.dev/"]);
    expect(published.publishNote).toBeUndefined();
    expect(seenPublish).toEqual([true]);
    // Missing account subdomain: deployed with an explicit note, never a URL.
    const unpublished = await runWith({ published: false, reason: "no-account-subdomain" });
    expect(unpublished.ok).toBe(true);
    expect(unpublished.urls).toBeUndefined();
    expect(unpublished.publishNote).toContain("no workers.dev subdomain");
    // A verified custom domain is listed first, before workers.dev.
    const withDomain = await runWith({ published: true, url: "https://api.myaccount.workers.dev" }, [{ resource: "worker-custom-domain", action: "attach", name: "app.example.com" }]);
    expect(withDomain.ok).toBe(true);
    expect(withDomain.urls).toEqual(["https://app.example.com/", "https://api.myaccount.workers.dev/"]);
  });

  test("driver fails the deploy when postcheck bindings do not verify", async () => {
    const bytes = buildValidZip({ "wrangler.jsonc": WRANGLER, "worker/main.mjs": CODE });
    const source = await retainV3SourceBytes(bytes, "release.zip");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String((init as RequestInit & { body?: string }).body)) as Record<string, unknown>;
      const phase = String(body.phase ?? "");
      if (phase === "create-worker") return Response.json({ ok: true, result: { versionId: "v-1" }, phaseReceipt: "r-worker" });
      if (phase === "activate") return Response.json({ ok: true, result: {}, phaseReceipt: "r-active" });
      if (phase === "postcheck") {
        return Response.json({ ok: true, result: { deployed: true, bindingsVerified: false, bindingMismatches: ["stale binding"] }, phaseReceipt: "r-post" });
      }
      return Response.json({ error: "GRAPH_PHASE_MISMATCH" }, { status: 409 });
    }) as typeof fetch;
    try {
      const out = await runGraphDeploy({
        csrf: "c",
        accountId: "a".repeat(32),
        source,
        configText: JSON.stringify({ schemaVersion: 3, app: { id: "x", name: "X" }, source: {}, capabilities: ["workers"] }),
        releaseProof: "p",
        graphPlan: {
          ok: true, blocked: false, digest: "g",
          units: [{ unitId: "main", kind: "worker", name: "api", requiresBundle: true, diffs: [
            { resource: "worker", action: "create", name: "api" },
            { resource: "deployment", action: "create", name: "api" },
          ] }],
          guards: [],
          cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
        },
        executionContext: "ctx",
        approval: "appr",
        bundleDigests: { main: "bd-main" },
        onStep: () => undefined,
      });
      expect(out.ok).toBe(false);
      expect(out.error).toContain("bindings");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
