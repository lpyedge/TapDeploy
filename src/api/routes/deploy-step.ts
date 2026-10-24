// One authenticated deploy step. The client re-sends manifest + inputs +
// wranglerJsonc + the digest from /api/deploy/plan plus the step and its args;
// the server re-plans against a fresh live snapshot, verifies the digest still
// matches (otherwise the plan is stale and no write happens), then executes
// exactly one step. Asset payloads never transit this route.
//
// State machine: the digest binds only the immutable approved
// release/target identity (see planning/digest.ts) so own writes never stale
// it; the explicit expected target guards external drift. Own activate
// legitimately advances the active deployment. Mutating post-activate steps
// require a sealed session/plan/version receipt, exclusive active ownership,
// and unchanged resource identities; read-only postcheck reports facts. Other guards fail
// closed, and pre-activate steps stay strict so outside writes block.

import { pagesCnameTarget } from "../../core/deploy/custom-domains.js";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv, TapDeployEnv } from "../app.js";
import { parseCookies } from "../../auth/cookies.js";
import { validateCsrf, validateOrigin } from "../../auth/csrf.js";
import { sessionCookieName, readSession, type SessionPayload } from "../../auth/session.js";
import type { DeploySpec } from "../../core/deploy-spec.js";
import type { DeployBundle } from "../../release/deploy-bundle.js";
import {
  createCloudflareClient,
  type CloudflareApiError,
  type CloudflareApiClient,
} from "../../cloudflare/client/index.js";
import { snapshotAccountResources, snapshotTarget } from "../../core/planning/snapshot.js";
import type { GraphDeployPlan, GraphPlanUnitPlan } from "../../core/planning/plan.js";
import { graphActionId, isManagedWorkerForProject } from "../../core/planning/digest.js";
import type { ExpectedTarget, TargetSnapshot } from "../../core/planning/types.js";
import {
  DEPLOY_STEP_NAMES,
  assetUploadManifest,
  executeDeployStep,
  isGraphActionStepAllowed,
  graphStepForResourceAction,
  versionMessage,
  type DeployStepName,
} from "../../core/deploy/steps.js";
import { loadKey } from "./auth.js";
import { openSeal, type SealedEnvelope } from "../../auth/keys.js";
import { detectDrift, withAuthenticatedCreates } from "../../core/planning/drift.js";
import { verifyGraphPlanApproval } from "../../core/planning/plan-approval.js";
import { canonicalJson } from "../../core/planning/digest.js";
import { publicBindingProof, matchesBindingProof, matchesRuntimeProof, type RuntimeProof } from "../../core/deploy/version-proof.js";
import { exactGraphPhase, isDispatchableGraphAction } from "../../core/planning/graph-operation-support.js";
import { isGraphPhaseReceipt, openGraphExecutionContext, openGraphPhaseReceipt, sealGraphPhaseReceipt, type GraphExecutionContext, type GraphPhaseReceipt } from "../../core/planning/graph-execution-context.js";
import { exactGraphDispatchSpec } from "../../core/deploy/graph-dispatch.js";
import { assessBootstrapPrivacy, BootstrapObjectReadUnverifiedError, checkBootstrapRace, clientBootstrapRunner, decideBootstrapMode, inspectBootstrapTarget, validateBootstrapProfile, type BootstrapDirective } from "../../core/deploy/bootstrap-profile.js";
import { evaluateR2Privacy } from "../../core/deploy/r2-private-guard.js";
import { readR2PrivacyFacts } from "../../cloudflare/resources/r2.js";

const POST_ACTIVATE_WRITES = new Set<DeployStepName>([
  "reconcile-schedules", "reconcile-rate-limits", "register-queue-consumers", "apply-workflows", "reconcile-domains", "publish-workers-dev",
]);
interface ProgressReceipt {
  kind: "tapdeploy-version-progress";
  nonce: string;
  accountId: string;
  planDigest: string;
  versionId: string;
  expiresAt: number;
  baseActiveDeploymentId?: string;
  baseActiveVersionIds?: string[];
  bindingProof?: Array<Record<string, unknown>>;
  runtimeProof?: RuntimeProof;
}
async function verifiedProgress(key: CryptoKey, envelope: unknown, expected: Pick<ProgressReceipt, "nonce" | "accountId" | "planDigest" | "versionId">): Promise<ProgressReceipt | undefined> {
  if (!envelope || typeof envelope !== "object") return undefined;
  const proof = await openSeal<ProgressReceipt>(key, envelope as SealedEnvelope);
  if (!proof || proof.kind !== "tapdeploy-version-progress" || typeof proof.expiresAt !== "number" || !Number.isFinite(proof.expiresAt) || proof.expiresAt <= Date.now()) return undefined;
  return proof.nonce === expected.nonce && proof.accountId === expected.accountId &&
    proof.planDigest === expected.planDigest && proof.versionId === expected.versionId ? proof : undefined;
}
export async function verifyProgressReceipt(key: CryptoKey, envelope: unknown, expected: Pick<ProgressReceipt, "nonce" | "accountId" | "planDigest" | "versionId">): Promise<string | undefined> {
  return (await verifiedProgress(key, envelope, expected))?.versionId;
}

// graph execution authorization is intentionally server-shaped and pure
// enough to be shared by Node/Workers handlers.  The browser may choose which
// *approved* action to request, but it cannot replay another unit's approval,
// substitute a diff, provide a different bundle, or turn a preserve/conflict
// into a mutation. The route re-snapshots before dispatch; this gate is the
// immutable/sealed half of that boundary.
export interface GraphStepAuthorizationInput {
  key: CryptoKey;
  approval: unknown;
  nonce: string;
  configHash?: string;
  accountId: string;
  graphPlan: GraphDeployPlan;
  references: Record<string, ExpectedTarget>;
  unitId: string;
  actionId: string;
  step: DeployStepName;
  /** Exact bundle digest supplied for a bundle-consuming unit. */
  bundleDigest?: string;
}

export type GraphStepAuthorization =
  | { ok: true; unit: GraphPlanUnitPlan; action: { resource: string; action: string; name?: string } }
  | { ok: false; detail: string };

export async function authorizeGraphStep(
  input: GraphStepAuthorizationInput,
): Promise<GraphStepAuthorization> {
  const { graphPlan } = input;
  if (graphPlan.blocked || !graphPlan.ok) {
    return { ok: false, detail: "the graph plan is blocked; no action may be dispatched" };
  }
  if (graphPlan.accountId !== input.accountId) {
    return { ok: false, detail: "the graph plan belongs to a different account" };
  }
  if (!await verifyGraphPlanApproval(input.key, input.approval, {
    nonce: input.nonce,
    configHash: input.configHash,
    accountId: input.accountId,
    digest: graphPlan.digest,
    references: input.references,
  })) {
    return { ok: false, detail: "the sealed graph approval is absent, expired or belongs to another session/account/plan" };
  }
  const unit = graphPlan.units.find((candidate) => candidate.unitId === input.unitId);
  if (!unit) return { ok: false, detail: "the requested unit is not in the approved graph" };
  if (unit.requiresBundle) {
    if (!graphPlan.bundleDigest || input.bundleDigest !== graphPlan.bundleDigest) {
      return { ok: false, detail: "the exact approved bundle proof is required for this unit" };
    }
  } else if (input.bundleDigest !== undefined) {
    return { ok: false, detail: "a resource-only unit must not receive an unrelated bundle proof" };
  }
  const action = unit.diffs.find((diff) =>
    graphActionId({
      unitId: unit.unitId,
      resource: diff.resource,
      action: diff.action,
      ...(diff.name !== undefined ? { name: diff.name } : {}),
    }) === input.actionId,
  );
  if (!action) return { ok: false, detail: "the requested action is not an exact approved unit diff" };
  if (!isDispatchableGraphAction(action.action)) {
    return { ok: false, detail: `approved diff ${action.resource}:${action.action} is not a dispatchable safe mutation` };
  }
  if (!isGraphActionStepAllowed({
    unitKind: unit.kind,
    step: input.step,
    resource: action.resource,
    action: action.action,
  })) {
    return { ok: false, detail: "the requested step is not valid for this approved unit action" };
  }
  return {
    ok: true,
    unit,
    action: {
      resource: action.resource,
      action: action.action,
      ...(action.name !== undefined ? { name: action.name } : {}),
    },
  };
}

interface DeployStepBody {
  accountId?: string;
  manifest?: unknown;
  inputs?: Record<string, unknown>;
  wranglerJsonc?: string;
  // The nonsecret config this session was authorized for.
  config?: { text?: unknown };
  expected?: ExpectedTarget;
  planDigest?: string;
  approval?: unknown;
  step?: string;
  args?: Record<string, unknown>;
  // the operator's per-resource operation intent, re-applied here so the
  // re-planned spec/digest matches the approved plan (select vs create is
  // digest-bound).
  resourceChoices?: unknown;
  // explicit paid-risk confirmation for a potentially billable step.
  paidRiskConfirmed?: unknown;
  executionContext?: unknown;
  unitId?: unknown;
  actionId?: unknown;
  phase?: unknown;
  bundleDigest?: unknown;
}

export function attachDeployStepRoutes(
  app: Hono<AppEnv>,
  env: TapDeployEnv,
): void {
  app.post("/api/deploy/step", async (c) => stepHandler(c, env));
}

async function stepHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const publicOrigin = env.PUBLIC_ORIGIN ?? "";
  const origin = c.req.header("origin");
  const csrf = c.req.header("x-tapdeploy-csrf");

  const cookies = parseCookies(c.req.raw.headers.get("cookie"));
  const raw = cookies[sessionCookieName(publicOrigin)];
  const key = raw ? await loadKey(env).catch(() => null) : null;
  if (!key || !raw) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const payload = await readSession(key, raw);
  if (!payload) {
    return c.json({ error: "unauthenticated" }, 401);
  }

  if (!validateOrigin(publicOrigin, origin) || !validateCsrf(payload, csrf)) {
    return c.json({ error: "csrf/origin check failed" }, 403);
  }

  let body: DeployStepBody;
  try {
    body = (await c.req.json()) as DeployStepBody;
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }

  const accountId = body.accountId ?? payload.accountId;
  if (!accountId) {
    return c.json({ error: "accountId is required" }, 400);
  }
  const step = body.step;
  if (typeof step !== "string" || !DEPLOY_STEP_NAMES.includes(step as DeployStepName)) {
    return c.json({ error: "unknown deploy step" }, 400);
  }
  // A step's only authority is the sealed context created by /plan, never a
  // browser graph, spec, expected target, or bundle digest.
  if (body.executionContext === undefined) {
    return c.json({ error: "executionContext is required", detail: "a deploy step needs the sealed execution context returned by /api/deploy/plan" }, 400);
  }
  return graphV3Step(c, payload, key, body, accountId, step as DeployStepName);
}

async function graphV3Step(
  c: Context<AppEnv>,
  payload: SessionPayload,
  key: CryptoKey,
  body: DeployStepBody,
  accountId: string,
  step: DeployStepName,
): Promise<Response> {
  if (typeof body.unitId !== "string" || typeof body.actionId !== "string" || typeof body.phase !== "string") {
    return c.json({ error: "GRAPH_ACTION_REQUIRED" }, 400);
  }
  if (body.phase !== step) return c.json({ error: "GRAPH_PHASE_MISMATCH" }, 409);
  const sourcePolicyDigest = payload.sourcePolicy
    ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload.sourcePolicy)) as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("")
    : "";
  const context = await openGraphExecutionContext(key, body.executionContext, {
    nonce: payload.nonce, configHash: payload.configHash ?? "", accountId, sourcePolicyDigest,
  }, payload.expiresAt);
  if (!context) return c.json({ error: "GRAPH_CONTEXT_MISMATCH" }, 409);
  const approvalOk = await verifyGraphPlanApproval(key, body.approval, {
    nonce: payload.nonce, configHash: payload.configHash, accountId,
    digest: context.graphPlanDigest,
    references: context.expectedPerUnitReferences as Record<string, ExpectedTarget>,
    executionContextDigest: context.executionContextDigest,
  });
  if (!approvalOk) return c.json({ error: "GRAPH_APPROVAL_MISMATCH" }, 409);
  const approved = context.approvedDiffsWithActionIds.find((entry) => entry.unitId === body.unitId && entry.actionId === body.actionId);
  if (!approved || typeof approved.resource !== "string" || typeof approved.action !== "string" || (approved.name !== undefined && typeof approved.name !== "string")) return c.json({ error: "GRAPH_ACTION_MISMATCH" }, 409);
  if (!isDispatchableGraphAction(approved.action)) return c.json({ error: "GRAPH_ACTION_UNSAFE" }, 409);
  const graphPlan = context.canonicalNonsecretGraphPlan as unknown as GraphDeployPlan;
  const unit = graphPlan.units?.find((candidate) => candidate.unitId === body.unitId);
  const pagesUnit = unit?.kind === "pages-static" || unit?.kind === "pages-functions";
  const resourceStep = graphStepForResourceAction(approved.resource, approved.action);
  // The one exact phase of the approved action comes from the same pure catalog
  // the plan preflight used (workers-dev, queue consumers, workflows, routes,
  // schedules, Pages and the worker asset pair all resolve there). It is derived
  // from the sealed context only, never from browser input.
  const exactPhase = unit ? exactGraphPhase({ unitId: body.unitId, unitKind: unit.kind, resource: approved.resource, action: approved.action }) : undefined;
  const pagesPostcheck = pagesUnit && approved.resource === "deployment" && step === "pages-postcheck";
  // complete-assets is the second phase of the sealed worker-asset pair.
  // It is addressable only for the approved static-assets action and only
  // after the register-assets receipt for the same actionId is verified below.
  const workerAssetsComplete = !pagesUnit && approved.resource === "static-assets" && (approved.action === "create" || approved.action === "update") && step === "complete-assets";
  if (exactPhase !== step && !(approved.resource === "worker" && step === "postcheck") && !pagesPostcheck && !workerAssetsComplete) return c.json({ error: "GRAPH_PHASE_MISMATCH" }, 409);
  if (!unit || !isGraphActionStepAllowed({ unitKind: unit.kind, step, resource: approved.resource, action: approved.action })) return c.json({ error: "GRAPH_PHASE_MISMATCH" }, 409);
  const sourceSpec = (context.perUnitCanonicalSpecs as Record<string, unknown>)[body.unitId] as DeploySpec | undefined;
  if (!sourceSpec) return c.json({ error: "GRAPH_SPEC_MISMATCH" }, 409);
  const exact = exactGraphDispatchSpec(sourceSpec, approved as { resource: string; action: string; name?: string });
  if (!exact) return c.json({ error: "GRAPH_ACTION_UNSUPPORTED" }, 409);
  const proof = (context.perUnitWranglerAndBundleProofs as Record<string, unknown>)[body.unitId];
  const bundle = graphBundleFromProof(proof, exact, context.archiveSha256, context.manifestDigest);
  if (unit.requiresBundle && (!bundle || body.bundleDigest !== bundle.bundleDigest)) return c.json({ error: "GRAPH_BUNDLE_MISMATCH" }, 409);
  const client = createCloudflareClient({ accessToken: payload.accessToken });
  const suppliedReceipts = body.args?.receipts ?? [];
  if (!Array.isArray(suppliedReceipts) || suppliedReceipts.length > 2048) return c.json({ error: "GRAPH_RECEIPTS_INVALID" }, 400);
  const dependencies = context.dependencies.filter(edge => edge.dependent === body.unitId).map(edge => edge.dependency);
  // Only receipts of this unit and of the units it depends on can satisfy this
  // step; others are not verified (each verification re-reads live state, and
  // a Worker request has a subrequest budget). One snapshot per unit serves all
  // of that unit's receipts in this request.
  const relevantUnits = new Set([body.unitId, ...dependencies]);
  const snapshots = new Map<string, Promise<TargetSnapshot>>();
  const verifiedReceipts: GraphPhaseReceipt[] = [];
  for (const envelope of suppliedReceipts) {
    const sealed = envelope && typeof envelope === "object" ? await openSeal<unknown>(key, envelope as SealedEnvelope) : null;
    if (!isGraphPhaseReceipt(sealed)) return c.json({ error: "GRAPH_RECEIPT_STATE_CHANGED" }, 409);
    if (!relevantUnits.has(sealed.unitId)) continue;
    const receipt = await verifyCurrentGraphReceipt(key, envelope, client, context, snapshots);
    if (!receipt) return c.json({ error: "GRAPH_RECEIPT_STATE_CHANGED" }, 409);
    verifiedReceipts.push(receipt);
  }
  const prerequisiteActions = context.approvedDiffsWithActionIds.filter(action =>
    isDispatchableGraphAction(String(action.action)) && (
      dependencies.includes(String(action.unitId)) ||
      (action.unitId === body.unitId && ((["create-worker", "create-version"].includes(step) && (graphStepForResourceAction(String(action.resource), String(action.action)) || action.resource === "static-assets")) || (step === "activate" && action.resource === "worker") || (["reconcile-schedules", "postcheck", "publish-workers-dev"].includes(step) && action.resource === "deployment") || (step === "register-queue-consumers" && (action.resource === "worker" || action.resource === "deployment" || (action.resource === "queue" && action.action === "create"))) || (step === "apply-workflows" && (action.resource === "worker" || action.resource === "deployment")) || (step === "reconcile-domains" && (action.resource === "worker" || action.resource === "deployment"))))
    ));
  if (prerequisiteActions.some(action => !verifiedReceipts.some(receipt => receipt.unitId === action.unitId && receipt.actionId === action.actionId))) return c.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
  // complete-assets is only valid after the register-assets phase for the
  // same approved action proved the provider session for the exact manifest.
  // The browser must upload the approved buckets between the two calls; a
  // forged or missing register receipt refuses before any provider write.
  if (workerAssetsComplete && !verifiedReceipts.some(receipt => receipt.unitId === body.unitId && receipt.actionId === body.actionId && receipt.phase === "register-assets")) {
    return c.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
  }
  // a version upload for an assets unit additionally requires the
  // complete-assets receipt for the same unit: only a provider-attested
  // completion (not a bare register) may precede the assetJwt-bound upload.
  // The provider itself rejects a forged assetJwt at upload time.
  if ((step === "create-worker" || step === "create-version") && !pagesUnit) {
    const assetAction = context.approvedDiffsWithActionIds.find((entry) => entry.unitId === body.unitId && entry.resource === "static-assets");
    if (assetAction && !verifiedReceipts.some((receipt) => receipt.unitId === assetAction.unitId && receipt.actionId === assetAction.actionId && receipt.phase === "complete-assets")) {
      return c.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
    }
  }
  const preparedVersion = verifiedReceipts.find(receipt => receipt.unitId === body.unitId && prerequisiteActions.some(action => action.resource === "worker" && action.actionId === receipt.actionId))?.versionId;
  if (step === "activate" && (!preparedVersion || body.args?.versionId !== preparedVersion)) return c.json({ error: "GRAPH_VERSION_RECEIPT_REQUIRED" }, 409);
  // Pages asset handoff order: the project must be proven before the browser
  // JWT is minted or a deployment is created; the deployment must be proven
  // before its postcheck. Receipts are re-verified against live state below,
  // so a deleted/replaced project or a foreign redeploy blocks here.
  // A sealed preserve of an existing project has no mutation and therefore no
  // receipt: the live identity/owner/baseline-deployment predicate below
  // replaces it on every dependent step.
  const pagesAssetHandoffStep = pagesUnit && (step === "pages-register-assets" || step === "pages-deploy");
  let pagesProjectPreserved = false;
  if (pagesAssetHandoffStep) {
    const projectAction = context.approvedDiffsWithActionIds.find(action => action.unitId === body.unitId && action.resource === "pages-project");
    pagesProjectPreserved = projectAction?.action === "preserve";
    if (!projectAction || (!pagesProjectPreserved && !verifiedReceipts.some(receipt => receipt.unitId === body.unitId && receipt.actionId === projectAction.actionId))) return c.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
  }
  // The browser asset upload happens between the JWT handoff and the
  // deployment create. The server cannot observe the JWT-scoped upload, but it
  // can enforce the handshake order: a deployment without a prior handoff
  // receipt for the approved asset set is refused before any provider write.
  // Successful postcheck remains the proof the assets actually landed.
  if (step === "pages-deploy") {
    const assetsAction = context.approvedDiffsWithActionIds.find(action => action.unitId === body.unitId && action.resource === "static-assets");
    if (assetsAction && !verifiedReceipts.some(receipt => receipt.unitId === body.unitId && receipt.actionId === assetsAction.actionId)) return c.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
  }
  if (pagesPostcheck) {
    const deployAction = context.approvedDiffsWithActionIds.find(action => action.unitId === body.unitId && action.resource === "deployment");
    if (!deployAction || !verifiedReceipts.some(receipt => receipt.unitId === body.unitId && receipt.actionId === deployAction.actionId)) return c.json({ error: "GRAPH_DEPENDENCY_REQUIRED" }, 409);
  }
  // guarded R2 owner bootstrap. The gate runs only for Worker version
  // uploads (create-worker/create-version) — the only steps that can arm —
  // and never for other steps. A version upload without a bootstrap profile
  // proceeds untouched; with one, the flow is: validate profile, resolve the
  // unit's R2 bucket from the sealed spec, inspect live state with verified
  // object existence (never contents), decide Fresh/Resume/Upgrade, and for
  // fresh/resume prove bucket privacy immediately before the write and hand
  // the server-built directive to the version upload. Upgrade never arms.
  // Every ambiguous/denied/error state blocks here before any provider write.
  let bootstrapDirective: BootstrapDirective | undefined;
  const bootstrapPolicies = (context.optionalBootstrapPolicyIdentity as Record<string, unknown> | undefined)?.policies;
  const rawPolicy = Array.isArray(bootstrapPolicies)
    ? bootstrapPolicies.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).unitId === body.unitId)
    : undefined;
  if (rawPolicy && (step === "create-worker" || step === "create-version")) {
    const profile = validateBootstrapProfile(rawPolicy);
    if (!profile.ok) return c.json({ error: "BOOTSTRAP_PROFILE_INVALID" }, 409);
    if (exact.targetKind !== "workers") return c.json({ error: "BOOTSTRAP_BINDING_MISMATCH", detail: "guarded owner bootstrap requires a Worker unit" }, 409);
    const binding = exact.cloudflare.r2.find((item) => item.binding === profile.value.r2Binding);
    if (!binding) return c.json({ error: "BOOTSTRAP_BINDING_MISMATCH" }, 409);
    const runner = clientBootstrapRunner(client.withAccount(accountId), {
      objectExists: async (bucketName, objectKey) => {
        try {
          return await client.withAccount(accountId).headR2Object(bucketName, objectKey);
        } catch (error) {
          const kind = (error as { kind?: unknown }).kind;
          if (kind === "not-found") return false;
          if (kind === "forbidden" || kind === "unauthorized") {
            throw new BootstrapObjectReadUnverifiedError(`R2 object existence read for "${objectKey}" was denied; nothing is treated as absent`);
          }
          throw error;
        }
      },
    });
    const inspected = await inspectBootstrapTarget(runner, { workerName: exact.cloudflare.workerName, bucketName: binding.bucketName, profile: profile.value });
    if (!inspected.ok) return c.json({ error: inspected.refusal.code, detail: inspected.refusal.detail }, 409);
    const mode = decideBootstrapMode(inspected.value);
    if (!mode.ok) return c.json({ error: mode.refusal.code, detail: mode.refusal.detail }, 409);
    if (mode.value.mode === "fresh" || mode.value.mode === "resume") {
      const facts = await readR2PrivacyFacts(client.withAccount(accountId), { accountId, bucketName: binding.bucketName, readAtMs: Date.now() });
      const assessed = assessBootstrapPrivacy(evaluateR2Privacy(facts), Date.now());
      if (!assessed.ok) return c.json({ error: assessed.refusal.code, detail: assessed.refusal.detail }, 409);
      // The identity/state is re-read immediately before the mutation so two
      // installs started together cannot both plan a root; any change is
      // RACE_DETECTED with a safe re-run (the guard claims no atomicity).
      const recheck = await inspectBootstrapTarget(runner, { workerName: exact.cloudflare.workerName, bucketName: binding.bucketName, profile: profile.value });
      if (!recheck.ok) return c.json({ error: "RACE_DETECTED", detail: recheck.refusal.detail }, 409);
      const race = checkBootstrapRace(inspected.value, recheck.value, mode.value.mode);
      if (!race.ok) return c.json({ error: race.refusal.code, detail: race.refusal.detail }, 409);
      bootstrapDirective = { profile: profile.value, mode: mode.value.mode, bucketName: binding.bucketName, privacyProof: assessed.value };
    }
  }
  let snapshot;
  try {
    snapshot = await readGraphTarget(client, accountId, exact, unit.kind === "resource-only");
  } catch (error) { return isUpstreamError(error) ? upstreamResponse(c, error) : c.json({ error: "GRAPH_SNAPSHOT_FAILED" }, 502); }
  if (step === "activate") {
    const reference = context.expectedPerUnitReferences[body.unitId] as ExpectedTarget | undefined;
    const alreadyActive = snapshot.activeDeploymentVersionIds.length === 1 && snapshot.activeDeploymentVersionIds[0] === preparedVersion;
    if (!alreadyActive && (!reference || snapshot.activeDeploymentId !== reference.activeDeploymentId)) return c.json({ error: "GRAPH_TARGET_STALE" }, 409);
  }
  if (body.args?.phaseReceipt !== undefined) {
    const prior = await verifyCurrentGraphReceipt(key, body.args.phaseReceipt, client, context);
    if (!prior || prior.unitId !== body.unitId || prior.actionId !== body.actionId || prior.phase !== step) return c.json({ error: "GRAPH_RECEIPT_STATE_CHANGED" }, 409);
  }
  if (pagesProjectPreserved) {
    const reference = context.expectedPerUnitReferences[body.unitId] as ExpectedTarget | undefined;
    if (!reference?.pagesProjectId || !snapshot.pagesProjectExists || snapshot.pagesProjectId !== reference.pagesProjectId || snapshot.pagesOwnerProjectId !== exact.project.id) return c.json({ error: "GRAPH_PROJECT_CONFLICT" }, 409);
    if (snapshot.pagesActiveDeploymentId !== reference.activeDeploymentId) return c.json({ error: "GRAPH_TARGET_STALE" }, 409);
  }
  if (pagesPostcheck && body.args?.deploymentId !== snapshot.pagesActiveDeploymentId) return c.json({ error: "GRAPH_TARGET_STALE" }, 409);
  if (step === "pages-create-project" && snapshot.pagesProjectExists) {
    const receipt = await verifyCurrentGraphReceipt(key, body.args?.phaseReceipt, client, context);
    const matches = receipt?.unitId === body.unitId && receipt.actionId === body.actionId && receipt.phase === step;
    if (!matches) return c.json({ error: "GRAPH_PROJECT_CONFLICT" }, 409);
    return c.json({ ok: true, status: "IDEMPOTENT_VERIFIED", unitId: body.unitId, actionId: body.actionId, phaseReceipt: body.args?.phaseReceipt });
  }
  if (step === "create-worker" && snapshot.workerExists) {
    const receipt = await verifyCurrentGraphReceipt(key, body.args?.phaseReceipt, client, context);
    const matches = receipt?.unitId === body.unitId && receipt.actionId === body.actionId && receipt.phase === step;
    if (!matches) return c.json({ error: "GRAPH_WORKER_CONFLICT" }, 409);
    return c.json({ ok: true, status: "IDEMPOTENT_VERIFIED", unitId: body.unitId, actionId: body.actionId, phaseReceipt: body.args?.phaseReceipt });
  }
  // idempotent re-register on a lost register-assets response. The
  // provider session is derived from the exact approved manifest, so
  // re-registering never resends bytes; the verified register receipt proves
  // the session without a new provider write.
  if (exactPhase === "register-assets" && step === "register-assets" && body.args?.phaseReceipt !== undefined) {
    const receipt = await verifyCurrentGraphReceipt(key, body.args.phaseReceipt, client, context);
    const matches = receipt?.unitId === body.unitId && receipt.actionId === body.actionId && receipt.phase === step;
    if (!matches) return c.json({ error: "GRAPH_RECEIPT_STATE_CHANGED" }, 409);
    return c.json({ ok: true, status: "IDEMPOTENT_VERIFIED", unitId: body.unitId, actionId: body.actionId, phaseReceipt: body.args?.phaseReceipt });
  }
  if (resourceStep) {
    const inventories = { r2: snapshot.r2Buckets, d1: snapshot.d1Databases, kv: snapshot.kvNamespaces, queue: snapshot.queues, vectorize: snapshot.vectorizeIndexes };
    const existing = inventories[approved.resource as keyof typeof inventories]?.filter((entry) => entry.name === approved.name) ?? [];
    if (existing.length > 0) {
      const stateHash = await graphPhaseStateHash(accountId, context.graphPlanDigest, body.unitId, body.actionId, step, existing);
      const receipt = existing.length === 1 && await openGraphPhaseReceipt(key, body.args?.phaseReceipt, {
        nonce: payload.nonce, configHash: payload.configHash ?? "", accountId, sourcePolicyDigest,
        graphPlanDigest: context.graphPlanDigest, executionContextDigest: context.executionContextDigest,
        unitId: body.unitId, actionId: body.actionId, phase: step, stateHash,
      }, context.expiresAt);
      if (!receipt) return c.json({ error: "GRAPH_RESOURCE_CONFLICT" }, 409);
      return c.json({ ok: true, status: "IDEMPOTENT_VERIFIED", unitId: body.unitId, actionId: body.actionId, phaseReceipt: body.args?.phaseReceipt });
    }
    if (body.args?.phaseReceipt !== undefined) return c.json({ error: "GRAPH_RECEIPT_STATE_CHANGED" }, 409);
  }
  if (step === "create-version") {
    const reference = context.expectedPerUnitReferences[body.unitId] as ExpectedTarget | undefined;
    // Resources this run created under a verified receipt are progress, not drift.
    const created = context.approvedDiffsWithActionIds
      .filter((action) => action.unitId === body.unitId && action.action === "create" && typeof action.name === "string" && verifiedReceipts.some((receipt) => receipt.unitId === action.unitId && receipt.actionId === action.actionId))
      .map((action) => ({ resource: String(action.resource), name: String(action.name) }));
    if (!reference || detectDrift(withAuthenticatedCreates(reference, created), snapshot).drifted || !snapshot.workerExists) return c.json({ error: "GRAPH_TARGET_STALE" }, 409);
  }
  let preparedBindings: Record<string, unknown>[] | undefined;
  let preparedRuntime: RuntimeProof | undefined;
  const outcome = await executeDeployStep(step, {
    client: client.withAccount(accountId), accountId, workerName: exact.cloudflare.workerName,
    spec: exact, snapshot, accessToken: payload.accessToken, ...(bundle ? { bundle } : {}),
    onPreparedBindings: (bindings, runtime) => { preparedBindings = publicBindingProof(bindings, snapshot.activeBindings); preparedRuntime = { compatibility_date: runtime.compatibility_date, compatibility_flags: runtime.compatibility_flags ?? [] }; },
  }, { ...body.args, ...(bootstrapDirective ? { bootstrap: bootstrapDirective } : {}) });
  if (!outcome.ok) return stepFailureResponse(c, outcome.error);
  // A provider 2xx alone is not a graph transition. Re-read the exact target
  // and seal the observed identity into a phase-specific receipt.
  let readback;
  try {
    readback = await readGraphTarget(client, accountId, exact, unit.kind === "resource-only");
  } catch (error) { return isUpstreamError(error) ? upstreamResponse(c, error) : c.json({ error: "GRAPH_READBACK_REQUIRED" }, 502); }
  const inventories = { r2: readback.r2Buckets, d1: readback.d1Databases, kv: readback.kvNamespaces, queue: readback.queues, vectorize: readback.vectorizeIndexes };
  const resourceState = inventories[approved.resource as keyof typeof inventories]?.filter((entry) => entry.name === approved.name);
  if (resourceState && (resourceState.length !== 1 || !resourceState[0]?.id)) return c.json({ error: "GRAPH_READBACK_MISMATCH" }, 409);
  // the step claims the set it reconciled; the sealed receipt requires
  // the provider to report back that exact sorted set immediately. An empty
  // approved set preserves (reconcile never clears), so the claim then equals
  // the untouched live set rather than an empty one.
  if (approved.resource === "schedule") {
    const claimed = (outcome.result as { crons?: unknown } | undefined)?.crons;
    const liveCrons = [...(readback.scheduleCrons ?? [])].sort();
    if (!Array.isArray(claimed) || JSON.stringify([...claimed].sort()) !== JSON.stringify(liveCrons)) {
      return c.json({ error: "GRAPH_READBACK_MISMATCH" }, 409);
    }
  }
  // the step claims the exact workflow definition it applied; the sealed
  // receipt requires the provider to report back that exact identity
  // (name/class/script) plus the exact sorted direct schedule set. A definition
  // the readback cannot find, or a schedule set that differs, is a mismatch —
  // never a silent success.
  if (approved.resource === "workflow") {
    const claimed = (outcome.result as { workflows?: Array<Record<string, unknown>> } | undefined)?.workflows;
    const workflowName = typeof approved.name === "string" ? approved.name : undefined;
    const live = workflowName ? (readback.workflows ?? []).filter((item) => item.name === workflowName) : [];
    const claim = Array.isArray(claimed) && claimed.length === 1 ? claimed[0] : undefined;
    const observed = live.length === 1 ? live[0] : undefined;
    if (!claim || !observed) return c.json({ error: "GRAPH_READBACK_MISMATCH" }, 409);
    const claimSchedules = Array.isArray(claim["schedules"]) ? [...(claim["schedules"] as string[])].sort() : undefined;
    if (
      claim["name"] !== observed.name ||
      claim["className"] !== observed.className ||
      claim["scriptName"] !== observed.scriptName ||
      claimSchedules === undefined ||
      JSON.stringify(claimSchedules) !== JSON.stringify([...observed.schedules].sort())
    ) {
      return c.json({ error: "GRAPH_READBACK_MISMATCH" }, 409);
    }
  }
  // the step claims the exact applied route; the sealed receipt requires
  // the provider to report that pattern bound to this Worker in its zone. A
  // missing pattern or a foreign delivering script is a mismatch.
  if (approved.resource === "worker-route") {
    const claimed = (outcome.result as { applied?: Array<Record<string, unknown>> } | undefined)?.applied;
    const pattern = typeof approved.name === "string" ? approved.name : undefined;
    const claim = Array.isArray(claimed) ? claimed.find((item) => item["hostname"] === pattern) : undefined;
    const entry = pattern ? exact.cloudflare.domains?.find((domain) => domain.kind === "workers-route" && domain.hostname === pattern) : undefined;
    const zoneId = entry?.zoneId ?? (entry?.zoneName ? (readback.zones ?? []).find((zone) => zone.name.toLowerCase() === entry.zoneName!.toLowerCase())?.id : undefined);
    const live = pattern && zoneId ? (readback.workerRoutes ?? []).filter((route) => route.pattern === pattern && route.zoneId === zoneId) : [];
    if (!claim || live.length !== 1 || live[0]?.script !== exact.cloudflare.workerName) {
      return c.json({ error: "GRAPH_READBACK_MISMATCH" }, 409);
    }
  }
  // Worker postcheck must seal the exact version the verified receipts produced.
  // preparedVersion only covers worker-resource prerequisites (activate), while
  // postcheck's prerequisites are deployment-resource actions — so the sealed
  // worker version is resolved separately above (sealedWorkerVersion). The
  // browser's expectedVersionId is accepted only when it equals that sealed
  // version; anything else leaves versionId undefined so the readback seal
  // fails closed with GRAPH_READBACK_MISMATCH, never a false success. The
  // active-deployment check inside graphActionState then proves the sealed
  // version is actually live.
  const sealedWorkerVersion = step === "postcheck"
    ? verifiedReceipts.find(receipt => receipt.unitId === body.unitId && context.approvedDiffsWithActionIds.some(action => (action as { unitId?: unknown; actionId?: unknown; resource?: unknown }).unitId === receipt.unitId && (action as { actionId?: unknown }).actionId === receipt.actionId && (action as { resource?: unknown }).resource === "worker"))?.versionId
    : undefined;
  const postcheckVersion = typeof sealedWorkerVersion === "string" && body.args?.expectedVersionId === sealedWorkerVersion ? sealedWorkerVersion : undefined;
  const versionId = ["create-worker", "create-version"].includes(step) ? (outcome.result as { versionId?: string })?.versionId : step === "activate" ? preparedVersion : postcheckVersion;
  if (["create-worker", "create-version"].includes(step)) {
    if (!versionId || !preparedBindings || !preparedRuntime) return c.json({ error: "GRAPH_VERSION_READBACK_REQUIRED" }, 409);
    let version;
    try {
      version = await client.withAccount(accountId).getVersion(exact.cloudflare.workerName, versionId);
    } catch (error) {
      if ((error as { kind?: string }).kind === "not-found") return c.json({ error: "GRAPH_VERSION_READBACK_PENDING", detail: "Cloudflare has not made the uploaded version readable yet; retry this step" }, 409);
      throw error;
    }
    if (!Array.isArray(version.resources?.bindings) || !matchesBindingProof(preparedBindings, version.resources.bindings) || !matchesRuntimeProof(preparedRuntime, version.resources?.script_runtime)) return c.json({ error: "GRAPH_VERSION_READBACK_MISMATCH" }, 409);
  }
  let verifiedState;
  try { verifiedState = await graphActionState(client, accountId, exact, approved, step, readback, versionId); }
  catch { return c.json({ error: "GRAPH_READBACK_MISMATCH" }, 409); }
  const stateHash = await graphPhaseStateHash(accountId, context.graphPlanDigest, body.unitId, body.actionId, step, verifiedState);
  const receipt = await sealGraphPhaseReceipt(key, { kind: "tapdeploy-graph-phase-receipt/v1", nonce: payload.nonce, configHash: payload.configHash ?? "", accountId, sourcePolicyDigest, graphPlanDigest: context.graphPlanDigest, executionContextDigest: context.executionContextDigest, unitId: body.unitId, actionId: body.actionId, phase: step, stateHash, expiresAt: context.expiresAt, ...(versionId ? { versionId } : {}) });
  return c.json({ ok: true, result: outcome.result, unitId: body.unitId, actionId: body.actionId, phaseReceipt: receipt });
}

async function graphActionState(client: CloudflareApiClient, accountId: string, spec: DeploySpec, action: Record<string, unknown>, phase: string, snapshot: TargetSnapshot, versionId?: string): Promise<unknown> {
  const inventories = { r2: snapshot.r2Buckets, d1: snapshot.d1Databases, kv: snapshot.kvNamespaces, queue: snapshot.queues, vectorize: snapshot.vectorizeIndexes };
  const inventory = inventories[action.resource as keyof typeof inventories];
  if (inventory) {
    const state = inventory.filter(item => item.name === action.name);
    if (state.length !== 1 || !state[0]?.id) throw new Error("resource identity unavailable");
    return state;
  }
  // Custom-domain receipts bind the live binding: the hostname bound to this
  // Worker (or registered on this Pages project with its CNAME), or confirmed
  // absent after an approved removal. Re-read fresh on every verification so
  // a later re-point or removal invalidates outstanding receipts.
  if (action.resource === "worker-custom-domain" || action.resource === "pages-custom-domain") {
    const hostname = typeof action.name === "string" ? action.name : undefined;
    const entry = hostname ? spec.cloudflare.domains?.find((domain) => domain.hostname === hostname) : undefined;
    if (!hostname || !entry) throw new Error("custom domain identity unavailable");
    const removal = entry.updateAction === "detach";
    if (action.resource === "worker-custom-domain") {
      const bound = snapshot.workerDomains?.find((domain) => domain.hostname === hostname);
      if (removal) {
        if (bound?.service === spec.cloudflare.workerName) throw new Error("custom domain still bound");
        return { hostname, bound: false };
      }
      if (!bound?.id || bound.service !== spec.cloudflare.workerName) throw new Error("custom domain not bound to this Worker");
      return { hostname, id: bound.id, service: bound.service };
    }
    const project = spec.cloudflare.pages?.projectName ?? spec.cloudflare.workerName;
    const target = pagesCnameTarget(project, { ...(snapshot.pagesSubdomain ? { pagesSubdomain: snapshot.pagesSubdomain } : {}) });
    const registered = (snapshot.pagesDomains ?? []).some((domain) => domain.name === hostname);
    const cname = (snapshot.dnsRecords ?? []).find((record) => record.type === "CNAME" && record.name.toLowerCase() === hostname && record.content?.toLowerCase() === target);
    if (removal) {
      if (registered || cname) throw new Error("Pages domain still bound");
      return { hostname, bound: false };
    }
    if (!registered || !cname) throw new Error("Pages domain not bound to this project");
    return { hostname, project, cnameId: cname.id };
  }
  // Pages readback is project/deployment identity from the Pages snapshot, not
  // the Workers versions API. The sealed state binds the provider-generated
  // project id and the canonical deployment id (never its moving stage
  // status), so a replaced project or a foreign redeploy invalidates
  // outstanding receipts.
  if (spec.targetKind === "pages") {
    const projectName = spec.cloudflare.pages?.projectName;
    if (!projectName || snapshot.workerName !== projectName || !snapshot.pagesProjectId) throw new Error("pages project identity unavailable");
    const project = { projectName, projectId: snapshot.pagesProjectId };
    if (action.resource === "pages-project" || action.resource === "static-assets") return project;
    if (action.resource === "deployment") {
      if (!snapshot.pagesActiveDeploymentId) throw new Error("pages deployment identity unavailable");
      // Identity only: the stage status keeps moving (active -> success) after
      // the receipt is minted; terminal success is the postcheck's own verdict.
      return { ...project, deploymentId: snapshot.pagesActiveDeploymentId };
    }
    throw new Error("unsupported pages action state");
  }
  // worker static-asset receipts bind the exact approved asset manifest
  // (rooted path → upload hash/size) derived from the sealed spec. Presence
  // and completion are proven by the provider: register-assets mints the
  // session, complete-assets re-registers and fails when hashes are still
  // missing, and the completion JWT is consumed by create-version (which the
  // provider accepts only for a completed session).
  if (action.resource === "static-assets" && (phase === "register-assets" || phase === "complete-assets")) {
    return { manifest: await assetUploadManifest(spec) };
  }
  // schedule receipts bind the exact live sorted cron set. No version
  // identity is required: the set itself is the state, re-read fresh on every
  // verification so drift invalidates outstanding receipts.
  if (action.resource === "schedule") {
    if (!Array.isArray(snapshot.scheduleCrons)) throw new Error("schedule identity unavailable");
    return { crons: [...snapshot.scheduleCrons].sort() };
  }
  // queue-consumer receipts bind the exact live queue identity plus its
  // consumer set (consumer ids and delivering scripts). Re-read fresh on every
  // verification so a replaced queue, an added/removed consumer or a foreign
  // trigger invalidates outstanding receipts.
  if (action.resource === "queue-consumer") {
    const queueName = typeof action.name === "string" ? action.name : undefined;
    const queue = queueName ? snapshot.queues.find((item) => item.name === queueName) : undefined;
    if (!queue?.id) throw new Error("queue identity unavailable");
    const consumers = (snapshot.queueConsumers?.[queue.name] ?? [])
      .map((consumer) => ({ consumerId: consumer.consumerId, scriptName: consumer.scriptName ?? null }))
      .sort((a, b) => (a.consumerId < b.consumerId ? -1 : a.consumerId > b.consumerId ? 1 : 0));
    return { queueId: queue.id, consumers };
  }
  // workflow receipts bind the exact provider definition identity (id,
  // name, class, script) plus the exact sorted direct schedule set. Re-read
  // fresh on every verification so a replaced or foreign definition and any
  // out-of-band schedule drift invalidate outstanding receipts.
  if (action.resource === "workflow") {
    const workflowName = typeof action.name === "string" ? action.name : undefined;
    const workflow = workflowName ? snapshot.workflows?.find((item) => item.name === workflowName) : undefined;
    if (!workflow) throw new Error("workflow identity unavailable");
    return {
      id: workflow.id,
      name: workflow.name,
      className: workflow.className,
      scriptName: workflow.scriptName,
      schedules: [...workflow.schedules].sort(),
    };
  }
  // route receipts bind the exact live route identity (zone, pattern,
  // provider id, delivering script). Re-read fresh on every verification so
  // a deleted route, a foreign re-point or a zone change invalidates
  // outstanding receipts.
  if (action.resource === "worker-route") {
    const pattern = typeof action.name === "string" ? action.name : undefined;
    const entry = pattern ? spec.cloudflare.domains?.find((domain) => domain.kind === "workers-route" && domain.hostname === pattern) : undefined;
    const zoneId = entry?.zoneId ?? (entry?.zoneName ? snapshot.zones?.find((zone) => zone.name.toLowerCase() === entry.zoneName!.toLowerCase())?.id : undefined);
    const route = pattern && zoneId ? snapshot.workerRoutes?.find((candidate) => candidate.pattern === pattern && candidate.zoneId === zoneId) : undefined;
    if (!route?.id) throw new Error("route identity unavailable");
    return { pattern, zoneId, id: route.id, script: route.script ?? null };
  }
  // workers-dev receipts bind the live provider truth: enabled flag
  // plus account subdomain (verified URL), or the explicit not-published
  // outcome when the account has no subdomain. Re-read fresh on every
  // verification so drift invalidates outstanding receipts; a subdomain that
  // exists while the flag reads back disabled fails closed as a mismatch.
  if (action.resource === "workers-dev") {
    let subdomain: string | undefined;
    try {
      subdomain = await client.withAccount(accountId).getAccountSubdomain();
    } catch (error) {
      if ((error as { kind?: string }).kind !== "not-found") throw error;
    }
    if (!subdomain) return { published: false, reason: "no-account-subdomain" };
    const script = await client.withAccount(accountId).getScriptSubdomain(spec.cloudflare.workerName);
    if (!script.enabled) throw new Error("workers.dev is not enabled for the Worker");
    const label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(spec.cloudflare.workerName) ? spec.cloudflare.workerName : undefined;
    return { published: true, ...(label ? { url: `https://${label}.${subdomain}.workers.dev` } : {}) };
  }
  if (!versionId) throw new Error("version identity unavailable");
  const version = await client.withAccount(accountId).getVersion(spec.cloudflare.workerName, versionId);
  if (version.message !== versionMessage(spec)) throw new Error("version ownership mismatch");
  if (phase === "create-worker" && (snapshot.activeDeploymentVersionIds.length !== 1 || snapshot.activeDeploymentVersionIds[0] !== versionId)) throw new Error("first upload active version changed");
  if (action.resource === "worker") return { workerName: spec.cloudflare.workerName, version };
  if (snapshot.activeDeploymentVersionIds.length !== 1 || snapshot.activeDeploymentVersionIds[0] !== versionId) throw new Error("active version mismatch");
  return { workerName: spec.cloudflare.workerName, version, activeDeploymentId: snapshot.activeDeploymentId };
}

async function verifyCurrentGraphReceipt(key: CryptoKey, envelope: unknown, client: CloudflareApiClient, context: GraphExecutionContext, snapshots: Map<string, Promise<TargetSnapshot>> = new Map()): Promise<GraphPhaseReceipt | null> {
  if (!envelope || typeof envelope !== "object") return null;
  const receipt = await openSeal<unknown>(key, envelope as SealedEnvelope);
  if (!isGraphPhaseReceipt(receipt)) return null;
  const action = context.approvedDiffsWithActionIds.find(item => item.unitId === receipt.unitId && item.actionId === receipt.actionId);
  const spec = context.perUnitCanonicalSpecs[receipt.unitId] as DeploySpec | undefined;
  const plan = context.canonicalNonsecretGraphPlan as unknown as GraphDeployPlan;
  const unit = plan.units.find(item => item.unitId === receipt.unitId);
  if (!action || !spec || !unit) return null;
  try {
    let pending = snapshots.get(receipt.unitId);
    if (!pending) {
      pending = readGraphTarget(client, context.accountId, spec, unit.kind === "resource-only");
      snapshots.set(receipt.unitId, pending);
    }
    const snapshot = await pending;
    const state = await graphActionState(client, context.accountId, spec, action, receipt.phase, snapshot, receipt.versionId);
    const stateHash = await graphPhaseStateHash(context.accountId, context.graphPlanDigest, receipt.unitId, receipt.actionId, receipt.phase, state);
    return openGraphPhaseReceipt(key, envelope, { nonce: context.nonce, configHash: context.configHash, accountId: context.accountId, sourcePolicyDigest: context.sourcePolicyDigest, graphPlanDigest: context.graphPlanDigest, executionContextDigest: context.executionContextDigest, unitId: receipt.unitId, actionId: receipt.actionId, phase: receipt.phase, stateHash }, context.expiresAt);
  } catch { return null; }
}

async function readGraphTarget(client: CloudflareApiClient, accountId: string, spec: DeploySpec, resourceOnly: boolean) {
  const cf = spec.cloudflare;
  const domains = cf.domains ?? [];
  const hasDomains = domains.length > 0;
  // Domain facts are scoped to the kinds and zones the (sliced) spec carries:
  // a route reads zones + route tables only; a custom domain also reads the
  // DNS records of its zone and the Worker custom-domain list.
  const domainKinds = [...new Set(domains.map((entry) => entry.kind))];
  const zoneNames = [...new Set(domains.flatMap((entry) => entry.zoneName ? [entry.zoneName.toLowerCase()] : []))];
  const needs = { r2: cf.r2.length > 0, d1: cf.d1.length > 0, kv: cf.kv.length > 0, queues: cf.queues.length > 0, queueConsumers: cf.queues.some((queue) => queue.role === "consumer" || queue.role === "both"), workflows: (cf.workflows?.length ?? 0) > 0, hyperdrive: cf.hyperdrive.length > 0, vectorize: cf.vectorize.length > 0, secretsStore: cf.secretsStore.length > 0, schedules: cf.cron.length > 0, rateLimits: false, domains: hasDomains, ...(hasDomains ? { domainKinds } : {}), ...(zoneNames.length > 0 ? { zoneNames } : {}) };
  return resourceOnly ? snapshotAccountResources(client, { accountId, needs }) : snapshotTarget(client, { accountId, workerName: cf.workerName, targetKind: spec.targetKind, needs });
}

async function graphPhaseStateHash(accountId: string, planDigest: string, unitId: string, actionId: string, phase: string, snapshot: unknown): Promise<string> {
  const text = canonicalJson({ kind: "tapdeploy-graph-phase-state/v1", accountId, planDigest, unitId, actionId, phase, snapshot });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function graphBundleFromProof(proof: unknown, spec: DeploySpec, archiveSha256: string, manifestDigest: string): DeployBundle | undefined {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return undefined;
  const value = proof as Record<string, unknown>;
  if (typeof value.bundleDigest !== "string" || typeof value.wranglerPath !== "string" || typeof value.wranglerSha256 !== "string" || typeof value.wranglerEffectiveHash !== "string" || !Array.isArray(value.modules) || !Array.isArray(value.assets)) return undefined;
  const modules = value.modules as Array<Record<string, unknown>>;
  const assets = value.assets as Array<Record<string, unknown>>;
  const main = value.mainModule as Record<string, unknown> | undefined;
  if (spec.targetKind === "workers" && (!main || typeof main.path !== "string")) return undefined;
  if (!modules.every((m) => typeof m.path === "string" && typeof m.sha256 === "string" && typeof m.size === "number" && (m.mime === "application/javascript+module" || m.mime === "application/wasm"))) return undefined;
  if (!assets.every((a) => typeof a.path === "string" && typeof a.sha256 === "string" && typeof a.size === "number")) return undefined;
  return { schemaVersion: 1, appName: spec.cloudflare.workerName, targetKind: spec.targetKind, ...(main ? { mainModule: main.path as string } : {}), modules: modules.map((m) => ({ name: m.path as string, kind: m.mime === "application/wasm" ? "wasm" : "esm", mime: m.mime as string, size: m.size as number, sha256: m.sha256 as string })), assets: assets.map((a) => ({ path: a.path as string, size: a.size as number, sha256: a.sha256 as string })), config: { path: value.wranglerPath, size: 0, sha256: value.wranglerSha256 }, source: { archiveBytes: 0, archiveSha256, manifestDigest }, wranglerEffectiveHash: value.wranglerEffectiveHash, bundleDigest: value.bundleDigest };
}

// A provider answer about the credentials is an auth state, not a missing target:
// 401 = the token is no longer valid (sign in again), 403 = it is valid but lacks
// the permission (signing in again will not help). Only a real not-found is 404.
function providerAuthStatus(kind: string): 401 | 403 | undefined {
  return kind === "unauthorized" ? 401 : kind === "forbidden" ? 403 : undefined;
}

function upstreamResponse(c: Context<AppEnv>, error: CloudflareApiError): Response {
  const status = providerAuthStatus(error.kind) ?? (error.kind === "not-found" ? 404 : 502);
  return c.json({ error: "upstream", upstream: error.kind }, status);
}

// own writes advance expected state; outside writes fail safely.
// - Mutating post-activate steps require exact attested version ownership.
//   Resource identity is independently checked in the handler. Only read-only
//   postcheck can tolerate drift without a progress proof.
// - Idempotent retry of a completed activate (same versionId already live)
//   must stay green on the frozen plan instead of yielding plan_stale.
// - Fresh-install window: between our own create-worker (which makes the
//   remote worker exist, stamping the managed marker on the created version)
//   and the first activate there is no active deployment yet, so active
//   ownership cannot be resolved and the plan reports unrelated-worker. Own
//   continuous progress through that window (create-worker idempotent retry,
//   create-version, apply-secrets, activate) is provable when the CURRENT
//   version carries this project's managed marker AND the active set is still
//   empty; any active deployment that appears (own or outside) resolves
//   ownership normally, so those later steps stay strict.
// Any other blocking guard (account, ownership, R2/secret identity, stale
// version) still fails closed, and all other pre-activate steps stay strict
// so an outside deployment before the cutover blocks.
export function isOwnProgressRetry(
  step: DeployStepName,
  plan: { guards: { code: string; level: string }[] },
  snapshot: {
    activeDeploymentVersionIds?: string[];
    activeDeploymentId?: string;
    versions: { id: string; number?: number; message?: string }[];
  },
  args: Record<string, unknown>,
  projectId: string | undefined,
  attestedVersionId?: string,
  progress?: Pick<ProgressReceipt, "baseActiveDeploymentId" | "baseActiveVersionIds">,
): boolean {
  const blocking = plan.guards.filter((g) => g.level === "block");
  if (blocking.length === 0) {
    return false;
  }
  // the fresh-install create-worker -> activate window. The remote worker
  // exists (our own first write or an idempotent retry) but no deployment is
  // active yet, so active ownership is unresolved and every step in the window
  // would see unrelated-worker. Tolerate only when the current version proves
  // own progress (managed marker for this project) and no active deployment has
  // appeared; otherwise fail closed exactly like any outside adoption.
  if (blocking.every((g) => g.code === "unrelated-worker")) {
    if (
      (step === "create-worker" ||
        step === "create-version" ||
        step === "apply-secrets" ||
        step === "activate") &&
      (snapshot.activeDeploymentVersionIds ?? []).length === 0 &&
      !!attestedVersionId && snapshot.versions[0]?.id === attestedVersionId &&
      isManagedWorkerForProject(snapshot.versions.filter(v => v.id === attestedVersionId), projectId)
    ) {
      return true;
    }
    return false;
  }
  if (!blocking.every((g) => g.code === "remote-drift")) {
    return false;
  }
  if (
    step === "postcheck" ||
    // Pages own progress is idempotent; re-running pages-postcheck after
    // our own deployment create must not be treated as an outside drift.
    step === "pages-postcheck"
  ) {
    return true;
  }
  if (["create-worker", "create-version", "apply-secrets", "activate"].includes(step) || POST_ACTIVATE_WRITES.has(step)) {
    const versionId = args.versionId;
    if (typeof versionId !== "string" || versionId.length === 0) {
      return false;
    }
    // Only the idempotent case: the requested version is already live.
    // An outside cutover to a different version still blocks (plan_stale)
    // instead of being silently overwritten.
    const active = snapshot.activeDeploymentVersionIds ?? [];
    // On first install, script PUT already served the complete initial version
    // before create-version staged its successor. The latter receipt seals that
    // exact predecessor; it cannot excuse a later external cutover.
    if (step === "activate" && attestedVersionId === versionId && active.length === 1 &&
        progress?.baseActiveVersionIds?.length === 1 && progress.baseActiveVersionIds[0] === active[0] &&
        progress.baseActiveDeploymentId === snapshot.activeDeploymentId &&
        isManagedWorkerForProject(snapshot.versions.filter(v => v.id === active[0]), projectId)) return true;
    return attestedVersionId === versionId && active.length === 1 && active[0] === versionId &&
      isManagedWorkerForProject(snapshot.versions.filter(v => v.id === versionId), projectId);
  }
  return false;
}

function stepFailureResponse(
  c: Context<AppEnv>,
  error: { kind: string; retryAfterSeconds?: number; detail: string },
  domainReceipt?: SealedEnvelope,
): Response {
  const { kind, retryAfterSeconds, detail } = error;
  let status = 502;
  if (kind === "invalid-args") {
    status = 400;
  } else if (kind === "invalid-manifest") {
    // A browser-supplied Pages manifest that does not bind to the approved
    // release is a client payload failure, never an upstream fault. It fails
    // before any provider write.
    status = 400;
  } else if (kind === "wrong-version" || kind === "step-not-applicable") {
    status = 409;
  } else if (kind === "not-found") {
    status = 404;
  } else if (providerAuthStatus(kind) !== undefined) {
    status = providerAuthStatus(kind)!;
  } else if (
    kind === "conflict" ||
    kind === "binding-conflict" ||
    kind === "validation" ||
    kind === "unsupported-resource" ||
    kind === "missing-secret" ||
    kind === "inherit-source-unavailable" ||
    kind === "unsupported-pages-resource" ||
    // approved buckets still missing at complete-assets is a
    // client-ordering failure (upload before complete), never an upstream
    // fault: the provider answered, the bytes are just not there yet.
    kind === "assets-not-ready" ||
    // writing secrets / registering queue consumers against a Worker that
    // is not (yet) present is an ordering/state failure (409), never a 502
    // upstream fault.
    kind === "worker-missing" ||
    // a domain/route/DNS refusal (unresolvable zone, foreign route,
    // collision, missing confirmation) is a verification refusal before any
    // provider write, never an upstream fault.
    kind === "domain_error"
  ) {
    status = 409;
  } else if (kind === "rate-limited") {
    status = 429;
  } else if (kind === "artifact-mismatch") {
    status = 422;
  }
  return c.json(
    {
      ok: false,
      error: kind,
      detail,
      ...(domainReceipt ? { domainReceipt } : {}),
      ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}),
    },
    status as ContentfulStatusCode,
  );
}


function isUpstreamError(error: unknown): error is CloudflareApiError {
  return typeof error === "object" && error !== null && "kind" in error;
}
