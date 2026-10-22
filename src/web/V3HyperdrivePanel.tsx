export interface V3HyperdrivePanelProps {
  /** Per unit: its Worker name and the Hyperdrive bindings the release declares. */
  units: ReadonlyArray<{ unitId: string; target: string; bindings: readonly string[] }>;
  configs: readonly string[] | null;
  loading: boolean;
  error: string | null;
  choices: Readonly<Record<string, Readonly<Record<string, string>>>>;
  onChoice: (unitId: string, binding: string, config: string) => void;
}

/**
 * Configure step: a Hyperdrive binding connects the app to the operator's own
 * database, so it must point at one of the operator's Hyperdrive
 * configurations; TapDeploy never creates one or sees its credentials.
 */
export function V3HyperdrivePanel({ units, configs, loading, error, choices, onChoice }: V3HyperdrivePanelProps) {
  if (units.length === 0) return null;
  return (
    <div className="field" data-testid="v3-hyperdrive">
      <label>Database (Hyperdrive)</label>
      <p className="meta">This app connects to a database through Cloudflare Hyperdrive. Pick the Hyperdrive configuration that holds your database connection; TapDeploy never sees its credentials.</p>
      {loading && <p className="meta" role="status">Reading your Hyperdrive configurations…</p>}
      {error && <p className="error" data-testid="v3-hyperdrive-error">Could not list Hyperdrive configurations ({error}).</p>}
      {configs && configs.length === 0 && (
        <p className="warn-block text-sm text-amber-900" data-testid="v3-hyperdrive-none">This account has no Hyperdrive configuration yet. Create one for your database in the Cloudflare dashboard, then come back to this step.</p>
      )}
      {configs && configs.length > 0 && units.flatMap((unit) => unit.bindings.map((binding) => (
        <div key={`${unit.unitId}:${binding}`} className="flex flex-wrap items-center gap-2">
          <span className="text-sm"><strong>{unit.target}</strong> · {binding}</span>
          <select
            aria-label={`Hyperdrive configuration for ${binding}`}
            value={choices[unit.unitId]?.[binding] ?? ""}
            onChange={(e) => onChoice(unit.unitId, binding, e.target.value)}
            data-testid={`v3-hyperdrive-${unit.unitId}-${binding}`}
          >
            <option value="">Select a configuration…</option>
            {configs.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
      )))}
    </div>
  );
}
