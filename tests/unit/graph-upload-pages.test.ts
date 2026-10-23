import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadV3PagesAssets } from "../../src/web/graph-upload.js";
import { retainV3SourceBytes } from "../../src/web/release.js";
import { buildValidZip } from "./zip-builder.js";

afterEach(() => vi.unstubAllGlobals());

describe("uploadV3PagesAssets", () => {
  it("stores each file with the content type of its extension, so a browser shows an HTML page instead of downloading it", async () => {
    const source = await retainV3SourceBytes(buildValidZip({
      "units/site/wrangler.jsonc": JSON.stringify({ name: "site", compatibility_date: "2026-10-01", pages_build_output_dir: "public" }),
      "units/site/public/index.html": "<!doctype html><title>x</title>",
      "units/site/public/app.css": "body{}",
      "units/site/public/logo.svg": "<svg/>",
      "units/site/public/data.bin": "\u0001\u0002",
    }), "release.zip");
    const uploaded: Array<{ key: string; metadata: { contentType: string } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const target = new URL(String(input), "https://installer.example").searchParams.get("target");
      const body = JSON.parse(String(init?.body)) as unknown;
      if (target === "pages-check-missing") return Response.json({ success: true, result: (body as { hashes: string[] }).hashes });
      if (target === "pages-upload") uploaded.push(...(body as typeof uploaded));
      return Response.json({ success: true, result: {} });
    }));

    await uploadV3PagesAssets({ csrf: "c", accountId: "a".repeat(32), source }, "units/site/wrangler.jsonc", "jwt");

    expect(uploaded).toHaveLength(4);
    expect(uploaded.map((file) => file.metadata.contentType).sort()).toEqual(["application/octet-stream", "image/svg+xml", "text/css", "text/html"]);
  });
});
