import { afterEach, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createApp } from "../../src/api/app.js";
import { deriveSealKey } from "../../src/auth/keys.js";
import { createSession, sessionCookieName } from "../../src/auth/session.js";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";
import { prepareForm, sessionBinding } from "./login.js";

const MiB = 1024 * 1024;
const origin = "https://installer.example";
const secret = "boundary-synthetic-secret";
afterEach(() => vi.unstubAllGlobals());

it("bounds real prepare/relay requests and records 25 sequential prepare measurements", async () => {
  const app = createApp({ RUNTIME: "node", PUBLIC_ORIGIN: origin, OAUTH_CLIENT_SECRET: secret });
  const config: ConfigV3 = { schemaVersion: 3, app: { id: "example/boundary", name: "Boundary" }, source: { allowLocalZip: true }, capabilities: ["workers"], units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }] };
  const configText = JSON.stringify(config);
  const session = await createSession(await deriveSealKey(secret), { ttlMs: 120_000, publicOrigin: origin }, {
    accessToken: "synthetic-only", tokenType: "Bearer", scope: [], source: "boundary", ...(await sessionBinding(config)),
  });
  const auth = { origin, cookie: `${sessionCookieName(origin)}=${session.cookieValue}`, "x-tapdeploy-csrf": session.payload.csrf };
  const files = {
    "wrangler.jsonc": strToU8(JSON.stringify({ name: "boundary", main: "main.mjs", compatibility_date: "2026-10-17" })),
    "main.mjs": strToU8("export default { fetch() { return new Response('ok'); } };"),
    "extra.wasm": new Uint8Array(0),
  };
  const overhead = zipSync(files, { level: 0 }).length;
  const samples: object[] = [];
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { calls++; return Response.json({ success: true }); }));
  // A null type sends the prepare multipart form (config + ZIP); its boundary sets the type.
  async function measure(route: string, body: Uint8Array, type: string | null, expected: number, label: string) {
    const before = process.memoryUsage(); const cpu = process.cpuUsage(); const start = performance.now();
    const response = await app.request(route, { method: "POST", headers: { ...auth, ...(type ? { "content-type": type } : {}), "x-tapdeploy-upload-jwt": "synthetic.jwt.123456789" }, body: type ? body as BodyInit : prepareForm(configText, body) });
    const result = await response.json() as { error?: string };
    expect(response.status, `${label}: ${result.error ?? "ok"}`).toBe(expected);
    const memory = process.memoryUsage();
    samples.push({ label, bytes: body.length, inputSha256: createHash("sha256").update(body).digest("hex"), status: response.status, error: result.error,
      elapsedMs: performance.now() - start, cpuMicros: process.cpuUsage(cpu), rssBefore: before.rss, rssAfter: memory.rss, heapUsed: memory.heapUsed, peakRssKiB: process.resourceUsage().maxRSS });
  }
  for (const size of [0.5 * MiB, 4 * MiB, 8 * MiB, 8 * MiB + 1]) {
    const archive = zipSync({ ...files, "extra.wasm": new Uint8Array(size - overhead) }, { level: 0 });
    expect(archive.length).toBe(size);
    await measure("/api/deploy/prepare", archive, null, size > 8 * MiB ? 413 : 200, `zip-${size}`);
  }
  expect(calls).toBe(0);
  for (const size of [MiB, 8 * MiB, 16 * MiB, 16 * MiB + 1]) {
    const before = calls;
    await measure("/api/upload/assets?target=pages-upload", new Uint8Array(size).fill(32), "application/json", size > 16 * MiB ? 413 : 200, `relay-${size}`);
    expect(calls - before).toBe(size > 16 * MiB ? 0 : 1);
  }
  const tiny = zipSync({ "wrangler.jsonc": files["wrangler.jsonc"], "main.mjs": files["main.mjs"] }, { level: 0 });
  for (let i = 0; i < 25; i++) await measure("/api/deploy/prepare", tiny, null, 200, `sequential-${i + 1}`);
  mkdirSync("temp/test/release-followup", { recursive: true });
  writeFileSync("temp/test/release-followup/limits-node.json", JSON.stringify(samples, null, 2));
}, 60_000);
