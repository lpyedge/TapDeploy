// Shared config-aware login helper for contract tests.
//
// /api/auth/start is a config-bounded POST: a session is only created after a
// valid V3 config is supplied and the granted scopes cover the derived set.
// These helpers build a real session through the full callback flow with a
// stub provider, using a fixed Worker + R2 config so the derived scopes are
// deterministic.

import type { createApp } from "../../src/api/app.js";

export const CONFIG_TEXT = JSON.stringify({
  schemaVersion: 3,
  app: { id: "fixture/minimal-worker", name: "Minimal Worker" },
  source: { allowLocalZip: true },
  capabilities: ["workers", "r2"],
  units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
});

// The scopes this config derives (sorted): Worker Admin + R2 Write.
// An HTTP unit implies Zone Read + DNS Write (custom domains).
export const WORKER_CONFIG_SCOPES = ["dns.write", "workers-r2.write", "workers-scripts.admin", "zone.read"];

export interface LoginResult {
  sessionCookie: string;
  csrf: string;
  accessToken: string;
}

function configStartReq(
  app: ReturnType<typeof createApp>,
  configText = CONFIG_TEXT,
): Response | Promise<Response> {
  return app.request("/api/auth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: configText }),
  });
}

function findCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function runConfigLogin(
  app: ReturnType<typeof createApp>,
  opts: { scope?: string; configText?: string } = {},
): Promise<LoginResult> {
  const startRes = await configStartReq(app, opts.configText);
  const startBody = (await startRes.json()) as { url: string };
  const state = new URL(startBody.url).searchParams.get("state")!;
  const txCookie = findCookie(startRes, "__Host-tapdeploy_oauth_tx");
  if (!txCookie) throw new Error("no tx cookie");
  const accessToken = `tok-${Math.random().toString(36).slice(2)}`;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/oauth2/token")) {
      return jsonResponse({
        access_token: accessToken,
        token_type: "Bearer",
        scope: opts.scope ?? WORKER_CONFIG_SCOPES.join(" "),
        expires_in: 3600,
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const cbRes = await app.request(
      `/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: txCookie } },
    );
    const sessionRaw = findCookie(cbRes, "__Host-tapdeploy_session");
    if (!sessionRaw) throw new Error("no session cookie");
    const sessionCookie = sessionRaw.split(";")[0]!;
    const sessRes = await app.request("/api/auth/session", {
      headers: { cookie: sessionCookie },
    });
    const sessBody = (await sessRes.json()) as { csrf: string };
    return { sessionCookie, csrf: sessBody.csrf, accessToken };
  } finally {
    globalThis.fetch = origFetch;
  }
}
