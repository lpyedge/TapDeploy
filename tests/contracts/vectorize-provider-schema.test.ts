import { expect, it } from "vitest";
import { createCloudflareClient } from "../../src/cloudflare/client/client.js";

it("official Vectorize v2 name/config/created_on response needs no fabricated provider UUID", async () => {
  const index = { name: "vectors", created_on: "2026-10-14T00:00:00Z", config: { dimensions: 768, metric: "cosine" } };
  const fetcher = async () => Response.json({ success: true, result: [index] });
  const client = createCloudflareClient({ accessToken: "fake", accountId: "a".repeat(32), fetcher });
  expect(await client.listVectorizeIndexes()).toEqual([{ ...index, id: "vectors@2026-10-14T00:00:00Z" }]);
});
it("Vectorize name-only response is unavailable, not evidence of a stable incarnation", async () => {
  const client = createCloudflareClient({ accessToken: "fake", accountId: "a".repeat(32), fetcher: async () => Response.json({ success: true, result: [{ name: "vectors" }] }) });
  await expect(client.listVectorizeIndexes()).rejects.toMatchObject({ kind: "invalid-response" });
});
