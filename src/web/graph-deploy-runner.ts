// Sealed-graph deploy driver (browser). `runGraphDeploy` is the stable entry:
// it dispatches the server-approved actions step by step with chained receipts,
// then runs the Worker postchecks and the Pages postchecks. A Worker
// deployment id never enters the Pages loop.

import { doGraphStep, isAuthFailure, type GraphPlan } from "./api.js";
import { v3UnitWorkerPaths, v3WorkerStepBytes, type V3RetainedSource } from "./release.js";
import { blockedByPrerequisite, parseSchedulerHints, type SchedulerHints } from "./graph-scheduler.js";
import { graphActionId } from "../core/planning/digest.js";
import { resolveGraphOperation } from "../core/planning/graph-operation-support.js";
import { type DeployStepState, verifiedDeploymentUrl, safeErrorMessage } from "./deploy-shared.js";
import { normalizeHostname } from "../core/deploy/custom-domains.js";
import { v3PagesManifestFor, uploadV3WorkerAssets, uploadV3PagesAssets } from "./graph-upload.js";

export interface GraphDeployAction {
  unitId: string;
  unitKind: string;
  resource: string;
  action: string;
  name?: string;
  actionId: string;
  phase: string;
}

export interface GraphStepStatus {
  unitId: string;
  resource: string;
  action: string;
  name?: string;
  phase: string;
  state: DeployStepState;
  detail?: string;
  // Present and true once the server sealed a phase receipt for this action.
  receipt?: boolean;
}

export interface GraphDeployContext {
  csrf: string;
  accountId: string;
  /** Exact retained ZIP bytes both sources converged on. */
  source: V3RetainedSource;
  /** V3 config text (addressing only: unit/wrangler paths). */
  configText: string;
  releaseProof: unknown;
  graphPlan: GraphPlan;
  executionContext: unknown;
  approval: unknown;
  /** Per-unit bundle digests disclosed by the plan response, when present. */
  bundleDigests?: Record<string, string>;
  secretValues?: Record<string, string>;
  /** The operator confirmed replacing what serves a chosen hostname today (Configure step). */
  confirmDomainChanges?: boolean;
  /** Non-secret dispatch-order advice from the plan response; never authority. */
  schedulerHints?: unknown;
  signal?: AbortSignal;
  onStep?: (status: GraphStepStatus) => void;
}

export interface GraphDeployResult {
  ok: boolean;
  receipts: unknown[];
  failedAction?: { unitId: string; resource: string; action: string; name?: string; phase: string };
  error?: string;
  authExpired?: boolean;
  pending?: boolean;
  // Verified public addresses, most specific first: operator-bound custom
  // domains, then workers.dev, then the Pages production address.
  urls?: string[];
  // Non-fatal truthful outcome (e.g. deployed but account has no workers.dev
  // subdomain yet). Never a URL.
  publishNote?: string;
}

/** Expand the server-derived plan into addressable actions. Throws (fail-closed) on anything unaddressable. */
export function graphActionsForPlan(plan: GraphPlan): GraphDeployAction[] {
  const out: GraphDeployAction[] = [];
  for (const unit of plan.units ?? []) {
    for (const diff of unit.diffs ?? []) {
      const resolution = resolveGraphOperation({
        unitId: unit.unitId,
        unitKind: unit.kind,
        resource: diff.resource,
        action: diff.action,
      });
      if (!resolution.supported) {
        throw new Error(
          `approved action "${unit.unitId}:${diff.resource}:${diff.action}" is not safely dispatchable (${resolution.detail}); refusing partial deploy`,
        );
      }
      if (resolution.phases.length === 0) continue;
      const phase = resolution.phases[0]!;
      out.push({
        unitId: unit.unitId,
        unitKind: unit.kind,
        resource: diff.resource,
        action: diff.action,
        ...(diff.name !== undefined ? { name: diff.name } : {}),
        actionId: graphActionId({ unitId: unit.unitId, resource: diff.resource, action: diff.action, ...(diff.name !== undefined ? { name: diff.name } : {}) }),
        phase,
      });
    }
  }
  return out;
}

interface V3UnitAddress {
  wranglerPath?: string;
}

/** Resolve each unit id to its declared Wrangler path from the V3 config text (addressing only). */
async function v3UnitAddresses(configText: string, source: V3RetainedSource): Promise<Map<string, V3UnitAddress>> {
  let value: unknown;
  try {
    value = JSON.parse(configText);
  } catch {
    throw new Error("V3 config text is not valid JSON; cannot address graph units");
  }
  const units = (value as { units?: unknown }).units;
  const out = new Map<string, V3UnitAddress>();
  if (units === undefined) {
    const candidates = (await source.access.listFiles()).filter((entry) => entry.path === "wrangler.jsonc" || entry.path.endsWith("/wrangler.jsonc")).map((entry) => entry.path);
    if (candidates.length !== 1 || !candidates[0]) throw new Error("implicit single-unit release must contain exactly one wrangler.jsonc");
    out.set("main", { wranglerPath: candidates[0] });
    return out;
  }
  if (!Array.isArray(units)) throw new Error("V3 config units must be an array");
  for (const unit of units) {
    if (!unit || typeof unit !== "object") throw new Error("V3 config unit must be an object");
    const record = unit as { id?: unknown; kind?: unknown; wrangler?: unknown };
    if (typeof record.id !== "string" || !record.id) throw new Error("V3 config unit is missing its id");
    out.set(record.id, typeof record.wrangler === "string" && record.wrangler ? { wranglerPath: record.wrangler } : {});
  }
  return out;
}

/**
 * Sealed-graph deploy driver, one instance per deploy run. All run-scoped
 * observations (receipts, produced version/deployment ids, workers.dev
 * outcome) live on the instance — never in module state and never persisted —
 * so a re-run starts from a clean slate. Phase order is fixed: dispatch every
 * approved action (server order authoritative) -> worker postchecks ->
 * pages postchecks. `runGraphDeploy` below is the stable entry point.
 */
// The https address of a custom domain a reconcile-domains step attached (or
// moved) and verified; unbinding or keeping one yields no new address.
function boundDomainUrl(action: GraphDeployAction): string | undefined {
  if (action.phase !== "reconcile-domains" || (action.action !== "attach" && action.action !== "update")) return undefined;
  if (action.resource !== "worker-custom-domain" && action.resource !== "pages-custom-domain") return undefined;
  const hostname = normalizeHostname(action.name);
  return hostname ? `https://${hostname}/` : undefined;
}

class GraphDeployRunner {
  private readonly onStep: NonNullable<GraphDeployContext["onStep"]>;
  private readonly receipts: unknown[] = [];
  private actions: GraphDeployAction[] = [];
  private addresses = new Map<string, V3UnitAddress>();
  private base: { accountId: string; executionContext: unknown; approval: unknown } = { accountId: "", executionContext: undefined, approval: undefined };
  private readonly versions = new Map<string, string>();
  private readonly deployments = new Map<string, string>();
  private readonly domainUrls: string[] = [];
  private readonly workersDevUrls: string[] = [];
  private pagesUrls: string[] = [];
  private publishNote: string | undefined;
  private readonly assetCompletions = new Map<string, string>();
  private readonly workerActionIds = new Map<string, string>();
  private readonly deploymentActionIds = new Map<string, string>();
  private assetUnits = new Set<string>();
  private pending: GraphDeployAction[] = [];

  constructor(private readonly ctx: GraphDeployContext) {
    this.onStep = ctx.onStep ?? (() => undefined);
  }

  async run(): Promise<GraphDeployResult> {
    try {
      this.actions = graphActionsForPlan(this.ctx.graphPlan);
    } catch (error) {
      return { ok: false, receipts: this.receipts, error: safeErrorMessage(error) };
    }
    const hints = parseSchedulerHints(this.ctx.schedulerHints, this.ctx.graphPlan.units.map((unit) => unit.unitId));
    if (!hints) return { ok: false, receipts: this.receipts, error: "The deployment plan has missing or invalid scheduler hints. Review the changes again to obtain a new plan." };
    try {
      this.addresses = await v3UnitAddresses(this.ctx.configText, this.ctx.source);
    } catch (error) {
      return { ok: false, receipts: this.receipts, error: safeErrorMessage(error) };
    }
    this.base = {
      accountId: this.ctx.accountId,
      executionContext: this.ctx.executionContext,
      approval: this.ctx.approval,
    };
    // Units carrying a static-assets action must complete the asset pair before
    // any version upload for that unit.
    this.assetUnits = new Set(this.actions.filter((a) => a.resource === "static-assets").map((a) => a.unitId));
    this.pending = [...this.actions];
    const actionsOutcome = await this.runActions(hints);
    if (actionsOutcome) return actionsOutcome;
    if (this.ctx.signal?.aborted) return { ok: false, receipts: this.receipts, error: "deploy aborted" };
    const workerOutcome = await this.runWorkerPostchecks();
    if (workerOutcome) return workerOutcome;
    if (this.ctx.signal?.aborted) return { ok: false, receipts: this.receipts, error: "deploy aborted" };
    const pagesOutcome = await this.runPagesPostchecks();
    if (pagesOutcome) return pagesOutcome;
    if (this.ctx.signal?.aborted) return { ok: false, receipts: this.receipts, error: "deploy aborted" };
    // surface only verified addresses (or the explicit not-published note
    // alongside success). No URL is ever fabricated.
    const urls = [...new Set([...this.domainUrls, ...this.workersDevUrls, ...this.pagesUrls])];
    return { ok: true, receipts: this.receipts, ...(urls.length > 0 ? { urls } : {}), ...(this.publishNote ? { publishNote: this.publishNote } : {}) };
  }

  private fail(action: GraphDeployAction | undefined, error: unknown): GraphDeployResult {
    if (isAuthFailure(error)) {
      return { ok: false, receipts: this.receipts, authExpired: true, ...(action ? { failedAction: toFailedAction(action) } : {}) };
    }
    return { ok: false, receipts: this.receipts, ...(action ? { failedAction: toFailedAction(action) } : {}), error: safeErrorMessage(error) };
  }

  private async runActions(hints: SchedulerHints): Promise<GraphDeployResult | null> {
    const { ctx, receipts, pending, actions, addresses, base, versions, deployments, workerActionIds, deploymentActionIds, assetUnits, assetCompletions } = this;
    const onStep = this.onStep;
    const fail = (action: GraphDeployAction | undefined, error: unknown): GraphDeployResult => this.fail(action, error);
    const unitState = { versions, deployments, assetCompletions };
    // Dependency-retry loop: each round must complete at least one action or the
    // graph is deadlocked and fails closed. Server order is authoritative.
    // Walk the current plan in order; prerequisites wait locally. The server
    // still checks receipts, including dependencies omitted from the advice.
    for (let round = 0; pending.length > 0 && round <= actions.length; round += 1) {
      if (ctx.signal?.aborted) return { ok: false, receipts, error: "deploy aborted" };
      let completed = 0;
      for (let index = 0; index < pending.length; index += 1) {
        if (ctx.signal?.aborted) return { ok: false, receipts, error: "deploy aborted" };
        const action = pending[index]!;
        if (blockedByPrerequisite(action, pending, hints)) continue;
        onStep({ ...toFailedAction(action), state: "running" });
        try {
          const result = await dispatchGraphAction(ctx, base, addresses, action, receipts, unitState, assetUnits);
          if (result.phaseReceipts !== undefined) receipts.push(...result.phaseReceipts);
          else if (result.phaseReceipt !== undefined) receipts.push(result.phaseReceipt);
          if (result.versionId) versions.set(action.unitId, result.versionId);
          // Worker activate also returns a Cloudflare deployment id, but that is
          // a Workers deployment, not a Pages deployment: only pages-kind units
          // feed the pages-postcheck loop. Recording a worker deployment id here
          // used to fire a bogus pages-postcheck (GRAPH_PHASE_MISMATCH) after
          // every successful worker deploy.
          if (result.deploymentId && (action.unitKind === "pages-static" || action.unitKind === "pages-functions")) deployments.set(action.unitId, result.deploymentId);
          // Keep every verified address in a multi-Worker release.
          if (result.url) this.workersDevUrls.push(result.url);
          if (result.publishNote && !this.publishNote) this.publishNote = result.publishNote;
          // A custom domain bound by a verified reconcile-domains step.
          const domainUrl = boundDomainUrl(action);
          if (domainUrl) this.domainUrls.push(domainUrl);
          if (action.resource === "worker") workerActionIds.set(action.unitId, action.actionId);
          if (action.resource === "deployment") deploymentActionIds.set(action.unitId, action.actionId);
          pending.splice(index, 1);
          index -= 1;
          completed += 1;
          onStep({ ...toFailedAction(action), state: "done", ...(result.phaseReceipt !== undefined ? { receipt: true as const } : {}) });
        } catch (error) {
          if (isDependencyRefusal(error)) {
            onStep({ ...toFailedAction(action), state: "waiting", detail: "waiting for dependency receipts" });
            continue;
          }
          onStep({ ...toFailedAction(action), state: "error", detail: safeErrorMessage(error) });
          return fail(action, error);
        }
      }
      if (completed === 0) {
        const stuck = pending[0]!;
        onStep({ ...toFailedAction(stuck), state: "error", detail: "graph dependencies cannot be satisfied" });
        return { ok: false, receipts, failedAction: toFailedAction(stuck), error: `graph dependencies cannot be satisfied; action "${stuck.unitId}:${stuck.resource}:${stuck.action}" is still blocked after all others completed` };
      }
    }
    if (pending.length > 0) {
      const stuck = pending[0]!;
      return { ok: false, receipts, failedAction: toFailedAction(stuck), error: "graph deploy did not converge" };
    }
    return null;
  }

  private async runWorkerPostchecks(): Promise<GraphDeployResult | null> {
    const { ctx, receipts, versions, workerActionIds } = this;
    const onStep = this.onStep;
    const fail = (action: GraphDeployAction | undefined, error: unknown): GraphDeployResult => this.fail(action, error);
    const base = this.base;
    // Read-only postchecks: each needs the produced identity, never a guess.
    for (const [unitId, versionId] of versions) {
      if (ctx.signal?.aborted) return { ok: false, receipts, error: "deploy aborted" };
      const actionId = workerActionIds.get(unitId);
      if (!actionId) continue;
      const action = { unitId, unitKind: "worker", resource: "worker", action: "create", actionId, phase: "postcheck" };
      onStep({ ...toFailedAction(action), state: "running" });
      try {
        const res = await doGraphStep(ctx.csrf, { ...base, unitId, actionId, phase: "postcheck", step: "postcheck", ...(bundleDigestFor(ctx, unitId) ? { bundleDigest: bundleDigestFor(ctx, unitId) } : {}), args: { ...(receipts.length ? { receipts: [...receipts] } : {}), expectedVersionId: versionId } });
        if (!res.ok) throw graphStepError(res);
        const verdict = res.result as { deployed?: boolean; bindingsVerified?: boolean; bindingMismatches?: string[] } | undefined;
        if (!verdict?.deployed) throw new Error("postcheck reported the target version is not the active deployment");
        // a cutover to a version missing approved bindings is not a
        // success, even when the version itself is active, so version-readback
        // mismatches cannot slip through.
        if (verdict.bindingsVerified === false) {
          throw new Error(`postcheck: the deployed Worker bindings differ from the approved plan (${(verdict.bindingMismatches ?? []).join("; ")})`);
        }
        if (res.phaseReceipt !== undefined) receipts.push(res.phaseReceipt);
        onStep({ ...toFailedAction(action), state: "done", ...(res.phaseReceipt !== undefined ? { receipt: true as const } : {}) });
      } catch (error) {
        onStep({ ...toFailedAction(action), state: "error", detail: safeErrorMessage(error) });
        return fail(action, error);
      }
    }
    return null;
  }

  private async runPagesPostchecks(): Promise<GraphDeployResult | null> {
    const { ctx, receipts, deployments, deploymentActionIds } = this;
    const onStep = this.onStep;
    const fail = (action: GraphDeployAction | undefined, error: unknown): GraphDeployResult => this.fail(action, error);
    const base = this.base;
    for (const [unitId, deploymentId] of deployments) {
      if (ctx.signal?.aborted) return { ok: false, receipts, error: "deploy aborted" };
      const actionId = deploymentActionIds.get(unitId);
      if (!actionId) continue;
      const action = { unitId, unitKind: "pages-static", resource: "deployment", action: "create", actionId, phase: "pages-postcheck" };
      onStep({ ...toFailedAction(action), state: "running" });
      try {
        const res = await doGraphStep(ctx.csrf, { ...base, unitId, actionId, phase: "pages-postcheck", step: "pages-postcheck", ...(bundleDigestFor(ctx, unitId) ? { bundleDigest: bundleDigestFor(ctx, unitId) } : {}), args: { ...(receipts.length ? { receipts: [...receipts] } : {}), deploymentId } });
        if (!res.ok) throw graphStepError(res);
        const verdict = res.result as { succeeded?: boolean; pending?: boolean; status?: string; url?: string } | undefined;
        if (!verdict?.succeeded) {
          if (verdict?.pending) return { ok: false, receipts, failedAction: toFailedAction(action), pending: true, error: `Pages deployment ${deploymentId} is still in progress (${verdict.status ?? "unknown"})` };
          throw new Error(`Pages deployment ${deploymentId} ended with ${verdict?.status ?? "unknown"}`);
        }
        if (res.phaseReceipt !== undefined) receipts.push(res.phaseReceipt);
        const url = verifiedDeploymentUrl(verdict.url);
        onStep({ ...toFailedAction(action), state: "done", ...(res.phaseReceipt !== undefined ? { receipt: true as const } : {}) });
        if (url) this.pagesUrls.push(url);
      } catch (error) {
        onStep({ ...toFailedAction(action), state: "error", detail: safeErrorMessage(error) });
        return fail(action, error);
      }
    }
    return null;
  }
}

export async function runGraphDeploy(ctx: GraphDeployContext): Promise<GraphDeployResult> {
  return new GraphDeployRunner(ctx).run();
}

function toFailedAction(action: { unitId: string; resource: string; action: string; name?: string; phase: string }): { unitId: string; resource: string; action: string; name?: string; phase: string } {
  return { unitId: action.unitId, resource: action.resource, action: action.action, ...(action.name !== undefined ? { name: action.name } : {}), phase: action.phase };
}

function bundleDigestFor(ctx: GraphDeployContext, unitId: string): string | undefined {
  const digest = ctx.bundleDigests?.[unitId];
  return typeof digest === "string" && digest ? digest : undefined;
}

function isDependencyRefusal(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { kind?: unknown }).kind === "GRAPH_DEPENDENCY_REQUIRED";
}

function graphStepError(res: { error?: string; detail?: string }): Error {
  const error = new Error(res.detail ?? res.error ?? "graph step failed") as Error & { kind?: string };
  if (res.error) error.kind = res.error;
  return error;
}

async function dispatchGraphAction(
  ctx: GraphDeployContext,
  base: { accountId: string; executionContext: unknown; approval: unknown },
  addresses: Map<string, V3UnitAddress>,
  action: GraphDeployAction,
  receipts: unknown[],
  unitState: { versions: Map<string, string>; deployments: Map<string, string>; assetCompletions: Map<string, string> },
  assetUnits: Set<string>,
): Promise<{ phaseReceipt?: unknown; phaseReceipts?: unknown[]; versionId?: string; deploymentId?: string; url?: string; publishNote?: string }> {
  const args: Record<string, unknown> = {};
  if (receipts.length > 0) args.receipts = [...receipts];
  const address = addresses.get(action.unitId) ?? {};
  // the sealed worker-asset pair executes inline for one graph action:
  // register-assets mints the provider upload JWT for the exact sealed
  // manifest, only approved buckets are uploaded, then complete-assets asks
  // the provider to attest completion. Both phase receipts are collected
  // under the same actionId; the completion JWT flows into the same unit's
  // version upload (never persisted, memory only).
  if (action.phase === "register-assets" && action.resource === "static-assets") {
    const register = await doGraphStep(ctx.csrf, {
      ...base,
      unitId: action.unitId,
      actionId: action.actionId,
      phase: "register-assets",
      step: "register-assets",
      ...(bundleDigestFor(ctx, action.unitId) ? { bundleDigest: bundleDigestFor(ctx, action.unitId) } : {}),
      args,
    });
    if (!register.ok) throw graphStepError(register);
    const session = register.result as { jwt?: unknown; buckets?: unknown } | undefined;
    const sessionJwt = session?.jwt;
    if (typeof sessionJwt !== "string" || !sessionJwt) throw new Error("asset upload JWT was not returned");
    // The upload leg throws on any failure (wrong JWT, forbidden hash,
    // transport error) before completion is requested; the server alone mints
    // the completion token from the provider re-registration below.
    await uploadV3WorkerAssets(ctx, address.wranglerPath, sessionJwt, session?.buckets);
    const completeReceipts = [...(args.receipts as unknown[] ?? [])];
    if (register.phaseReceipt !== undefined) completeReceipts.push(register.phaseReceipt);
    const complete = await doGraphStep(ctx.csrf, {
      ...base,
      unitId: action.unitId,
      actionId: action.actionId,
      phase: "complete-assets",
      step: "complete-assets",
      ...(bundleDigestFor(ctx, action.unitId) ? { bundleDigest: bundleDigestFor(ctx, action.unitId) } : {}),
      args: { ...(completeReceipts.length > 0 ? { receipts: completeReceipts } : {}) },
    });
    if (!complete.ok) throw graphStepError(complete);
    const completion = (complete.result as { jwt?: unknown } | undefined)?.jwt;
    if (typeof completion !== "string" || !completion) throw new Error("asset completion JWT was not returned");
    unitState.assetCompletions.set(action.unitId, completion);
    const pairReceipts = [register.phaseReceipt, complete.phaseReceipt].filter((r) => r !== undefined);
    return { ...(pairReceipts.length > 0 ? { phaseReceipts: pairReceipts } : {}), ...(complete.phaseReceipt !== undefined ? { phaseReceipt: complete.phaseReceipt } : {}) };
  }
  if (action.phase === "activate") {
    // The cutover must name the exact version the create receipt attests;
    // the route rejects anything else before touching the provider. A missing
    // version only means the create has not completed yet: defer like any
    // other server-ordered dependency instead of failing the graph.
    const versionId = unitState.versions.get(action.unitId);
    if (!versionId) {
      const deferred = new Error(`unit "${action.unitId}" has no created version to activate yet`) as Error & { kind?: string };
      deferred.kind = "GRAPH_DEPENDENCY_REQUIRED";
      throw deferred;
    }
    args.versionId = versionId;
  } else if (action.phase === "create-worker" || action.phase === "create-version") {
    if (!address.wranglerPath) throw new Error(`unit "${action.unitId}" declares no Wrangler path; cannot address worker bytes`);
    const paths = await v3UnitWorkerPaths(ctx.source, address.wranglerPath);
    Object.assign(args, await v3WorkerStepBytes(ctx.source, paths.main, paths.extras));
    if (ctx.secretValues && Object.keys(ctx.secretValues).length > 0) args.secrets = { ...ctx.secretValues };
    if (assetUnits.has(action.unitId)) {
      // The version upload must carry the completion JWT of the same unit's
      // sealed asset pair; a missing completion only means the pair has not
      // completed yet: defer like any other server-ordered dependency.
      const completionJwt = unitState.assetCompletions.get(action.unitId);
      if (!completionJwt) {
        const deferred = new Error(`unit "${action.unitId}" has no completed asset upload to bind yet`) as Error & { kind?: string };
        deferred.kind = "GRAPH_DEPENDENCY_REQUIRED";
        throw deferred;
      }
      args.assetJwt = completionJwt;
    }
  } else if (action.phase === "pages-create-project") {
    if (ctx.secretValues && Object.keys(ctx.secretValues).length > 0) args.secrets = { ...ctx.secretValues };
  } else if (action.phase === "reconcile-domains") {
    // The step re-requires the operator's replacement consent for any
    // approved explicit-change entry; it is only sent when they gave it.
    if (ctx.confirmDomainChanges) args.confirmDomainChanges = true;
  } else if (action.phase === "publish-workers-dev") {
    // the approved enable intent travels as the step argument (the plan
    // diff is the authority; the server re-verifies). The provider-verified
    // URL (or the explicit not-published outcome) comes back in the result.
    args.publish = true;
  } else if (action.phase === "pages-register-assets") {
    // Handled below: the JWT upload must succeed before the step is complete.
  } else if (action.phase === "pages-deploy") {
    // NOTE: no workerBundleB64 is sent: the server projection currently
    // declares no per-unit Pages worker bundle, so any bundle payload would
    // fail closed server-side. If bundle support lands (declare + verify),
    // re-add it here with the sealed binding.
    args.manifest = (await v3PagesManifestFor(ctx, address.wranglerPath)).manifest;
  }
  const res = await doGraphStep(ctx.csrf, {
    ...base,
    unitId: action.unitId,
    actionId: action.actionId,
    phase: action.phase,
    step: action.phase,
    ...(bundleDigestFor(ctx, action.unitId) ? { bundleDigest: bundleDigestFor(ctx, action.unitId) } : {}),
    args,
  });
  if (!res.ok) throw graphStepError(res);
  if (action.phase === "pages-register-assets") {
    const jwt = (res.result as { jwt?: unknown } | undefined)?.jwt;
    if (typeof jwt !== "string" || !jwt) throw new Error("Pages upload JWT was not returned");
    await uploadV3PagesAssets(ctx, address.wranglerPath, jwt);
  }
  // surface the provider-verified workers.dev outcome. The URL is only
  // ever the provider-built address from the publish step's result (a Pages
  // deployment's own hash address is not it); a missing account subdomain
  // surfaces as an explicit non-fatal note, never a URL.
  const publishedUrl = action.phase === "publish-workers-dev" ? verifiedDeploymentUrl((res.result as { url?: unknown } | undefined)?.url) : undefined;
  const publishReason = (res.result as { reason?: unknown } | undefined)?.reason;
  return {
    ...(res.phaseReceipt !== undefined ? { phaseReceipt: res.phaseReceipt } : {}),
    ...(((res.result as { versionId?: unknown } | undefined)?.versionId as string | undefined) ? { versionId: (res.result as { versionId: string }).versionId } : {}),
    ...(((res.result as { deploymentId?: unknown } | undefined)?.deploymentId as string | undefined) ? { deploymentId: (res.result as { deploymentId: string }).deploymentId } : {}),
    ...(publishedUrl ? { url: publishedUrl } : {}),
    ...(publishReason === "no-account-subdomain" ? { publishNote: "This account has no workers.dev subdomain yet, so the Worker is deployed but not published. Create the subdomain in the Cloudflare dashboard (Workers & Pages), then enable the Worker's workers.dev route." } : {}),
  };
}
