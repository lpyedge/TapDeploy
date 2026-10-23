import type { DomainsEnvelope } from "./api.js";
import { EMPTY_DRAFT, boundHostnames, draftHostname, existingSubdomains, hostnameOccupant, type HttpUnit, type UnitDomainDraft } from "./domain-choices.js";
import { Segmented } from "./Segmented.js";

export interface V3DomainsPanelProps {
  units: readonly HttpUnit[];
  mode: "install" | "upgrade";
  facts: DomainsEnvelope | null;
  factsLoading: boolean;
  factsError: string | null;
  recordsByZone: Readonly<Record<string, ReadonlyArray<{ name: string; type: string; content?: string }>>>;
  drafts: Readonly<Record<string, UnitDomainDraft>>;
  errors: Readonly<Record<string, string>>;
  onDraft: (unitId: string, draft: UnitDomainDraft) => void;
}

/**
 * Configure step: optional custom domains for each HTTP unit (Worker or Pages).
 * Bind `<sub>.<zone>` from the account's own zones; on upgrade the hostnames
 * bound today are listed and can be unbound. Anything that replaces or removes
 * a live address needs the operator's explicit confirmation; the server
 * re-verifies every choice before it writes.
 */
export function V3DomainsPanel({ units, mode, facts, factsLoading, factsError, recordsByZone, drafts, errors, onDraft }: V3DomainsPanelProps) {
  if (units.length === 0) return null;
  return (
    <div className="field" data-testid="v3-domains">
      <label>Custom domain (optional)</label>
      {factsLoading && <p className="meta" role="status">Reading your domains…</p>}
      {factsError && <p className="meta" data-testid="v3-domains-error">Could not read your domains ({factsError}); the release can still be installed without one.</p>}
      {facts && facts.zones.length === 0 && <p className="meta" data-testid="v3-domains-no-zones">This account has no domains yet. Add one to Cloudflare first to bind it here.</p>}
      {facts && units.map((unit) => {
        const draft = drafts[unit.unitId] ?? EMPTY_DRAFT;
        const set = (patch: Partial<UnitDomainDraft>) => onDraft(unit.unitId, { ...draft, ...patch });
        const bound = mode === "upgrade" || unit.kind === "pages" ? boundHostnames(unit, facts) : [];
        const hostname = draft.bind ? draftHostname(draft) : null;
        const records = recordsByZone[draft.zone] ?? [];
        const occupant = hostname ? hostnameOccupant(hostname, unit, facts, records) : null;
        const existing = existingSubdomains(draft.zone, facts, records);
        return (
          <div key={unit.unitId} className="domain-unit" data-testid={`v3-domain-${unit.unitId}`}>
            <p className="m-0">{unit.kind === "pages" ? "Pages site" : "Worker"} <strong>{unit.target}</strong></p>
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
                        {existing.map((name) => <option key={name || "@"} value={name || "@"}>{name || "@ (the domain itself)"}</option>)}
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
                {occupant && (
                  <label className="warn-block flex items-start gap-2 text-sm text-amber-900">
                    <input type="checkbox" checked={draft.confirmReplace} onChange={(e) => set({ confirmReplace: e.target.checked })} data-testid={`v3-domain-confirm-replace-${unit.unitId}`} />
                    <span><strong>{hostname}</strong> is used by {occupant}. Replace it — whatever it serves today may stop working at this address.</span>
                  </label>
                )}
              </>
            )}
            {errors[unit.unitId] && <p className="error" data-testid={`v3-domain-error-${unit.unitId}`}>{errors[unit.unitId]}</p>}
          </div>
        );
      })}
    </div>
  );
}
