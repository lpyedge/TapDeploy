import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/api/routes/auth.js", () => ({ loadKey: vi.fn() }));
const { readBoundedPrepareZip, MAX_VERIFIED_ZIP_COMPRESSED } = await import("../../src/api/routes/deploy-prepare.js");

describe("prepare ZIP stream bound", () => {
  it("preserves actual bytes and rejects an oversized chunk", async () => {
    const normal = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } });
    expect(await readBoundedPrepareZip(normal)).toEqual(new Uint8Array([1, 2, 3]));
    const tooLarge = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_VERIFIED_ZIP_COMPRESSED + 1)); } });
    expect(await readBoundedPrepareZip(tooLarge)).toBeNull();
  });
});
