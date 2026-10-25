import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app.js";
import { readBoundedBody } from "./read-bounded-body.js";

const BODY_READ_DEADLINE_MS = 30_000;

// Bound actual bytes, including chunked requests and lying Content-Length.
// Never parse arbitrary JSON or buffer release ZIPs inside an API isolate.
export const boundedApiBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  // These two routes authenticate and validate before they read their large raw
  // body in their own handlers (bounded there). Exact paths only: do not turn
  // this into a prefix exception.
  if (c.req.method === "POST" && (c.req.path === "/api/deploy/prepare" || c.req.path === "/api/upload/assets")) return next();
  const request = c.req.raw;
  if (!request.body) return next();
  const limit = c.req.path === "/api/auth/start"
    ? 192 * 1024 // config text (<=64 KiB) plus JSON escaping and envelope
    : 8 * 1024 * 1024;
  const tooLarge = () => c.json({ error: "payload_too_large", detail: `request exceeds the ${limit}-byte API limit; ZIP and static asset bytes must remain in the browser` }, 413);
  if (Number(request.headers.get("content-length")) > limit) {
    await request.body.cancel().catch(() => {});
    return tooLarge();
  }
  const read = await readBoundedBody(request.body, limit, BODY_READ_DEADLINE_MS);
  if (!read.ok) {
    if (read.reason === "too_large") return tooLarge();
    return read.reason === "timeout"
      ? c.json({ error: "request_timeout", detail: "the request did not arrive in time" }, 408)
      : c.json({ error: "invalid_body", detail: "request body could not be read" }, 400);
  }
  const bytes = read.bytes;
  c.req.raw = new Request(request, { body: bytes as BodyInit });
  return next();
};
