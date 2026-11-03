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
import { zipSync } from "fflate";
import { createHash } from "node:crypto";

import { buildValidZip } from "../unit/zip-builder.js";
import { graphActionsForPlan, runGraphDeploy } from "../../src/web/graph-deploy-runner.js";
import {
  v3ModuleBytes,
  v3UnitWorkerPaths,
  v3WorkerStepBytes,
} from "../../src/web/release.js";
import { doGraphStep, fetchGraphPlan, prepareReleaseZip } from "../../src/web/api.js";
import { retainedSource } from "../unit/retained-source.js";
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
      takeover: { workers: [], confirmed: false },
    },
    schedulerHints: { version: 1, topoOrder: ["main"], dependencies: [] },
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
  /** When set, the first R2 step waits for it so a test can act mid-deploy. */
  stepGate?: Promise<void>;
  /** When set, the plan response carries these scheduler hints. */
  schedulerHints?: unknown;
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
  // Configure discovers existing Workers in the selected account.
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
    if (url.includes("/api/") && !url.includes("/api/auth/session") && !url.includes("/api/auth/check-config") && !url.includes("/api/cloudflare/accounts") && !url.includes("/api/cloudflare/targets") && !url.includes("/api/cloudflare/domains") && !url.includes("/api/cloudflare/pages-domain-status") && !url.includes("/api/cloudflare/hyperdrive") && !url.includes("/api/cloudflare/inventory") && !url.includes("/api/auth/start") && !url.includes("/api/deploy/prepare") && !url.includes("/api/deploy/plan") && !url.includes("/api/deploy/step") && !url.includes("/api/upload/assets")) {
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
    // multipart/form-data: the authorized config text and the exact ZIP bytes.
    expect(headers["content-type"]).toContain("multipart/form-data");
    const form = await new Request("http://prepare.test", { method: "POST", headers: { "content-type": headers["content-type"]! }, body: req.postDataBuffer() ?? Buffer.of() }).formData();
    expect((JSON.parse(String(form.get("config"))) as { schemaVersion?: unknown }).schemaVersion).toBe(3);
    mocks.prepareBodies.push(Buffer.from(await (form.get("release") as Blob).arrayBuffer()));
    return json(route, {
      releaseProof: "proof-sealed",
      releaseSummary: { archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 2, units: [{ unitId: "main", kind: "worker", name: "api" }] },
    });
  });
  await page.route("**/api/deploy/plan", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    mocks.planBodies.push(body);
    if (planStatus) return json(route, planStatus.body, planStatus.status);
    return json(route, { ...graphPlanBody(), ...(mocks.schedulerHints !== undefined ? { schedulerHints: mocks.schedulerHints } : {}) });
  });
  await page.route("**/api/deploy/step", async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    mocks.stepCalls.push(body);
    const args = (body.args ?? {}) as Record<string, unknown>;
    const seen = new Set(((args.receipts ?? []) as unknown[]).map(String));
    const phase = String(body.phase ?? "");
    if (phase === "create-r2-buckets") {
      if (mocks.stepGate) await mocks.stepGate;
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

/** Optional Configure sections start collapsed: open one to reach its fields. */
async function openSection(page: Page, testId: string): Promise<void> {
  const toggle = page.getByTestId(`${testId}-toggle`);
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
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
  test("planning and deployment lock account, navigation and mutable configuration", async ({ page }) => {
    const mocks = newMocks();
    let finishPlan!: () => void;
    const planGate = new Promise<void>((resolve) => { finishPlan = resolve; });
    let finishStep!: () => void;
    mocks.stepGate = new Promise<void>((resolve) => { finishStep = resolve; });
    await mockV3Api(page, mocks);
    await page.route("**/api/cloudflare/accounts", (route) => json(route, { accounts: [
      { id: "a".repeat(32), name: "Acme" }, { id: "b".repeat(32), name: "Other account" },
    ] }));
    await page.route("**/api/deploy/plan", async (route) => {
      mocks.planBodies.push(route.request().postDataJSON());
      await planGate;
      return json(route, graphPlanBody());
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("account-select").selectOption("a".repeat(32));
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-planning")).toBeVisible();
    await expect(page.getByTestId("account-select")).toBeDisabled();
    await expect(page.getByTestId("v3-input-workerName")).toBeDisabled();
    await expect(page.getByTestId("v3-back-to-source")).toBeDisabled();
    await expect(page.getByTestId("v3-exit")).toBeDisabled();
    await expect(page.getByTestId("v3-sign-out")).toBeDisabled();
    finishPlan();
    await expect(page.getByTestId("v3-plan-review")).toContainText("Acme");
    await expect(page.getByTestId("account-select")).toBeDisabled();
    await page.getByTestId("v3-confirm-deploy").click();
    await expect(page.getByTestId("v3-stop-deploy")).toBeVisible();
    await expect(page.getByTestId("v3-exit")).toBeDisabled();
    await expect(page.getByTestId("v3-sign-out")).toHaveCount(0);
    await expect(page.getByTestId("v3-confirm-deploy")).toHaveCount(0);
    finishStep();
    await expect(page.getByTestId("v3-result")).toContainText("Deployment succeeded");
    expect(mocks.planBodies[0]?.accountId).toBe("a".repeat(32));
    expect(mocks.stepCalls.every((call) => call.accountId === "a".repeat(32))).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a new quick link takes priority over the previous tab config", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.addInitScript((text) => sessionStorage.setItem("tapdeploy.config.v3", JSON.stringify({
      text, appId: "old/app", sourceLabel: "old config", storedAt: Date.now(),
    })), V3_TEXT.replace("example/prebuilt", "old/app"));
    const configUrl = "https://config.example.com/new-app.json";
    const next = JSON.stringify({ ...JSON.parse(V3_TEXT), app: { id: "example/new-app", name: "New app" } });
    await page.route(configUrl, (route) => route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: next }));
    await page.goto(`/?config=${encodeURIComponent(configUrl)}`);
    await expect(page.locator('[data-testid="v3-flow"] h2')).toHaveText("Install New app");
    await expect(page.getByTestId("v3-flow")).toContainText(configUrl);
    expect(mocks.authStarts).toBe(0);
    await page.getByTestId("v3-exit").click();
    await expect(page.getByTestId("config-step")).toBeVisible();
    await expect(page.getByTestId("config-input")).toHaveValue("");
  });

  test("local ZIP reaches prepare bytes, proof-forwarded plan, and receipt-chained steps", async ({ page }) => {
    const mocks = newMocks();
    const zip = zipBytes();
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zip });
    await expect(page.getByTestId("v3-prepare")).toBeEnabled();
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    // The step change moves keyboard/screen-reader focus to the flow heading.
    await expect(page.locator('[data-testid="v3-flow"] h2')).toBeFocused();
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
    // Exact prepare bytes, ordered dispatch, single OAuth, no compiler.
    expect(mocks.prepareBodies).toHaveLength(1);
    expect(mocks.prepareBodies[0]?.equals(zip)).toBe(true);
    const workerCalls = mocks.stepCalls.filter((call) => (call as Record<string, unknown>).phase === "create-worker");
    expect(workerCalls).toHaveLength(1);
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

  test("release link and file share one page, prepare gated", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    // Nothing to verify yet: no link and no file keeps Verify disabled.
    await page.getByTestId("v3-asset-url").fill("");
    await expect(page.getByTestId("v3-prepare")).toBeDisabled();
    // A chosen file takes over from the link on the same page; removing it hands back to the link.
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await expect(page.getByTestId("v3-local-zip-name")).toHaveText("release.zip");
    await expect(page.getByTestId("v3-asset-url")).toBeDisabled();
    await expect(page.getByTestId("v3-prepare")).toBeEnabled();
    await expect(page.getByTestId("v3-prepare")).toContainText("Verify release.zip");
    await page.getByTestId("v3-local-zip-clear").click();
    await expect(page.getByTestId("v3-asset-url")).toBeEnabled();
    await expect(page.getByTestId("v3-prepare")).toBeDisabled();
    expect(mocks.prepareBodies).toEqual([]);
    expect(mocks.planBodies).toEqual([]);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  test("Sign out asks the server to revoke the Cloudflare sign-in and returns to the config entry", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    const logouts: Array<{ method: string; csrf: string | undefined }> = [];
    await page.route("**/api/auth/logout", (route) => {
      logouts.push({ method: route.request().method(), csrf: route.request().headers()["x-tapdeploy-csrf"] });
      return json(route, { localSessionCleared: true, providerRevocation: "confirmed" });
    });
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-sign-out").click();
    await expect(page.getByTestId("config-step")).toBeVisible();
    await expect(page.getByTestId("v3-flow")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Signed out" })).toBeVisible();
    expect(logouts).toEqual([{ method: "POST", csrf: CSRF }]);
  });

  test("sign-out warns when provider revocation is unconfirmed and forgets the local flow on reload", async ({ page }) => {
    await mockV3Api(page, newMocks());
    await page.route("**/api/auth/logout", (route) => json(route, { localSessionCleared: true, providerRevocation: "unconfirmed" }));
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-sign-out").click();
    await expect(page.getByRole("status")).toContainText("Cloudflare revocation was not confirmed");
    await expect(page.getByTestId("v3-sign-out")).toHaveCount(0);
    await page.route("**/api/auth/session", (route) => json(route, { authenticated: false }));
    await page.reload();
    await expect(page.getByTestId("config-step")).toBeVisible();
    await expect(page.getByTestId("v3-flow")).toHaveCount(0);
  });

  test("sign-out waits for confirmation and keeps retry available after failure", async ({ page }) => {
    await mockV3Api(page, newMocks());
    let finishLogout!: () => void;
    const gate = new Promise<void>((resolve) => { finishLogout = resolve; });
    await page.route("**/api/auth/logout", async (route) => {
      await gate;
      return json(route, { error: "unavailable" }, 503);
    });
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-sign-out").click();
    await expect(page.getByTestId("session-loading")).toHaveText("Signing out…");
    await expect(page.getByTestId("config-step")).toHaveCount(0);
    finishLogout();
    await expect(page.getByRole("status").filter({ hasText: "Sign-out could not be confirmed" })).toBeVisible();
    await expect(page.getByTestId("v3-sign-out")).toBeVisible();
    await page.route("**/api/auth/logout", (route) => json(route, { localSessionCleared: true, providerRevocation: "confirmed" }));
    await page.getByTestId("v3-sign-out").click();
    await expect(page.getByTestId("config-step")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Signed out" })).toBeVisible();
  });

  for (const [label, size] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 390, height: 844 }]] as const) {
    test(`cancel while the installer verifies returns to the Release step without an error (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      const mocks = newMocks();
      await mockV3Api(page, mocks);
      let held: Route | undefined;
      await page.unroute("**/api/deploy/prepare");
      await page.route("**/api/deploy/prepare", (route) => { held = route; });
      await page.goto("/");
      await pasteV3Config(page);
      await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
      await page.getByTestId("v3-prepare").click();
      await expect(page.getByTestId("v3-release-stage")).toHaveText("Verifying with the installer…");
      await expect(page.getByTestId("v3-prepare")).toBeDisabled();
      await page.getByTestId("v3-release-cancel").click();
      await expect(page.getByTestId("v3-release-stage")).toHaveText("");
      await expect(page.getByTestId("v3-release-cancel")).toHaveCount(0);
      await expect(page.getByTestId("v3-prepare")).toBeEnabled();
      await expect(page.getByTestId("v3-error")).toHaveCount(0);
      await expect(page.getByTestId("v3-configure")).toHaveCount(0);
      // The late server answer of the cancelled run must not install a release.
      await held?.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ releaseProof: "late-proof", releaseSummary: { archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 1, units: [] } }) });
      await page.waitForTimeout(100);
      await expect(page.getByTestId("v3-configure")).toHaveCount(0);
      // The chosen file is still usable: verifying again reaches Configure.
      await page.unroute("**/api/deploy/prepare");
      await page.route("**/api/deploy/prepare", (route) => json(route, { releaseProof: "proof-sealed", releaseSummary: { archiveSha256: "a".repeat(64), manifestDigest: "b".repeat(64), entryCount: 2, units: [{ unitId: "main", kind: "worker", name: "api" }] } }));
      await page.getByTestId("v3-prepare").click();
      await expect(page.getByTestId("v3-configure")).toBeVisible();
    });
  }

  test("cancel while the Worker unpacks a large ZIP leaves no stale result, and another ZIP can be chosen", async ({ page }) => {
    // ~22 MiB expanded (3 files of a 4-symbol alphabet, ~4x compressible): the Worker is busy for a visible moment.
    const symbols = (length: number, seed: number) => { let s = seed; const out = new Uint8Array(length); for (let i = 0; i < length; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = 65 + (s >>> 30); } return out; };
    const big = Buffer.from(zipSync({
      "wrangler.jsonc": new TextEncoder().encode(WRANGLER), "worker/main.mjs": new TextEncoder().encode(CODE),
      "public/p1.bin": symbols(7_000_000, 1), "public/p2.bin": symbols(7_000_000, 2), "public/p3.bin": symbols(7_000_000, 3),
    }, { level: 1 }));
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "big.zip", mimeType: "application/zip", buffer: big });
    await expect(page.getByTestId("v3-release-stage")).toHaveText("Checking the ZIP in your browser…");
    await page.getByTestId("v3-release-cancel").click();
    await expect(page.getByTestId("v3-release-stage")).toHaveText("");
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("v3-local-zip-name")).toHaveCount(0);
    await expect(page.getByTestId("v3-error")).toHaveCount(0);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "small.zip", mimeType: "application/zip", buffer: zipBytes() });
    await expect(page.getByTestId("v3-local-zip-name")).toHaveText("small.zip");
    expect(mocks.prepareBodies).toEqual([]);
  });

  const withSource = (source: Record<string, unknown>) => JSON.stringify({ ...V3_CONFIG, source: { defaultUrl: "https://example.org/notes-release.zip", ...source } });
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const CORS = { "access-control-allow-origin": "*" };

  test("a pinned SHA-256 that does not match refuses the ZIP in the browser (local file and download link), nothing is uploaded", async ({ page }) => {
    const mocks = newMocks();
    const pin = "0123456789ab".padEnd(64, "0");
    await mockV3Api(page, mocks);
    await page.route("https://example.org/notes-release.zip", (route) => route.fulfill({ status: 200, contentType: "application/zip", headers: CORS, body: zipBytes() }));
    await page.goto("/");
    await pasteV3Config(page, withSource({ allowLocalZip: true, expectedSha256: pin }));
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await expect(page.getByTestId("v3-error")).toContainText("SHA-256 does not match 0123456789ab…");
    await expect(page.getByTestId("v3-local-zip-name")).toHaveCount(0);
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-error")).toContainText("SHA-256 does not match 0123456789ab…");
    await expect(page.getByTestId("v3-configure")).toHaveCount(0);
    expect(mocks.prepareBodies).toEqual([]);
  });

  for (const via of ["file", "link"] as const) {
    test(`a matching pin lets the ZIP through from the ${via} with identical prepare bytes`, async ({ page }) => {
      const zip = zipBytes();
      const mocks = newMocks();
      await mockV3Api(page, mocks);
      await page.route("https://example.org/notes-release.zip", (route) => route.fulfill({ status: 200, contentType: "application/zip", headers: CORS, body: zip }));
      await page.goto("/");
      await pasteV3Config(page, withSource({ allowLocalZip: true, expectedSha256: sha256(zip) }));
      if (via === "file") await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zip });
      await page.getByTestId("v3-prepare").click();
      await expect(page.getByTestId("v3-configure")).toBeVisible();
      expect(mocks.prepareBodies).toHaveLength(1);
      expect(mocks.prepareBodies[0]?.equals(zip)).toBe(true);
    });
  }

  test("a download link whose ZIP is over the deployable limit is refused from its headers, without downloading it", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    const methods: string[] = [];
    await page.route("https://example.org/notes-release.zip", (route) => {
      methods.push(route.request().method());
      return route.fulfill({ status: 200, contentType: "application/zip", headers: { ...CORS, "content-length": String(8 * 1024 * 1024 + 1) }, body: "x" });
    });
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-error")).toContainText("the limit is 8.0 MiB");
    expect(methods).not.toContain("GET");
    expect(mocks.prepareBodies).toEqual([]);
  });

  test("cancel while the download link is still downloading stops it quietly", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    await page.route("https://example.org/notes-release.zip", async (route) => {
      if (route.request().method() === "HEAD") return route.fulfill({ status: 200, headers: CORS });
      started = true;
      await gate;
      return route.abort().catch(() => undefined);
    });
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-release-stage")).toHaveText("Downloading the ZIP…");
    await expect.poll(() => started).toBe(true);
    await page.getByTestId("v3-release-cancel").click();
    await expect(page.getByTestId("v3-release-stage")).toHaveText("");
    await expect(page.getByTestId("v3-prepare")).toBeEnabled();
    await expect(page.getByTestId("v3-error")).toHaveCount(0);
    release?.();
    await page.waitForTimeout(100);
    await expect(page.getByTestId("v3-configure")).toHaveCount(0);
    expect(mocks.prepareBodies).toEqual([]);
  });

  test("a config that allows only its own link hides the file chooser", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page, withSource({ allowLocalZip: false }));
    await expect(page.getByTestId("v3-asset-url")).toBeVisible();
    await expect(page.getByTestId("v3-local-zip")).toHaveCount(0);
    await expect(page.getByTestId("v3-local-zip-browse")).toHaveCount(0);
  });

  test("a ZIP over the verifiable limit is refused before it is read", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "big.zip", mimeType: "application/zip", buffer: Buffer.alloc(8 * 1024 * 1024 + 1) });
    await expect(page.getByTestId("v3-error")).toContainText("8.0 MiB");
    await expect(page.getByTestId("v3-error")).toContainText("up to 8.0 MiB");
    await expect(page.getByTestId("v3-local-zip-name")).toHaveCount(0);
    expect(mocks.prepareBodies).toEqual([]);
  });

  test("plan scheduler hints reach the driver: no early dependency probe, steps run in the order the server requires", async ({ page }) => {
    const mocks = newMocks();
    mocks.schedulerHints = { version: 1, topoOrder: ["main"], dependencies: [] };
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await page.getByTestId("v3-to-deploy").click();
    await page.getByTestId("v3-confirm-deploy").click();
    await expect(page.getByTestId("v3-result")).toContainText("Deployment succeeded");
    expect(mocks.stepCalls.map((call) => call.phase)).toEqual(["create-r2-buckets", "create-worker", "activate", "postcheck"]);
    expect(mocks.unexpectedApi).toEqual([]);
  });

  async function deployUntilFirstStepAnswers(page: Page, mocks: FlowMocks, status: number, body: unknown) {
    await mockV3Api(page, mocks);
    await page.unroute("**/api/deploy/step");
    await page.route("**/api/deploy/step", (route) => {
      mocks.stepCalls.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
      return json(route, body, status);
    });
    await page.route("https://example.org/oauth", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>oauth</title>" }));
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await page.getByTestId("v3-to-deploy").click();
    await page.getByTestId("v3-confirm-deploy").click();
  }

  test("a provider 401 mid-deploy sends the operator back to sign in for the same config and does not retry the write", async ({ page }) => {
    const mocks = newMocks();
    await deployUntilFirstStepAnswers(page, mocks, 401, { ok: false, error: "unauthorized", detail: "Cloudflare API rejected the credentials" });
    await expect.poll(() => mocks.authStarts).toBe(1);
    await expect(page).toHaveURL("https://example.org/oauth");
    // The very first step answered 401: nothing was sent after it, and it was not repeated.
    expect(mocks.stepCalls).toHaveLength(1);
  });

  test("a provider 403 (missing permission) is explained and does not loop through sign-in", async ({ page }) => {
    const mocks = newMocks();
    await deployUntilFirstStepAnswers(page, mocks, 403, { ok: false, error: "forbidden", detail: "Cloudflare API denied access" });
    await expect(page.getByTestId("v3-result")).toContainText("Cloudflare denied this action");
    await expect(page.getByTestId("v3-result")).toContainText("Signing in again will not help");
    expect(mocks.authStarts).toBe(0);
    await expect(page).not.toHaveURL(/example\.org/);
  });

  test("reloading the page keeps no ZIP and no token: the release must be chosen again", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("v3-flow")).toBeVisible();
    await expect(page.getByTestId("v3-configure")).toHaveCount(0);
    await expect(page.getByTestId("v3-local-zip-name")).toHaveCount(0);
    // Only the config's own link is offered again; the chosen file is gone and must be picked again.
    await expect(page.getByTestId("v3-prepare")).toHaveText("Verify release from link");
    const stored = await page.evaluate(async () => {
      const dump = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
      const dbs = (await indexedDB.databases?.()) ?? [];
      return { dump, databases: dbs.length };
    });
    expect(stored.dump).not.toContain("UEsDB"); // base64 of a ZIP's local-file header
    expect(stored.dump).not.toContain(CSRF);
    expect(stored.dump).not.toContain("proof-sealed");
    expect(stored.databases).toBe(0);
  });

  test("on a phone-width screen the whole install runs without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    expect(await noOverflow()).toBe(true);
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    expect(await noOverflow()).toBe(true);
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect(await noOverflow()).toBe(true);
    await page.getByTestId("v3-confirm-deploy").click();
    await expect(page.getByTestId("v3-result")).toContainText("Deployment succeeded");
    expect(await noOverflow()).toBe(true);
  });

  test("Stop holds back later actions, keeps what finished, and says nothing was rolled back", async ({ page }) => {
    const mocks = newMocks();
    let open!: () => void;
    mocks.stepGate = new Promise<void>((resolve) => { open = resolve; });
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await page.getByTestId("v3-to-deploy").click();
    await page.getByTestId("v3-confirm-deploy").click();
    await expect(page.getByTestId("v3-stop-note")).toContainText("does not undo anything already written");
    await page.getByTestId("v3-stop-deploy").click();
    await expect(page.getByTestId("v3-stop-deploy")).toBeDisabled();
    await expect(page.getByTestId("v3-stop-note")).toContainText("Stopping after the step in progress");
    open();
    await expect(page.getByTestId("v3-result")).toContainText("Deployment did not complete");
    await expect(page.getByTestId("v3-result")).toContainText("You stopped the deployment");
    await expect(page.getByTestId("v3-result")).toContainText("nothing was rolled back");
    await expect(page.getByTestId("v3-result")).toContainText("1 verified receipts");
    // Only the step in flight completed; no later action ran.
    const phases = mocks.stepCalls.map((call) => call.phase);
    expect(phases).toEqual(["create-r2-buckets"]);
    await expect(page.getByTestId("v3-stop-deploy")).toHaveCount(0);
  });

  test("a ZIP the shared verifier refuses is rejected by the browser Worker before any upload", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.goto("/");
    await pasteV3Config(page);
    const withSecret = Buffer.from(buildValidZip({ "wrangler.jsonc": WRANGLER, "worker/main.mjs": CODE, ".env": "SECRET=1" }));
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: withSecret });
    await expect(page.getByTestId("v3-error")).toContainText("INVALID_PREBUILT_ZIP");
    await expect(page.getByTestId("v3-local-zip-name")).toHaveCount(0);
    expect(mocks.prepareBodies).toEqual([]);
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
      inputs: [{ key: "workerName", type: "string", label: "Worker name", validation: { minLength: 3, maxLength: 63, pattern: "^[a-z0-9-]+$" } }],
    });
    await page.goto("/");
    await pasteV3Config(page, config);
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
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-domains")).toBeVisible();
    await expect(page.getByTestId("v3-domains-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("v3-domains-toggle")).toContainText("none");
    await openSection(page, "v3-domains");
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
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-domains")).toBeVisible();
    await expect(page.getByTestId("v3-domains-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("v3-domains-toggle")).toContainText("none");
    await openSection(page, "v3-domains");
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
  test("upgrading a Worker TapDeploy did not deploy needs the takeover confirmation, which re-plans", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/cloudflare/targets");
    await page.route("**/api/cloudflare/targets", (route) => json(route, { accountId: "a".repeat(32), workers: [{ name: "api" }], pages: [] }));
    await page.unroute("**/api/deploy/plan");
    await page.route("**/api/deploy/plan", (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      mocks.planBodies.push(body);
      const confirmed = body.takeoverConfirmed === true;
      const envelope = graphPlanBody();
      envelope.graphPlan.takeover = { workers: ["api"], confirmed } as typeof envelope.graphPlan.takeover;
      envelope.graphPlan.blocked = !confirmed;
      envelope.graphPlan.guards = confirmed ? [] : [{ code: "unit-blocked", level: "block", detail: "unit \"main\": not deployed by TapDeploy (unmanaged-worker)" }] as typeof envelope.graphPlan.guards;
      return json(route, envelope);
    });
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await page.getByTestId("v3-mode-upgrade").check();
    await page.getByTestId("v3-upgrade-target").selectOption("api");
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-takeover")).toContainText("api was deployed another way");
    await expect(page.getByTestId("v3-confirm-deploy")).toBeDisabled();
    expect(mocks.planBodies.at(-1)).not.toHaveProperty("takeoverConfirmed");
    await page.getByTestId("v3-takeover-confirm").check();
    await expect(page.getByTestId("v3-confirm-deploy")).toBeEnabled();
    await expect(page.getByTestId("v3-takeover-confirm")).toBeChecked();
    expect(mocks.planBodies.at(-1)?.takeoverConfirmed).toBe(true);
    await page.getByTestId("v3-takeover-confirm").uncheck();
    await expect(page.getByTestId("v3-confirm-deploy")).toBeDisabled();
    expect(mocks.planBodies.at(-1)).not.toHaveProperty("takeoverConfirmed");
    expect(mocks.unexpectedApi).toEqual([]);
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

  // OFFLINE: API is mocked; this proves UI behaviour only, not Cloudflare.
  test("inputs follow required / upgradeKeep per mode, validate by type, and an upgrade can change a secret", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/deploy/plan");
    await page.route("**/api/deploy/plan", (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      mocks.planBodies.push(body);
      const plan = graphPlanBody();
      if (Array.isArray(body.replaceSecrets)) plan.graphPlan.units[0]!.diffs.push({ resource: "secret", action: "update", name: "ADMIN_PASSWORD" });
      return json(route, plan);
    });
    await page.unroute("**/api/cloudflare/targets");
    await page.route("**/api/cloudflare/targets", (route) => json(route, { accountId: "a".repeat(32), workers: [{ name: "api-live" }], pages: [] }));
    const config = JSON.stringify({
      schemaVersion: 3,
      app: { id: "example/inputs", name: "Inputs" },
      source: { allowLocalZip: true },
      capabilities: ["workers", "r2"],
      inputs: [
        { key: "REGION", type: "select", label: "Region", upgradeKeep: true, options: [{ label: "Europe", value: "eu" }, "us"] },
        { key: "RETENTION_DAYS", type: "integer", label: "Retention days", validation: { minimum: 1, maximum: 30 } },
        { key: "TAGS", type: "multiselect", label: "Tags", required: false, options: [{ label: "Alpha", value: "a" }, "b"] },
        { key: "EXPIRES", type: "date", label: "Expires", required: false },
        { key: "ADMIN_PASSWORD", type: "secret", label: "Admin password", required: false, validation: { minLength: 8 } },
      ],
    });
    await page.goto("/");
    await pasteV3Config(page, config);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    // Required inputs are always shown; optional ones wait in a collapsed section. A required one blocks until valid.
    await expect(page.getByTestId("v3-secrets-change")).toHaveCount(0);
    await expect(page.getByTestId("v3-input-RETENTION_DAYS")).toBeVisible();
    await expect(page.getByTestId("v3-optional-inputs-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("v3-input-TAGS")).toBeHidden();
    await expect(page.getByTestId("v3-optional-inputs-toggle")).toContainText("0 of 2 set");
    await expect(page.getByTestId("v3-input-EXPIRES")).toHaveAttribute("type", "date");
    await expect(page.getByTestId("v3-to-deploy")).toBeDisabled();
    await page.getByTestId("v3-input-REGION").selectOption("eu");
    await page.getByTestId("v3-input-RETENTION_DAYS").fill("99");
    await expect(page.getByTestId("v3-input-RETENTION_DAYS-error")).toHaveText("at most 30");
    await page.getByTestId("v3-input-RETENTION_DAYS").fill("7");
    await openSection(page, "v3-optional-inputs");
    await page.getByTestId("v3-input-TAGS-a").check();
    await page.getByTestId("v3-input-TAGS-b").check();
    await page.getByTestId("v3-input-EXPIRES").fill("2027-02-28");
    await expect(page.getByTestId("v3-optional-inputs-toggle")).toContainText("2 of 2 set");
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect((mocks.planBodies[0] as Record<string, unknown>).inputs).toEqual({ workerName: "api", REGION: "eu", RETENTION_DAYS: "7", TAGS: "a,b", EXPIRES: "2027-02-28" });
    expect((mocks.planBodies[0] as Record<string, unknown>).replaceSecrets).toBeUndefined();
    // Upgrade: the install-only input is gone, empty optional ones keep the current value, and a secret can be chosen for change.
    await page.getByTestId("v3-back-to-configure").click();
    await page.getByTestId("v3-mode-upgrade").check();
    await page.getByTestId("v3-upgrade-target").selectOption("api-live");
    await expect(page.getByTestId("v3-input-REGION")).toHaveCount(0);
    // On upgrade nothing is required: every setting sits in the collapsed section, empty keeps the current value.
    await expect(page.getByTestId("v3-optional-inputs-toggle")).toContainText("empty keeps the current value");
    await openSection(page, "v3-optional-inputs");
    await expect(page.getByTestId("v3-input-TAGS")).toContainText("Alpha");
    await expect(page.getByTestId("v3-secrets-change")).toBeVisible();
    await page.getByTestId("v3-input-RETENTION_DAYS").fill("14");
    await page.getByTestId("v3-secret-change-ADMIN_PASSWORD").check();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    const upgradeBody = mocks.planBodies.at(-1) as Record<string, unknown>;
    expect(upgradeBody.mode).toBe("upgrade");
    expect(upgradeBody.replaceSecrets).toEqual(["ADMIN_PASSWORD"]);
    expect(upgradeBody.inputs).toMatchObject({ RETENTION_DAYS: "14", workerName: "api-live" });
    expect(upgradeBody.inputs).not.toHaveProperty("REGION");
    // The new value is asked on the review step and follows the declared rules.
    await expect(page.getByTestId("v3-secret-prompts")).toContainText("New Admin password");
    await expect(page.getByTestId("v3-confirm-deploy")).toBeDisabled();
    await page.getByTestId("v3-secret-ADMIN_PASSWORD").fill("short");
    await expect(page.getByTestId("v3-secret-ADMIN_PASSWORD-error")).toHaveText("at least 8 characters");
    await expect(page.getByTestId("v3-confirm-deploy")).toBeDisabled();
    await page.getByTestId("v3-secret-ADMIN_PASSWORD").fill("long-enough-password");
    await expect(page.getByTestId("v3-confirm-deploy")).toBeEnabled();
    expect(mocks.unexpectedApi).toEqual([]);
  });

  // OFFLINE: API is mocked; this proves UI behaviour only, not Cloudflare.
  test("upgrade: keeping, replacing and removing the bound domain are one choice", async ({ page }) => {
    const mocks = newMocks();
    await mockV3Api(page, mocks);
    await page.unroute("**/api/cloudflare/targets");
    await page.route("**/api/cloudflare/targets", (route) => json(route, { accountId: "a".repeat(32), workers: [{ name: "api" }], pages: [] }));
    await page.unroute("**/api/cloudflare/domains");
    await page.route("**/api/cloudflare/domains", (route) =>
      json(route, { accountId: "a".repeat(32), zones: ["example.com"], workerDomains: [{ hostname: "api.example.com", service: "api", zone: "example.com" }], pagesDomains: {} }),
    );
    await page.goto("/");
    await pasteV3Config(page);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await page.getByTestId("v3-mode-upgrade").check();
    await page.getByTestId("v3-upgrade-target").selectOption("api");
    await expect(page.getByTestId("v3-domains-toggle")).toContainText("1 bound today, kept");
    await openSection(page, "v3-domains");
    // Keep is the default: the bound domain is listed, nothing to bind or confirm.
    await expect(page.getByTestId("v3-domain-bound-main")).toContainText("api.example.com");
    await expect(page.getByTestId("v3-domain-stance-keep-main")).toBeChecked();
    await expect(page.getByTestId("v3-domain-bind-main")).toHaveCount(0);
    await expect(page.getByTestId("v3-domain-zone-main")).toHaveCount(0);
    // Use another instead: the bind form appears and unbinding the old one needs confirming.
    await page.getByTestId("v3-domain-stance-replace-main").check();
    await expect(page.getByTestId("v3-domain-zone-main")).toBeVisible();
    await expect(page.getByTestId("v3-domain-confirm-remove-main")).toBeVisible();
    await page.getByTestId("v3-domain-zone-main").selectOption("example.com");
    await page.getByTestId("v3-domain-sub-main").fill("new");
    await expect(page.getByTestId("v3-to-deploy")).toBeDisabled();
    await page.getByTestId("v3-domain-confirm-remove-main").check();
    await expect(page.getByTestId("v3-to-deploy")).toBeEnabled();
    // Remove: the bind form goes away, the confirmation to unbind stays.
    await page.getByTestId("v3-domain-stance-remove-main").check();
    await expect(page.getByTestId("v3-domain-zone-main")).toHaveCount(0);
    await expect(page.getByTestId("v3-domain-confirm-remove-main")).not.toBeChecked();
    await expect(page.getByTestId("v3-to-deploy")).toBeDisabled();
    await page.getByTestId("v3-domain-confirm-remove-main").check();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect((mocks.planBodies.at(-1) as Record<string, unknown>).domains).toEqual({ main: { remove: [{ hostname: "api.example.com", zone: "example.com" }] } });
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
  test("install names each resource (release suggestion first); upgrade keeps what the Worker binds unless onUpgrade is change", async ({ page }) => {
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
            { key: "r2:cache", kind: "r2", name: "cache", bindings: [{ unitId: "main", binding: "CACHE" }], changeOnUpgrade: true },
          ],
        },
      }),
    );
    await page.unroute("**/api/cloudflare/targets");
    await page.route("**/api/cloudflare/targets", (route) => json(route, { accountId: "a".repeat(32), workers: [{ name: "api" }, { name: "other-api" }], pages: [] }));
    let finishInventory!: () => void;
    const inventoryGate = new Promise<void>((resolve) => { finishInventory = resolve; });
    const inventoryQueries: Array<Record<string, unknown>> = [];
    await page.route("**/api/cloudflare/inventory", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      inventoryQueries.push(body);
      if (body.worker === "other-api") {
        await inventoryGate;
        return json(route, { accountId: "a".repeat(32), names: { r2: ["other-media", "other-cache"] }, bindings: [
          { binding: "MEDIA", kind: "r2", name: "other-media" }, { binding: "CACHE", kind: "r2", name: "other-cache" },
        ] });
      }
      return json(route, { accountId: "a".repeat(32), names: { r2: ["live-media", "media", "live-cache"] }, ...(body.worker ? { bindings: [{ binding: "MEDIA", kind: "r2", name: "live-media" }, { binding: "CACHE", kind: "r2", name: "live-cache" }] } : {}) });
    });
    await page.goto("/");
    await pasteV3Config(page, V3_TEXT);
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zipBytes() });
    await page.getByTestId("v3-prepare").click();
    // Install: collapsed with a summary; opened, editable, prefilled from the release, an existing name is reused.
    await expect(page.getByTestId("v3-names-toggle")).toContainText("suggested by the app");
    await openSection(page, "v3-names");
    await expect(page.getByTestId("v3-name-r2-media")).toHaveValue("media");
    await expect(page.getByTestId("v3-names")).toContainText("it will be reused");
    await page.getByTestId("v3-name-r2-media").fill("photos");
    await page.getByTestId("v3-input-workerName").fill("api-two");
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    expect((mocks.planBodies.at(-1) as Record<string, unknown>).names).toEqual({ "r2:media": "photos" });
    // Upgrade: the Worker's binding decides, shown read-only; a resource the
    // config marks onUpgrade change stays editable, starting at today's binding.
    await page.getByTestId("v3-back-to-configure").click();
    await page.getByTestId("v3-mode-upgrade").check();
    await page.getByTestId("v3-upgrade-target").selectOption("api");
    await expect(page.getByTestId("v3-names-toggle")).toContainText("kept as today, some can change");
    await openSection(page, "v3-names");
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
    await page.getByTestId("v3-back-to-configure").click();
    await page.getByTestId("v3-upgrade-target").selectOption("other-api");
    await expect.poll(() => inventoryQueries.some((query) => query.worker === "other-api")).toBe(true);
    await expect(page.getByTestId("v3-to-deploy")).toBeDisabled();
    await expect(page.getByTestId("v3-name-r2-media")).not.toHaveValue("live-media");
    finishInventory();
    await expect(page.getByTestId("v3-name-r2-media")).toHaveValue("other-media");
    await expect(page.getByTestId("v3-to-deploy")).toBeEnabled();
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
      units: [],
      resources: [{ kind: "r2", name: "cache-data" }, { kind: "kv", name: "cache-kv" }],
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
          takeover: { workers: [], confirmed: false },
        },
        schedulerHints: { version: 1, topoOrder: ["resources"], dependencies: [] },
        executionContext: "ctx-r", approval: "appr-r", bundleDigests: { resources: "bd-r" },
      }),
    );
    await page.route("**/api/deploy/step", (route) =>
      json(route, { ok: true, result: {}, phaseReceipt: `r-${String((route.request().postDataJSON() as Record<string, unknown>).phase)}` }),
    );
    await page.goto("/");
    await pasteV3Config(page, config);
    const zip = Buffer.from(buildValidZip({ "README.md": "resource release" }));
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

  test("pages flow completes the asset handoff, shows each address apart and watches the custom domain until it is live", async ({ page }) => {
    await page.clock.install();
    const mocks = newMocks();
    const consoleWarnings: string[] = [];
    page.on("console", (message) => { if (message.type() === "warning") consoleWarnings.push(message.text()); });
    // Cloudflare keeps a new Pages domain pending until DNS and its certificate are done.
    let domainStatus = "pending";
    const config = JSON.stringify({
      schemaVersion: 3,
      app: { id: "example/site", name: "Site" },
      source: { allowLocalZip: true },
      capabilities: ["pages"],
      units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }],
    });
    await mockBase(page, mocks);
    await page.route("**/api/cloudflare/domains", (route) =>
      json(route, { accountId: "a".repeat(32), zones: ["example.com"], workerDomains: [], pagesDomains: { site: ["www.example.com"] } }),
    );
    await page.route("**/api/cloudflare/pages-domain-status", (route) => json(route, { status: domainStatus }));
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
            { resource: "pages-custom-domain", action: "attach", name: "www.example.com" },
          ] }],
          guards: [],
          cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
          takeover: { workers: [], confirmed: false },
        },
        schedulerHints: { version: 1, topoOrder: ["site"], dependencies: [] },
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
      if (phase === "reconcile-domains") return json(route, { ok: true, result: {}, phaseReceipt: "p-domain" });
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
    await page.getByTestId("v3-local-zip").setInputFiles({ name: "release.zip", mimeType: "application/zip", buffer: zip });
    await page.getByTestId("v3-prepare").click();
    await expect(page.getByTestId("v3-configure")).toBeVisible();
    await expect(page.getByTestId("v3-no-inputs")).toBeVisible();
    await page.getByTestId("v3-to-deploy").click();
    await expect(page.getByTestId("v3-plan-review")).toBeVisible();
    await page.getByTestId("v3-confirm-deploy").click();
    await expect(page.getByTestId("v3-result")).toContainText("Deployment succeeded");
    // Each address is its own row, told apart by kind; the custom domain comes first.
    const rows = page.locator('[data-testid="v3-result-links"] > li');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Custom domain");
    await expect(page.getByTestId("v3-result-url")).toContainText("Open www.example.com");
    await expect(page.getByTestId("v3-result-url")).toHaveAttribute("href", "https://www.example.com/");
    await expect(rows.nth(1)).toContainText("Pages site");
    await expect(page.getByTestId("v3-result-url-more")).toHaveAttribute("href", "https://site.pages.dev/");
    // The domain is bound but Cloudflare is still verifying it: say so, then show it live once it is.
    await expect(page.getByTestId("v3-domain-pending")).toContainText("verifying DNS and issuing the certificate");
    await expect(page.getByTestId("v3-domain-pending")).toContainText("Cloudflare status: pending");
    domainStatus = "active";
    await page.clock.fastForward(6000);
    await expect(page.getByTestId("v3-domain-live")).toBeVisible();
    await expect(page.getByTestId("v3-domain-pending")).toHaveCount(0);
    await expect(page.getByTestId("v3-result-dashboard")).toHaveAttribute("href", /dash\.cloudflare\.com/);
    // The browser performed the JWT handoff upload before the deployment.
    expect(uploaded).toEqual(["check-missing", "upload", "upsert"]);
    // The manifest was hashed in the compute Worker with the BLAKE3 WASM (not the JS fallback).
    expect(mocks.compilerRequests.filter((url) => /blake3_js_bg.*\.wasm/.test(url))).toHaveLength(1);
    expect(consoleWarnings.filter((text) => text.includes("BLAKE3 WASM unavailable"))).toEqual([]);
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
      takeover: { workers: [], confirmed: false },
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
        takeover: { workers: [], confirmed: false },
      }),
    ).toThrow(/not safely dispatchable/);
  });

  test("retained bytes round-trip and re-encode exactly", async () => {
    const bytes = buildValidZip({ "wrangler.jsonc": WRANGLER, "worker/main.mjs": CODE });
    const source = await retainedSource(bytes, "release.zip");
    expect(Array.from(new Uint8Array(await source.blob.arrayBuffer()))).toEqual(Array.from(bytes));
    expect(new TextDecoder().decode(await v3ModuleBytes(source, "worker/main.mjs"))).toBe(CODE);
    await expect(v3ModuleBytes(source, "worker/missing.mjs")).rejects.toThrow();
    const paths = await v3UnitWorkerPaths(source, "wrangler.jsonc");
    expect(paths.main).toBe("worker/main.mjs");
    expect(paths.extras).toEqual([]);
    const step = await v3WorkerStepBytes(source, paths.main, paths.extras);
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
      const prepared = await prepareReleaseZip("csrf-x", V3_TEXT, new Blob([new Uint8Array([1, 2, 3])]));
      expect(prepared.releaseProof).toBe("p");
      expect(seen[0]?.url).toBe("/api/deploy/prepare");
      // The browser sets the multipart type (with its boundary) for the form itself.
      expect((seen[0]?.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
      expect((seen[0]?.init.headers as Record<string, string>)["x-tapdeploy-csrf"]).toBe("csrf-x");
      const form = seen[0]?.init.body as FormData;
      expect(form.get("config")).toBe(V3_TEXT);
      expect(Array.from(new Uint8Array(await (form.get("release") as Blob).arrayBuffer()))).toEqual([1, 2, 3]);
      // Non-2xx responses surface as typed failures, never silent fallbacks.
      await expect(fetchGraphPlan("csrf-x", { accountId: "a", releaseProof: "p", config: { text: V3_TEXT } })).rejects.toMatchObject({ kind: "UNSUPPORTED_GRAPH_OPERATION", status: 409 });
      await expect(doGraphStep("csrf-x", { accountId: "a", executionContext: "c", approval: "x", unitId: "m", actionId: "act", phase: "activate", step: "activate" })).rejects.toMatchObject({ kind: "GRAPH_DEPENDENCY_REQUIRED", status: 409 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("driver completes worker+r2 in dependency order with exact version cutover", async () => {
    const bytes = buildValidZip({ "wrangler.jsonc": WRANGLER, "worker/main.mjs": CODE });
    const source = await retainedSource(bytes, "release.zip");
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
          takeover: { workers: [], confirmed: false },
        },
        schedulerHints: { version: 1, topoOrder: ["main"], dependencies: [] },
        executionContext: "ctx",
        approval: "appr",
        bundleDigests: { main: "bd-main" },
        onStep: (status) => statuses.push(`${status.phase}:${status.state}`),
      });
      expect(out.ok).toBe(true);
      expect(out.receipts).toHaveLength(4);
      expect(phases.filter((phase) => phase === "create-worker")).toHaveLength(1);
      expect(statuses.filter((status) => status.endsWith(":done"))).toHaveLength(4);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("driver completes worker+assets pair in dependency order with exact version cutover", async () => {
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
    const source = await retainedSource(bytes, "release.zip");
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
          takeover: { workers: [], confirmed: false },
        },
        schedulerHints: { version: 1, topoOrder: ["main"], dependencies: [] },
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

  test("driver retains every verified workers.dev address in a multi-worker release", async () => {
    const source = await retainedSource(buildValidZip({ "wrangler.jsonc": WRANGLER, "worker/main.mjs": CODE }), "release");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.phase).toBe("publish-workers-dev");
      return Response.json({ ok: true, result: { published: true, url: `https://${body.unitId}.account.workers.dev` }, phaseReceipt: body.unitId });
    }) as typeof fetch;
    try {
      const out = await runGraphDeploy({
        csrf: "c", accountId: "a".repeat(32), source, releaseProof: "p",
        configText: JSON.stringify({ units: [{ id: "first" }, { id: "second" }] }),
        executionContext: "ctx", approval: "appr",
        schedulerHints: { version: 1, topoOrder: ["first", "second"], dependencies: [] },
        graphPlan: {
          ok: true, blocked: false, digest: "g", guards: [],
          cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
          takeover: { workers: [], confirmed: false },
          units: ["first", "second"].map((unitId) => ({ unitId, kind: "worker", name: unitId, requiresBundle: false,
            diffs: [{ resource: "workers-dev", action: "create", name: unitId }],
          })),
        },
      });
      expect(out.ok, out.error).toBe(true);
      expect(out.urls).toEqual(["https://first.account.workers.dev/", "https://second.account.workers.dev/"]);
    } finally {
      globalThis.fetch = realFetch;
      source.access.dispose();
    }
  });

  test("driver publishes workers.dev only from a verified provider result", async () => {
    const bytes = buildValidZip({ "wrangler.jsonc": WRANGLER, "worker/main.mjs": CODE });
    const source = await retainedSource(bytes, "release.zip");
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
            takeover: { workers: [], confirmed: false },
          },
          schedulerHints: { version: 1, topoOrder: ["main"], dependencies: [] },
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
    const source = await retainedSource(bytes, "release.zip");
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
          takeover: { workers: [], confirmed: false },
        },
        schedulerHints: { version: 1, topoOrder: ["main"], dependencies: [] },
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
