import { describe, expect, it, vi } from "vitest";
import { readBoundedResponse } from "../../src/core/bounded-response.js";

describe("bounded downloads", () => {
  it("cancels an oversized declared response before buffering", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    await expect(readBoundedResponse(new Response(stream, { headers: { "content-length": "5" } }), 4)).rejects.toThrow(/size bound/);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels an oversized stream even without Content-Length", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); }, cancel });
    await expect(readBoundedResponse(new Response(stream), 4)).rejects.toThrow(/size bound/);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("preserves bytes at the exact bound", async () => {
    expect(await readBoundedResponse(new Response(new Uint8Array([1, 2, 3, 4])), 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
