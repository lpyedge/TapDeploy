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
  // Read-only list of the account's Hyperdrive configurations (names only, never
  // connection details) so the operator can pick one per Hyperdrive binding.
  app.post("/api/cloudflare/hyperdrive", async (c) => hyperdriveHandler(c, env));
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

function isUpstreamError(error: unknown): error is CloudflareApiError {
  return typeof error === "object" && error !== null && "kind" in error;
}
