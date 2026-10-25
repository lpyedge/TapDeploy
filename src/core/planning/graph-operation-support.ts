

interface GraphSupportedOperation {
  readonly supported: true;
  // Exact step phases in execution order. Length > 1 (worker static-assets)
  // means the single graph action executes as an ordered phase pair.
  readonly phases: readonly string[];
  // Provider readback that proves the phase sequence.
  readonly readback: string;
}

interface GraphUnsupportedOperation {
  readonly supported: false;
  readonly code: "UNSUPPORTED_GRAPH_OPERATION";
  readonly detail: string;
}

export type GraphOperationResolution =
  | GraphSupportedOperation
  | GraphUnsupportedOperation;

// Actions that change nothing: correctly skipped without a dispatch.
const NO_DISPATCH_ACTIONS: ReadonlySet<string> = new Set(["preserve", "skip"]);

// Actions the graph may attempt to dispatch. Anything else (conflict and any
// unknown action) fails closed before the first dispatch. `detach` is
// dispatchable only where the catalog below gives it a phase: removing an
// operator-chosen custom domain from its own unit on upgrade.
const DISPATCHABLE_ACTIONS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "attach",
  "detach",
]);

// Operator-chosen custom domains: bind (attach), move from another Worker
// after consent (update), or remove from this unit (detach).
const CUSTOM_DOMAIN_ACTIONS: ReadonlySet<string> = new Set(["attach", "update", "detach"]);
const CUSTOM_DOMAIN_READBACK = "provider custom-domain binding (hostname, owning Worker or Pages project) plus its DNS record";

const ACCOUNT_RESOURCE_CREATE_PHASES: Readonly<Record<string, string>> = {
  r2: "create-r2-buckets",
  d1: "create-d1-databases",
  kv: "create-kv-namespaces",
  queue: "create-queues",
  vectorize: "create-vectorize-indexes",
};

/** True for the only actions a sealed plan may dispatch (never preserve/skip/conflict/detach). */
export function isDispatchableGraphAction(action: string): boolean {
  return DISPATCHABLE_ACTIONS.has(action);
}

/** The account-resource create phase for a resource kind (own keys only), if it has one. */
export function graphResourceCreatePhase(resource: string): string | undefined {
  return Object.hasOwn(ACCOUNT_RESOURCE_CREATE_PHASES, resource) ? ACCOUNT_RESOURCE_CREATE_PHASES[resource] : undefined;
}

function unsupported(
  unitId: string,
  unitKind: string,
  resource: string,
  action: string,
  reason: string,
): GraphUnsupportedOperation {
  return {
    supported: false,
    code: "UNSUPPORTED_GRAPH_OPERATION",
    detail: `UNSUPPORTED_GRAPH_OPERATION(${unitId},${resource},${action}): ${reason} (unitKind ${unitKind})`,
  };
}

/**
 * Resolve one graph diff to its exact phase(s) or to an explicit refusal.
 * Pure: no provider access, no secrets, identical on Node and Workers.
 * `unitId` is used only for the refusal detail string.
 */
export function resolveGraphOperation(input: {
  unitId: string;
  unitKind: string;
  resource: string;
  action: string;
}): GraphOperationResolution {
  const { unitId, unitKind, resource, action } = input;
  if (NO_DISPATCH_ACTIONS.has(action)) {
    return {
      supported: true,
      phases: [],
      readback: "no provider mutation; no readback required",
    };
  }
  if (!DISPATCHABLE_ACTIONS.has(action)) {
    return unsupported(
      unitId,
      unitKind,
      resource,
      action,
      `action "${action}" is never a safe graph mutation`,
    );
  }
  const pages = unitKind === "pages-static" || unitKind === "pages-functions";
  if (pages && resource === "pages-custom-domain" && CUSTOM_DOMAIN_ACTIONS.has(action)) {
    return { supported: true, phases: ["reconcile-domains"], readback: CUSTOM_DOMAIN_READBACK };
  }
  if (unitKind === "worker" && resource === "worker-custom-domain" && CUSTOM_DOMAIN_ACTIONS.has(action)) {
    return { supported: true, phases: ["reconcile-domains"], readback: CUSTOM_DOMAIN_READBACK };
  }
  if (pages) {
    if (resource === "pages-project" && action === "create") {
      return {
        supported: true,
        phases: ["pages-create-project"],
        readback: "provider Pages project id",
      };
    }
    if (resource === "static-assets" && (action === "create" || action === "update")) {
      return {
        supported: true,
        phases: ["pages-register-assets"],
        readback: "upload JWT handoff plus terminal Pages deployment",
      };
    }
    if (resource === "deployment" && action === "create") {
      return {
        supported: true,
        phases: ["pages-deploy"],
        readback: "terminal Pages deployment id and status",
      };
    }
    return unsupported(
      unitId,
      unitKind,
      resource,
      action,
      `Pages unit cannot address "${resource}:${action}"`,
    );
  }
  if (unitKind === "resource-only") {
    if (action === "create") {
      const phase = graphResourceCreatePhase(resource);
      if (phase) {
        return {
          supported: true,
          phases: [phase],
          readback: "account resource id from provider inventory",
        };
      }
    }
    return unsupported(
      unitId,
      unitKind,
      resource,
      action,
      `resource-only unit cannot address "${resource}:${action}"`,
    );
  }
  if (unitKind === "worker") {
    if (resource === "worker" && action === "create") {
      return {
        supported: true,
        phases: ["create-worker"],
        readback: "Worker version id plus binding/runtime proof",
      };
    }
    if (resource === "worker" && action === "update") {
      return {
        supported: true,
        phases: ["create-version"],
        readback: "Worker version id plus binding/runtime proof",
      };
    }
    if (resource === "deployment" && action === "create") {
      return {
        supported: true,
        phases: ["activate"],
        readback: "active deployment id bound to the prepared version",
      };
    }
    // a queue consumer trigger is registered on the queue's consumers
    // subresource after the queue resource exists and the Worker version is
    // live. The provider readback is the exact consumer identity (consumer id
    // plus delivering script) of the exact queue.
    if (resource === "queue-consumer" && (action === "create" || action === "update")) {
      return {
        supported: true,
        phases: ["register-queue-consumers"],
        readback: "provider queue consumer identity (consumer id plus delivering script) of the exact queue",
      };
    }
    // a Workflow definition is applied through the Workflows API after
    // the carrier version is active; the exact `{type:"workflow"}` binding was
    // verified in the version metadata first. The provider readback is the
    // exact workflow identity (name, class, script) plus the exact direct
    // schedule set.
    if (resource === "workflow" && (action === "create" || action === "update")) {
      return {
        supported: true,
        phases: ["apply-workflows"],
        readback:
          "provider workflow identity (name, class, script) plus the exact direct schedule set",
      };
    }
    // explicit zone-scoped route add/protected update. The pattern is
    // created when absent and left untouched when present (updateAction is
    // always preserve from wrangler conversion, so update/detach are
    // unreachable); the sealed receipt binds the zone, pattern, provider id
    // and delivering script, and the readback requires the live route to
    // point at this Worker. Anything else (DNS, custom domains, deletes)
    // has no phase and stays refused.
    if (resource === "worker-route" && (action === "create" || action === "update")) {
      return {
        supported: true,
        phases: ["reconcile-domains"],
        readback: "provider route pattern bound to this Worker in its zone",
      };
    }
    if (action === "create") {
      const phase = graphResourceCreatePhase(resource);
      if (phase) {
        return {
          supported: true,
          phases: [phase],
          readback: "account resource id from provider inventory",
        };
      }
    }
    // Whole-set semantics: the plan emits a nameless schedule diff and the
    // server reconciles the full approved cron set in one PUT (hardens
    // atomicity and readback; the addressing itself is exact here).
    if (resource === "schedule" && (action === "create" || action === "update")) {
      return {
        supported: true,
        phases: ["reconcile-schedules"],
        readback: "exact sorted provider cron set",
      };
    }
    // one graph action executes as an ordered provider-verified pair:
    // register-assets mints the short-lived upload JWT for the exact sealed
    // manifest, the browser uploads only approved buckets, and complete-assets
    // re-registers server-side: the provider itself attests completion (empty
    // missing set) and mints the completion JWT consumed by create-version.
    // No browser-supplied hash, JWT, or manifest is ever trusted.
    if (resource === "static-assets" && (action === "create" || action === "update")) {
      return {
        supported: true,
        phases: ["register-assets", "complete-assets"],
        readback: "provider completion JWT plus serving version with the exact sealed asset manifest",
      };
    }
    // explicit workers.dev enablement. Only a declared intent plans the
    // provider-verified publish step; the step itself is idempotent (no write
    // when already on) and the URL is built solely from provider reads.
    if (resource === "workers-dev" && action === "create") {
      return {
        supported: true,
        phases: ["publish-workers-dev"],
        readback: "provider-enabled flag plus account subdomain",
      };
    }
    if (resource === "secret" && (action === "create" || action === "update")) {
      // secrets are bound into the Worker version upload (create) or
      // inherited from the exact active version (preserve) — never a
      // standalone Secret PUT. The diff is therefore covered by the worker
      // create/update action: no separate dispatch, but the plan refuses
      // anything else.
      return {
        supported: true,
        phases: [],
        readback: "Worker version binding proof (secret names) plus postcheck binding verification",
      };
    }
    if (resource === "secret") {
      return unsupported(
        unitId,
        unitKind,
        resource,
        action,
        `Worker secret action "${action}" is never a safe graph mutation`,
      );
    }
    return unsupported(
      unitId,
      unitKind,
      resource,
      action,
      `Worker unit cannot address "${resource}:${action}"`,
    );
  }
  return unsupported(
    unitId,
    unitKind,
    resource,
    action,
    `unknown unit kind "${unitKind}"`,
  );
}

/**
 * The single step phase the server accepts for an approved action: the first
 * phase of its catalog resolution, or undefined when the action is not
 * dispatchable, unsupported or covered by another action's phase.
 */
export function exactGraphPhase(input: {
  unitId: string;
  unitKind: string;
  resource: string;
  action: string;
}): string | undefined {
  if (!isDispatchableGraphAction(input.action)) return undefined;
  const resolution = resolveGraphOperation(input);
  return resolution.supported ? resolution.phases[0] : undefined;
}

interface GraphDiffLike {
  readonly resource: string;
  readonly action: string;
  readonly name?: string;
}

export interface GraphUnitLike {
  readonly unitId: string;
  readonly kind: string;
  readonly diffs: readonly GraphDiffLike[];
}

export interface GraphUnsupportedDiff {
  readonly unitId: string;
  readonly resource: string;
  readonly action: string;
  readonly name?: string;
  readonly detail: string;
}

/**
 * Plan preflight: every dispatchable diff in every unit must resolve to an
 * exact supported phase sequence. Returns the offending diffs (empty when the
 * whole graph is addressable). No-op actions never offend.
 */
export function unsupportedGraphDiffs(
  units: readonly GraphUnitLike[],
): GraphUnsupportedDiff[] {
  const out: GraphUnsupportedDiff[] = [];
  for (const unit of units) {
    for (const diff of unit.diffs ?? []) {
      if (NO_DISPATCH_ACTIONS.has(diff.action)) continue;
      const resolution = resolveGraphOperation({
        unitId: unit.unitId,
        unitKind: unit.kind,
        resource: diff.resource,
        action: diff.action,
      });
      if (!resolution.supported) {
        out.push({
          unitId: unit.unitId,
          resource: diff.resource,
          action: diff.action,
          ...(diff.name !== undefined ? { name: diff.name } : {}),
          detail: resolution.detail,
        });
      }
    }
  }
  return out;
}
