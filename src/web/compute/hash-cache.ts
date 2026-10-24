// Per-source cache of upload hashes. An upload hash is a pure function of the
// file bytes and its extension, so the key is (algorithm, content SHA-256,
// extension exactly as that algorithm sees it): Workers hashes keep the
// extension's case, Pages hashes lowercase it. The cache lives and dies with
// one source (it is never shared across ZIPs, tabs or sessions) and holds
// public content digests only.

export type UploadHashKind = "workers" | "pages";

const MAX_ENTRIES = 4096;

export class UploadHashCache {
  private readonly entries = new Map<string, string>();

  get(kind: UploadHashKind, contentSha256: string, extension: string): string | undefined {
    return this.entries.get(`${kind}\0${contentSha256}\0${extension}`);
  }

  set(kind: UploadHashKind, contentSha256: string, extension: string, hash: string): void {
    if (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(`${kind}\0${contentSha256}\0${extension}`, hash);
  }

  get size(): number {
    return this.entries.size;
  }
}

// The extension each algorithm appends to the base64 text (no leading dot; a
// dotfile has none). Mirrors assetUploadHash / pagesAssetHash exactly.
export function uploadHashExtension(kind: UploadHashKind, path: string): string {
  const filename = path.split("/").at(-1) ?? "";
  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 ? filename.slice(dot + 1) : "";
  return kind === "pages" ? extension.toLowerCase() : extension;
}
