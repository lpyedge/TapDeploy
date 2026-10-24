import { pagesAssetHash } from "../../src/cloudflare/pages/manifest.js";
import { createSourceStore } from "../../src/web/compute/source-store.js";
import { extractZipAsync } from "../../src/web/lib/zip.js";
import type { V3RetainedSource } from "../../src/web/release.js";

// Test stand-in for what the compute Worker holds: the exact ZIP plus an in-memory source store.
export async function retainedSource(zip: Uint8Array, label: string): Promise<V3RetainedSource> {
  const extracted = await extractZipAsync(zip);
  if (!extracted.ok || !extracted.files) throw new Error(extracted.error ?? "ZIP did not extract");
  return { blob: new Blob([zip as BlobPart]), access: createSourceStore(extracted.files, async () => pagesAssetHash), label };
}
