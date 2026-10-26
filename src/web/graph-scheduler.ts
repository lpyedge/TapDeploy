import { graphStepForResourceAction } from "../core/deploy/steps.js";
import { isDispatchableGraphAction } from "../core/planning/graph-operation-support.js";

// Dispatch-order advice for the graph deploy driver. The server discloses the
// unit dependency edges it already sealed into the execution context as
// non-secret `schedulerHints`; the driver uses them only to avoid asking for
// work whose prerequisites it knows are not finished. They carry no authority:
// the server still verifies every receipt and refuses (GRAPH_DEPENDENCY_REQUIRED)
// any step whose prerequisites are missing, whatever order the browser chose.

export interface SchedulerHints {
  version: 1;
  topoOrder: string[];
  dependencies: Array<{ dependent: string; dependency: string }>;
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Hints that are well formed for this plan, or null (the driver refuses the
 * plan). Unknown units, duplicates, self edges, cycles and an order
 * that contradicts the edges are all treated as unusable, never repaired.
 */
export function parseSchedulerHints(raw: unknown, planUnitIds: readonly string[]): SchedulerHints | null {
  if (raw === null || typeof raw !== "object") return null;
  const { version, topoOrder, dependencies } = raw as { version?: unknown; topoOrder?: unknown; dependencies?: unknown };
  if (version !== 1 || !isStringArray(topoOrder) || !Array.isArray(dependencies)) return null;
  const known = new Set(planUnitIds);
  if (topoOrder.length !== known.size || new Set(topoOrder).size !== topoOrder.length || topoOrder.some((id) => !known.has(id))) return null;
  const position = new Map(topoOrder.map((id, index) => [id, index]));
  const seen = new Set<string>();
  const edges: SchedulerHints["dependencies"] = [];
  for (const edge of dependencies) {
    const { dependent, dependency } = (edge ?? {}) as { dependent?: unknown; dependency?: unknown };
    if (typeof dependent !== "string" || typeof dependency !== "string" || dependent === dependency) return null;
    if (!position.has(dependent) || !position.has(dependency)) return null;
    // A valid topological order lists every dependency before its dependent; this also rules out cycles.
    if (position.get(dependency)! >= position.get(dependent)!) return null;
    const key = `${dependent}\0${dependency}`;
    if (seen.has(key)) return null;
    seen.add(key);
    edges.push({ dependent, dependency });
  }
  return { version: 1, topoOrder: [...topoOrder], dependencies: edges };
}

export interface SchedulableAction {
  unitId: string;
  resource: string;
  action: string;
  phase: string;
}

/**
 * True while something this action must follow is still pending: any pending
 * action of a unit its unit depends on (hints), or a pending action of its own
 * unit that the step route requires first (the same prerequisite rules the
 * route enforces: resources before the version upload, the Worker before its
 * activation, and so on). Pure advice for ordering requests; the route re-checks
 * every receipt either way.
 */
export function blockedByPrerequisite(action: SchedulableAction, pending: ReadonlyArray<SchedulableAction>, hints: SchedulerHints): boolean {
  const dependencies = new Set(hints.dependencies.filter((edge) => edge.dependent === action.unitId).map((edge) => edge.dependency));
  return pending.some((other) => {
    if (other === action || !isDispatchableGraphAction(other.action)) return false;
    if (dependencies.has(other.unitId)) return true;
    if (other.unitId !== action.unitId) return false;
    switch (action.phase) {
      case "create-worker":
      case "create-version":
        return graphStepForResourceAction(other.resource, other.action) !== undefined || other.resource === "static-assets";
      case "activate":
        return other.resource === "worker";
      case "reconcile-schedules":
      case "postcheck":
      case "publish-workers-dev":
        return other.resource === "deployment";
      case "register-queue-consumers":
        return other.resource === "worker" || other.resource === "deployment" || (other.resource === "queue" && other.action === "create");
      case "pages-register-assets":
        return other.resource === "pages-project";
      case "pages-deploy":
        return other.resource === "pages-project" || other.resource === "static-assets";
      case "apply-workflows":
      case "reconcile-domains":
        return other.resource === "worker" || other.resource === "deployment";
      default:
        return false;
    }
  });
}
