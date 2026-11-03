// A whole upgrade, every step: the browser graph runner drives the real server
// routes against a provider mock of a live Worker. The release has the shape of
// a real app that hit each of these in turn: a Worker first deployed from Git
// (no installer marker, a static-assets binding, a root secret), a guarded R2
// Owner bootstrap with an existing Owner, an optional upgradeKeep secret the
// Worker never had, rate limits and a cron. Each step passing alone is not
// enough; the run must reach a verified postcheck, and a second upgrade from
// the state it leaves must plan cleanly.

import { afterEach, expect, it, vi } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { createApp } from "../../src/api/app.js";
import { deriveSealKey } from "../../src/auth/keys.js";
import { createSession, sessionCookieName } from "../../src/auth/session.js";
import { TAPDEPLOY_MANAGED_MARKER } from "../../src/core/planning/digest.js";
import { runGraphDeploy } from "../../src/web/graph-deploy-runner.js";
import type { GraphPlan } from "../../src/web/api.js";
import { prepareForm, sessionBinding } from "./login.js";

afterEach(() => vi.unstubAllGlobals());

const ACCOUNT = "a".repeat(32);
const ORIGIN = "https://installer.example.com";
const WORKER = "chest";
const BUCKET = "chest-data";
const enc = new TextEncoder();

const CONFIG_TEXT = JSON.stringify({
  schemaVersion: 3,
  app: { id: "example/chest", name: "Chest" },
  source: { allowLocalZip: true },
  capabilities: ["workers", "r2"],
  resources: [{ kind: "r2", name: BUCKET }],
  inputs: [{ key: "OWNER_SETUP_PASSWORD", type: "secret", label: "Owner password", required: false, upgradeKeep: true, validation: { minLength: 8 } }],
  install: { policies: [{ kind: "private-r2-owner-bootstrap/v1", unitId: "main", r2Binding: "STORAGE", rootSecret: "JWT_SECRET", armSecret: "SETUP_ARMED", armValue: "yes", ownerKey: "auth/owner.json", markerKey: "auth/bootstrap-marker", initialPasswordKey: "auth/initial-owner-password.txt", readinessPath: "/api/auth/methods" }] },
});
const RATELIMITS = [
  { name: "AUTH_LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } },
  { name: "UPLOAD_LIMITER", namespace_id: "1002", simple: { limit: 60, period: 60 } },
];
const ZIP = zipSync({
  "wrangler.jsonc": enc.encode(JSON.stringify({
    name: WORKER, main: "worker.mjs", compatibility_date: "2025-08-13", workers_dev: true,
    r2_buckets: [{ binding: "STORAGE", bucket_name: BUCKET }], ratelimits: RATELIMITS, triggers: { crons: ["0 * * * *"] },
  })),
  "worker.mjs": enc.encode("export default { fetch() { return new Response('ok'); }, scheduled() {} };"),
}, { level: 0 });

type Binding = Record<string, unknown>;
interface Version { id: string; message: string; bindings: Binding[]; runtime: Record<string, unknown> }

async function liveAccount(start: "git" | "managed") {
  const liveBindings: Binding[] = [
    ...(start === "git" ? [{ name: "ASSETS", type: "assets" }] : []),
    { name: "STORAGE", type: "r2_bucket", bucket_name: BUCKET },
    { name: "JWT_SECRET", type: "secret_text" },
    ...RATELIMITS.map((limit) => ({ ...limit, type: "ratelimit" })),
  ];
  let counter = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const world = {
    versions: [{ id: nextId(), message: start === "git" ? "Automatic deployment on Workers Builds" : `example/chest v0.9.0 ${TAPDEPLOY_MANAGED_MARKER}`, bindings: liveBindings, runtime: { compatibility_date: "2025-08-13", compatibility_flags: [] } }] as Version[],
    active: "",
    objects: new Set([`${BUCKET}/auth/owner.json`, `${BUCKET}/auth/bootstrap-marker`]),
    crons: ["0 * * * *"],
    workersDev: true,
    writes: [] as string[],
  };
  world.active = world.versions[0]!.id;
  const activeVersion = () => world.versions.find((version) => version.id === world.active)!;
  const secretNames = () => activeVersion().bindings.filter((b) => b.type === "secret_text" || b.type === "secret_key").map((b) => String(b.name));
  const ok = (result: unknown) => Response.json({ success: true, result });
  const notFound = () => Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 });
  const storeVersion = (bindings: Binding[], message: string, runtime: Record<string, unknown>) => {
    // The provider resolves `inherit` against the active version.
    const resolved = bindings.map((b) => {
      if (b.type !== "inherit") return b;
      const source = activeVersion().bindings.find((live) => live.name === b.name);
      if (!source) throw new Error(`inherit of unknown binding ${String(b.name)}`);
      return source.type === "secret_text" || source.type === "secret_key" ? { name: b.name, type: source.type } : source;
    });
    const id = nextId();
    world.versions.unshift({ id, message, bindings: resolved, runtime });
    return id;
  };
  const provider = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const path = url.pathname.replace(`/client/v4/accounts/${ACCOUNT}`, "");
    if (method !== "GET") world.writes.push(`${method} ${path}`);
    const object = /^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/.exec(path);
    if (object) {
      if (method !== "GET") return new Response(null, { status: 405 });
      const key = decodeURIComponent(object[2]!).split("/").map(decodeURIComponent).join("/");
      return world.objects.has(`${decodeURIComponent(object[1]!)}/${key}`) ? new Response("{}") : notFound();
    }
    if (path === "/r2/buckets" && method === "GET") return ok({ buckets: [{ name: BUCKET, id: "bucket-1" }] });
    if (path === `/r2/buckets/${BUCKET}` && method === "GET") return ok({ name: BUCKET, id: "bucket-1" });
    if (path.endsWith("/domains/managed") && method === "GET") return ok({ domain: `${BUCKET}.r2.dev`, enabled: false });
    if (path.endsWith("/domains/custom") && method === "GET") return ok({ domains: [] });
    if (path === "/workers/subdomain" && method === "GET") return ok({ subdomain: "example" });
    if (path === "/workers/scripts" && method === "GET") return ok([{ id: WORKER }]);
    if (path === "/workers/workers" && method === "GET") return Response.json({ success: true, result: [{ id: "worker-resource-1", name: WORKER }], result_info: { total_pages: 1 } });
    if (path === "/workers/workers/worker-resource-1" && method === "GET") return ok({ id: "worker-resource-1", name: WORKER });
    if (path === "/workers/workers/worker-resource-1/versions" && method === "POST") {
      const body = JSON.parse(String(init.body)) as { bindings?: Binding[]; annotations?: Record<string, string>; compatibility_date?: string; compatibility_flags?: string[] };
      return ok({ id: storeVersion(body.bindings ?? [], body.annotations?.["workers/message"] ?? "", { compatibility_date: body.compatibility_date, compatibility_flags: body.compatibility_flags ?? [] }) });
    }
    const script = new RegExp(`^/workers/scripts/${WORKER}(.*)$`).exec(path);
    if (script) {
      const tail = script[1]!;
      if (tail === "/versions" && method === "GET") return ok({ items: world.versions.map(({ id, message }) => ({ id, message })) });
      if (tail.startsWith("/versions/") && method === "GET") {
        const version = world.versions.find((v) => v.id === tail.slice("/versions/".length));
        return version ? ok({ id: version.id, message: version.message, resources: { bindings: version.bindings, script_runtime: version.runtime } }) : notFound();
      }
      if (tail === "/deployments") {
        if (method === "POST") world.active = (JSON.parse(String(init.body)) as { versions: Array<{ version_id: string }> }).versions[0]!.version_id;
        const deployment = { id: `deployment-${world.active}`, versions: [{ version_id: world.active, percentage: 100 }] };
        return ok(method === "GET" ? { deployments: [deployment] } : deployment);
      }
      if (tail === "/settings" && method === "GET") return ok({ bindings: activeVersion().bindings });
      if (tail === "/secrets" && method === "GET") return ok(secretNames().map((name) => ({ name, type: "secret_text" })));
      if (tail === "/schedules" && method === "GET") return ok({ schedules: world.crons.map((cron) => ({ cron })) });
      if (tail === "/subdomain" && method === "GET") return ok({ enabled: world.workersDev, previews_enabled: true });
    }
    throw new Error(`unexpected provider operation ${method} ${path}`);
  };

  const env = { RUNTIME: "node", PUBLIC_ORIGIN: ORIGIN, OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } as const;
  const app = createApp(env);
  const session = await createSession(await deriveSealKey(env.OAUTH_CLIENT_SECRET), { ttlMs: 600_000, publicOrigin: ORIGIN }, {
    accessToken: "offline-test-token", tokenType: "Bearer", scope: [], source: "v3", accountId: ACCOUNT,
    ...(await sessionBinding(JSON.parse(CONFIG_TEXT))),
  });
  const cookie = { origin: ORIGIN, cookie: `${sessionCookieName(ORIGIN)}=${session.cookieValue}` };
  // The browser's same-origin calls reach the app with its session cookie; the
  // app's own provider calls reach the mock.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = String(input);
    if (href.startsWith("/")) return app.request(href, { ...init, headers: { ...(init.headers as Record<string, string>), ...cookie } });
    const url = new URL(href);
    expect(url.origin).toBe("https://api.cloudflare.com");
    return provider(url, init);
  });
  return { world, activeVersion, csrf: session.payload.csrf };
}

async function upgrade(start: "git" | "managed") {
  const t = await liveAccount(start);
  const call = async (path: string, body: BodyInit, json = true) => {
    const res = await fetch(path, { method: "POST", headers: { "x-tapdeploy-csrf": t.csrf, ...(json ? { "content-type": "application/json" } : {}) }, body });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const prepared = await call("/api/deploy/prepare", prepareForm(CONFIG_TEXT, ZIP), false);
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const plan = (takeoverConfirmed: boolean) => call("/api/deploy/plan", JSON.stringify({
    accountId: ACCOUNT, releaseProof: prepared.body.releaseProof, config: { text: CONFIG_TEXT }, mode: "upgrade", paidRiskConfirmed: false,
    ...(takeoverConfirmed ? { takeoverConfirmed: true } : {}),
  }));
  return { ...t, plan };
}

const files = unzipSync(ZIP);
const source = {
  blob: new Blob([ZIP]),
  label: "chest.zip",
  access: {
    listFiles: async () => Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: "" })),
    readFile: async (path: string) => new Uint8Array(files[path]!),
  },
} as never;

async function deploy(t: Awaited<ReturnType<typeof upgrade>>, planned: { body: Record<string, unknown> }) {
  const writesBefore = t.world.writes.length;
  const result = await runGraphDeploy({
    csrf: t.csrf, accountId: ACCOUNT, source, configText: CONFIG_TEXT,
    releaseProof: undefined, graphPlan: planned.body.graphPlan as GraphPlan, executionContext: planned.body.executionContext,
    approval: planned.body.approval, bundleDigests: planned.body.bundleDigests as Record<string, string>, schedulerHints: planned.body.schedulerHints,
    secretValues: {},
  });
  return { result, writes: t.world.writes.slice(writesBefore) };
}

const diffsOf = (planned: { body: Record<string, unknown> }) =>
  (planned.body.graphPlan as GraphPlan).units.flatMap((unit) => unit.diffs.map((d) => `${unit.unitId} ${d.resource} ${d.action}${d.name ? ` ${d.name}` : ""}`));

it("takes over a Git-deployed Worker and upgrades it through a verified postcheck", async () => {
  const t = await upgrade("git");
  const unconfirmed = await t.plan(false);
  expect((unconfirmed.body.graphPlan as GraphPlan).blocked).toBe(true);
  expect((unconfirmed.body.graphPlan as GraphPlan).takeover).toEqual({ workers: [WORKER], confirmed: false });
  const planned = await t.plan(true);
  const graphPlan = planned.body.graphPlan as GraphPlan;
  expect(graphPlan.blocked, JSON.stringify(graphPlan)).toBe(false);
  expect(diffsOf(planned)).toEqual(expect.arrayContaining([`main worker update ${WORKER}`, "main secret skip OWNER_SETUP_PASSWORD", `main r2 preserve ${BUCKET}`]));

  const { result, writes } = await deploy(t, planned);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, urls: [`https://${WORKER}.example.workers.dev/`] });
  // One version upload and one cutover: nothing else in the account changes.
  expect(writes).toEqual(["POST /workers/workers/worker-resource-1/versions", `POST /workers/scripts/${WORKER}/deployments`]);
  const live = t.activeVersion();
  expect(live.message).toContain(TAPDEPLOY_MANAGED_MARKER);
  expect(live.bindings.map((b) => `${String(b.name)}:${String(b.type)}`).sort()).toEqual(
    ["AUTH_LIMITER:ratelimit", "JWT_SECRET:secret_text", "STORAGE:r2_bucket", "UPLOAD_LIMITER:ratelimit"],
  );
  expect(t.world.crons).toEqual(["0 * * * *"]);

  const again = await t.plan(false);
  expect((again.body.graphPlan as GraphPlan).blocked).toBe(false);
  expect((again.body.graphPlan as GraphPlan).takeover.workers).toEqual([]);
});

it("re-runs an upgrade whose earlier attempt already cut over, through a verified postcheck", async () => {
  const t = await upgrade("managed");
  const planned = await t.plan(false);
  expect((planned.body.graphPlan as GraphPlan).blocked, JSON.stringify(planned.body.graphPlan)).toBe(false);
  const { result } = await deploy(t, planned);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(t.activeVersion().bindings.some((b) => b.name === "OWNER_SETUP_PASSWORD")).toBe(false);
});
