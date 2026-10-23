import { Spinner } from "./Spinner.js";
import type { RefObject } from "react";
import { Segmented } from "./Segmented.js";

export type V3ReleaseMode = "url" | "file";

export interface V3ReleasePanelProps {
  releaseMode: V3ReleaseMode;
  /** The parent owns clearing the other side (retained bytes, file input key). */
  onReleaseMode: (mode: V3ReleaseMode) => void;
  assetUrl: string;
  onAssetUrl: (value: string) => void;
  /** The retained local ZIP (label only), or null. */
  source: { label: string } | null;
  fileKey: number;
  fileInputRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
  /** Computed by the flow from the machine (can RELEASE_READY), account and input validity. */
  prepareDisabled: boolean;
  onFile: (file: File) => void;
  onPrepare: () => void;
}

/** Release step: one URL | local ZIP choice and a single Verify button. */
export function V3ReleasePanel({
  releaseMode,
  onReleaseMode,
  assetUrl,
  onAssetUrl,
  source,
  fileKey,
  fileInputRef,
  busy,
  prepareDisabled,
  onFile,
  onPrepare,
}: V3ReleasePanelProps) {
  return (
    <>
      <p className="lead mt-0">Choose the release to install: the publisher's download link, or a release ZIP on this computer. The installer verifies every byte before anything touches Cloudflare.</p>
      <div className="field">
        <span id="v3-source-label" className="sr-only">Release source</span>
        <Segmented
          name="v3-source"
          label="Release source"
          value={releaseMode}
          onChange={onReleaseMode}
          options={[
            { value: "url", label: "Download link", testId: "v3-source-url-mode" },
            { value: "file", label: "ZIP file", testId: "v3-source-file-mode" },
          ]}
        />
        <div className="mt-3" role="group" aria-labelledby="v3-source-label">
          {releaseMode === "url" ? (
            <input id="v3-asset-url" type="url" data-testid="v3-asset-url" value={assetUrl} onChange={(e) => onAssetUrl(e.target.value)} placeholder="https://example.com/release.zip" aria-label="Release ZIP URL" />
          ) : (
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer?.files?.[0]; if (file && !busy) onFile(file); }}
            >
              <input
                readOnly
                value={source?.label ?? ""}
                placeholder="Drop a release ZIP here, or browse…"
                data-testid="v3-local-zip-name"
                className="text-center"
                aria-label="Chosen release ZIP file"
                onClick={() => fileInputRef.current?.click()}
              />
              <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()} data-testid="v3-local-zip-browse">Browse…</button>
              <input id="v3-local-zip" key={fileKey} ref={fileInputRef} type="file" className="sr-only" accept=".zip,application/zip" data-testid="v3-local-zip" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; if (file) onFile(file); }} />
            </div>
          )}
        </div>
      </div>
      <div className="actionbar">
        <button
          type="button"
          className="primary"
          disabled={prepareDisabled}
          onClick={() => onPrepare()}
          data-testid="v3-prepare"
        >
          {busy ? <><Spinner />Verifying…</> : `Verify ${releaseMode === "url" ? "release from link" : source ? source.label : "release"}`}
        </button>
      </div>
    </>
  );
}
