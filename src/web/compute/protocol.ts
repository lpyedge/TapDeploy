// Versioned message contract between the page and the release compute Worker.
// The Worker is pure browser compute: it never receives a session, token or
// provider credential, and its verdict is early feedback only. The server
// re-verifies the same bytes at /api/deploy/prepare before any proof exists.
//
// One Worker owns one source: `analyze` unpacks and checks the ZIP, then the
// extracted files stay in the Worker and the page asks `source-call` questions
// (a fixed allowlist of addressing operations) for only the bytes it needs.

import type { PrebuiltReleasePolicy, PrebuiltReleaseRefusal, ReleaseSummary } from "../../release/verify-prebuilt-release.js";
import type { SourceAccessor } from "./source-store.js";

export const RELEASE_COMPUTE_PROTOCOL = 1;

export const SOURCE_METHODS = ["listFiles", "readFile", "workerAssetIndex", "workerAssetFiles", "pagesManifest", "pagesFiles"] as const;
export type SourceMethod = (typeof SOURCE_METHODS)[number];

export interface AnalyzeRequest {
  v: typeof RELEASE_COMPUTE_PROTOCOL;
  id: number;
  type: "analyze";
  /** Transferred to the Worker (detached on the sending side). */
  buffer: ArrayBuffer;
  policy: PrebuiltReleasePolicy;
}

export interface SourceCallRequest {
  v: typeof RELEASE_COMPUTE_PROTOCOL;
  id: number;
  type: "source-call";
  method: SourceMethod;
  args: unknown[];
}

export type ReleaseComputeRequest = AnalyzeRequest | SourceCallRequest;

/** What crosses the wire: a verdict and a bounded summary, never the files. */
export type WireAnalysis = { ok: true; summary: ReleaseSummary } | ({ ok: false } & PrebuiltReleaseRefusal);

/** What the page holds: the summary plus the accessor onto the Worker-held source. */
export type ReleaseAnalysis = { ok: true; summary: ReleaseSummary; access: SourceAccessor } | ({ ok: false } & PrebuiltReleaseRefusal);

export type ReleaseComputeResponse =
  | { v: typeof RELEASE_COMPUTE_PROTOCOL; id: number; type: "analysis"; analysis: WireAnalysis }
  | { v: typeof RELEASE_COMPUTE_PROTOCOL; id: number; type: "source-result"; value: unknown }
  | { v: typeof RELEASE_COMPUTE_PROTOCOL; id: number; type: "failed"; message: string };
