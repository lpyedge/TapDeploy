// Session + origin + CSRF gate shared by the authenticated API routes.

import type { Context } from "hono";
import type { AppEnv, TapDeployEnv } from "./app.js";
import { parseCookies } from "../auth/cookies.js";
import { validateCsrf, validateOrigin } from "../auth/csrf.js";
import { sessionCookieName, readSession, type SessionPayload } from "../auth/session.js";
import { loadKey } from "./routes/auth.js";

export async function authenticate(c: Context<AppEnv>, env: TapDeployEnv): Promise<{ session: SessionPayload } | { denied: Response }> {
  const publicOrigin = env.PUBLIC_ORIGIN ?? "";
  const cookies = parseCookies(c.req.raw.headers.get("cookie"));
  const raw = cookies[sessionCookieName(publicOrigin)];
  const key = raw ? await loadKey(env).catch(() => null) : null;
  const session = key && raw ? await readSession(key, raw) : null;
  if (!session) {
    return { denied: c.json({ error: "unauthenticated" }, 401) };
  }
  if (
    !validateOrigin(publicOrigin, c.req.header("origin")) ||
    !validateCsrf(session, c.req.header("x-tapdeploy-csrf"))
  ) {
    return { denied: c.json({ error: "csrf/origin check failed" }, 403) };
  }
  return { session };
}
