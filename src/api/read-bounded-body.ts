// Read a request body that is allowed to be large only after the caller has been
// authenticated and the request validated. The limit counts actual bytes (a
// Content-Length that lies cannot widen it) and a stalled sender is dropped after
// a deadline instead of holding the connection.

export type BoundedBody =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "timeout" | "unreadable" };

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, deadlineMs: number): Promise<BoundedBody> {
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, deadlineMs);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: timedOut ? "timeout" : "unreadable" };
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  if (timedOut) return { ok: false, reason: "timeout" };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { ok: true, bytes };
}
