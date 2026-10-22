// Real Cloudflare R2 bucket objects carry no `id` (only name, creation_date, ...).
// The installer identifies a bucket by name@creation_date; a CREATE response must
// be normalized the same way as a LIST row, otherwise the create step reports
// "resource creation identity unavailable" and the deployment stops.

import { describe, expect, it } from "vitest";
import { createCloudflareClient } from "../../src/cloudflare/client/index.js";
import { ensureR2Bucket } from "../../src/cloudflare/resources/r2.js";

const ACCOUNT = "a".repeat(32);
const created = { name: "showcase-media", creation_date: "2026-10-16T01:02:03.000Z", location: "APAC", storage_class: "Standard" };

function client() {
  const fetcher = async () =>
    new Response(JSON.stringify({ success: true, errors: [], messages: [], result: created }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return createCloudflareClient({ accessToken: "t", accountId: ACCOUNT, fetcher });
}

describe("R2 create/get identity", () => {
  it("createR2Bucket returns the same name@creation_date identity a list row gets", async () => {
    const bucket = await client().createR2Bucket("showcase-media");
    expect(bucket.id).toBe("showcase-media@2026-10-16T01:02:03.000Z");
    expect(bucket.name).toBe("showcase-media");
  });

  it("getR2Bucket is normalized too", async () => {
    expect((await client().getR2Bucket("showcase-media")).id).toBe("showcase-media@2026-10-16T01:02:03.000Z");
  });

  it("ensureR2Bucket reports a usable id after creating", async () => {
    const result = await ensureR2Bucket(client(), { bucketName: "showcase-media", createIfMissing: true, knownBuckets: [] });
    expect(result).toMatchObject({ action: "create", name: "showcase-media", id: "showcase-media@2026-10-16T01:02:03.000Z" });
  });
});
