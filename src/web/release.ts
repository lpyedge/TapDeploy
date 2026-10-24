// Browser-side release loading. Public HTTPS ZIPs are fetched directly by the
// browser (and must opt into CORS). GitHub release download hosts do not send
// CORS headers, so only that fixed allowlist uses the authenticated, bounded
// same-origin relay; ZIP extraction and integrity checking remain in-browser.

import type { SourceAccessor } from "./compute/source-store.js";
import { parse as parseJsonc } from "jsonc-parser";
import { base64String } from "../core/encoding/base64-ascii.js";
import { readBoundedResponse } from "../core/bounded-response.js";
import { RELEASE_MAX_BYTES } from "../core/upload-limits.js";
import { isRelayedDownloadHost } from "../release/url.js";
import { checkPublicHttpsUrl } from "../core/config-entry.js";
import { fetchBounded, formatBytes } from "./lib/guarded-fetch.js";

const RELEASE_FETCH_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// V3 sealed-graph source bridge.
//
// Both ZIP sources (HTTPS URL bytes, local file bytes) converge here: the
// EXACT bytes are retained as a Blob for the tab flow, the authenticated prepare
// route receives those identical bytes, and every action-time module payload is
// re-read from the retained bytes — never from a mutated in-memory copy and
// never re-downloaded. The server rehashes every byte against the sealed
// per-unit bundle before any provider mutation, so a browser-side mixup fails
// closed (4xx, zero writes) instead of deploying unapproved code.
// ---------------------------------------------------------------------------

export interface V3RetainedSource {
  /** The exact ZIP the server re-verifies; read fresh for each use, never a detached buffer. */
  blob: Blob;
  /** Addressing onto the extracted files, which live in the compute Worker. */
  access: SourceAccessor;
  label: string;
}

/** Read one exact file from the retained source; unknown paths fail closed. */
export function v3ModuleBytes(source: V3RetainedSource, path: string): Promise<Uint8Array> {
  return source.access.readFile(path);
}

export interface V3WorkerStepBytes {
  scriptB64: string;
  additionalModules: { name: string; contentB64: string }[];
}

/**
 * Re-encode the exact Worker upload payload from the retained source at action
 * time. `mainPath` + `extraPaths` are addressing hints only (parsed by the
 * browser from its own copy of the unit Wrangler); the server verifies every
 * byte against the sealed bundle before dispatch.
 */
export async function v3WorkerStepBytes(
  source: V3RetainedSource,
  mainPath: string,
  extraPaths: string[],
): Promise<V3WorkerStepBytes> {
  const scriptB64 = base64String(await v3ModuleBytes(source, mainPath));
  const additionalModules: V3WorkerStepBytes["additionalModules"] = [];
  for (const name of new Set(extraPaths)) {
    if (name !== mainPath) additionalModules.push({ name, contentB64: base64String(await v3ModuleBytes(source, name)) });
  }
  return { scriptB64, additionalModules };
}

/** Directory prefix (with trailing slash, or "") of a unit Wrangler path. */
export function v3UnitDirOf(wranglerPath: string): string {
  return wranglerPath.includes("/") ? wranglerPath.slice(0, wranglerPath.lastIndexOf("/") + 1) : "";
}
// Addressing-only mirror of the server's resolveZipRelativePath
// (src/manifest/wrangler-v3.ts): ZIP-relative dot-segment resolution used to
// locate the unit Wrangler's declared files inside the retained source. The
// server re-resolves authoritatively; any divergence fails closed there.
export function resolveV3UnitRelative(baseDir: string, rel: string): string | null {
  if (rel.includes("\0")) return null;
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const segments = [...(baseDir === "" ? [] : baseDir.split("/")), ...normalized.split("/")];
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length > 0 ? out.join("/") : null;
}

export interface V3UnitWorkerPaths {
  wranglerPath: string;
  main: string;
  extras: string[];
}

/**
 * Derive a worker unit's upload file set from the retained source the same way
 * the server projection does: every .mjs/.js/.wasm file under the unit prefix
 * except the Wrangler file itself and the declared asset directory. Addressing
 * only — the server verifies the exact set and every byte before dispatch.
 */
export async function v3UnitWorkerPaths(
  source: V3RetainedSource,
  wranglerPath: string,
): Promise<V3UnitWorkerPaths> {
  const text = new TextDecoder().decode(await v3ModuleBytes(source, wranglerPath));
  const parsed = parseJsonc(text) as { main?: unknown; assets?: { directory?: unknown } };
  const prefix = v3UnitDirOf(wranglerPath);
  const baseDir = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const mainRaw = typeof parsed.main === "string" ? parsed.main : "";
  const main = mainRaw ? resolveV3UnitRelative(baseDir, mainRaw) : null;
  if (!main) throw new Error(`unit Wrangler "${wranglerPath}" does not declare a resolvable main module`);
  const assetsRaw = parsed.assets && typeof parsed.assets === "object" ? (parsed.assets as { directory?: unknown }).directory : undefined;
  const assetsDir = typeof assetsRaw === "string" && assetsRaw ? resolveV3UnitRelative(baseDir, assetsRaw) : null;
  const modules = (await source.access.listFiles())
    .filter((entry) => entry.path.startsWith(prefix) && entry.path !== wranglerPath && (assetsDir === null || !entry.path.startsWith(`${assetsDir}/`)) && (entry.path.endsWith(".mjs") || entry.path.endsWith(".js") || entry.path.endsWith(".wasm")))
    .map((entry) => entry.path)
    .sort();
  if (!modules.includes(main)) throw new Error(`main module "${main}" is not part of the retained source`);
  return { wranglerPath, main, extras: modules.filter((path) => path !== main) };
}
// GitHub release downloads go through the installer (they send no CORS headers);
// any other host is fetched by the browser itself and must allow that.
export async function fetchReleaseBytes(url: string, csrf: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (!checkPublicHttpsUrl(url, "release").ok) throw new Error("release URL must use HTTPS and not target a private/local host");
  if (isRelayedDownloadHost(url)) return fetchViaInstaller(url, csrf, signal);
  try {
    return await fetchBounded(url, {
      ...(signal ? { signal } : {}),
      maxBytes: RELEASE_MAX_BYTES,
      accept: "application/zip, application/octet-stream",
      timeoutMs: RELEASE_FETCH_TIMEOUT_MS,
      label: "release ZIP",
      checkFinalUrl: (final) => (checkPublicHttpsUrl(final, "release").ok ? null : "release redirected to a disallowed URL"),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        "The browser could not download this URL (the host does not allow cross-origin downloads). Use a GitHub release, a host that sends CORS headers, or choose the file with Local ZIP.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function fetchViaInstaller(url: string, csrf: string, signal?: AbortSignal): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("/api/release/download", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tapdeploy-csrf": csrf },
      body: JSON.stringify({ url }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new Error(timeout.aborted ? "release ZIP download timed out" : "could not reach the installer to download the release");
  }
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as { error?: string; detail?: string; size?: number; limit?: number; status?: number } | null;
    if (problem?.error === "too_large") {
      throw new Error(`release ZIP is ${formatBytes(problem.size ?? 0)}; the limit is ${formatBytes(problem.limit ?? RELEASE_MAX_BYTES)}`);
    }
    if (problem?.error === "upstream_status" && problem.status === 404) throw new Error("release ZIP not found (HTTP 404)");
    throw new Error(`could not download the release (${problem?.detail ?? problem?.error ?? `HTTP ${res.status}`})`);
  }
  return readBoundedResponse(res, RELEASE_MAX_BYTES);
}
