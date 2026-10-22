import type { DeploySpec } from "../deploy-spec.js";

export interface ExactGraphAction {
  resource: string;
  action: string;
  name?: string;
}

/**
 * Produces the only spec a graph resource mutation may receive.  In particular,
 * the resource helpers must never see a second create candidate merely
 * because it was present in the original unit spec.
 */
// An operator-chosen custom domain addresses exactly one entry of its unit;
// only that entry reaches reconcile-domains (the step re-decides it against
// live state and refuses anything the approval does not cover).
function customDomainSlice(spec: DeploySpec, action: ExactGraphAction, kind: "workers-custom-domain" | "pages-custom-domain"): DeploySpec | null {
  if (action.action !== "attach" && action.action !== "update" && action.action !== "detach") return null;
  const domains = (spec.cloudflare.domains ?? []).filter((item) => item.kind === kind && item.hostname === action.name);
  if (domains.length !== 1) return null;
  if ((action.action === "detach") !== (domains[0]!.updateAction === "detach")) return null;
  return { ...spec, cloudflare: { ...spec.cloudflare, domains } };
}

export function exactGraphDispatchSpec(
  spec: DeploySpec,
  action: ExactGraphAction,
): DeploySpec | null {
  if (!action.name) {
    // the plan emits a nameless schedule diff carrying the whole approved
    // cron set; dispatch the full spec so reconcileSchedules can PUT the exact
    // set (hardens atomicity/readback). Every other resource still
    // requires a name to slice its exact batch.
    if (action.resource === "schedule" && (action.action === "create" || action.action === "update")) return spec;
    return null;
  }
  if (spec.targetKind === "pages" && action.resource === "pages-custom-domain") return customDomainSlice(spec, action, "pages-custom-domain");
  if (spec.targetKind === "workers" && action.resource === "worker-custom-domain") return customDomainSlice(spec, action, "workers-custom-domain");
  // Pages is a distinct target: project/deployment/asset diffs bind to the
  // Pages project name, never to a Worker script name. The full spec is
  // returned (asset handoff is verified against the sealed asset set at
  // deploy time); narrowing per-resource slices only applies to Workers.
  if (spec.targetKind === "pages") {
    const projectName = spec.cloudflare.pages?.projectName;
    if (!projectName || action.name !== projectName) return null;
    if (action.resource === "pages-project" && action.action === "create") return spec;
    if (action.resource === "deployment" && action.action === "create") return spec;
    if (action.resource === "static-assets" && (action.action === "create" || action.action === "update")) return spec;
    return null;
  }
  // the plan emits a single unit-bound whole-set schedule action (the
  // nameless case returns the full spec above). A per-cron `name` slice must
  // never be passed to the replace-all schedules API (it would silently drop
  // the other expressions), so a named schedule action is not dispatchable.
  if (action.resource === "schedule" && (action.action === "create" || action.action === "update")) {
    return null;
  }
  if ((action.resource === "worker" || action.resource === "deployment") && (action.action === "create" || action.action === "update") && action.name === spec.cloudflare.workerName) return spec;
  if (action.resource === "static-assets" && (action.action === "create" || action.action === "update")) {
    // the worker asset pair operates on the whole sealed spec (manifest
    // plus code). Dispatch the full spec; the route enforces register before
    // complete and completion before any version upload.
    if (spec.targetKind === "workers" && action.name === spec.cloudflare.workerName) return spec;
    return null;
  }
  if (action.resource === "workers-dev" && action.action === "create") {
    // exposure verification needs the whole sealed spec (worker identity
    // plus resolved bindings). Dispatch the full spec; the route enforces
    // activation first and verifies the provider flag plus subdomain.
    if (spec.targetKind === "workers" && action.name === spec.cloudflare.workerName) return spec;
    return null;
  }
  // a consumer trigger operates on exactly one declared consumer/both
  // queue of this unit; only that queue reaches the registration step. Create
  // and update are both exact-queue actions.
  if (action.resource === "queue-consumer" && (action.action === "create" || action.action === "update")) {
    const consumers = spec.cloudflare.queues.filter(
      (item) => item.queueName === action.name && (item.role === "consumer" || item.role === "both"),
    );
    if (consumers.length !== 1) return null;
    return { ...spec, cloudflare: { ...spec.cloudflare, queues: consumers } };
  }
  // a Workflow definition operates on exactly one declared workflow of
  // this unit; only that definition reaches the apply-workflows step (the step
  // re-verifies ownership and readback against the live provider state).
  if (action.resource === "workflow" && (action.action === "create" || action.action === "update")) {
    const workflows = (spec.cloudflare.workflows ?? []).filter((item) => item.name === action.name);
    if (workflows.length !== 1) return null;
    return { ...spec, cloudflare: { ...spec.cloudflare, workflows } };
  }
  // a route operation addresses exactly one declared pattern of this
  // unit; only that entry reaches reconcile-domains (the step re-verifies the
  // live route and refuses foreign targets with zero writes).
  if (action.resource === "worker-route" && (action.action === "create" || action.action === "update")) {
    const domains = (spec.cloudflare.domains ?? []).filter((item) => item.kind === "workers-route" && item.hostname === action.name);
    if (domains.length !== 1) return null;
    return { ...spec, cloudflare: { ...spec.cloudflare, domains } };
  }
  if (action.action !== "create") return null;
  if (action.resource === "worker" && action.name === spec.cloudflare.workerName) return spec;
  const cloudflare = { ...spec.cloudflare };
  switch (action.resource) {
    case "r2":
      cloudflare.r2 = spec.cloudflare.r2.filter((item) => item.bucketName === action.name);
      if (cloudflare.r2.length !== 1) return null;
      break;
    case "d1":
      cloudflare.d1 = spec.cloudflare.d1.filter((item) => item.databaseName === action.name);
      if (cloudflare.d1.length !== 1) return null;
      break;
    case "kv":
      // match by declared provider id when present (the live name is
      // resolved into namespaceName after snapshot, but the id is the stable
      // identity); otherwise match the TapDeploy-managed name.
      cloudflare.kv = spec.cloudflare.kv.filter((item) => item.namespaceName === action.name || (item.namespaceId !== undefined && item.namespaceId === action.name));
      if (cloudflare.kv.length !== 1) return null;
      break;
    case "queue":
      cloudflare.queues = spec.cloudflare.queues.filter((item) => item.queueName === action.name);
      if (cloudflare.queues.length !== 1) return null;
      break;
    case "vectorize":
      cloudflare.vectorize = spec.cloudflare.vectorize.filter((item) => item.indexName === action.name && item.config !== undefined);
      if (cloudflare.vectorize.length !== 1) return null;
      break;
    default:
      return null;
  }
  return { ...spec, cloudflare };
}
