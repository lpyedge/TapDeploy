import type { TapDeployEnv } from "../api/app.js";

export function nodeEnvFromProcess(): TapDeployEnv {
  return {
    RUNTIME: "node",
    TAPDEPLOY_PUBLIC_ORIGIN: process.env.TAPDEPLOY_PUBLIC_ORIGIN,
    TAPDEPLOY_OAUTH_CLIENT_ID: process.env.TAPDEPLOY_OAUTH_CLIENT_ID,
    TAPDEPLOY_OAUTH_CLIENT_SECRET: process.env.TAPDEPLOY_OAUTH_CLIENT_SECRET,
  };
}

export function workerEnvFromBindings(env: Record<string, unknown>): TapDeployEnv {
  return {
    RUNTIME: "workers",
    TAPDEPLOY_PUBLIC_ORIGIN: asString(env.TAPDEPLOY_PUBLIC_ORIGIN),
    TAPDEPLOY_OAUTH_CLIENT_ID: asString(env.TAPDEPLOY_OAUTH_CLIENT_ID),
    TAPDEPLOY_OAUTH_CLIENT_SECRET: asString(env.TAPDEPLOY_OAUTH_CLIENT_SECRET),
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
