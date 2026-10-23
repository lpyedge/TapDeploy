import type { DomainsEnvelope } from "./api.js";
import { EMPTY_DRAFT, boundHostnames, draftHostname, existingSubdomains, hostnameOccupant, type HttpUnit, type RecordsByZone, type UnitDomainDraft } from "./domain-choices.js";
import { Disclosure } from "./Disclosure.js";
import { Segmented } from "./Segmented.js";

export interface V3DomainsPanelProps {
  units: readonly HttpUnit[];
  mode: "install" | "upgrade";
  facts: DomainsEnvelope | null;
  factsLoading: boolean;
  factsError: string | null;
  recordsByZone: RecordsByZone;
  drafts: Readonly<Record<string, UnitDomainDraft>>;
  errors: Readonly<Record<string, string>>;
  onDraft: (unitId: string, draft: UnitDomainDraft) => void;
  /** The address of this TapDeploy instance: never offered for binding. */
  selfHostname: string;
}

/**
 * Configure step: optional custom domains for each HTTP unit (Worker or Pages),
 * in a collapsed section. Bind `<sub>.<zone>` from the account's own zones; on
 * upgrade the hostnames bound today are listed and can be unbound. Anything that
 * replaces or removes a live address needs the operator's explicit
 * confirmation; the server re-verifies every choice before it writes.
 */
export function V3DomainsPanel({ units, mode, facts, factsLoading, factsError, recordsByZone, drafts, errors, onDraft, selfHostname }: V3DomainsPanelProps) {
  if (units.length === 0) return null;
  return (
    <Disclosure testId="v3-domains" title="Custom domain" summary={domainsSummary(units, mode, facts, drafts)} forceOpen={Object.keys(errors).length > 0}>
      {factsLoading && <p className="meta" role="status">Reading your domains…</p>}
      {factsError && <p className="meta" data-testid="v3-domains-error">Could not read your domains ({factsError}); the release can still be installed without one.</p>}
      {facts && facts.zones.length === 0 && <p className="meta" data-testid="v3-domains-no-zones">This account has no domains yet. Add one to Cloudflare first to bind it here.</p>}
      {facts && units.map((unit) => (
        <UnitDomains
          key={unit.unitId}
          unit={unit}
          mode={mode}
          facts={facts}
          records={recordsByZone}
          draft={drafts[unit.unitId] ?? EMPTY_DRAFT}
          error={errors[unit.unitId]}
          selfHostname={selfHostname}
          onDraft={(draft) => onDraft(unit.unitId, draft)}
        />
      ))}
    </Disclosure>
  );
}

/** What the collapsed section says: the hostnames chosen, or what stays bound today. */
function domainsSummary(units: readonly HttpUnit[], mode: "install" | "upgrade", facts: DomainsEnvelope | null, drafts: Readonly<Record<string, UnitDomainDraft>>): string {
  const chosen = units.flatMap((unit) => {
    const draft = drafts[unit.unitId];
    return draft?.bind ? [draftHostname(draft)].filter((hostname): hostname is string => hostname !== null) : [];
  });
  const unbound = units.reduce((count, unit) => count + (drafts[unit.unitId]?.remove.length ?? 0), 0);
  const parts = [...chosen, ...(unbound > 0 ? [`${unbound} to unbind`] : [])];
  if (parts.length > 0) return parts.join(", ");
  const kept = units.reduce((count, unit) => count + (mode === "upgrade" || unit.kind === "pages" ? boundHostnames(unit, facts).length : 0), 0);
  return kept > 0 ? `${kept} bound today, kept` : "none";
}

interface UnitDomainsProps {
  unit: HttpUnit;
  mode: "install" | "upgrade";
  facts: DomainsEnvelope;
  records: RecordsByZone;
  draft: UnitDomainDraft;
  error: string | undefined;
  selfHostname: string;
  onDraft: (draft: UnitDomainDraft) => void;
}

function UnitDomains({ unit, mode, facts, records, draft, error, selfHostname, onDraft }: UnitDomainsProps) {
  const set = (patch: Partial<UnitDomainDraft>) => onDraft({ ...draft, ...patch });
  const bound = mode === "upgrade" || unit.kind === "pages" ? boundHostnames(unit, facts) : [];
  const hostname = draft.bind ? draftHostname(draft) : null;
  const zoneRecords = records[draft.zone] ?? [];
  const occupant = hostname ? hostnameOccupant(hostname, unit, facts, zoneRecords) : null;
  const existing = existingSubdomains(draft.zone, facts, zoneRecords);
  return (
    <div className="domain-unit" data-testid={`v3-domain-${unit.unitId}`}>
      <p className="m-0">{unit.kind === "pages" ? "Pages site" : "Worker"} <strong>{unit.target}</strong></p>
      {mode === "upgrade" && (
        <p className="meta m-0">{bound.length > 0 ? "Bound today — kept unless you untick it:" : "No custom domain is bound to it today."}</p>
      )}
      {bound.length > 0 && (
        <ul className="m-0 list-none p-0" data-testid={`v3-domain-bound-${unit.unitId}`}>
          {bound.map((name) => (
            <li key={name}>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!draft.remove.includes(name)}
                  onChange={(e) => set({ remove: e.target.checked ? draft.remove.filter((item) => item !== name) : [...draft.remove, name], confirmRemove: false })}
                  data-testid={`v3-domain-keep-${name}`}
                />
                <span className="break-all">{name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {draft.remove.length > 0 && (
        <label className="warn-block mt-2 flex items-start gap-2 text-sm text-amber-900">
          <input type="checkbox" checked={draft.confirmRemove} onChange={(e) => set({ confirmRemove: e.target.checked })} data-testid={`v3-domain-confirm-remove-${unit.unitId}`} />
          <span>Unbind {draft.remove.join(", ")}: visitors of {draft.remove.length > 1 ? "these addresses" : "this address"} will no longer reach this app.</span>
        </label>
      )}
      {facts.zones.length > 0 && (
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={draft.bind} onChange={(e) => set({ bind: e.target.checked, confirmReplace: false })} data-testid={`v3-domain-bind-${unit.unitId}`} />
          <span>Bind {bound.length > 0 ? "another" : "a"} domain</span>
        </label>
      )}
      {draft.bind && (
        <>
          <div className="domain-row">
            <div className="domain-sub">
              <Segmented
                name={`v3-domain-mode-${unit.unitId}`}
                label="Subdomain"
                value={draft.subMode}
                options={[
                  { value: "new", label: "New name", testId: `v3-domain-mode-new-${unit.unitId}` },
                  { value: "existing", label: "Existing name", testId: `v3-domain-mode-existing-${unit.unitId}` },
                ]}
                onChange={(subMode) => set({ subMode, sub: "", confirmReplace: false })}
              />
              {draft.subMode === "new" ? (
                <input
                  type="text"
                  aria-label="Subdomain"
                  placeholder="www (or @ for the domain itself)"
                  value={draft.sub}
                  onChange={(e) => set({ sub: e.target.value, confirmReplace: false })}
                  data-testid={`v3-domain-sub-${unit.unitId}`}
                />
              ) : (
                <select
                  aria-label="Existing subdomain"
                  value={draft.sub}
                  disabled={!draft.zone}
                  onChange={(e) => set({ sub: e.target.value, confirmReplace: false })}
                  data-testid={`v3-domain-existing-${unit.unitId}`}
                >
                  <option value="">{draft.zone ? (existing.length > 0 ? "Choose a name…" : "No names in this domain yet") : "Choose a domain first"}</option>
                  {existing.map((name) => {
                    const self = (name ? `${name}.${draft.zone}` : draft.zone) === selfHostname;
                    return <option key={name || "@"} value={name || "@"} disabled={self}>{name || "@ (the domain itself)"}{self ? " (this TapDeploy instance)" : ""}</option>;
                  })}
                </select>
              )}
            </div>
            <div className="domain-zone">
              <span className="domain-dot" aria-hidden="true">.</span>
              <select
                aria-label="Domain"
                value={draft.zone}
                onChange={(e) => set({ zone: e.target.value, ...(draft.subMode === "existing" ? { sub: "" } : {}), confirmReplace: false })}
                data-testid={`v3-domain-zone-${unit.unitId}`}
              >
                <option value="">Choose a domain…</option>
                {facts.zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </div>
          </div>
          <p className="meta" data-testid={`v3-domain-preview-${unit.unitId}`}>{hostname ? `https://${hostname}` : "Choose a domain and a subdomain."}{hostname && bound.includes(hostname) ? " is already bound." : ""}</p>
          {occupant && hostname !== selfHostname && (
            <label className="warn-block flex items-start gap-2 text-sm text-amber-900">
              <input type="checkbox" checked={draft.confirmReplace} onChange={(e) => set({ confirmReplace: e.target.checked })} data-testid={`v3-domain-confirm-replace-${unit.unitId}`} />
              <span>I understand <strong>{hostname}</strong> will be bound to this {unit.kind === "pages" ? "Pages site" : "Worker"}; what uses it today ({occupant}) may stop working at this address.</span>
            </label>
          )}
        </>
      )}
      {error && <p className="error" data-testid={`v3-domain-error-${unit.unitId}`}>{error}</p>}
    </div>
  );
}
