// Download an untrusted URL from the browser with its size decided up front.
//
// 1. HEAD first: a declared Content-Length over the limit is refused before any
//    body byte is requested. HEAD can be blocked (CORS, 405); that is not an
//    error, the bounded GET below is still authoritative.
// 2. GET with the same declared-length check, a streaming byte cap (covers
//    chunked / lying responses), a redirect-target policy check and a timeout
//    so a slow or endless response cannot hang the wizard.

import { readBoundedResponse } from "../../core/bounded-response.js";

export interface GuardedFetchOptions {
  maxBytes: number;
  accept: string;
  timeoutMs: number;
  /** What is being downloaded, for error messages ("config", "release ZIP"). */
  label: string;
  /** Rejects a final (post-redirect) URL; returns an error message or null. */
  checkFinalUrl: (url: string) => string | null;
  signal?: AbortSignal;
}

export class DownloadRefusedError extends Error {
  constructor(message: string, readonly field = "$source.url") {
    super(message);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function refuseIfTooLarge(res: Response, opts: GuardedFetchOptions): void {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    throw new DownloadRefusedError(`${opts.label} is ${formatBytes(declared)}; the limit is ${formatBytes(opts.maxBytes)}`);
  }
  if (res.url) {
    const problem = opts.checkFinalUrl(res.url);
    if (problem) throw new DownloadRefusedError(problem);
  }
}

export async function fetchBounded(url: string, opts: GuardedFetchOptions): Promise<Uint8Array> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;
  try {
    let head: Response | null = null;
    try {
      head = await fetch(url, { method: "HEAD", headers: { Accept: opts.accept }, signal });
    } catch {
      head = null;
    }
    signal.throwIfAborted();
    if (head) {
      await head.body?.cancel();
      if (head.ok) refuseIfTooLarge(head, opts);
    }
    const res = await fetch(url, { headers: { Accept: opts.accept }, signal });
    if (!res.ok) {
      await res.body?.cancel();
      throw new DownloadRefusedError(`${opts.label} URL returned HTTP ${res.status}`);
    }
    try {
      refuseIfTooLarge(res, opts);
    } catch (error) {
      await res.body?.cancel();
      throw error;
    }
    return await readBoundedResponse(res, opts.maxBytes);
  } catch (error) {
    if (timeout.signal.aborted) {
      throw new DownloadRefusedError(`${opts.label} download timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
