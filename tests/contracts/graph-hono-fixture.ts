import { expect, vi } from "vitest";
import { zipSync } from "fflate";
import { createApp, type TapDeployEnv } from "../../src/api/app.js";
import { deriveSealKey, openSeal, type SealedEnvelope } from "../../src/auth/keys.js";
import { createSession, sessionCookieName } from "../../src/auth/session.js";
import { computeConfigV3Id, type ConfigV3 } from "../../src/manifest/config-v3.js";
import type { VerifiedReleaseContext } from "../../src/core/planning/graph-execution-context.js";
import type { GraphDeployPlan } from "../../src/core/planning/plan.js";
import { graphActionId } from "../../src/core/planning/digest.js";

interface MockVersion { id: string; message: string; bindings: Record<string, unknown>[]; migrations: unknown; runtime: Record<string, unknown> }
interface MockWorker { versions: MockVersion[]; active: string; schedules: string[] }
interface MockQueueConsumer { consumer_id: string; script: string; type: "worker"; settings?: Record<string, unknown>; dead_letter_queue?: string }
// account Workflow definitions, keyed by the account-unique name.
interface MockWorkflow { id: string; name: string; className: string; scriptName: string; schedules: string[] }

// Options for tests that assert a prepare refusal: the fixture returns without
// a release/plan (accessing those fields throws a clear error).
export interface GraphHonoFixtureOptions {
  allowPrepareFailure?: boolean;
  /** Provider read-after-write lag: a new version answers 404 to this many reads first. */
  versionReadbackLag?: number;
  /** A new Pages deployment reports stage status "active" for this many reads before "success". */
  pagesDeployReadsBeforeSuccess?: number;
}

// Only the provider HTTP seam is mocked. Session authentication, ZIP parsing,
// planning, context/receipt cryptography and step dispatch use production code.
export async function graphHonoFixture(config: ConfigV3, files: Record<string, Uint8Array>, runtime: TapDeployEnv["RUNTIME"] = "node", seed: { queues?: Array<{ name: string; consumers?: Array<{ script: string; settings?: Record<string, unknown> }> }>; workflows?: Array<{ name: string; className: string; scriptName: string; schedules?: string[] }>; zones?: Array<{ id: string; name: string }>; dnsRecords?: Array<{ zoneId: string; id: string; name: string; type: string; content?: string }>; workerDomains?: Array<{ id: string; hostname: string; service: string; zone_id?: string }>; hyperdriveConfigs?: Array<{ id: string; name: string }>; vectorizeIndexes?: Array<{ name: string; dimensions: number; metric: string }>; secretsStores?: Array<{ id: string; name: string; secrets: string[] }> } = {}, options: GraphHonoFixtureOptions = {}) {
  const origin = "https://installer.example";
  const accountId = "a".repeat(32);
  const env: TapDeployEnv = { RUNTIME: runtime, PUBLIC_ORIGIN: origin, OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
  const key = await deriveSealKey(env.OAUTH_CLIENT_SECRET!);
  const session = await createSession(key, { ttlMs: 120_000, publicOrigin: origin }, {
    accessToken: "offline-test-token", tokenType: "Bearer", scope: [], source: "v3", accountId,
    configHash: await computeConfigV3Id(config),
    sourcePolicy: { ...config.source, allowLocalZip: config.source.allowLocalZip ?? true, appId: config.app.id, units: (config.units ?? []).map(({ id, kind, wrangler }) => ({ id, kind, ...(wrangler ? { wrangler } : {}) })) },
  });
  const app = createApp(env);
  const trace: Array<{ method: string; path: string }> = [];
  const workers = new Map<string, MockWorker>();
  const versionReads = new Map<string, number>();
  const buckets: Array<{ name: string; id: string }> = [];
  const namespaces: Array<{ title: string; id: string }> = [];
  // account queues plus their consumers subresource state. The seed
  // pre-populates account state before planning (an existing queue with a
  // foreign consumer, an existing queue id, ...).
  const queues: Array<{ id: string; name: string }> = [];
  const queueConsumers = new Map<string, MockQueueConsumer[]>();
  let queueConsumerCounter = 0;
  let queueCounter = 0;
  for (const seeded of seed.queues ?? []) {
    const queue = { id: `queue-${seeded.name}-${++queueCounter}`, name: seeded.name };
    queues.push(queue);
    queueConsumers.set(queue.id, (seeded.consumers ?? []).map((consumer, index) => ({
      consumer_id: `consumer-seed-${seeded.name}-${index + 1}`,
      script: consumer.script,
      type: "worker" as const,
      ...(consumer.settings ? { settings: consumer.settings } : {}),
    })));
  }
  // live account Workflow definitions. Tests mutate this array directly to
  // model out-of-band drift (schedule change, foreign rewrite).
  const workflows: MockWorkflow[] = (seed.workflows ?? []).map((entry) => ({
    id: `wf-${entry.name}`,
    name: entry.name,
    className: entry.className,
    scriptName: entry.scriptName,
    schedules: entry.schedules ?? [],
  }));
  // zones plus the zone-scoped route tables. Tests mutate workerRoutes
  // directly to model out-of-band drift (foreign re-point, deletion).
  const zones: Array<{ id: string; name: string }> = (seed.zones ?? []).map((entry) => ({ id: entry.id, name: entry.name }));
  const workerRoutes: Array<{ zoneId: string; id: string; pattern: string; script?: string }> = [];
  let routeCounter = 0;
  // Custom domains: zone DNS records and account-level Worker custom domains.
  const dnsRecords: Array<{ zoneId: string; id: string; name: string; type: string; content?: string; proxied?: boolean }> = (seed.dnsRecords ?? []).map((record) => ({ ...record }));
  const workerDomains: Array<{ id: string; hostname: string; service: string; zone_id?: string }> = (seed.workerDomains ?? []).map((domain) => ({ ...domain }));
  let domainCounter = 0;
  // Platform resources: Hyperdrive configs (read only), Vectorize indexes,
  // Secrets Stores with their secret names (values never exist in the mock).
  const hyperdriveConfigs = (seed.hyperdriveConfigs ?? []).map((config) => ({ ...config }));
  const vectorizeIndexes: Array<{ name: string; created_on: string; config: { dimensions: number; metric: string } }> = (seed.vectorizeIndexes ?? []).map((index) => ({ name: index.name, created_on: "2026-01-01T00:00:00Z", config: { dimensions: index.dimensions, metric: index.metric } }));
  const secretsStores = (seed.secretsStores ?? []).map((store) => ({ ...store, secrets: [...store.secrets] }));
  interface MockPagesDeployment { id: string; url: string; manifest: Record<string, string> }
  interface MockPagesProject { id: string; name: string; domains?: string[]; productionBranch?: string; configs?: Record<string, unknown>; deployment?: MockPagesDeployment; canonical?: MockPagesDeployment }
  const pagesProjects = new Map<string, MockPagesProject>();
  const pagesManifests: Array<{ project: string; manifest: Record<string, string> }> = [];
  const pagesDeployReads = new Map<string, number>();
  const pagesStatus = (deploymentId: string) => {
    const reads = (pagesDeployReads.get(deploymentId) ?? 0) + 1;
    pagesDeployReads.set(deploymentId, reads);
    return reads > (options.pagesDeployReadsBeforeSuccess ?? 0) || deploymentId === "pages-dep-foreign" ? "success" : "active";
  };
  const pagesProjectJson = (project: MockPagesProject) => ({
    id: project.id, name: project.name, subdomain: `${project.name}.pages.dev`,
    ...(project.productionBranch ? { production_branch: project.productionBranch } : {}),
    ...(project.configs ? { deployment_configs: { production: project.configs, preview: project.configs } } : {}),
    ...(project.deployment ? (() => {
      // Production keeps serving the last successful deployment (canonical)
      // until the newest one (latest) finishes building.
      const status = pagesStatus(project.deployment.id);
      if (status === "success") project.canonical = project.deployment;
      const canonical = project.canonical;
      return {
        ...(canonical ? { canonical_deployment: { id: canonical.id, project_id: project.id, project_name: project.name, url: canonical.url, environment: "production", latest_stage: { name: "deploy", status: "success" } } } : {}),
        latest_deployment: { id: project.deployment.id, project_id: project.id, project_name: project.name, url: project.deployment.url, environment: "production", latest_stage: { name: "deploy", status } },
      };
    })() : {}),
  });
  const pagesDeploymentJson = (project: MockPagesProject) => ({
    id: project.deployment!.id, project_id: project.id, project_name: project.name, url: project.deployment!.url,
    environment: "production", latest_stage: { name: "deploy", status: pagesStatus(project.deployment!.id) },
    env_vars: (project.configs as Record<string, Record<string, unknown>> | undefined)?.env_vars ?? {},
  });
  let failNextUpload = false;
  let hideResourceReadback = false;
  let versionCounter = 0;
  const ok = (result: unknown) => Response.json({ success: true, result });
  const notFound = () => Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 });
  const providerError = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }] }, { status });
  const workflowJson = (workflow: MockWorkflow, withSchedules = true) => ({
    id: workflow.id,
    name: workflow.name,
    class_name: workflow.className,
    script_name: workflow.scriptName,
    ...(withSchedules ? { schedules: workflow.schedules.map((cron) => ({ cron })) } : {}),
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.cloudflare.com");
    // zone-scoped routes live outside the account prefix (`/zones`,
    // `/zones/{id}/...`); everything else is account-scoped.
    expect(url.pathname.includes(`/accounts/${accountId}/`) || url.pathname.endsWith("/zones") || url.pathname.includes("/zones/")).toBe(true);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    trace.push({ method, path });
    if (path.endsWith("/r2/buckets")) {
      if (method === "GET") return ok({ buckets: hideResourceReadback ? [] : buckets });
      if (method === "POST") {
        const { name } = JSON.parse(String(init?.body)) as { name: string };
        const bucket = { name, id: `bucket-${name}` }; buckets.push(bucket); return ok(bucket);
      }
    }
    if (path.endsWith("/storage/kv/namespaces")) {
      if (method === "GET") return ok(namespaces);
      if (method === "POST") {
        const { title } = JSON.parse(String(init?.body)) as { title: string };
        const ns = { title, id: "b".repeat(32) }; namespaces.push(ns); return ok(ns);
      }
    }
    // queue resources plus the consumers subresource (create/list/put).
    if (path.endsWith("/queues")) {
      if (method === "GET") return ok(queues.map(queue => ({ queue_id: queue.id, queue_name: queue.name, consumers_total_count: (queueConsumers.get(queue.id) ?? []).length })));
      if (method === "POST") {
        const { queue_name } = JSON.parse(String(init?.body)) as { queue_name: string };
        const queue = { id: `queue-${queue_name}-${++queueCounter}`, name: queue_name };
        queues.push(queue);
        queueConsumers.set(queue.id, []);
        return ok({ queue_id: queue.id, queue_name: queue.name });
      }
    }
    const queueConsumerMatch = /\/queues\/([^/]+)\/consumers(?:\/([^/]+))?$/.exec(path);
    if (queueConsumerMatch) {
      const queueId = decodeURIComponent(queueConsumerMatch[1]!);
      const consumerId = queueConsumerMatch[2] !== undefined ? decodeURIComponent(queueConsumerMatch[2]) : undefined;
      const queue = queues.find(candidate => candidate.id === queueId);
      const list = queueConsumers.get(queueId);
      if (!queue || !list) return notFound();
      const consumerJson = (consumer: MockQueueConsumer) => ({
        consumer_id: consumer.consumer_id, script: consumer.script, type: consumer.type, queue_name: queue.name,
        ...(consumer.settings ? { settings: consumer.settings } : {}),
        ...(consumer.dead_letter_queue ? { dead_letter_queue: consumer.dead_letter_queue } : {}),
      });
      if (consumerId === undefined && method === "GET") return ok(list.map(consumerJson));
      if (consumerId === undefined && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { script_name: string; settings?: Record<string, unknown>; dead_letter_queue?: string };
        const consumer: MockQueueConsumer = { consumer_id: `consumer-${++queueConsumerCounter}`, script: body.script_name, type: "worker", ...(body.settings ? { settings: body.settings } : {}), ...(body.dead_letter_queue ? { dead_letter_queue: body.dead_letter_queue } : {}) };
        list.push(consumer);
        return ok(consumerJson(consumer));
      }
      if (consumerId !== undefined && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { script_name: string; settings?: Record<string, unknown>; dead_letter_queue?: string };
        const existing = list.find(consumer => consumer.consumer_id === consumerId);
        if (!existing) return notFound();
        existing.script = body.script_name;
        if (body.settings) existing.settings = body.settings; else delete existing.settings;
        if (body.dead_letter_queue) existing.dead_letter_queue = body.dead_letter_queue; else delete existing.dead_letter_queue;
        return ok(consumerJson(existing));
      }
    }
    if (path.endsWith("/workers/scripts") && method === "GET") return ok([...workers.keys()].map(id => ({ id })));
    // zones plus zone-scoped Workers routes. The mock stores the exact
    // provider shapes ({id, name} / {id, pattern, script}) so readback
    // assertions measure the real contract.
    if (path.endsWith("/zones") && method === "GET") return ok(zones);
    if (path.endsWith("/hyperdrive/configs") && method === "GET") return ok(hyperdriveConfigs.map((config) => ({ id: config.id, name: config.name, origin: { host: "db.example.internal", port: 5432, database: "app", scheme: "postgres", user: "app" } })));
    if (path.endsWith("/vectorize/v2/indexes")) {
      if (method === "GET") return ok(vectorizeIndexes);
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as { name: string; config: { dimensions: number; metric: string } };
        const created = { name: body.name, created_on: "2026-10-22T00:00:00Z", config: body.config };
        vectorizeIndexes.push(created);
        return ok(created);
      }
    }
    if (path.endsWith("/secrets_store/stores") && method === "GET") return ok(secretsStores.map((store) => ({ id: store.id, name: store.name })));
    const storeSecretsMatch = /\/secrets_store\/stores\/([^/]+)\/secrets$/.exec(path);
    if (storeSecretsMatch && method === "GET") {
      const store = secretsStores.find((candidate) => candidate.id === decodeURIComponent(storeSecretsMatch[1]!));
      return store ? ok(store.secrets.map((name, index) => ({ id: `${store.id}-secret-${index}`, name, store_id: store.id }))) : notFound();
    }
    const dnsMatch = /\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
    if (dnsMatch) {
      const zoneId = decodeURIComponent(dnsMatch[1]!);
      const recordId = dnsMatch[2] !== undefined ? decodeURIComponent(dnsMatch[2]!) : undefined;
      if (!zones.some((zone) => zone.id === zoneId)) return notFound();
      const publicRecord = (record: (typeof dnsRecords)[number]) => ({ id: record.id, name: record.name, type: record.type, ...(record.content !== undefined ? { content: record.content } : {}), ...(record.proxied !== undefined ? { proxied: record.proxied } : {}) });
      if (method === "GET" && recordId === undefined) return ok(dnsRecords.filter((record) => record.zoneId === zoneId).map(publicRecord));
      if (method === "POST" && recordId === undefined) {
        const body = JSON.parse(String(init?.body)) as { type: string; name: string; content: string; proxied?: boolean };
        const created = { zoneId, id: String(++domainCounter).padStart(32, "d"), name: body.name, type: body.type, content: body.content, ...(body.proxied !== undefined ? { proxied: body.proxied } : {}) };
        dnsRecords.push(created);
        return ok(publicRecord(created));
      }
      if (method === "DELETE" && recordId !== undefined) {
        const index = dnsRecords.findIndex((record) => record.zoneId === zoneId && record.id === recordId);
        if (index < 0) return notFound();
        dnsRecords.splice(index, 1);
        return ok({ id: recordId });
      }
    }
    const workerDomainMatch = /\/workers\/domains(?:\/([^/]+))?$/.exec(path);
    if (workerDomainMatch) {
      const domainId = workerDomainMatch[1] !== undefined ? decodeURIComponent(workerDomainMatch[1]!) : undefined;
      if (method === "GET" && domainId === undefined) return ok(workerDomains);
      if (method === "PUT" && domainId === undefined) {
        const body = JSON.parse(String(init?.body)) as { hostname: string; service: string; zone_id?: string };
        // Provider parity: an existing address record blocks a new custom domain.
        if (!workerDomains.some((domain) => domain.hostname === body.hostname) && dnsRecords.some((record) => record.name === body.hostname && ["A", "AAAA", "CNAME"].includes(record.type))) return providerError(409, 100117, "Hostname already has externally managed DNS records");
        const existing = workerDomains.find((domain) => domain.hostname === body.hostname);
        if (existing) { existing.service = body.service; return ok(existing); }
        const created = { id: String(++domainCounter).padStart(32, "c"), hostname: body.hostname, service: body.service, ...(body.zone_id ? { zone_id: body.zone_id } : {}) };
        workerDomains.push(created);
        return ok(created);
      }
      if (method === "DELETE" && domainId !== undefined) {
        const index = workerDomains.findIndex((domain) => domain.id === domainId);
        if (index < 0) return notFound();
        workerDomains.splice(index, 1);
        return ok(null);
      }
    }
    const zoneRouteMatch = /\/zones\/([^/]+)\/workers\/routes(?:\/([^/]+))?$/.exec(path);
    if (zoneRouteMatch) {
      const zoneId = decodeURIComponent(zoneRouteMatch[1]!);
      const routeId = zoneRouteMatch[2] !== undefined ? decodeURIComponent(zoneRouteMatch[2]!) : undefined;
      if (!zones.some((zone) => zone.id === zoneId)) return notFound();
      if (method === "GET" && routeId === undefined) {
        return ok(workerRoutes.filter((route) => route.zoneId === zoneId).map((route) => ({ id: route.id, pattern: route.pattern, ...(route.script !== undefined ? { script: route.script } : {}) })));
      }
      if (method === "POST" && routeId === undefined) {
        const body = JSON.parse(String(init?.body)) as { pattern: string; script: string };
        expect(typeof body.pattern).toBe("string");
        expect(typeof body.script).toBe("string");
        const created = { zoneId, id: `route-${++routeCounter}`, pattern: body.pattern, script: body.script };
        workerRoutes.push(created);
        return ok({ id: created.id, pattern: created.pattern, script: created.script });
      }
      if (method === "PUT" && routeId !== undefined) {
        const body = JSON.parse(String(init?.body)) as { pattern: string; script: string };
        const existing = workerRoutes.find((route) => route.zoneId === zoneId && route.id === routeId);
        if (!existing) return notFound();
        existing.pattern = body.pattern;
        existing.script = body.script;
        return ok({ id: existing.id, pattern: existing.pattern, script: existing.script });
      }
    }
    // account Workflows. The official PUT replaces the definition and its
    // response OMITS schedules; the GET is the only proof of the live schedule
    // set (which is exactly why the apply step must read back).
    if (path.endsWith("/workflows") && method === "GET") {
      return ok(workflows.map((workflow) => workflowJson(workflow)));
    }
    const workflowMatch = /\/workflows\/([^/]+)$/.exec(path);
    if (workflowMatch) {
      const workflowName = decodeURIComponent(workflowMatch[1]!);
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { class_name: string; script_name: string; schedules?: Array<{ cron: string }> };
        expect(typeof body.class_name).toBe("string");
        expect(typeof body.script_name).toBe("string");
        // The apply path only ever sends a non-empty schedule set; an empty set
        // is expressed by omitting `schedules` (the provider replaces it with
        // no direct schedules).
        expect(body.schedules === undefined || body.schedules.length > 0).toBe(true);
        const existing = workflows.find(workflow => workflow.name === workflowName);
        const schedules = (body.schedules ?? []).map((schedule) => schedule.cron);
        if (existing) {
          existing.className = body.class_name;
          existing.scriptName = body.script_name;
          existing.schedules = schedules;
          return ok(workflowJson(existing, false));
        }
        const created: MockWorkflow = { id: `wf-${workflowName}`, name: workflowName, className: body.class_name, scriptName: body.script_name, schedules };
        workflows.push(created);
        return ok(workflowJson(created, false));
      }
      if (method === "GET") {
        const existing = workflows.find(workflow => workflow.name === workflowName);
        return existing ? ok(workflowJson(existing)) : notFound();
      }
    }
    const pagesMatch = /\/pages\/projects(?:\/([^/]+)(\/.*)?)?$/.exec(path);
    if (pagesMatch) {
      const projectName = pagesMatch[1] ? decodeURIComponent(pagesMatch[1]) : undefined;
      const tail = pagesMatch[2] ?? "";
      if (!projectName && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { name: string; production_branch?: unknown; deployment_configs?: { production?: Record<string, unknown> } };
        // Provider parity (live 400/8000033): a Pages project needs an explicit production branch.
        if (typeof body.production_branch !== "string" || body.production_branch.length === 0) return providerError(400, 8000033, "You must set a production branch.");
        const project: MockPagesProject = { id: `pages-${body.name}`, name: body.name, ...(typeof body.production_branch === "string" && body.production_branch ? { productionBranch: body.production_branch } : {}), ...(body.deployment_configs?.production ? { configs: body.deployment_configs.production } : {}) };
        pagesProjects.set(body.name, project);
        return ok(pagesProjectJson(project));
      }
      const project = projectName ? pagesProjects.get(projectName) : undefined;
      if (!project) return notFound();
      if (!tail && method === "GET") return ok(pagesProjectJson(project));
      if (tail === "/upload-token" && method === "GET") return ok({ jwt: `pages-jwt-for-${project.name}` });
      if (tail === "/domains" && method === "GET") return ok((project.domains ?? []).map((name) => ({ id: `pd-${name}`, domain_id: `pd-${name}`, name, status: "active" })));
      if (tail === "/domains" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { name: string };
        project.domains = [...(project.domains ?? []).filter((name) => name !== body.name), body.name];
        return ok({ id: `pd-${body.name}`, domain_id: `pd-${body.name}`, name: body.name, status: "pending" });
      }
      const pagesDomainMatch = /^\/domains\/([^/]+)$/.exec(tail);
      if (pagesDomainMatch && method === "DELETE") {
        const name = decodeURIComponent(pagesDomainMatch[1]!);
        if (!(project.domains ?? []).includes(name)) return notFound();
        project.domains = project.domains!.filter((candidate) => candidate !== name);
        return ok(null);
      }
      if (tail === "/deployments" && method === "POST") {
        const form = init?.body as FormData;
        const manifest = JSON.parse(String(form.get("manifest"))) as Record<string, string>;
        pagesManifests.push({ project: project.name, manifest });
        // Like Cloudflare: each deployment has its own hash address; the project's
        // production address is its `subdomain`.
        project.deployment = { id: `pages-dep-${pagesManifests.length}`, url: `https://${pagesManifests.length}a2b3c4d.${project.name}.pages.dev`, manifest };
        return ok(pagesDeploymentJson(project));
      }
      const deploymentMatch = /^\/deployments\/([^/]+)$/.exec(tail);
      if (deploymentMatch && method === "GET") {
        return project.deployment?.id === deploymentMatch[1] ? ok(pagesDeploymentJson(project)) : notFound();
      }
      throw new Error(`unexpected provider operation ${method} ${path}`);
    }
    const match = /\/workers\/scripts\/([^/]+)(.*)$/.exec(path);
    if (match) {
      const name = decodeURIComponent(match[1]!); const tail = match[2]!;
      const worker = workers.get(name);
      if ((tail === "" && method === "PUT") || (tail === "/versions" && method === "POST")) {
        if (failNextUpload) { failNextUpload = false; throw new Error("ambiguous upload transport failure"); }
        const form = init?.body as FormData;
        const meta = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<string, unknown>;
        const main = meta.main_module as string;
        expect(new Uint8Array(await (form.get(main) as Blob).arrayBuffer())).toEqual(files[main]);
        // Provider parity (live 400/10021): migrations is ONE object, never the wrangler-style array.
        if (Array.isArray(meta.migrations)) return providerError(400, 10021, "cannot unmarshal array into Go struct field Metadata.migrations of type ActorMigrations");
        // Provider parity (live 400/10021): a Workflow class must be an exported WorkflowEntrypoint.
        const mainSource = new TextDecoder().decode(files[main]);
        for (const binding of (meta.bindings ?? []) as Array<{ type?: string; name?: string; class_name?: string; script_name?: string }>) {
          if (binding.type !== "workflow" || binding.script_name !== undefined) continue;
          if (!new RegExp(`export\\s+class\\s+${binding.class_name}\\s+extends\\s+WorkflowEntrypoint\\b`).test(mainSource)) return providerError(400, 10021, `Workflow ${binding.name} must be exported or a script_name must be specified`);
        }
        for (const [part, value] of form.entries()) {
          if (part === "metadata") continue;
          expect(new Uint8Array(await (value as Blob).arrayBuffer()), part).toEqual(files[part]);
          expect((value as Blob).type).toBe(part.endsWith(".wasm") ? "application/wasm" : "application/javascript+module");
        }
        const id = `00000000-0000-4000-8000-${String(++versionCounter).padStart(12, "0")}`;
        // the upload metadata is stored verbatim (bindings and any
        // forwarded migrations are provider-shaped (single object), so tests assert exactly what TapDeploy uploaded.
        const version: MockVersion = { id, message: (meta.annotations as Record<string, string>)["workers/message"]!, bindings: meta.bindings as Record<string, unknown>[] ?? [], migrations: (meta as Record<string, unknown>).migrations ?? null, runtime: { compatibility_date: meta.compatibility_date, compatibility_flags: meta.compatibility_flags ?? [] } };
        if (worker) worker.versions.unshift(version);
        else workers.set(name, { versions: [version], active: id, schedules: [] });
        return ok({ id: tail === "" ? name : id });
      }
      if (!worker) return notFound();
      if (tail === "/versions" && method === "GET") return ok({ items: worker.versions.map(({ id, message }) => ({ id, message })) });
      if (tail.startsWith("/versions/") && method === "GET") {
        const versionId = tail.slice("/versions/".length);
        const lagged = versionReads.get(versionId) ?? 0;
        if (lagged < (options.versionReadbackLag ?? 0)) {
          versionReads.set(versionId, lagged + 1);
          return Response.json({ success: false, errors: [{ code: 100146, message: "The requested Worker version could not be found" }] }, { status: 404 });
        }
        const version = worker.versions.find(v => v.id === versionId);
        return version ? ok({ id: version.id, message: version.message, resources: { bindings: version.bindings, script_runtime: version.runtime } }) : notFound();
      }
      if (tail === "/deployments") {
        if (method === "POST") worker.active = (JSON.parse(String(init?.body)) as { versions: Array<{ version_id: string }> }).versions[0]!.version_id;
        const deployment = { id: `deployment-${worker.active}`, versions: [{ version_id: worker.active, percentage: 100 }] };
        return ok(method === "GET" ? { deployments: [deployment] } : deployment);
      }
      if (tail === "/schedules") {
        if (method === "PUT") worker.schedules = (JSON.parse(String(init?.body)) as Array<{ cron: string }>).map(item => item.cron);
        return ok({ schedules: worker.schedules.map(cron => ({ cron })) });
      }
      if (tail === "/settings") return ok({ bindings: worker.versions[0]?.bindings ?? [] });
      if (tail === "/secrets") return ok([]);
    }
    throw new Error(`unexpected provider operation ${method} ${path}`);
  }));
  const headers = { origin, "x-tapdeploy-csrf": session.payload.csrf, cookie: `${sessionCookieName(origin)}=${session.cookieValue}` };
  const json = (route: string, body: unknown) => app.request(route, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const archive = zipSync(files, { level: 0 });
  const prepare = () => app.request("/api/deploy/prepare", { method: "POST", headers: { ...headers, "content-type": "application/zip" }, body: archive });
  const prepared = await prepare();
  const preparedBody = await prepared.json() as { releaseProof: SealedEnvelope };
  if (options.allowPrepareFailure) {
    // The caller asserts the exact refusal; release/plan/step fields would be
    // meaningless and throw a clear error if touched.
    const unavailable = (field: string): never => {
      throw new Error(`graphHonoFixture: ${field} is unavailable when prepare is expected to fail`);
    };
    return {
      app, env, accountId, key, session, headers, archive, prepare, plan: undefined as never, json,
      trace, workers, buckets, namespaces, queues, queueConsumers, workflows, zones, workerRoutes, dnsRecords, workerDomains, vectorizeIndexes, pagesProjects, pagesManifests,
      tamperPagesDeployment: undefined as never, foreignActivateWorker: undefined as never,
      writes: () => trace.filter(call => call.method !== "GET"),
      failUpload: () => { failNextUpload = true; },
      hideResourceReadback: () => { hideResourceReadback = true; },
      get release(): never { return unavailable("release"); },
      get planned(): never { return unavailable("planned"); },
      get plannedBody(): never { return unavailable("plannedBody"); },
      get step(): never { return unavailable("step"); },
      get makeStep(): never { return unavailable("makeStep"); },
    };
  }
  expect(prepared.status, JSON.stringify(preparedBody)).toBe(200);
  const release = (await openSeal<VerifiedReleaseContext>(key, preparedBody.releaseProof))!;
  const plan = (overrides: Record<string, unknown> = {}) => json("/api/deploy/plan", { accountId, releaseProof: preparedBody.releaseProof, config: { text: JSON.stringify(config) }, paidRiskConfirmed: true, mode: "install", ...overrides });
  const planned = await plan();
  const plannedBody = await planned.json() as { graphPlan: GraphDeployPlan; executionContext: unknown; approval: unknown; error?: string };
  const makeStep = (planBody: typeof plannedBody) => (unitId: string, resource: string, action: string, name: string, phase: string, args: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => {
    const unit = release.units.find(unit => unit.unitId === unitId);
    const main = unit?.mainModule as { path: string } | undefined;
    const modules = unit?.modules as Array<{ path: string }> | undefined;
    const bytes = main && ["create-worker", "create-version"].includes(phase) ? { scriptB64: Buffer.from(files[main.path]!).toString("base64"), additionalModules: (modules ?? []).filter(module => module.path !== main.path).map(module => ({ name: module.path, contentB64: Buffer.from(files[module.path]!).toString("base64") })) } : {};
    // Bundle-carrying units (Worker and Pages) always bind the sealed bundle
    // digest so a step can never drift to unapproved bytes/assets.
    const pagesUnit = (unit?.canonicalWrangler as { kind?: unknown } | undefined)?.kind === "pages";
    const bundle = typeof unit?.bundleDigest === "string" && (main !== undefined || pagesUnit) ? { bundleDigest: unit.bundleDigest } : {};
    return json("/api/deploy/step", { accountId, executionContext: planBody.executionContext, approval: planBody.approval, unitId, actionId: graphActionId({ unitId, resource, action, name }), step: phase, phase, ...bundle, args: { ...bytes, ...args }, ...overrides });
  };
  const step = makeStep(plannedBody);
  const tamperPagesDeployment = (projectName: string) => {
    const project = pagesProjects.get(projectName);
    if (project) project.deployment = { id: "pages-dep-foreign", url: `https://${projectName}.pages.dev`, manifest: {} };
  };
  const foreignActivateWorker = (name: string) => {
    const worker = workers.get(name);
    if (worker) worker.active = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  };
  return { app, env, accountId, key, session, headers, archive, prepare, plan, planned, plannedBody, step, makeStep, json, release, trace, workers, buckets, namespaces, queues, queueConsumers, workflows, zones, workerRoutes, dnsRecords, workerDomains, vectorizeIndexes, pagesProjects, pagesManifests, tamperPagesDeployment, foreignActivateWorker, writes: () => trace.filter(call => call.method !== "GET"), failUpload: () => { failNextUpload = true; }, hideResourceReadback: () => { hideResourceReadback = true; } };
}
