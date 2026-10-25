import { describe, expect, it, vi } from "vitest";
import {
  createCloudflareClient,
  isAllowedCloudflareUrl,
  ROUTES,
} from "../../src/cloudflare/client/index.js";
import {
  fixtureResponse,
  readFixture,
} from "../fixtures/cloudflare/load-fixture.js";
import { fixtureFetcher } from "./cloudflare-fixtures.js";
import type { PagesProjectSummary } from "../../src/cloudflare/models/index.js";

const ACCOUNT_ID = "a".repeat(32);
const TOKEN = "mock-access-token";
const SCRIPT = "demo-worker";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function envelope(result: unknown, success = true) {
  return { success, errors: [], messages: [], result };
}

type RequestLog = {
  url: string;
  init: RequestInit;
  body?: unknown;
};

function mockFetcher() {
  const log: RequestLog[] = [];
  const queue: Response[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    log.push({
      url: String(input),
      init: init ?? {},
      body: init?.body ? safeParseBody(init.body) : undefined,
    });
    const canned = queue.shift();
    if (canned) {
      return canned;
    }
    return jsonResponse(envelope({ ok: true }));
  });
  return { fn, log, schedule: (response: Response) => queue.push(response) };
}

function at(log: RequestLog[], index: number): RequestLog {
  const entry = log[index];
  if (!entry) {
    throw new Error(`no fetch call at index ${index}`);
  }
  return entry;
}

function safeParseBody(body: BodyInit): unknown {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}

describe("cloudflare api client contract", () => {
  it("listAccounts parses the result array", async () => {
    const { fn, schedule } = mockFetcher();
    schedule(
      jsonResponse(envelope([{ id: ACCOUNT_ID, name: "Test Acct" }])),
    );
    const client = createCloudflareClient({ accessToken: TOKEN, fetcher: fn });
    const accounts = await client.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: ACCOUNT_ID,
      name: "Test Acct",
    });
  });

  it("requires a bound account for account-scoped reads", async () => {
    const { fn } = mockFetcher();
    const client = createCloudflareClient({ accessToken: TOKEN, fetcher: fn });
    await expect(client.getAccount()).rejects.toThrow(
      "Cloudflare account id is required",
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects an invalid account id", async () => {
    const { fn } = mockFetcher();
    expect(() =>
      createCloudflareClient({
        accessToken: TOKEN,
        accountId: "not-32-hex",
        fetcher: fn,
      }),
    ).toThrow("Invalid Cloudflare account id");
  });

  it("withAccount re-binds the account for bound calls", async () => {
    const { fn, schedule } = mockFetcher();
    schedule(
      jsonResponse(envelope({ id: ACCOUNT_ID, name: "Bound Acct" })),
    );
    const client = createCloudflareClient({ accessToken: TOKEN, fetcher: fn });
    const account = await client.withAccount(ACCOUNT_ID).getAccount();
    expect(account.id).toBe(ACCOUNT_ID);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("sends Bearer token and fixed path for account reads", async () => {
    const { fn, log, schedule } = mockFetcher();
    schedule(jsonResponse(envelope([])));
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });
    await client.listWorkers();
    const call = at(log, 0);
    expect(call.url).toContain(`/accounts/${ACCOUNT_ID}/workers/scripts`);
    expect(call.init.method).toBe("GET");
    const auth = (call.init.headers as Record<string, string>)["Authorization"];
    expect(auth).toBe(`Bearer ${TOKEN}`);
  });

  it("declared write routes send POST/PUT to fixed allowlisted paths", async () => {
    const { fn, log, schedule } = mockFetcher();
    // Real R2 bucket objects carry name + creation_date, not an id.
    schedule(
      jsonResponse(envelope({ name: "docs-assets", creation_date: "2026-10-16T00:00:00.000Z" })),
    );
    schedule(
      jsonResponse(envelope({ name: "API_KEY", type: "secret_text" })),
    );
    schedule(
      jsonResponse(envelope({ schedules: [{ cron: "0 0 * * *" }] })),
    );
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });

    await client.createR2Bucket("docs-assets");
    expect(at(log, 0).url).toContain(`/accounts/${ACCOUNT_ID}/r2/buckets`);
    expect(at(log, 0).init.method).toBe("POST");
    expect(at(log, 0).body).toMatchObject({ name: "docs-assets" });

    await client.updateSecret(SCRIPT, "API_KEY", "s3cr3t");
    expect(at(log, 1).url).toContain(
      `/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT}/secrets`,
    );
    expect(at(log, 1).init.method).toBe("PUT");
    expect(at(log, 1).body).toMatchObject({
      name: "API_KEY",
      type: "secret_text",
    });

    await client.updateSchedules(SCRIPT, ["0 0 * * *"]);
    expect(at(log, 2).url).toContain(
      `/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT}/schedules`,
    );
    expect(at(log, 2).init.method).toBe("PUT");
    // Official write body is an array of {cron} objects (not a {crons} envelope).
    expect(at(log, 2).body).toEqual([{ cron: "0 0 * * *" }]);
  });

  it("asset bucket upload POSTs JWT multipart to the account endpoint", async () => {
    const { fn, log, schedule } = mockFetcher();
    schedule(jsonResponse(envelope({ jwt: "complete-jwt-1" })));
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });
    const out = await client.uploadWorkerAssets("upload-jwt-1", {
      ["a".repeat(32)]: { base64: "PGh0bWw+", contentType: "text/html" },
    });
    expect(out.jwt).toBe("complete-jwt-1");
    expect(at(log, 0).url).toContain(
      `/accounts/${ACCOUNT_ID}/workers/assets/upload?base64=true`,
    );
    expect(at(log, 0).init.method).toBe("POST");
    expect((at(log, 0).init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer upload-jwt-1",
    );
    expect(at(log, 0).init.body).toBeInstanceOf(FormData);
  });

  it("rejects a non-32-hex asset hash before any fetch", async () => {
    const { fn } = mockFetcher();
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });
    await expect(
      client.uploadWorkerAssets("upload-jwt-1", {
        abcd: { base64: "eA==", contentType: "text/html" },
      }),
    ).rejects.toMatchObject({ kind: "invalid-response" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("asset session uses the official assets-upload-session path and buckets", async () => {
    const { fn, log, schedule } = mockFetcher();
    const h1 = "a".repeat(32);
    const h2 = "b".repeat(32);
    schedule(jsonResponse(envelope({ jwt: "session-jwt", buckets: [[h1, h2], []] })));
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });
    const session = await client.startAssetUploadSession(SCRIPT, {
      manifest: {
        "/index.html": { hash: h1, size: 7 },
      },
    });
    expect(session.jwt).toBe("session-jwt");
    expect(session.buckets).toEqual([[h1, h2], []]);
    expect(at(log, 0).url).toContain(`/assets-upload-session`);
    expect(at(log, 0).url).not.toContain(`/assets/start-session`);
    expect(at(log, 0).body).toMatchObject({
      manifest: { "/index.html": { hash: h1, size: 7 } },
    });
  });

  it("rejects an asset session result with the invented bucket shape", async () => {
    const { fn, schedule } = mockFetcher();
    schedule(
      jsonResponse(envelope({ jwt: "x", bucket: "b.upload-api.cloudflare.com" })),
    );
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });
    await expect(
      client.startAssetUploadSession(SCRIPT, {
        manifest: { "/index.html": { hash: "a".repeat(32), size: 1 } },
      }),
    ).rejects.toMatchObject({ kind: "invalid-response" });
  });

  it("version upload uses multipart metadata with main_module", async () => {
    const { fn, log, schedule } = mockFetcher();
    schedule(
      jsonResponse(envelope({ id: "version-1", number: 1, resources: {} })),
    );
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });
    await client.createVersion(SCRIPT, {
      metadata: {
        main_module: "worker.mjs",
        compatibility_date: "2026-10-10",
        annotations: { "workers/message": "test" },
      },
      mainModule: {
        name: "worker.mjs",
        content: "export default {}",
        contentType: "application/javascript+module",
      },
    });
    expect(at(log, 0).url).toContain(`/versions`);
    expect(at(log, 0).init.method).toBe("POST");
    expect(at(log, 0).init.body).toBeInstanceOf(FormData);
    const form = at(log, 0).init.body as unknown as FormData;
    const metadataRaw = form.get("metadata");
    const metadataText = metadataRaw instanceof Blob ? await metadataRaw.text() : String(metadataRaw);
    expect(JSON.parse(metadataText)).toMatchObject({ main_module: "worker.mjs" });

    schedule(jsonResponse(envelope({ id: "dep-1" })));
    await client.createDeployment(SCRIPT, {
      strategy: "percentage",
      versions: [{ version_id: "version-1", percentage: 100 }],
    });
    expect(at(log, 1).url).toContain(`/deployments`);
    expect(at(log, 1).body).toMatchObject({
      strategy: "percentage",
      versions: [{ version_id: "version-1", percentage: 100 }],
    });
  });

  it("first-time worker create uses PUT scripts/{name} multipart with main_module", async () => {
    const { fn, log, schedule } = mockFetcher();
    schedule(
      jsonResponse(envelope({ id: "version-1", number: 1, resources: {} })),
    );
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });
    await client.createWorker(SCRIPT, {
      metadata: {
        main_module: "worker.mjs",
        compatibility_date: "2026-10-10",
        annotations: { "workers/message": "test" },
      },
      mainModule: {
        name: "worker.mjs",
        content: "export default {}",
        contentType: "application/javascript+module",
      },
    });
    expect(at(log, 0).url).toContain(`/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT}`);
    expect(at(log, 0).url).not.toContain(`/versions`);
    expect(at(log, 0).init.method).toBe("PUT");
    expect(at(log, 0).init.body).toBeInstanceOf(FormData);
    const form = at(log, 0).init.body as unknown as FormData;
    const metadataRaw = form.get("metadata");
    const metadataText = metadataRaw instanceof Blob ? await metadataRaw.text() : String(metadataRaw);
    expect(JSON.parse(metadataText)).toMatchObject({ main_module: "worker.mjs" });
  });

  it("rejects a bare version_id deployment without percentage strategy", async () => {
    const { fn } = mockFetcher();
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });
    await expect(
      client.createDeployment(SCRIPT, {
        strategy: "percentage",
        versions: [],
      }),
    ).rejects.toMatchObject({ kind: "invalid-response" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a version upload without main_module", async () => {
    const { fn } = mockFetcher();
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });
    await expect(
      client.createVersion(SCRIPT, {
        metadata: { main_module: "" },
        mainModule: { name: "", content: "x", contentType: "application/javascript+module" },
      }),
    ).rejects.toMatchObject({ kind: "invalid-response" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("no invented /rate-limits route exists; rate-limit state is read via settings", async () => {
    // The undocumented /rate-limits provider path must never be in the allowlist.
    for (const route of Object.values(ROUTES)) {
      expect(route.path({ accountId: ACCOUNT_ID, scriptName: SCRIPT })).not.toContain("/rate-limits");
    }
    // Documented source: worker settings bindings expose ratelimit bindings.
    const { fn, log } = fixtureFetcher();
    const client = createCloudflareClient({
      accessToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetcher: fn,
    });
    const settings = await client.getWorkerSettings(SCRIPT);
    expect(settings.bindings).toContainEqual({ name: "RL", type: "ratelimit" });
    expect(at(log, 0).url).toContain(`/workers/scripts/${SCRIPT}/settings`);
  });

  describe("error normalization", () => {
    it.each([
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not-found"],
      [409, "conflict"],
      [500, "server"],
      [502, "server"],
    ])("maps HTTP %i to kind %s", async (status, kind) => {
      const { fn, schedule } = mockFetcher();
      schedule(
        jsonResponse({ success: false, errors: [{ message: "boom" }] }, status),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listWorkers()).rejects.toMatchObject({
        kind,
        status,
      });
    });

    it("carries retry-after for 429", async () => {
      const { fn, schedule } = mockFetcher();
      schedule(fixtureResponse(readFixture("error-rate-limited")));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listWorkers()).rejects.toMatchObject({
        kind: "rate-limited",
        retryAfterSeconds: 32,
      });
    });

    it("normalizes network failures", async () => {
      const { fn } = mockFetcher();
      fn.mockRejectedValue(new TypeError("fetch failed"));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listWorkers()).rejects.toMatchObject({
        kind: "network",
      });
    });

    it("treats success=false as invalid response", async () => {
      const { fn, schedule } = mockFetcher();
      schedule(jsonResponse({ success: false }));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listWorkers()).rejects.toMatchObject({
        kind: "invalid-response",
      });
    });
  });

  describe("route allowlist", () => {
    it("every fixed route stays within the allowlisted base", () => {
      const ctx = {
        accountId: ACCOUNT_ID,
        scriptName: SCRIPT,
        bucketName: "docs-assets",
      };
      for (const route of Object.values(ROUTES)) {
        const url = new URL(
          `https://api.cloudflare.com/client/v4${route.path(ctx)}`,
        );
        expect(isAllowedCloudflareUrl(url), route.id).toBe(true);
      }
    });

    it("rejects non-https and foreign origins", () => {
      expect(isAllowedCloudflareUrl("http://api.cloudflare.com/client/v4/accounts")).toBe(false);
      expect(isAllowedCloudflareUrl("https://evil.example.com/client/v4/accounts")).toBe(false);
      expect(isAllowedCloudflareUrl("https://api.cloudflare.com/client/v4/accounts")).toBe(true);
    });
  });

  describe("provider read contract (official shapes from fixtures)", () => {
    it("resolves worker metadata via list, never parsing raw script bytes as JSON", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const worker = await client.getWorker(SCRIPT);
      expect(worker.id).toBe(SCRIPT);
      // Only the list route was called — never the raw download path as JSON.
      expect(log).toHaveLength(1);
      expect(at(log, 0).url).toContain(`/accounts/${ACCOUNT_ID}/workers/scripts`);
      expect(at(log, 0).url).not.toContain(`/workers/scripts/${SCRIPT}/settings`);
      expect(at(log, 0).url).not.toMatch(/\/workers\/scripts\/[^?/]+$/);
    });

    it("returns not-found for an absent worker via list", async () => {
      // Override the workers-list route with the empty (absent) fixture.
      const { fn, schedule } = fixtureFetcher();
      schedule(fixtureResponse(readFixture("workers-list-empty")));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.getWorker("absent-worker")).rejects.toMatchObject({ kind: "not-found" });
    });

    it("parses version list from result.items with metadata", async () => {
      const { fn } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const versions = await client.listVersions(SCRIPT);
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({ id: "v-2", number: 2, created_on: "2026-02-01T00:00:00Z" });
    });

    it("maps annotations.workers/message to version message so the ownership marker is read (live)", async () => {
      const { fn, schedule } = mockFetcher();
      schedule(
        jsonResponse(
          envelope({
            items: [
              {
                id: "v-1",
                number: 1,
                metadata: { created_on: "2026-03-01T00:00:00Z" },
                annotations: {
                  "workers/message": "demo v0.1.0 managed-by-tapdeploy",
                  "workers/triggered_by": "upload",
                },
              },
            ],
          }),
        ),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const versions = await client.listVersions(SCRIPT);
      expect(versions).toHaveLength(1);
      expect(versions[0]!.message).toBe(
        "demo v0.1.0 managed-by-tapdeploy",
      );
      expect(versions[0]!.annotations).toMatchObject({
        "workers/message": "demo v0.1.0 managed-by-tapdeploy",
      });
    });

    it("rejects a version list array from the wrong path", async () => {
      const { fn, schedule } = fixtureFetcher();
      schedule(fixtureResponse(readFixture("versions-list-invalid-array")));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listVersions(SCRIPT)).rejects.toMatchObject({
        kind: "invalid-response",
      });
    });

    it("parses deployments from result.deployments with version_id", async () => {
      const { fn } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const deployments = await client.listDeployments(SCRIPT);
      expect(deployments).toHaveLength(1);
      expect(deployments[0]!.versions[0]).toMatchObject({ version_id: "v-2", percentage: 100 });
    });

    it("parses R2 list from result.buckets and follows cursor with a bound", async () => {
      const { fn, log, schedule } = fixtureFetcher();
      // First page: the documented result.buckets fixture plus a cursor.
      const page1 = readFixture("r2-buckets-list");
      schedule(
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: page1.result,
            result_info: { cursor: "cursor-2", per_page: 100 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      // Second page: the documented result.buckets envelope with no cursor.
      schedule(
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: { buckets: [{ name: "b-2", creation_date: "2026-01-02T00:00:00Z" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const buckets = await client.listR2Buckets();
      expect(buckets.map((b) => b.name)).toEqual(["b-1", "b-2"]);
      // Cursor pagination issued a second bounded request with cursor param.
      expect(log).toHaveLength(2);
      expect(at(log, 1).url).toContain("cursor=");
    });

    it("rejects an R2 list array from the wrong path", async () => {
      const { fn, schedule } = fixtureFetcher();
      schedule(fixtureResponse(readFixture("r2-buckets-list-invalid-array")));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listR2Buckets()).rejects.toMatchObject({
        kind: "invalid-response",
      });
    });

    it("parses schedules from result.schedules", async () => {
      const { fn } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const meta = await client.getSchedules(SCRIPT);
      expect(meta.crons).toEqual(["*/30 * * * *"]);
    });

    it("parses D1 database list from result[] with uuid/name (d1)", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const dbs = await client.listD1Databases();
      expect(dbs).toHaveLength(2);
      expect(dbs[0]).toMatchObject({
        id: "12345678-1234-1234-1234-1234567890ab",
        uuid: "12345678-1234-1234-1234-1234567890ab",
        name: "my-database",
        jurisdiction: "eu",
      });
      expect(at(log, 0).url).toContain("/d1/database");
      expect(at(log, 0).init.method).toBe("GET");
    });

    it("rejects a D1 database list array from the wrong path (d1)", async () => {
      const { fn, schedule } = fixtureFetcher();
      schedule(
        jsonResponse(envelope({ not_an_array: true })),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listD1Databases()).rejects.toMatchObject({
        kind: "invalid-response",
      });
    });

    it("creates a D1 database with a JSON body (d1)", async () => {
      const { fn, log, schedule } = mockFetcher();
      schedule(
        jsonResponse(
          envelope({
            uuid: "12345678-1234-1234-1234-1234567890ab",
            name: "my-database",
            jurisdiction: "eu",
            created_at: "2026-01-01T00:00:00Z",
          }),
        ),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const created = await client.createD1Database({ name: "my-database", jurisdiction: "eu" });
      expect(created).toMatchObject({ id: "12345678-1234-1234-1234-1234567890ab", name: "my-database" });
      expect(at(log, 0).url).toContain("/d1/database");
      expect(at(log, 0).init.method).toBe("POST");
      const body = at(log, 0).init.body as string;
      expect(JSON.parse(body)).toEqual({ name: "my-database", jurisdiction: "eu" });
    });

    it("parses KV namespace list from result[] with id/title (kv)", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const ns = await client.listKvNamespaces();
      expect(ns).toHaveLength(2);
      expect(ns[0]).toMatchObject({
        id: "0f2ac74b498b48028cb68387c421e279",
        title: "My Own Namespace",
        name: "My Own Namespace",
        mode: "instant",
      });
      expect(at(log, 0).url).toContain("/storage/kv/namespaces");
      expect(at(log, 0).init.method).toBe("GET");
    });

    it("creates a KV namespace with a JSON body (kv)", async () => {
      const { fn, log, schedule } = mockFetcher();
      schedule(
        jsonResponse(
          envelope({
            id: "0f2ac74b498b48028cb68387c421e279",
            title: "My Own Namespace",
            jurisdiction: "eu",
            mode: "instant",
            supports_url_encoding: true,
          }),
        ),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const created = await client.createKvNamespace({ title: "My Own Namespace", jurisdiction: "eu" });
      expect(created).toMatchObject({ id: "0f2ac74b498b48028cb68387c421e279", name: "My Own Namespace" });
      expect(at(log, 0).url).toContain("/storage/kv/namespaces");
      expect(at(log, 0).init.method).toBe("POST");
      const body = at(log, 0).init.body as string;
      expect(JSON.parse(body)).toEqual({ title: "My Own Namespace", jurisdiction: "eu" });
    });

    // Queues — list/create + consumer trigger registration.
    it("parses Queue list from result[] with queue_id/queue_name (queues)", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const queues = await client.listQueues();
      expect(queues).toHaveLength(2);
      expect(queues[0]).toMatchObject({
        id: "f0a0f0a0f0a0f0a0f0a0f0a0f0a0f0a0",
        queue_id: "f0a0f0a0f0a0f0a0f0a0f0a0f0a0f0a0",
        queue_name: "my-queue",
        name: "my-queue",
      });
      expect(at(log, 0).url).toContain("/queues");
      expect(at(log, 0).init.method).toBe("GET");
    });

    it("rejects a Queue list array from the wrong shape (queues)", async () => {
      const { fn, schedule } = fixtureFetcher();
      schedule(jsonResponse(envelope({ not_an_array: true })));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listQueues()).rejects.toMatchObject({ kind: "invalid-response" });
    });

    it("creates a Queue with a JSON body (queues)", async () => {
      const { fn, log, schedule } = mockFetcher();
      schedule(
        jsonResponse(
          envelope({ queue_id: "f0a0f0a0f0a0f0a0f0a0f0a0f0a0f0a0", queue_name: "my-queue" }),
        ),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const created = await client.createQueue({ queue_name: "my-queue" });
      expect(created).toMatchObject({ id: "f0a0f0a0f0a0f0a0f0a0f0a0f0a0f0a0", name: "my-queue" });
      expect(at(log, 0).url).toContain("/queues");
      expect(at(log, 0).init.method).toBe("POST");
      const body = at(log, 0).init.body as string;
      expect(JSON.parse(body)).toEqual({ queue_name: "my-queue" });
    });

    it("registers a Queue consumer trigger via POST /queues/{id}/consumers (queues)", async () => {
      const { fn, log, schedule } = mockFetcher();
      schedule(
        jsonResponse(
          envelope({ consumer_id: "8a6fc8d9-1f0d-4a7b-9f3e-9d3c0d3f2c8a", script_name: "demo-worker" }),
        ),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const created = await client.createQueueConsumer("f0a0f0a0f0a0f0a0f0a0f0a0f0a0f0a0", {
        script_name: "demo-worker",
      });
      expect(created).toMatchObject({ consumer_id: "8a6fc8d9-1f0d-4a7b-9f3e-9d3c0d3f2c8a", script_name: "demo-worker" });
      expect(at(log, 0).url).toContain("/queues/f0a0f0a0f0a0f0a0f0a0f0a0f0a0f0a0/consumers");
      expect(at(log, 0).init.method).toBe("POST");
      const body = at(log, 0).init.body as string;
      expect(JSON.parse(body)).toEqual({ type: "worker", script_name: "demo-worker" });
    });

    it("reads the Worker of a listed Queue consumer from `script` (the live list response shape)", async () => {
      const { fn, schedule } = mockFetcher();
      schedule(
        jsonResponse(
          envelope([{ consumer_id: "8a6fc8d9-1f0d-4a7b-9f3e-9d3c0d3f2c8a", script: "demo-worker", type: "worker", queue_name: "jobs", settings: { batch_size: 10 } }]),
        ),
      );
      const client = createCloudflareClient({ accessToken: TOKEN, accountId: ACCOUNT_ID, fetcher: fn });
      const [consumer] = await client.listQueueConsumers("f0a0f0a0f0a0f0a0f0a0f0a0f0a0f0a0");
      expect(consumer).toMatchObject({ consumer_id: "8a6fc8d9-1f0d-4a7b-9f3e-9d3c0d3f2c8a", script_name: "demo-worker", type: "worker" });
    });

    it("updates a Queue consumer trigger via PUT /queues/{id}/consumers/{consumer_id} (queues)", async () => {
      const { fn, log, schedule } = mockFetcher();
      schedule(
        jsonResponse(
          envelope({ consumer_id: "8a6fc8d9-1f0d-4a7b-9f3e-9d3c0d3f2c8a", script_name: "demo-worker" }),
        ),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const created = await client.putQueueConsumer("f0a0f0a0f0a0f0a0f0a0f0a0f0a0f0a0", "8a6fc8d9-1f0d-4a7b-9f3e-9d3c0d3f2c8a", {
        script_name: "demo-worker",
      });
      expect(created).toMatchObject({ consumer_id: "8a6fc8d9-1f0d-4a7b-9f3e-9d3c0d3f2c8a", script_name: "demo-worker" });
      expect(at(log, 0).url).toContain(
        "/queues/f0a0f0a0f0a0f0a0f0a0f0a0f0a0f0a0/consumers/8a6fc8d9-1f0d-4a7b-9f3e-9d3c0d3f2c8a",
      );
      expect(at(log, 0).init.method).toBe("PUT");
    });

    // Hyperdrive — list/create.
    it("parses Hyperdrive config list from result[] with id/name (hyperdrive)", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const configs = await client.listHyperdriveConfigs();
      expect(configs).toHaveLength(2);
      expect(configs[0]).toMatchObject({
        id: "0f2ac74b498b48028cb68387c421e279",
        name: "my-hyperdrive",
      });
      expect(at(log, 0).url).toContain("/hyperdrive/configs");
      expect(at(log, 0).init.method).toBe("GET");
    });

    it("rejects a Hyperdrive config list array from the wrong shape (hyperdrive)", async () => {
      const { fn, schedule } = fixtureFetcher();
      schedule(jsonResponse(envelope({ not_an_array: true })));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listHyperdriveConfigs()).rejects.toMatchObject({ kind: "invalid-response" });
    });

    // Vectorize indexes — list/create.
    it("parses Vectorize index list from result[] with id/name/config (vectorize)", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const indexes = await client.listVectorizeIndexes();
      expect(indexes).toHaveLength(2);
      expect(indexes[0]).toMatchObject({
        id: "848a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
        name: "my-index",
        config: { dimensions: 768, metric: "cosine" },
        description: "Search over notes",
      });
      expect(indexes[1]).toMatchObject({
        name: "legacy-index",
        config: { preset: "@cf/baai/bge-small-en-v1.5" },
      });
      expect(at(log, 0).url).toContain("/vectorize/v2/indexes");
      expect(at(log, 0).init.method).toBe("GET");
    });

    it("rejects a Vectorize index list array from the wrong shape (vectorize)", async () => {
      const { fn, schedule } = fixtureFetcher();
      schedule(jsonResponse(envelope({ not_an_array: true })));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listVectorizeIndexes()).rejects.toMatchObject({ kind: "invalid-response" });
    });

    it("creates a Vectorize index with a config body (vectorize)", async () => {
      const { fn, log, schedule } = mockFetcher();
      schedule(
        jsonResponse(
          envelope({
            id: "848a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            name: "my-index",
            config: { dimensions: 768, metric: "cosine" },
          }),
        ),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const created = await client.createVectorizeIndex({
        name: "my-index",
        config: { dimensions: 768, metric: "cosine" },
      });
      expect(created).toMatchObject({ id: "848a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0", name: "my-index", config: { dimensions: 768, metric: "cosine" } });
      expect(at(log, 0).url).toContain("/vectorize/v2/indexes");
      expect(at(log, 0).init.method).toBe("POST");
      const body = at(log, 0).init.body as string;
      expect(JSON.parse(body)).toEqual({ name: "my-index", config: { dimensions: 768, metric: "cosine" } });
    });

    // Secrets Store — stores + secrets list/create.
    it("parses Secrets Store store list from result[] with id/name (secrets-store)", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const stores = await client.listSecretsStores();
      expect(stores).toHaveLength(2);
      expect(stores[0]).toMatchObject({
        id: "11111111111111111111111111111111",
        name: "my-secrets-store",
      });
      expect(at(log, 0).url).toContain("/secrets_store/stores");
      expect(at(log, 0).init.method).toBe("GET");
    });

    it("rejects a Secrets Store store list array from the wrong shape (secrets-store)", async () => {
      const { fn, schedule } = fixtureFetcher();
      schedule(jsonResponse(envelope({ not_an_array: true })));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listSecretsStores()).rejects.toMatchObject({ kind: "invalid-response" });
    });

    it("parses Secrets Store secret list from result[] with id/name/store_id and no value (secrets-store)", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const secrets = await client.listSecretsStoreSecrets("11111111111111111111111111111111");
      expect(secrets).toHaveLength(2);
      const first = secrets[0] as unknown as Record<string, unknown>;
      expect(first).toMatchObject({
        id: "33333333333333333333333333333333",
        name: "api-token",
        store_id: "11111111111111111111111111111111",
      });
      expect("value" in first).toBe(false);
      expect(at(log, 0).url).toContain("/secrets_store/stores/11111111111111111111111111111111/secrets");
      expect(at(log, 0).init.method).toBe("GET");
    });

    it("rejects a Secrets Store secret list array from the wrong shape (secrets-store)", async () => {
      const { fn, schedule } = fixtureFetcher();
      schedule(jsonResponse(envelope({ not_an_array: true })));
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listSecretsStoreSecrets("11111111111111111111111111111111")).rejects.toMatchObject({ kind: "invalid-response" });
    });

    it("lists Pages projects from the official /pages/projects array shape", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const projects = await client.listPages();
      expect(projects).toHaveLength(1);
      const first = projects[0] as PagesProjectSummary;
      expect(first).toMatchObject({
        id: "project-id-1",
        name: "my-pages-app",
        subdomain: "my-pages-app.pages.dev",
        domains: ["my-pages-app.pages.dev", "example.com"],
      });
      expect(first.latestDeployment).toMatchObject({
        id: "deployment-id-1",
        url: "https://my-pages-app.pages.dev",
        environment: "production",
      });
      // Uses the documented account-scoped route: GET /accounts/{id}/pages/projects.
      expect(at(log, 0).url).toContain(`/accounts/${ACCOUNT_ID}/pages/projects`);
      expect(at(log, 0).init.method).toBe("GET");
    });

    it("fails closed on a malformed Pages project entry", async () => {
      const { fn, schedule } = mockFetcher();
      schedule(
        jsonResponse(
          envelope([{ id: "x", created_on: "2026-01-01T00:00:00Z" }]), // missing name
        ),
      );
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      await expect(client.listPages()).rejects.toMatchObject({ kind: "invalid-response" });
    });

    it("reads worker settings bindings as the valid metadata route", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const settings = await client.getWorkerSettings(SCRIPT);
      expect(settings.bindings).toHaveLength(2);
      expect(settings.bindings).toContainEqual({ name: "RL", type: "ratelimit" });
      expect(at(log, 0).url).toContain(`/workers/scripts/${SCRIPT}/settings`);
    });
  });

  describe("DNS / zone / route / custom-domain contract (official shapes from fixtures)", () => {
    it("lists zones via GET /zones (zone.read selector)", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const zones = await client.listZones();
      expect(zones).toHaveLength(2);
      expect(zones[0]).toMatchObject({ id: "023e105f4ecef8ad9ca31a8372d0c353", name: "example.com" });
      expect(at(log, 0).url).toMatch(/\/client\/v4\/zones$/);
      expect(at(log, 0).init.method).toBe("GET");
    });

    it("lists DNS records via GET /zones/{zone_id}/dns_records (DNS Write accepts list)", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const records = await client.listDnsRecords("023e105f4ecef8ad9ca31a8372d0c353");
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ id: "023e105f4ecef8ad9ca31a8372d0c353", type: "A", name: "www.example.com" });
      expect(at(log, 0).url).toContain(`/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records`);
    });

    it("lists Workers routes via GET /zones/{zone_id}/workers/routes (Workers Routes Write)", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const routes = await client.listWorkerRoutes("023e105f4ecef8ad9ca31a8372d0c353");
      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({ id: "023e105f4ecef8ad9ca31a8372d0c353", pattern: "example.com/*" });
      expect(at(log, 0).url).toContain(`/zones/023e105f4ecef8ad9ca31a8372d0c353/workers/routes`);
    });

    it("lists Workers custom domains via GET /accounts/{id}/workers/domains", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const domains = await client.listWorkerDomains();
      expect(domains).toHaveLength(1);
      expect(domains[0]).toMatchObject({ id: "023e105f4ecef8ad9ca31a8372d0c353", hostname: "app.example.com" });
      expect(at(log, 0).url).toContain(`/accounts/${ACCOUNT_ID}/workers/domains`);
    });

    it("lists Pages custom domains via GET /accounts/{id}/pages/projects/{name}/domains", async () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      const domains = await client.listPagesDomains("my-pages-app");
      expect(domains).toHaveLength(1);
      expect(domains[0]).toMatchObject({ name: "docs.example.com", status: "active" });
      expect(at(log, 0).url).toContain(`/accounts/${ACCOUNT_ID}/pages/projects/my-pages-app/domains`);
    });

    it("fails closed on an invalid zone id before any fetch", () => {
      const { fn, log } = fixtureFetcher();
      const client = createCloudflareClient({
        accessToken: TOKEN,
        accountId: ACCOUNT_ID,
        fetcher: fn,
      });
      expect(() => client.listDnsRecords("not-a-zone!")).toThrow(/Invalid Cloudflare zone id/i);
      expect(log).toHaveLength(0);
    });
  });
});
