import type { DeployStepState } from "./deploy-shared.js";
import { graphActionsForPlan, type GraphStepStatus } from "./graph-deploy-runner.js";
import type { GraphPlan, GraphPlanUnit } from "./api.js";
import { STEP_STATE_LABEL, phaseLabel, resourceLabel } from "./step-labels.js";

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
// Progress, one row per deployed item: each Worker and Pages site, each
// account resource created for the release, each custom domain or route. A
// row's state summarizes the approved steps behind it (the server plan is the
// only source, so unapproved work cannot appear); its detail names the step in
// progress or the step that failed.
// ---------------------------------------------------------------------------

export interface GraphProgressItem {
  key: string;
  unitId: string;
  label: string;
  name?: string;
  state: DeployStepState;
  detail?: string;
  verified: boolean;
}

const DOMAIN_RESOURCES = new Set(["worker-custom-domain", "pages-custom-domain", "worker-route"]);

// Which item a step belongs to: an account resource it creates, a domain it
// binds, or else the unit's Worker / Pages site itself.
function itemFor(unit: GraphPlanUnit | undefined, step: { unitId: string; resource: string; phase: string; name?: string }): { key: string; label: string; name?: string } {
  if (DOMAIN_RESOURCES.has(step.resource)) return { key: `${step.unitId}-domain-${step.name ?? ""}`, label: resourceLabel(step.resource), ...(step.name ? { name: step.name } : {}) };
  if (step.phase.startsWith("create-") && step.phase !== "create-worker" && step.phase !== "create-version") {
    return { key: `${step.unitId}-${step.resource}-${step.name ?? ""}`, label: resourceLabel(step.resource), ...(step.name ? { name: step.name } : {}) };
  }
  const pages = unit?.kind.startsWith("pages") ?? step.phase.startsWith("pages-");
  const name = unit?.name || step.name;
  return { key: step.unitId, label: pages ? "Pages site" : "Worker", ...(name ? { name } : {}) };
}

// Every Worker and Pages site is read back once more after its last action: a
// step of the item from the start, so the item is not "done" before that
// verification has run and never steps back from done to verifying.
function expectedPostchecks(plan: GraphPlan): Array<{ unitId: string; resource: string; phase: string }> {
  return plan.units.flatMap((unit) => {
    const diffs = unit.diffs ?? [];
    if (unit.kind === "worker" && diffs.some((diff) => diff.resource === "worker")) return [{ unitId: unit.unitId, resource: "worker", phase: "postcheck" }];
    if (unit.kind.startsWith("pages") && diffs.some((diff) => diff.resource === "deployment")) return [{ unitId: unit.unitId, resource: "deployment", phase: "pages-postcheck" }];
    return [];
  });
}

/**
 * The visible items for a graph plan with live statuses (postchecks included).
 * Pure: the same plan always yields the same items in plan order.
 */
export function graphProgressItems(plan: GraphPlan, statuses: GraphStepStatus[], checks: GraphStepStatus[] = []): GraphProgressItem[] {
  const live = new Map<string, GraphStepStatus>();
  for (const status of [...statuses, ...checks]) live.set(`${status.unitId}\0${status.phase}`, status);
  const units = new Map(plan.units.map((unit) => [unit.unitId, unit]));
  const steps = [
    ...graphActionsForPlan(plan).map((action) => ({ unitId: action.unitId, resource: action.resource, phase: action.phase, ...(action.name !== undefined ? { name: action.name } : {}) })),
    ...expectedPostchecks(plan),
  ];
  const groups = new Map<string, { item: { key: string; label: string; name?: string }; unitId: string; steps: Array<{ phase: string; status?: GraphStepStatus }> }>();
  for (const step of steps) {
    const item = itemFor(units.get(step.unitId), step);
    const group = groups.get(item.key) ?? { item, unitId: step.unitId, steps: [] };
    if (!group.steps.some((entry) => entry.phase === step.phase)) group.steps.push({ phase: step.phase, status: live.get(`${step.unitId}\0${step.phase}`) });
    groups.set(item.key, group);
  }
  return [...groups.values()].map(({ item, unitId, steps: entries }) => {
    const failed = entries.find((entry) => entry.status?.state === "error");
    const active = entries.find((entry) => entry.status?.state === "running") ?? entries.find((entry) => entry.status?.state === "waiting");
    const done = entries.filter((entry) => entry.status?.state === "done").length;
    const state: DeployStepState = failed ? "error" : done === entries.length ? "done" : active?.status?.state ?? (done > 0 ? "running" : "pending");
    const current = failed ?? active ?? (done > 0 && done < entries.length ? entries.find((entry) => entry.status?.state !== "done") : undefined);
    const detail = failed ? `${phaseLabel(failed.phase)}: ${failed.status?.detail ?? "failed"}` : current ? phaseLabel(current.phase) : undefined;
    return {
      key: item.key,
      unitId,
      label: item.label,
      ...(item.name ? { name: item.name } : {}),
      state,
      ...(detail ? { detail } : {}),
      verified: done === entries.length && entries.every((entry) => entry.status?.receipt === true || entry.phase.endsWith("postcheck")),
    };
  });
}

const STATE_ICON: Record<string, string> = { pending: "○", running: "◔", waiting: "◔", done: "✓", error: "✕" };

/** The deployed items as a checklist, one row each. */
export function GraphProgress({ plan, statuses, checks = [], finished = false, testidPrefix = "graph-step" }: { plan: GraphPlan; statuses: GraphStepStatus[]; checks?: GraphStepStatus[]; finished?: boolean; testidPrefix?: string }) {
  const items = graphProgressItems(plan, statuses, checks);
  const done = items.filter((item) => item.state === "done").length;
  return (
    <section className="progress" data-testid="graph-progress">
      <div className="progress-head">
        <h3 className="m-0">{finished ? "Deployment" : "Deploying…"}</h3>
        <span className="meta">{done} of {items.length} done</span>
      </div>
      <div className="progress-bar" aria-hidden="true"><span style={{ width: `${items.length ? Math.round((done / items.length) * 100) : 0}%` }} /></div>
      {!finished && (
        <p className="panel-note">Runs in this browser tab — keep it open until the result appears. Nothing continues in the background.</p>
      )}
      <ol className="step-list">
        {items.map((item) => (
          <li key={item.key} data-testid={`${testidPrefix}-${item.key}`} data-state={item.state}>
            <span className="step-icon" aria-hidden="true">{STATE_ICON[item.state] ?? "○"}</span>
            <span className="step-name">
              {item.label}
              {item.name ? <strong className="step-target"> {item.name}</strong> : null}
            </span>
            <span className="step-state">{STEP_STATE_LABEL[item.state]}{item.state === "done" && item.verified ? " · verified" : ""}</span>
            {item.detail && item.state !== "done" && !(finished && item.state === "error") ? <span className="step-detail">{item.detail}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
