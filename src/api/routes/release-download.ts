// Same-origin relay for GitHub release downloads.
//
// GitHub release assets (and the CDN they redirect to) send no CORS headers, so a
// browser cannot download them itself. For an authenticated session this route
// fetches ONE allowlisted https URL (github.com release downloads, codeload and
// the GitHub asset CDNs), follows a few redirects only when each hop is allowlisted
// too, sends no credentials, refuses anything over the release size limit before
// streaming and cuts a longer stream off, and has a timeout. It is not a general proxy.

import type { Context, Hono } from "hono";
import type { AppEnv, TapDeployEnv } from "../app.js";
import { RELEASE_MAX_BYTES } from "../../core/upload-limits.js";
import { relayedDownloadProblem } from "../../release/url.js";
import { authenticate } from "../session-guard.js";

const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 120_000;

export function attachReleaseDownloadRoutes(app: Hono<AppEnv>, env: TapDeployEnv): void {
  app.post("/api/release/download", (c) => relay(c, env));
}

async function relay(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const auth = await authenticate(c, env);
  if ("denied" in auth) return auth.denied;

  const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
  if (typeof body?.url !== "string") return c.json({ error: "url_required" }, 400);
  let target = body.url;
  const refused = relayedDownloadProblem(target);
  if (refused) return c.json({ error: "url_refused", detail: refused }, 400);

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let upstream: Response | undefined;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      upstream = await fetch(target, { redirect: "manual", headers: { Accept: "application/octet-stream" }, signal });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get("location");
      await upstream.body?.cancel();
      if (!location || hop === MAX_REDIRECTS) return c.json({ error: "redirect_refused", detail: "too many or empty redirects" }, 502);
      target = new URL(location, target).href;
      const problem = relayedDownloadProblem(target);
      if (problem) return c.json({ error: "redirect_refused", detail: problem }, 502);
    }
  } catch {
    return c.json({ error: "upstream_unreachable" }, 502);
  }
  if (!upstream || !upstream.ok || !upstream.body) {
    await upstream?.body?.cancel();
    return c.json({ error: "upstream_status", status: upstream?.status ?? 0 }, upstream?.status === 404 ? 404 : 502);
  }

  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RELEASE_MAX_BYTES) {
    await upstream.body.cancel();
    return c.json({ error: "too_large", size: declared, limit: RELEASE_MAX_BYTES }, 413);
  }
  let size = 0;
  const capped = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > RELEASE_MAX_BYTES) controller.error(new Error("release exceeds the size limit"));
      else controller.enqueue(chunk);
    },
  });
  const headers = new Headers({ "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
  if (Number.isFinite(declared) && declared > 0) headers.set("Content-Length", String(declared));
  return new Response(upstream.body.pipeThrough(capped), { status: 200, headers });
}
