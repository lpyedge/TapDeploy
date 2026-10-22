import { Hono } from "hono";
import { attachAuthRoutes } from "./routes/auth.js";
import { attachAccountsRoutes } from "./routes/accounts.js";
import { attachDeployPlanRoutes } from "./routes/deploy-plan.js";
import { attachDeployStepRoutes } from "./routes/deploy-step.js";
import { attachAssetUploadRoutes } from "./routes/asset-upload.js";
import { attachReleaseDownloadRoutes } from "./routes/release-download.js";
import { attachDeployPrepareRoutes } from "./routes/deploy-prepare.js";
import { RESOURCE_SUPPORT_MATRIX } from "../cloudflare/resources/index.js";
import { boundedApiBody } from "./body-limit.js";

export interface AppEnv {
  Bindings: TapDeployEnv;
}

export interface TapDeployEnv {
  TAPDEPLOY_PUBLIC_ORIGIN?: string;
  TAPDEPLOY_OAUTH_CLIENT_ID?: string;
  TAPDEPLOY_OAUTH_CLIENT_SECRET?: string;
  RUNTIME: "node" | "workers";
}

// The config schema version this server accepts (tapdeploy.config.json V3).
export const SUPPORTED_SCHEMA_VERSION = 3;

// Authoritative resource-kind vocabulary, derived from the resource support
// matrix (single source of truth). Distinct from `ResourceKind` only in that
// every row carries the installer's support policy.
const SUPPORTED_RESOURCE_KINDS = RESOURCE_SUPPORT_MATRIX.map((r) => r.kind);

export function createApp(env: TapDeployEnv): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/api/*", boundedApiBody);
  // Server errors leave one line in the log (route, status, our own error codes;
  // never request bodies or credentials) so a failure the browser only reports
  // as "upstream" can be traced.
  app.use("/api/*", async (c, next) => {
    await next();
    if (c.res.status < 500) return;
    const body = (await c.res.clone().json().catch(() => null)) as { error?: unknown; upstream?: unknown; detail?: unknown } | null;
    const codes = [body?.error, body?.upstream, body?.detail].filter((v): v is string => typeof v === "string");
    console.error(`[tapdeploy] ${c.req.method} ${c.req.path} -> ${c.res.status} ${codes.join(" | ")}`);
  });

  app.get("/api/health", (c) => {
    return c.json({
      ok: true,
      runtime: env.RUNTIME,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
    });
  });

  app.get("/api/capabilities", (c) => {
    return c.json({
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      resourceKinds: SUPPORTED_RESOURCE_KINDS,
      runtime: env.RUNTIME,
      bindings: {
        staticAssets: true,
        r2: true,
        secrets: true,
        rateLimit: false,
      },
    });
  });

  attachAuthRoutes(app, env);
  attachAccountsRoutes(app, env);
  attachDeployPlanRoutes(app, env);
  attachDeployPrepareRoutes(app, env);
  attachDeployStepRoutes(app, env);
  attachAssetUploadRoutes(app, env);
  attachReleaseDownloadRoutes(app, env);

  return app;
}
