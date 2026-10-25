// Client-side handling of the official buckets[][] grouping. Each inner
// array is one POST to the account upload endpoint. Hashes are 32-hex upload
// identifiers; duplicates within or across buckets are uploaded once.

const DEFAULT_MAX_PARTS_PER_BATCH = 64;

// Normalize server buckets for upload: dedupe globally, preserve bucket
// grouping, chunk any oversized bucket to the part cap.
export function splitBucketsForUpload(
  buckets: string[][],
  maxPartsPerBatch = DEFAULT_MAX_PARTS_PER_BATCH,
  bytes?: { sizeOf: (hash: string) => number; maxBytes: number },
): string[][] {
  if (!Number.isInteger(maxPartsPerBatch) || maxPartsPerBatch <= 0) {
    throw new Error("maxPartsPerBatch must be a positive integer");
  }
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const bucket of buckets) {
    const fresh = [...new Set(bucket)].filter((h) => {
      if (seen.has(h)) {
        return false;
      }
      seen.add(h);
      return true;
    });
    let chunk: string[] = [];
    let chunkBytes = 0;
    for (const hash of fresh) {
      const size = bytes ? bytes.sizeOf(hash) : 0;
      if (bytes && size > bytes.maxBytes) {
        throw new Error(`asset is ${size} bytes; the upload limit per file is ${bytes.maxBytes} bytes`);
      }
      if (chunk.length > 0 && (chunk.length >= maxPartsPerBatch || (bytes && chunkBytes + size > bytes.maxBytes))) {
        out.push(chunk);
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(hash);
      chunkBytes += size;
    }
    if (chunk.length > 0) {
      out.push(chunk);
    }
  }
  return out;
}
