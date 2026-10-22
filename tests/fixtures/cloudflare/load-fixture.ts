// load the documented Cloudflare wire-schema fixtures and serve them over
// a mock fetcher. These are static JSON files under tests/fixtures/cloudflare
// that reproduce the *documented provider response shapes* (see each file's
// `source`/`shape`), NOT shapes reconstructed inline to match the client
// implementation. The contract tests drive the real client against these fixed
// fixtures, so a client regression cannot be masked by a self-referential mock.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
);

export interface CloudflareFixture {
  label: string;
  source?: string;
  shape?: string;
  negated?: boolean;
  result?: unknown;
  success?: boolean;
  errors?: unknown[];
  messages?: unknown[];
  response_meta?: { status?: number; headers?: Record<string, string> };
  attached?: unknown;
}

export function readFixture(name: string): CloudflareFixture {
  const raw = readFileSync(path.join(fixtureDir, `${name}.json`), "utf8");
  return JSON.parse(raw) as CloudflareFixture;
}

/** The documented success envelope used by Cloudflare v4 responses. */
function envelope(result: unknown): Record<string, unknown> {
  return { success: true, errors: [], messages: [], result };
}

/** Build a Response from a fixture's `result` using the success envelope. */
export function fixtureResponse(fixture: CloudflareFixture): Response {
  const status = fixture.response_meta?.status ?? 200;
  const headers = {
    "content-type": "application/json",
    ...(fixture.response_meta?.headers ?? {}),
  };
  const body =
    fixture.success === false
      ? { success: false, errors: fixture.errors ?? [], messages: [] }
      : envelope(fixture.result);
  return new Response(JSON.stringify(body), { status, headers });
}
