import { describe, expect, it } from "vitest";
import { VersionSemantics } from "../fixtures/cloudflare/version-semantics.js";
import { createCloudflareClient } from "../../src/cloudflare/client/client.js";

describe("official version lifecycle contract", () => {
  it.each([false, true])("Secret PUT creates versions regardless of implicit deployment (%s)", (implicit) => {
    const provider = new VersionSemantics(implicit);
    const original = provider.upload({}, true);
    const second = provider.secret("PASSWORD", "fake-password");
    const third = provider.secret("JWT", "fake-key");
    expect(new Set([original, second, third]).size).toBe(3);
    provider.deploy(original);
    expect(provider.served.at(-1)).toEqual({}); // old sequence cannot be safe
  });
  it("bulk PATCH produces one new version, preserves omitted secrets and removes explicit null", () => {
    const provider = new VersionSemantics(false);
    provider.upload({ KEEP: "fake", REMOVE: "fake" }, true);
    provider.bulk({ PASSWORD: "fake-password", JWT: "fake-key", REMOVE: null });
    expect(provider.versions).toHaveLength(2);
    expect(provider.versions[1]?.bindings).toEqual({ KEEP: "fake", PASSWORD: "fake-password", JWT: "fake-key" });
  });
  it("complete inline metadata is present even when script PUT immediately deploys", () => {
    const provider = new VersionSemantics(true);
    provider.upload({ PASSWORD: "fake-password", JWT: "fake-key" }, true);
    expect(provider.served.every(s => s.PASSWORD && s.JWT)).toBe(true);
  });
  it("version upload is not activation; historical/latest inheritance is rejected", () => {
    const provider = new VersionSemantics(false);
    const active = provider.upload({ PASSWORD: "original" }, true);
    provider.upload({ PASSWORD: "foreign" });
    expect(provider.active).toBe(active);
    expect(() => provider.inherit(active, "PASSWORD")).toThrow(/unverified/);
  });
  it("real client uses multipart version upload with inline secret metadata", async () => {
    let method: string | undefined;
    let path = "";
    let metadata: unknown;
    const client = createCloudflareClient({ accountId: "a".repeat(32), accessToken: "fake", fetcher: async (url, init) => {
      method = init?.method;
      path = String(url);
      const part = (init?.body as FormData).get("metadata") as Blob;
      metadata = JSON.parse(await part.text());
      return Response.json({ success: true, result: { id: "prepared", resources: {} } });
    } });
    const bindings = [{ type: "secret_text", name: "PASSWORD", text: "fake-password" }];
    const uploaded = await client.createVersion("app", { metadata: { main_module: "worker.mjs", bindings }, mainModule: { name: "worker.mjs", content: "export default {}", contentType: "application/javascript+module" } });
    expect(method).toBe("POST");
    expect(path).toMatch(/\/scripts\/app\/versions/);
    expect(metadata).toEqual({ main_module: "worker.mjs", bindings });
    expect(uploaded.id).toBe("prepared");
  });
  it("insufficient provider permission rejects version creation, not a successful no-op", async () => {
    const client = createCloudflareClient({ accountId: "a".repeat(32), accessToken: "fake", fetcher: async () => Response.json({ success: false, errors: [{ code: 10000, message: "denied" }] }, { status: 403 }) });
    await expect(client.createVersion("app", { metadata: { main_module: "worker.mjs" }, mainModule: { name: "worker.mjs", content: "export default {}", contentType: "application/javascript+module" } })).rejects.toBeDefined();
  });
});
