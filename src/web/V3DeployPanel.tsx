import type { AccountSummary, GraphPlan } from "./api.js";
import type { V3MachineSnapshot } from "./v3-flow-machine.js";
import { GraphProgress, dashboardUrlForGraphPlan } from "./DeployProgress.js";
import type { GraphStepStatus } from "./graph-deploy-runner.js";
import { describeDiff, resourceLabel } from "./step-labels.js";

export interface SecretPrompt {
  name: string;
  label: string;
}

// first-install secret prompts. Derived from the approved plan diffs
// (secret+create names) joined with the declared config input policies;
// generate-once secrets are server-generated and never shown. The server
// re-validates everything (unknown names refused, missing values block the
// version upload); this UI is collection only and never persisted.
export function secretPromptsFor(configText: string, graphPlan: GraphPlan | null): SecretPrompt[] {
  let declared: Record<string, { policy?: string; label?: string }> = {};
  try {
    const parsed = JSON.parse(configText) as { inputs?: Array<{ key?: unknown; type?: unknown; secretPolicy?: unknown; label?: unknown }> };
    for (const input of parsed.inputs ?? []) {
      if (typeof input?.key === "string" && input.type === "secret") {
        declared[input.key] = {
          ...(typeof input.secretPolicy === "string" ? { policy: input.secretPolicy } : {}),
          ...(typeof input.label === "string" ? { label: input.label } : {}),
        };
      }
    }
  } catch {
    declared = {};
  }
  const created = new Set((graphPlan?.units ?? []).flatMap((unit) => unit.diffs ?? []).filter((diff) => diff.resource === "secret" && diff.action === "create" && typeof diff.name === "string").map((diff) => diff.name as string));
  return [...created].filter((name) => (declared[name]?.policy ?? "prompt") === "prompt").map((name) => ({ name, label: declared[name]?.label ?? name }));
}

/**
 * Success result for the sealed-graph flow. The primary address (verified
 * workers.dev / Pages URL) is the hero link; the Cloudflare dashboard link is
 * always present; deployments with no public surface (e.g. resource-only)
 * list the approved identities that were created instead of a fake URL.
 * Everything shown is server-derived (plan diffs + verified outcome).
 */
function V3SuccessCard({ snap, graphPlan, accountId, accounts }: {
  snap: V3MachineSnapshot;
  graphPlan: GraphPlan | null;
  accountId: string;
  accounts: { id: string; name: string }[];
}) {
  const diffs = (graphPlan?.units ?? []).flatMap((unit) => unit.diffs ?? []);
  const created = diffs.filter((d) => d.action === "create" && typeof d.name === "string" && d.resource !== "deployment");
  const workerName = created.find((d) => d.resource === "worker")?.name as string | undefined;
  const accountName = accounts.find((a) => a.id === accountId)?.name ?? accountId;
  const dashboard = dashboardUrlForGraphPlan(accountId, graphPlan);
  return (
    <div className="result-card result-ok" data-testid="v3-result">
      <div className="result-title">
        <span className="result-icon" aria-hidden="true">✓</span>
        <div>
          <p className="m-0 text-lg font-semibold text-emerald-800">Deployment succeeded</p>
          <p className="meta m-0">Every step was read back and verified on Cloudflare · account {accountName}</p>
        </div>
      </div>
      {snap.deployUrls.length > 0 ? (
        <div className="result-open">
          {snap.deployUrls.map((url, index) => (
            <a key={url} className={index === 0 ? "open-app" : "open-more"} href={url} target="_blank" rel="noopener noreferrer" data-testid={index === 0 ? "v3-result-url" : "v3-result-url-more"}>
              Open {url.replace(/^https:\/\//, "").replace(/\/$/, "")}
            </a>
          ))}
        </div>
      ) : (
        <p className="meta" data-testid="v3-result-no-url">
          No public address for this release{workerName ? " (workers.dev is off for this Worker)" : ""}.
          {created.length > 0 ? ` Created: ${created.map((d) => `${resourceLabel(d.resource)} ${d.name}`).join(", ")}.` : ""}
        </p>
      )}
      {snap.deployNote && <p className="notice" data-testid="v3-result-note">{snap.deployNote}</p>}
      <p className="m-0 mt-3">
        <a className="open-dashboard" href={dashboard} target="_blank" rel="noopener noreferrer" data-testid="v3-result-dashboard">
          Open in Cloudflare dashboard ↗
        </a>
      </p>
    </div>
  );
}

// "CODE; human detail" from the API reads as the detail first, code after.
function ErrorMessage({ message }: { message: string }) {
  const match = /^([A-Z][A-Z0-9_]{2,}); ([\s\S]+)$/.exec(message);
  return (
    <p className="error-block" role="alert" data-testid="v3-error">
      {match ? <>{match[2]} <code className="error-code">{match[1]}</code></> : message}
    </p>
  );
}

export interface V3DeployPanelProps {
  snap: V3MachineSnapshot;
  graphPlan: GraphPlan | null;
  accountId: string;
  accounts: AccountSummary[];
  modeIntent: "install" | "upgrade";
  statuses: GraphStepStatus[];
  /** True while the approved plan still needs the operator's billing confirmation. */
  paidRisk: true | undefined;
  paidConfirmed: boolean;
  onPaidConfirm: (checked: boolean) => void;
  secretPromptNames: readonly SecretPrompt[];
  secretValues: Readonly<Record<string, string>>;
  onSecretValue: (name: string, value: string) => void;
  secretsReady: boolean;
  busy: boolean;
  blocked: boolean;
  message: string | null;
  onBackToConfigure: () => void;
  onDeploy: () => void;
  onStartOver: () => void;
}

/**
 * Deploy step: review of the server-approved plan, billing/secret gates,
 * graph-native progress and the result card, all on the same page.
 */
export function V3DeployPanel({
  snap,
  graphPlan,
  accountId,
  accounts,
  modeIntent,
  statuses,
  paidRisk,
  paidConfirmed,
  onPaidConfirm,
  secretPromptNames,
  secretValues,
  onSecretValue,
  secretsReady,
  busy,
  blocked,
  message,
  onBackToConfigure,
  onDeploy,
  onStartOver,
}: V3DeployPanelProps) {
  const finished = snap.stage === "done";
  const postchecks = statuses.filter((status) => status.phase === "postcheck" || status.phase === "pages-postcheck");
  const actions = statuses.filter((status) => status.phase !== "postcheck" && status.phase !== "pages-postcheck");
  const reviewing = snap.stage === "deploy" && snap.deployOk === null && statuses.length === 0;
  return (
    <>
      {snap.stage === "deploy" && graphPlan && reviewing && (
        <>
          <div className="review-head">
            <h3 className="m-0">Review the changes</h3>
            <span className="chip" data-testid="v3-plan-kind">{modeIntent === "upgrade" ? "Upgrade" : "New install"}</span>
          </div>
          <p className="meta mt-1">Computed by the installer from your live Cloudflare account. Nothing has been written yet.</p>
          <div className="plan-units" data-testid="v3-plan-review">
            <p className="meta m-0">Account: <strong>{accounts.find((account) => account.id === accountId)?.name ?? accountId}</strong></p>
            {graphPlan.units.map((unit) => (
              <div className="plan-unit" key={unit.unitId}>
                <p className="plan-unit-title">{unit.kind === "resource-only" ? "Account resources" : unit.kind.startsWith("pages") ? "Pages site" : "Worker"} <span className="meta">· {unit.unitId}</span></p>
                <ul className="plan-diffs">
                  {unit.diffs.map((diff, index) => {
                    const d = describeDiff(diff);
                    return (
                      <li key={index} data-diff={`${diff.resource}:${diff.action}${diff.name ? `:${diff.name}` : ""}`}>
                        <span className={`badge badge-${d.tone}`}>{d.action}</span>
                        <span>{d.subject}{d.name ? <strong> {d.name}</strong> : null}</span>
                        {diff.action === "conflict" && diff.detail ? <span className="diff-detail" data-testid="v3-diff-detail">{diff.detail}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          {graphPlan.cost.operations.length > 0 && (
            <div className="paid-risk-block" data-testid="v3-cost-ops">
              <h3>May be billed by Cloudflare</h3>
              <p>{graphPlan.cost.operations.map((op) => `${resourceLabel(op.resource)}${op.name ? ` ${op.name}` : ""}`).join(", ")}</p>
              {paidRisk && (
                <label className="confirm-label mt-2 mb-0">
                  <input type="checkbox" checked={paidConfirmed} disabled={busy} onChange={(e) => onPaidConfirm(e.target.checked)} data-testid="v3-paid-confirm" />
                  I understand these operations may be billed to this account.
                </label>
              )}
            </div>
          )}
          {graphPlan.guards.filter((guard) => guard.level === "block").map((guard) => (
            <p key={guard.code} className="error-block" data-testid="v3-plan-guard">{guard.code}: {guard.detail}</p>
          ))}
          {secretPromptNames.length > 0 && (
            <div className="option-card" data-testid="v3-secret-prompts">
              <p className="m-0 font-medium text-slate-700">First-install secrets</p>
              <p className="meta mt-1">Used once for this install and sent only with the Worker upload — never stored in this page.</p>
              {secretPromptNames.map(({ name, label }) => (
                <label className="field" key={name}>
                  {label}
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={secretValues[name] ?? ""}
                    onChange={(e) => onSecretValue(name, e.target.value)}
                    data-testid={`v3-secret-${name}`}
                  />
                </label>
              ))}
              {!secretsReady && <p className="meta">Enter every secret above to enable deploy.</p>}
            </div>
          )}
          <div className="actionbar">
            <button type="button" className="link text-sm" onClick={() => onBackToConfigure()} data-testid="v3-back-to-configure">Back</button>
            <button type="button" className="primary" disabled={busy || blocked || !secretsReady} onClick={() => onDeploy()} data-testid="v3-confirm-deploy">
              {modeIntent === "upgrade" ? "Confirm and upgrade" : "Confirm and deploy"}
            </button>
          </div>
        </>
      )}
      {(snap.stage === "deploy" || finished) && graphPlan && !reviewing && (
        <GraphProgress plan={graphPlan} statuses={actions} checks={postchecks} finished={finished} testidPrefix="v3-status" />
      )}
      {message && <ErrorMessage message={message} />}
      {finished && snap.deployOk !== null && (
        snap.deployOk ? <V3SuccessCard snap={snap} graphPlan={graphPlan} accountId={accountId} accounts={accounts} />
          : (
            <div className={`result-card ${snap.deployPending ? "result-pending" : "result-fail"}`} data-testid="v3-result">
              <p className="m-0 font-semibold">{snap.deployPending ? "Still in progress at Cloudflare" : "Deployment did not complete"}</p>
              <p className="m-0 mt-1 text-sm">{snap.deployError}</p>
              {snap.failedAction && <p className="meta" data-testid="v3-failed-action">Stopped at {snap.failedAction}.</p>}
              <p className="panel-note">Completed steps stay live (there is no automatic rollback); {snap.verifiedReceipts} verified receipts were sealed before the stop. Check the dashboard, then start over to re-plan from the live state.</p>
            </div>
          )
      )}
      {finished && (
        <div className="btn-row">
          <button type="button" onClick={() => onStartOver()} data-testid="v3-start-over">Deploy another release</button>
        </div>
      )}
    </>
  );
}
