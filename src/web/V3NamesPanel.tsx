import type { NameRow } from "./name-choices.js";
import { resourceLabel } from "./step-labels.js";

export interface V3NamesPanelProps {
  rows: readonly NameRow[];
  mode: "install" | "upgrade";
  loading: boolean;
  error: string | null;
  onName: (key: string, value: string) => void;
}

const KIND_RESOURCE: Record<string, string> = { r2: "r2", d1: "d1", kv: "kv", queue: "queue", vectorize: "vectorize", pages: "pages-project" };

/**
 * Configure step: the names of the release's resources and Pages projects.
 * New install: editable, prefilled with the release's suggestion. Upgrade: what
 * the Worker uses today is shown locked unless the config lets it be swapped;
 * anything else is picked from the account's existing names.
 */
export function V3NamesPanel({ rows, mode, loading, error, onName }: V3NamesPanelProps) {
  if (rows.length === 0) return null;
  return (
    <div className="field" data-testid="v3-names">
      <label>{mode === "upgrade" ? "Resources used by this app" : "Resource names"}</label>
      <p className="meta">
        {mode === "upgrade"
          ? "Kept as they are today. The app allows changing the editable ones; the others stay bound."
          : "Suggested by the release; change any of them. An existing name is reused, not recreated."}
      </p>
      {loading && <p className="meta" role="status">Reading your account…</p>}
      {error && <p className="meta" data-testid="v3-names-error">Could not read your account ({error}).</p>}
      <div className="name-rows">
        {rows.map((row) => {
          const id = `v3-name-${row.key.replace(/[^a-z0-9-]/gi, "-")}`;
          return (
            <div key={row.key} className="name-row">
              <label htmlFor={id} className="name-label">{resourceLabel(KIND_RESOURCE[row.kind] ?? row.kind)}</label>
              {row.mode === "input" ? (
                <input id={id} type="text" value={row.value} onChange={(e) => onName(row.key, e.target.value.trim().toLowerCase())} data-testid={id} />
              ) : (
                <select id={id} value={row.value} disabled={row.mode === "locked"} onChange={(e) => onName(row.key, e.target.value)} data-testid={id}>
                  {row.mode === "select" && <option value="">Choose…</option>}
                  {row.options.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              )}
              {row.error ? <p className="error name-note">{row.error}</p>
                : row.mode === "input" && mode === "upgrade" && !row.exists ? <p className="meta name-note">Will be created; the Worker switches to it.</p>
                : row.mode === "input" && row.exists ? <p className="meta name-note">Exists in your account — it will be reused.</p>
                : row.mode === "locked" ? <p className="meta name-note">Bound to the Worker today.</p>
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
