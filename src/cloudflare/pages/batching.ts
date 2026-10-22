// Client-side Pages asset batching.
//
// Pages assets upload as a JSON array of parts in batches bounded by
// MAX_BUCKET_SIZE (40 MiB) and MAX_BUCKET_FILE_COUNT (2000 files) per POST.
// This splits the asset set into such buckets; duplicates across buckets are
// uploaded once.

import { PAGES_MAX_BUCKET_FILE_COUNT, PAGES_MAX_BUCKET_SIZE } from "./constants.js";

export interface PagesBucketEntry {
  hash: string;
  size: number;
}

export function planPagesBuckets(
  entries: PagesBucketEntry[],
  maxBytes = PAGES_MAX_BUCKET_SIZE,
  maxFiles = PAGES_MAX_BUCKET_FILE_COUNT,
): PagesBucketEntry[][] {
  const buckets: PagesBucketEntry[][] = [];
  let current: PagesBucketEntry[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    if (entry.size > maxBytes) {
      throw new Error(`Pages asset exceeds ${maxBytes} byte bucket limit`);
    }
    if (current.length > 0 && (currentBytes + entry.size > maxBytes || current.length >= maxFiles)) {
      buckets.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entry.size;
  }
  if (current.length > 0) {
    buckets.push(current);
  }
  return buckets;
}
