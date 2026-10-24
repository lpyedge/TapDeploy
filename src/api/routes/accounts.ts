// Read-only account list for the account dropdown. Authenticated + CSRF; data
// comes from the typed client's listAccounts route (read-only). Returns id/name
// only — no tokens.

import type { Context, Hono } from "hono";
import type { AppEnv, TapDeployEnv } from "../app.js";
import { parseCookies } from "../../auth/cookies.js";
import { validateCsrf, validateOrigin } from "../../auth/csrf.js";
import { sessionCookieName, readSession } from "../../auth/session.js";
import {
  createCloudflareClient,
  type CloudflareApiError,
} from "../../cloudflare/client/index.js";
import { loadKey } from "./auth.js";
import { authenticate } from "../session-guard.js";

export function attachAccountsRoutes(app: Hono<AppEnv>, env: TapDeployEnv): void {
  app.get("/api/cloudflare/accounts", async (c) => accountsHandler(c, env));
  // read-only target discovery for the selected account — returns the list of
  // existing Workers scripts and Pages projects so the operator can pick an
  // explicit upgrade target rather than silently overwriting a name.
  // POST (carries accountId in the body) but is strictly read-only: no mutation.
  app.post("/api/cloudflare/targets", async (c) => targetsHandler(c, env));
  // Read-only custom-domain discovery for the Configure step: the account's
  // zones, the address records of one chosen zone, and the domains already
  // bound to Workers / to the named Pages projects.
  app.post("/api/cloudflare/domains", async (c) => domainsHandler(c, env));
  app.post("/api/cloudflare/pages-domain-status", async (c) => pagesDomainStatusHandler(c, env));
  // Read-only list of the account's Hyperdrive configurations (names only, never
  // connection details) so the operator can pick one per Hyperdrive binding.
  app.post("/api/cloudflare/hyperdrive", async (c) => hyperdriveHandler(c, env));
  app.post("/api/cloudflare/inventory", async (c) => inventoryHandler(c, env));
}

// The account's existing names per resource kind (Configure: reuse on install,
// pick on upgrade), and, for an upgrade target Worker, the resource each of
// its bindings uses today. Only kinds the session's scopes cover are listed.
const INVENTORY_SCOPES: Record<string, string> = { r2: "workers-r2.write", d1: "d1.write", kv: "workers-kv-storage.write", queue: "queues.write", vectorize: "vectorize.write", pages: "page.write" };

async function inventoryHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const auth = await authenticate(c, env);
  if ("denied" in auth) return auth.denied;
  const body = (await c.req.json().catch(() => null)) as { accountId?: unknown; kinds?: unknown; worker?: unknown } | null;
  if (typeof body?.accountId !== "string" || body.accountId.length === 0) return c.json({ error: "accountId is required" }, 400);
  const kinds = Array.isArray(body.kinds) ? body.kinds.filter((kind): kind is string => typeof kind === "string" && kind in INVENTORY_SCOPES && auth.session.scope.includes(INVENTORY_SCOPES[kind]!)) : [];
  const client = createCloudflareClient({ accessToken: auth.session.accessToken }).withAccount(body.accountId);
  try {
    const names: Record<string, string[]> = {};
    const d1 = kinds.includes("d1") || typeof body.worker === "string" ? await client.listD1Databases().catch(() => []) : [];
    for (const kind of kinds) {
      const list = kind === "r2" ? (await client.listR2Buckets()).map((item) => item.name)
        : kind === "d1" ? d1.map((item) => item.name)
        : kind === "kv" ? (await client.listKvNamespaces()).map((item) => item.title)
        : kind === "queue" ? (await client.listQueues()).map((item) => item.name)
        : kind === "vectorize" ? (await client.listVectorizeIndexes()).map((item) => item.name)
        : (await client.listPages()).map((item) => item.name);
      names[kind] = [...new Set(list.filter((name): name is string => typeof name === "string"))].sort();
    }
    let bindings: Array<{ binding: string; kind: string; name: string }> | undefined;
    if (typeof body.worker === "string" && body.worker.length > 0) {
      const settings = await client.getWorkerSettings(body.worker);
      bindings = ((settings.bindings ?? []) as Array<Record<string, unknown>>).flatMap((binding) => {
        const name = typeof binding.name === "string" ? binding.name : "";
        if (binding.type === "r2_bucket" && typeof binding.bucket_name === "string") return [{ binding: name, kind: "r2", name: binding.bucket_name }];
        if (binding.type === "d1") {
          const id = typeof binding.id === "string" ? binding.id : typeof binding.database_id === "string" ? binding.database_id : "";
          const database = d1.find((item) => item.id === id);
          return database ? [{ binding: name, kind: "d1", name: database.name }] : [];
        }
        if (binding.type === "queue" && typeof binding.queue_name === "string") return [{ binding: name, kind: "queue", name: binding.queue_name }];
        if (binding.type === "vectorize" && typeof binding.index_name === "string") return [{ binding: name, kind: "vectorize", name: binding.index_name }];
        return [];
      });
    }
    return c.json({ accountId: body.accountId, names, ...(bindings ? { bindings } : {}) });
  } catch (error) {
    if (isUpstreamError(error)) return c.json({ error: "upstream", upstream: error.kind }, 502);
    throw error;
  }
}

async function hyperdriveHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const auth = await authenticate(c, env);
  if ("denied" in auth) return auth.denied;
  const body = (await c.req.json().catch(() => null)) as { accountId?: unknown } | null;
  if (typeof body?.accountId !== "string" || body.accountId.length === 0) return c.json({ error: "accountId is required" }, 400);
  try {
    const configs = await createCloudflareClient({ accessToken: auth.session.accessToken }).withAccount(body.accountId).listHyperdriveConfigs();
    return c.json({ accountId: body.accountId, configs: configs.map((config) => config.name).sort() });
  } catch (error) {
    if (isUpstreamError(error)) {
      return c.json({ error: "upstream", upstream: error.kind }, 502);
    }
    throw error;
  }
}

async function accountsHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const publicOrigin = env.PUBLIC_ORIGIN ?? "";
  const origin = c.req.header("origin");
  const csrf = c.req.header("x-tapdeploy-csrf");

  const cookies = parseCookies(c.req.raw.headers.get("cookie"));
  const raw = cookies[sessionCookieName(publicOrigin)];
  const key = raw ? await loadKey(env).catch(() => null) : null;
  if (!key || !raw) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const payload = await readSession(key, raw);
  if (!payload) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (!validateOrigin(publicOrigin, origin) || !validateCsrf(payload, csrf)) {
    return c.json({ error: "csrf/origin check failed" }, 403);
  }

  const client = createCloudflareClient({ accessToken: payload.accessToken });
  try {
    const accounts = await client.listAccounts();
    return c.json({
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    });
  } catch (error) {
    if (isUpstreamError(error)) {
      return c.json({ error: "upstream", upstream: error.kind }, 502);
    }
    throw error;
  }
}

// read-only target discovery for the selected account. Returns the live
// Workers scripts and Pages projects so the operator can choose an explicit
// upgrade target. Do not query undeclared products. A denied granted capability
// is an upstream failure, never an empty verified list.
async function targetsHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const publicOrigin = env.PUBLIC_ORIGIN ?? "";
  const origin = c.req.header("origin");
  const csrf = c.req.header("x-tapdeploy-csrf");

  const cookies = parseCookies(c.req.raw.headers.get("cookie"));
  const raw = cookies[sessionCookieName(publicOrigin)];
  const key = raw ? await loadKey(env).catch(() => null) : null;
  if (!key || !raw) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const payload = await readSession(key, raw);
  if (!payload) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (!validateOrigin(publicOrigin, origin) || !validateCsrf(payload, csrf)) {
    return c.json({ error: "csrf/origin check failed" }, 403);
  }

  let accountId: string;
  try {
    const parsed = (await c.req.json()) as { accountId?: unknown };
    if (typeof parsed.accountId !== "string" || parsed.accountId.length === 0) {
      return c.json({ error: "accountId is required" }, 400);
    }
    accountId = parsed.accountId;
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }

  const client = createCloudflareClient({ accessToken: payload.accessToken });
  const accountClient = client.withAccount(accountId);
  try {
    const workers = payload.scope.some((scope) => scope.startsWith("workers-scripts."))
      ? await accountClient.listWorkers() : [];
    const pages = payload.scope.includes("page.write") ? await accountClient.listPages() : [];
    return c.json({
      accountId,
      workers: workers.map((w) => ({ name: w.id })),
      pages: pages.map((p) => ({ name: p.name, id: p.id })),
    });
  } catch (error) {
    if (isUpstreamError(error)) {
      return c.json({ error: "upstream", upstream: error.kind }, 502);
    }
    throw error;
  }
}

// The record types that occupy a hostname for HTTP (what a custom domain replaces).
const ADDRESS_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"]);
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

async function domainsHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const auth = await authenticate(c, env);
  if ("denied" in auth) return auth.denied;
  const body = (await c.req.json().catch(() => null)) as { accountId?: unknown; zone?: unknown; pagesProjects?: unknown } | null;
  if (typeof body?.accountId !== "string" || body.accountId.length === 0) return c.json({ error: "accountId is required" }, 400);
  const zoneName = typeof body.zone === "string" ? body.zone.toLowerCase() : undefined;
  const pagesProjects = Array.isArray(body.pagesProjects) ? body.pagesProjects.filter((name): name is string => typeof name === "string" && PROJECT_NAME.test(name)).slice(0, 10) : [];
  const accountClient = createCloudflareClient({ accessToken: auth.session.accessToken }).withAccount(body.accountId);
  try {
    const zones = (await accountClient.listZones()).map((zone) => ({ id: zone.id, name: zone.name.toLowerCase() }));
    const zone = zoneName ? zones.find((candidate) => candidate.name === zoneName) : undefined;
    if (zoneName && !zone) return c.json({ error: "unknown_zone", detail: `the zone "${zoneName}" is not in this account` }, 404);
    const records = zone
      ? (await accountClient.listDnsRecords(zone.id)).filter((record) => ADDRESS_RECORD_TYPES.has(record.type)).map((record) => ({ name: record.name.toLowerCase(), type: record.type, ...(record.content !== undefined ? { content: record.content } : {}) }))
      : [];
    const workerDomains = (await accountClient.listWorkerDomains()).map((domain) => ({ hostname: domain.hostname.toLowerCase(), ...(domain.service ? { service: domain.service } : {}), ...(domain.zone_name ? { zone: domain.zone_name.toLowerCase() } : {}) }));
    const pagesDomains: Record<string, string[]> = {};
    for (const project of pagesProjects) {
      try {
        pagesDomains[project] = (await accountClient.listPagesDomains(project)).map((domain) => domain.name.toLowerCase());
      } catch (error) {
        // A project that does not exist yet has no domains.
        if ((error as { kind?: unknown }).kind !== "not-found") throw error;
        pagesDomains[project] = [];
      }
    }
    return c.json({ accountId: body.accountId, zones: zones.map((candidate) => candidate.name).sort(), ...(zone ? { zone: zone.name, records } : {}), workerDomains, pagesDomains });
  } catch (error) {
    if (isUpstreamError(error)) {
      return c.json({ error: "upstream", upstream: error.kind }, 502);
    }
    throw error;
  }
}

// One Cloudflare read for the result page's watch on a new Pages domain, so a
// poll every few seconds costs one subrequest instead of the whole discovery.
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

async function pagesDomainStatusHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const auth = await authenticate(c, env);
  if ("denied" in auth) return auth.denied;
  const body = (await c.req.json().catch(() => null)) as { accountId?: unknown; project?: unknown; hostname?: unknown } | null;
  const hostname = typeof body?.hostname === "string" ? body.hostname.toLowerCase() : "";
  if (typeof body?.accountId !== "string" || body.accountId.length === 0 || typeof body.project !== "string" || !PROJECT_NAME.test(body.project) || !HOSTNAME.test(hostname)) {
    return c.json({ error: "accountId, project and hostname are required" }, 400);
  }
  try {
    const domains = await createCloudflareClient({ accessToken: auth.session.accessToken }).withAccount(body.accountId).listPagesDomains(body.project);
    const found = domains.find((domain) => domain.name.toLowerCase() === hostname);
    return c.json({ status: found ? (found.status ?? "unknown") : "missing" });
  } catch (error) {
    if (isUpstreamError(error)) return c.json({ error: "upstream", upstream: error.kind }, 502);
    throw error;
  }
}

function isUpstreamError(error: unknown): error is CloudflareApiError {
  return typeof error === "object" && error !== null && "kind" in error;
}
