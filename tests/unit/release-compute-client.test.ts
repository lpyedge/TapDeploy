import { describe, expect, it, vi } from "vitest";
import { startReleaseAnalysis, ReleaseAnalysisCancelled } from "../../src/web/compute/client.js";
import { RELEASE_COMPUTE_PROTOCOL, type AnalyzeRequest, type ReleaseComputeRequest, type WireAnalysis } from "../../src/web/compute/protocol.js";
import type { PrebuiltReleasePolicy } from "../../src/release/verify-prebuilt-release.js";

const policy: PrebuiltReleasePolicy = { allowLocalZip: true, appId: "a/b", units: [] };
const accepted: WireAnalysis = { ok: true, summary: { archiveSha256: "a", manifestDigest: "m", entryCount: 1, units: [], resources: [] } };
const V = RELEASE_COMPUTE_PROTOCOL;

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  requests: ReleaseComputeRequest[] = [];
  postMessage(message: ReleaseComputeRequest) { this.requests.push(message); }
  terminate() { this.terminated = true; }
  reply(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
const harness = () => {
  const worker = new FakeWorker();
  return { worker, spawn: () => worker as unknown as Worker };
};
const nthRequest = async <T extends ReleaseComputeRequest>(worker: FakeWorker, n: number): Promise<T> => {
  while (worker.requests.length < n) await new Promise((r) => setTimeout(r, 0));
  return worker.requests[n - 1] as T;
};
const accept = async (worker: FakeWorker, spawn: () => Worker) => {
  const job = startReleaseAnalysis(new Blob([new Uint8Array([1, 2, 3])]), policy, spawn);
  const request = await nthRequest<AnalyzeRequest>(worker, 1);
  worker.reply({ v: V, id: request.id, type: "analysis", analysis: accepted });
  const analysis = await job.result;
  if (!analysis.ok) throw new Error("expected an accepted analysis");
  return { job, request, access: analysis.access };
};

describe("release analysis client", () => {
  it("sends one versioned analyze request; an accepted ZIP keeps its Worker alive behind the accessor", async () => {
    const { worker, spawn } = harness();
    const { request, access } = await accept(worker, spawn);
    expect(request).toMatchObject({ v: V, type: "analyze", policy });
    expect(request.buffer.byteLength).toBe(3);
    expect(worker.terminated).toBe(false);
    expect(typeof access.dispose).toBe("function");
  });

  it("accessor calls are fixed-method requests answered by matching id", async () => {
    const { worker, spawn } = harness();
    const { access } = await accept(worker, spawn);
    const read = access.readFile("worker/main.mjs");
    const call = await nthRequest<Extract<ReleaseComputeRequest, { type: "source-call" }>>(worker, 2);
    expect(call).toMatchObject({ v: V, type: "source-call", method: "readFile", args: ["worker/main.mjs"] });
    worker.reply({ v: V, id: call.id + 1, type: "source-result", value: new Uint8Array([9]) });
    worker.reply({ v: 99, id: call.id, type: "source-result", value: new Uint8Array([8]) });
    worker.reply({ v: V, id: call.id, type: "source-result", value: new Uint8Array([7]) });
    await expect(read).resolves.toEqual(new Uint8Array([7]));
    const assets = access.workerAssetFiles("public", ["h1"]);
    const second = await nthRequest<Extract<ReleaseComputeRequest, { type: "source-call" }>>(worker, 3);
    expect(second).toMatchObject({ method: "workerAssetFiles", args: ["public", ["h1"]] });
    worker.reply({ v: V, id: second.id, type: "failed", message: "absent hash" });
    await expect(assets).rejects.toThrow("absent hash");
  });

  it("dispose terminates the Worker, rejects pending calls and refuses later ones", async () => {
    const { worker, spawn } = harness();
    const { access } = await accept(worker, spawn);
    const pending = access.listFiles();
    await nthRequest(worker, 2);
    access.dispose();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow("released");
    await expect(access.readFile("x")).rejects.toThrow("released");
  });

  it("a Worker crash fails pending source calls", async () => {
    const { worker, spawn } = harness();
    const { access } = await accept(worker, spawn);
    const pending = access.pagesManifest("site");
    await nthRequest(worker, 2);
    worker.onerror?.({ message: "" } as ErrorEvent);
    await expect(pending).rejects.toThrow("release source worker crashed");
    expect(worker.terminated).toBe(true);
  });

  it("a refusal resolves with the refusal and terminates the Worker (no source is kept)", async () => {
    const { worker, spawn } = harness();
    const job = startReleaseAnalysis(new Blob([new Uint8Array(1)]), policy, spawn);
    const request = await nthRequest<AnalyzeRequest>(worker, 1);
    worker.reply({ v: V, id: request.id, type: "analysis", analysis: { ok: false, status: 400, body: { error: "INVALID_PREBUILT_ZIP", detail: "x" } } });
    await expect(job.result).resolves.toEqual({ ok: false, status: 400, body: { error: "INVALID_PREBUILT_ZIP", detail: "x" } });
    expect(worker.terminated).toBe(true);
  });

  it("ignores analysis messages for another job or protocol version", async () => {
    const { worker, spawn } = harness();
    const job = startReleaseAnalysis(new Blob([new Uint8Array(1)]), policy, spawn);
    const request = await nthRequest<AnalyzeRequest>(worker, 1);
    worker.reply({ v: V, id: request.id + 1, type: "analysis", analysis: accepted });
    worker.reply({ v: 99, id: request.id, type: "analysis", analysis: accepted });
    expect(worker.terminated).toBe(false);
    worker.reply({ v: V, id: request.id, type: "analysis", analysis: accepted });
    await expect(job.result).resolves.toMatchObject({ ok: true });
  });

  it("cancel before the verdict terminates the Worker, rejects, and a late response cannot resolve", async () => {
    const { worker, spawn } = harness();
    const job = startReleaseAnalysis(new Blob([new Uint8Array(1)]), policy, spawn);
    const request = await nthRequest<AnalyzeRequest>(worker, 1);
    job.cancel();
    expect(worker.terminated).toBe(true);
    await expect(job.result).rejects.toBeInstanceOf(ReleaseAnalysisCancelled);
    worker.reply({ v: V, id: request.id, type: "analysis", analysis: accepted });
    await expect(job.result).rejects.toBeInstanceOf(ReleaseAnalysisCancelled);
  });

  it("a browser without Worker support gets an actionable error instead of a crash", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(startReleaseAnalysis(new Blob([new Uint8Array(1)]), policy).result).rejects.toThrow("cannot run the background check");
    vi.unstubAllGlobals();
  });

  it("a Worker that dies silently is reported with the likely cause and a way out", async () => {
    const { worker, spawn } = harness();
    const job = startReleaseAnalysis(new Blob([new Uint8Array(1)]), policy, spawn);
    await nthRequest(worker, 1);
    worker.onerror?.({ message: "" } as ErrorEvent);
    await expect(job.result).rejects.toThrow(/out of memory.*smaller ZIP/);
  });

  it("cancelling before the file is read never starts a Worker", async () => {
    let spawnCount = 0;
    const job = startReleaseAnalysis(new Blob([new Uint8Array(1)]), policy, () => { spawnCount++; return new FakeWorker() as unknown as Worker; });
    job.cancel();
    await expect(job.result).rejects.toBeInstanceOf(ReleaseAnalysisCancelled);
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnCount).toBe(0);
  });

  it("surfaces an analysis failure message and a crash before the verdict as errors", async () => {
    const failing = harness();
    const failed = startReleaseAnalysis(new Blob([new Uint8Array(1)]), policy, failing.spawn);
    const failedRequest = await nthRequest<AnalyzeRequest>(failing.worker, 1);
    failing.worker.reply({ v: V, id: failedRequest.id, type: "failed", message: "boom" });
    await expect(failed.result).rejects.toThrow("boom");

    const crashing = harness();
    const crashed = startReleaseAnalysis(new Blob([new Uint8Array(1)]), policy, crashing.spawn);
    await nthRequest(crashing.worker, 1);
    crashing.worker.onerror?.({ message: "" } as ErrorEvent);
    await expect(crashed.result).rejects.toThrow("release analysis worker crashed");
    expect(crashing.worker.terminated).toBe(true);
  });
});
