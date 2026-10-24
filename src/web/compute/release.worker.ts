/// <reference lib="webworker" />
import { analyzeRelease } from "./analyze-release.js";
import { getPagesHasher } from "./pages-hasher.js";
import { RELEASE_COMPUTE_PROTOCOL, SOURCE_METHODS, type ReleaseComputeRequest, type ReleaseComputeResponse } from "./protocol.js";
import { createSourceStore, type SourceAccessor } from "./source-store.js";

let store: SourceAccessor | undefined;

// Every byte buffer in a result is a fresh copy owned by that result, so it can
// move to the page without detaching the Worker's retained source.
const buffersOf = (value: unknown): ArrayBuffer[] =>
  value instanceof Uint8Array ? [value.buffer as ArrayBuffer]
    : Array.isArray(value) ? value.flatMap(buffersOf)
      : value !== null && typeof value === "object" ? Object.values(value).flatMap(buffersOf)
        : [];

const reply = (response: ReleaseComputeResponse) => self.postMessage(response, response.type === "source-result" ? buffersOf(response.value) : []);

self.onmessage = async (event: MessageEvent<ReleaseComputeRequest>) => {
  const request = event.data;
  if (request?.v !== RELEASE_COMPUTE_PROTOCOL) return;
  try {
    if (request.type === "analyze") {
      // Pages units are hashed with BLAKE3: use the WASM engine for them (same digest as the server's JS one).
      const pagesHash = request.policy.units.some((unit) => unit.kind === "pages") ? (await getPagesHasher()).hash : undefined;
      const analysis = await analyzeRelease(new Uint8Array(request.buffer), request.policy, pagesHash ? { pagesHash } : {});
      if (!analysis.ok) return reply({ v: RELEASE_COMPUTE_PROTOCOL, id: request.id, type: "analysis", analysis });
      store = createSourceStore(analysis.files, async () => (await getPagesHasher()).hash);
      reply({ v: RELEASE_COMPUTE_PROTOCOL, id: request.id, type: "analysis", analysis: { ok: true, summary: analysis.summary } });
    } else if (request.type === "source-call") {
      if (!store || !SOURCE_METHODS.includes(request.method)) throw new Error("no retained source for this request");
      const call = store[request.method] as (...args: unknown[]) => Promise<unknown>;
      reply({ v: RELEASE_COMPUTE_PROTOCOL, id: request.id, type: "source-result", value: await call.apply(store, request.args) });
    }
  } catch (error) {
    reply({ v: RELEASE_COMPUTE_PROTOCOL, id: request.id, type: "failed", message: error instanceof Error ? error.message : String(error) });
  }
};
