import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/api/routes/auth.js", () => ({ loadKey: vi.fn() }));
const { readBoundedPrepareZip } = await import("../../src/api/routes/deploy-prepare.js");
const { RELEASE_MAX_BYTES } = await import("../../src/core/upload-limits.js");

describe("prepare ZIP stream bound", () => {
  it("preserves actual bytes and rejects an oversized chunk", async () => {
    const normal = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } });
    expect(await readBoundedPrepareZip(normal)).toEqual(new Uint8Array([1, 2, 3]));
    const tooLarge = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(RELEASE_MAX_BYTES + 1)); } });
    expect(await readBoundedPrepareZip(tooLarge)).toBeNull();
  });
});
