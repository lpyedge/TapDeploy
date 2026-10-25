import { Hono } from "hono";
import { attachAuthRoutes } from "./routes/auth.js";
import { attachAccountsRoutes } from "./routes/accounts.js";
import { attachDeployPlanRoutes } from "./routes/deploy-plan.js";
import { attachDeployStepRoutes } from "./routes/deploy-step.js";
import { attachAssetUploadRoutes } from "./routes/asset-upload.js";
import { attachReleaseDownloadRoutes } from "./routes/release-download.js";
import { attachDeployPrepareRoutes } from "./routes/deploy-prepare.js";
import { boundedApiBody } from "./body-limit.js";

export interface AppEnv {
  Bindings: TapDeployEnv;
}

export interface TapDeployEnv {
  PUBLIC_ORIGIN?: string;
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  RUNTIME: "node" | "workers";
}

// The config schema version this server accepts (tapdeploy.config.json V3).
export const SUPPORTED_SCHEMA_VERSION = 3;

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

  attachAuthRoutes(app, env);
  attachAccountsRoutes(app, env);
  attachDeployPlanRoutes(app, env);
  attachDeployPrepareRoutes(app, env);
  attachDeployStepRoutes(app, env);
  attachAssetUploadRoutes(app, env);
  attachReleaseDownloadRoutes(app, env);

  return app;
}
