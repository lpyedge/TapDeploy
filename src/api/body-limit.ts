import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app.js";
import { ASSET_UPLOAD_MAX_BODY_BYTES } from "../core/upload-limits.js";

// Bound actual bytes, including chunked requests and lying Content-Length.
// Never parse arbitrary JSON or buffer release ZIPs inside an API isolate; the
// asset upload forwarder is the one route with a larger, still bounded, limit.
export const boundedApiBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  // This route authenticates before it reads its raw ZIP stream in its own
  // handler.  Do not turn this into a prefix exception.
  if (c.req.method === "POST" && c.req.path === "/api/deploy/prepare") return next();
  const request = c.req.raw;
  if (!request.body) return next();
  const limit = c.req.path === "/api/auth/start"
    ? 192 * 1024 // config text (<=64 KiB) plus JSON escaping and envelope
    : c.req.path === "/api/upload/assets"
      ? ASSET_UPLOAD_MAX_BODY_BYTES
      : 8 * 1024 * 1024;
  const tooLarge = () => c.json({ error: "payload_too_large", detail: `request exceeds the ${limit}-byte API limit; ZIP and static asset bytes must remain in the browser` }, 413);
  const reader = request.body.getReader();
  if (Number(request.headers.get("content-length")) > limit) {
    await reader.cancel().catch(() => {});
    return tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  } catch {
    return c.json({ error: "invalid_body", detail: "request body could not be read" }, 400);
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  c.req.raw = new Request(request, { body: bytes });
  return next();
};
