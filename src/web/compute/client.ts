// Page-side handles for the release compute Worker. One analysis owns one fresh
// Worker; when it accepts the ZIP, that Worker keeps the extracted source and
// the returned accessor asks it for only what an approved action needs.
// Terminating the Worker (cancel before the verdict, dispose afterwards) is the
// only way to stop a synchronous unzip or release the source, and a terminated
// job can never resolve late.

import type { AssetBucketFile } from "../../cloudflare/assets/upload.js";
import type { PrebuiltReleasePolicy } from "../../release/verify-prebuilt-release.js";
import {
  RELEASE_COMPUTE_PROTOCOL,
  type AnalyzeRequest,
  type ReleaseAnalysis,
  type ReleaseComputeResponse,
  type SourceCallRequest,
  type SourceMethod,
} from "./protocol.js";
import type { SourceAccessor } from "./source-store.js";

export class ReleaseAnalysisCancelled extends Error {
  constructor() { super("release analysis cancelled"); }
}

export interface ReleaseAnalysisJob {
  result: Promise<ReleaseAnalysis>;
  /** Stops an analysis that has no verdict yet; afterwards use `access.dispose()`. */
  cancel(): void;
}

export type SpawnReleaseWorker = () => Worker;

const spawnReleaseWorker: SpawnReleaseWorker = () => {
  if (typeof Worker === "undefined") throw new Error("This browser cannot run the background check this installer needs. Use a current desktop browser.");
  return new Worker(new URL("./release.worker.ts", import.meta.url), { type: "module" });
};

// A Worker that dies without a message is most often the device running out of memory.
const CRASH_HINT = " (the browser may have run out of memory: try a desktop browser or a smaller ZIP)";

let nextMessageId = 0;

function workerAccessor(worker: Worker): SourceAccessor {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  let closed: Error | undefined;
  const close = (reason: Error) => {
    closed ??= reason;
    for (const call of pending.values()) call.reject(reason);
    pending.clear();
    worker.terminate();
  };
  worker.onmessage = (event: MessageEvent<ReleaseComputeResponse>) => {
    const response = event.data;
    if (response?.v !== RELEASE_COMPUTE_PROTOCOL) return;
    const call = pending.get(response.id);
    if (!call) return;
    pending.delete(response.id);
    if (response.type === "source-result") call.resolve(response.value);
    else if (response.type === "failed") call.reject(new Error(response.message));
  };
  worker.onerror = (event) => close(new Error(event.message || `release source worker crashed${CRASH_HINT}`));
  const call = <T,>(method: SourceMethod, ...args: unknown[]): Promise<T> => {
    if (closed) return Promise.reject(closed);
    const id = ++nextMessageId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      const request: SourceCallRequest = { v: RELEASE_COMPUTE_PROTOCOL, id, type: "source-call", method, args };
      worker.postMessage(request);
    });
  };
  return {
    listFiles: () => call("listFiles"),
    readFile: (path) => call("readFile", path),
    workerAssetIndex: (dir) => call("workerAssetIndex", dir),
    workerAssetFiles: (dir, hashes) => call<AssetBucketFile[]>("workerAssetFiles", dir, hashes),
    pagesManifest: (dir) => call("pagesManifest", dir),
    pagesFiles: (dir, hashes) => call("pagesFiles", dir, hashes),
    dispose: () => close(new Error("release source was released")),
  };
}

export function startReleaseAnalysis(blob: Blob, policy: PrebuiltReleasePolicy, spawn: SpawnReleaseWorker = spawnReleaseWorker): ReleaseAnalysisJob {
  const id = ++nextMessageId;
  let worker: Worker | undefined;
  let settled = false;
  let rejectJob: (reason: unknown) => void = () => {};
  const result = new Promise<ReleaseAnalysis>((resolve, reject) => {
    rejectJob = reject;
    void (async () => {
      const buffer = await blob.arrayBuffer();
      if (settled) return;
      const current = spawn();
      worker = current;
      current.onmessage = (event: MessageEvent<ReleaseComputeResponse>) => {
        const response = event.data;
        if (settled || response?.v !== RELEASE_COMPUTE_PROTOCOL || response.id !== id) return;
        settled = true;
        if (response.type === "analysis" && response.analysis.ok) {
          resolve({ ok: true, summary: response.analysis.summary, access: workerAccessor(current) });
          return;
        }
        current.terminate();
        if (response.type === "analysis") resolve(response.analysis as ReleaseAnalysis);
        else if (response.type === "failed") reject(new Error(response.message));
      };
      current.onerror = (event) => {
        if (settled) return;
        settled = true;
        current.terminate();
        reject(new Error(event.message || `release analysis worker crashed${CRASH_HINT}`));
      };
      const request: AnalyzeRequest = { v: RELEASE_COMPUTE_PROTOCOL, id, type: "analyze", buffer, policy };
      current.postMessage(request, [buffer]);
    })().catch((error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
  return {
    result,
    cancel() {
      if (settled) return;
      settled = true;
      worker?.terminate();
      rejectJob(new ReleaseAnalysisCancelled());
    },
  };
}
