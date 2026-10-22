import type { DeployStepState } from "./deploy-shared.js";
import { graphActionsForPlan, type GraphStepStatus } from "./graph-deploy-runner.js";
import type { GraphPlan } from "./api.js";
import { STEP_STATE_LABEL, phaseLabel } from "./step-labels.js";

export function dashboardTargetUrl(accountId: string, kind: string, name: string): string {
  const account = encodeURIComponent(accountId);
  const target = encodeURIComponent(name);
  return kind === "pages"
    ? `https://dash.cloudflare.com/${account}/pages/view/${target}`
    : `https://dash.cloudflare.com/${account}/workers/services/view/${target}`;
}

// The result link comes only from the server-approved plan: the effective
// Worker (or Pages project) name of the first matching unit, whatever its
// action (create, update, preserve). Nothing is guessed from the release
// name; with no such target the link falls back to the account home.
export function dashboardUrlForGraphPlan(accountId: string, plan: GraphPlan | null): string {
  const units = plan?.units ?? [];
  for (const [kind, matches] of [
    ["workers", (unitKind: string, resource: string) => unitKind === "worker" && resource === "worker"],
    ["pages", (unitKind: string, resource: string) => unitKind.startsWith("pages") && resource === "pages-project"],
  ] as const) {
    for (const unit of units) {
      const target = (unit.diffs ?? []).find((diff) => matches(unit.kind, diff.resource) && typeof diff.name === "string" && diff.name.length > 0);
      if (target?.name) return dashboardTargetUrl(accountId, kind, target.name);
    }
  }
  return `https://dash.cloudflare.com/${encodeURIComponent(accountId)}`;
}

// ---------------------------------------------------------------------------
// graph-native progress. Rows come ONLY from the server-approved plan
// diffs (never a static step list): unapproved work cannot appear, and an
// approved action the browser cannot address fails the run before dispatch
// (graphActionsForPlan throws) instead of vanishing from this list.
// ---------------------------------------------------------------------------

export interface GraphStepRow {
  key: string;
  unitId: string;
  resource: string;
  action: string;
  name?: string;
  phase: string;
  state: DeployStepState;
  detail?: string;
  receipt: boolean;
}

/**
 * Build the visible rows for a graph plan with live statuses. Pure: the same
 * plan always yields the same rows in plan order; statuses only flip state.
 */
export function graphStepRows(plan: GraphPlan, statuses: GraphStepStatus[]): GraphStepRow[] {
  const byPhase = new Map<string, GraphStepStatus>();
  for (const status of statuses) {
    byPhase.set(`${status.unitId}\0${status.phase}`, status);
  }
  return graphActionsForPlan(plan).map((action) => {
    const live = byPhase.get(`${action.unitId}\0${action.phase}`);
    const state = live?.state ?? "pending";
    return {
      key: `${action.unitId}:${action.phase}`,
      unitId: action.unitId,
      resource: action.resource,
      action: action.action,
      ...(action.name !== undefined ? { name: action.name } : {}),
      phase: action.phase,
      state,
      ...(live?.detail ? { detail: live.detail } : {}),
      receipt: live?.receipt === true,
    };
  });
}

const STATE_ICON: Record<string, string> = { pending: "○", running: "◔", waiting: "◔", done: "✓", error: "✕" };

/**
 * The approved actions as a checklist. `checks` are the postcheck statuses
 * (worker / Pages verification), appended after the actions they verify.
 */
export function GraphProgress({ plan, statuses, checks = [], finished = false, testidPrefix = "graph-step" }: { plan: GraphPlan; statuses: GraphStepStatus[]; checks?: GraphStepStatus[]; finished?: boolean; testidPrefix?: string }) {
  const rows = graphStepRows(plan, statuses);
  const checkRows = checks.map((status) => ({ key: `${status.unitId}:${status.phase}`, unitId: status.unitId, phase: status.phase, name: undefined as string | undefined, state: status.state, detail: status.detail, receipt: status.receipt === true }));
  const all = [...rows, ...checkRows];
  const singleUnit = new Set(all.map((row) => row.unitId)).size <= 1;
  const done = all.filter((row) => row.state === "done").length;
  return (
    <section className="progress" data-testid="graph-progress">
      <div className="progress-head">
        <h3 className="m-0">{finished ? "Deployment steps" : "Deploying…"}</h3>
        <span className="meta">{done} of {all.length} done</span>
      </div>
      <div className="progress-bar" aria-hidden="true"><span style={{ width: `${all.length ? Math.round((done / all.length) * 100) : 0}%` }} /></div>
      {!finished && (
        <p className="panel-note">Runs in this browser tab — keep it open until the result appears. Nothing continues in the background.</p>
      )}
      <ol className="step-list">
        {all.map((row) => (
          <li key={row.key} data-testid={`${testidPrefix}-${row.unitId}-${row.phase}`} data-state={row.state}>
            <span className="step-icon" aria-hidden="true">{STATE_ICON[row.state] ?? "○"}</span>
            <span className="step-name">
              {phaseLabel(row.phase)}
              {row.name ? <strong className="step-target"> {row.name}</strong> : null}
              {singleUnit ? null : <span className="step-unit">{row.unitId}</span>}
            </span>
            <span className="step-state">{STEP_STATE_LABEL[row.state]}{row.receipt ? " · verified" : ""}</span>
            {(row.state === "error" || row.state === "waiting") && row.detail ? (
              <span className="step-detail">{row.detail}</span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
