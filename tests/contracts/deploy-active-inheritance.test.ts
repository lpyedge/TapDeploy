import { expect, it, vi } from "vitest";
import { createCloudflareClient } from "../../src/cloudflare/client/client.js";
const active = "00000000-0000-4000-8000-000000000001";
const req = { metadata: { main_module: "worker.mjs", bindings: [{ type: "inherit", name: "PASSWORD", version_id: active }] }, mainModule: { name: "worker.mjs", content: "export default {}", contentType: "application/javascript+module" } };

it("explicit active inheritance uses immutable Worker identity and JSON version API, never legacy/latest", async () => {
  const calls: string[] = [];
  const client = createCloudflareClient({ accountId: "a".repeat(32), accessToken: "fake", fetcher: async (input, init) => {
    const url = new URL(input);
    calls.push(`${init?.method} ${url.pathname}`);
    if (init?.method === "GET" && url.pathname.endsWith("/workers/workers")) return Response.json({ success: true, result: [{ id: "immutable-id", name: "app" }] });
    if (init?.method === "GET" && url.pathname.endsWith("/workers/workers/immutable-id")) return Response.json({ success: true, result: { id: "immutable-id", name: "app" } });
    expect(url.pathname).toContain("/workers/workers/immutable-id/versions");
    expect(url.searchParams.get("deploy")).toBe("false");
    const body = JSON.parse(String(init?.body));
    expect(body.bindings).toEqual(req.metadata.bindings);
    expect(body.modules).toEqual([{ name: "worker.mjs", content_type: "application/javascript+module", content_base64: btoa("export default {}") }]);
    return Response.json({ success: true, result: { id: "prepared" } });
  } });
  expect((await client.createVersion("app", req)).id).toBe("prepared");
  expect(calls).toHaveLength(3);
});

it("unresolved Worker identity cannot cause upload or fallback to mutable latest", async () => {
  const fetched = vi.fn(async (_url, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    return Response.json({ success: true, result: [] });
  });
  const client = createCloudflareClient({ accountId: "a".repeat(32), accessToken: "fake", fetcher: fetched });
  await expect(client.createVersion("app", req)).rejects.toBeDefined();
});

it("translates D1 and Browser bindings to the resource API dialect", async () => {
  const client = createCloudflareClient({ accountId: "a".repeat(32), accessToken: "fake", fetcher: async (_url, init) => {
    if (init?.method === "GET") {
      const worker = { id: "immutable-id", name: "app" };
      return Response.json({ success: true, result: new URL(_url).pathname.endsWith("/workers/workers") ? [worker] : worker });
    }
    expect(JSON.parse(String(init?.body)).bindings).toEqual([...req.metadata.bindings, { type: "d1", name: "DB", database_id: "approved-db" }, { type: "browser", name: "BROWSER" }]);
    return Response.json({ success: true, result: { id: "prepared" } });
  } });
  await client.createVersion("app", { ...req, metadata: { ...req.metadata, bindings: [...req.metadata.bindings, { type: "d1", name: "DB", id: "approved-db" }, { type: "browser", name: "BROWSER" }] } });
});
