import type { TapDeployEnv } from "../api/app.js";

export function nodeEnvFromProcess(): TapDeployEnv {
  return {
    RUNTIME: "node",
    PUBLIC_ORIGIN: canonicalOrigin(process.env.PUBLIC_ORIGIN),
    OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET: process.env.OAUTH_CLIENT_SECRET,
  };
}

export function workerEnvFromBindings(env: Record<string, unknown>): TapDeployEnv {
  return {
    RUNTIME: "workers",
    PUBLIC_ORIGIN: canonicalOrigin(asString(env.PUBLIC_ORIGIN)),
    OAUTH_CLIENT_ID: asString(env.OAUTH_CLIENT_ID),
    OAUTH_CLIENT_SECRET: asString(env.OAUTH_CLIENT_SECRET),
  };
}

/**
 * The public origin as `scheme://host[:port]`. A value that names an origin in
 * another spelling (trailing `/`, surrounding spaces, uppercase host, explicit
 * default port) is reduced to it; anything with a path, query, fragment or
 * credentials is kept as given so the auth config check refuses it by value.
 */
export function canonicalOrigin(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password && value.includes("://")) return url.origin;
  } catch {
    // not a URL: refused by the auth config check
  }
  return value;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
