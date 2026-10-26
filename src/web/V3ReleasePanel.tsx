import type { RefObject } from "react";
import { Spinner } from "./Spinner.js";

export type ReleaseStage = "reading" | "analyzing" | "verifying";

// Plain stage names; no percentage because no stage has a trustworthy total.
const STAGE_TEXT: Record<ReleaseStage, string> = {
  reading: "Downloading the ZIP…",
  analyzing: "Checking the ZIP in your browser…",
  verifying: "Verifying with the installer…",
};

export interface V3ReleasePanelProps {
  assetUrl: string;
  onAssetUrl: (value: string) => void;
  /** The ZIP chosen on this computer (label only), or null: then the link is used. */
  localFile: { label: string } | null;
  /** False when the config only allows its own download link. */
  allowLocalZip: boolean;
  fileKey: number;
  fileInputRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
  /** Computed by the flow from the machine (can RELEASE_READY), account and input validity. */
  prepareDisabled: boolean;
  /** What the busy flow is doing right now (null while idle). */
  stage: ReleaseStage | null;
  onCancel: () => void;
  onFile: (file: File) => void;
  onClearFile: () => void;
  onPrepare: () => void;
}

/**
 * Release step on one page: the publisher's download link, or a ZIP from this
 * computer. A chosen file wins and the link rests until it is removed; there is
 * nothing to switch.
 */
export function V3ReleasePanel({ assetUrl, onAssetUrl, localFile, allowLocalZip, fileKey, fileInputRef, busy, prepareDisabled, stage, onCancel, onFile, onClearFile, onPrepare }: V3ReleasePanelProps) {
  return (
    <>
      <p className="lead mt-0">Choose the release to install. The installer verifies every byte before anything touches Cloudflare.</p>
      <div className="field">
        <label htmlFor="v3-asset-url">Download link</label>
        <input
          id="v3-asset-url"
          type="url"
          data-testid="v3-asset-url"
          value={assetUrl}
          disabled={busy || localFile !== null}
          onChange={(e) => onAssetUrl(e.target.value)}
          placeholder="https://example.com/release.zip"
        />
        {localFile && <p className="meta">Not used while a ZIP file is chosen.</p>}
      </div>
      {allowLocalZip && (
        <div className="field">
          <label htmlFor="v3-local-zip">{assetUrl.trim() === "" && !localFile ? "Or a release ZIP from this computer" : "Or use a release ZIP from this computer instead"}</label>
          <div
            className="dropzone"
            aria-busy={busy}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer?.files?.[0]; if (file && !busy) onFile(file); }}
          >
            {localFile ? (
              <p className="m-0 break-all">
                <strong data-testid="v3-local-zip-name">{localFile.label}</strong>{" "}
                <button type="button" className="link" disabled={busy} onClick={() => onClearFile()} data-testid="v3-local-zip-clear">Remove</button>
              </p>
            ) : (
              <p className="m-0">Drop a ZIP here or{" "}
                <button type="button" className="link" disabled={busy} onClick={() => fileInputRef.current?.click()} data-testid="v3-local-zip-browse">choose a file…</button>
              </p>
            )}
            <input id="v3-local-zip" key={fileKey} ref={fileInputRef} type="file" className="sr-only" accept=".zip,application/zip" data-testid="v3-local-zip" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; if (file) onFile(file); }} />
          </div>
        </div>
      )}
      <p className="meta" role="status" data-testid="v3-release-stage">{busy && stage ? STAGE_TEXT[stage] : ""}</p>
      <div className="actionbar">
        {busy && <button type="button" className="link text-sm" onClick={() => onCancel()} data-testid="v3-release-cancel">Cancel</button>}
        <button type="button" className="primary" disabled={prepareDisabled} onClick={() => onPrepare()} data-testid="v3-prepare">
          {busy ? <><Spinner />Verifying…</> : `Verify ${localFile ? localFile.label : "release from link"}`}
        </button>
      </div>
    </>
  );
}
