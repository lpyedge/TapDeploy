// One bounded deployment step per authenticated request. The browser drives the
// sequence (register-assets -> [bucket uploads with JWT local to browser] ->
// complete-assets -> create-version -> activate -> [reconcile-schedules] ->
// postcheck); the server executes exactly one step and never accepts asset
// payloads. Asset transport follows the official direct-upload protocol:
// POST .../assets-upload-session returns {jwt, buckets[][]}; buckets upload
// via POST .../workers/assets/upload?base64=true with the JWT; version upload
// is multipart/form-data with metadata.main_module; deployment uses the
// percentage strategy. Every step re-reads live state and is idempotent or
// fails closed; a failed cutover never silently replaces the already-live
// version.

import { verifyDeployedBindings } from "./postcheck-bindings.js";
import { resourceCapabilityIssues } from "./resource-validation.js";
import { startAssetUploadSession as startSessionFn } from "../../cloudflare/assets/index.js";
import { buildAssetUploadManifest } from "../../cloudflare/assets/index.js";
import { TAPDEPLOY_MANAGED_MARKER } from "../planning/digest.js";
import { graphResourceCreatePhase } from "../planning/graph-operation-support.js";
import { WORKER_UPLOAD_MAX_ENCODED_BYTES, WORKER_UPLOAD_MAX_MODULES } from "../../cloudflare/models/workers.js";
import { verifyDeployBundleModules } from "../../release/artifact-proof.js";
import type { DeployBundle } from "../../release/deploy-bundle.js";
import type { VersionModuleRef } from "../../cloudflare/models/workers.js";
import type { DeploySpec } from "../deploy-spec.js";
import type { TargetSnapshot } from "../planning/types.js";
import type { GraphUnitKind } from "../planning/deploy-graph.js";
import type { CloudflareApiClient } from "../../cloudflare/client/index.js";
import type { AssetSessionStartResult } from "../../cloudflare/assets/index.js";
import {
  createR2Buckets,
  createD1Databases,
  createKvNamespaces,
  createQueues,
  registerQueueConsumers,
  applyWorkflows,
  createHyperdriveConfigs,
  createVectorizeIndexes,
  createSecretsStores,
  ensureSecretsStoreSecrets,
  reconcileRateLimits,
  stepOk as ok,
  stepFail as fail,
  toStepFailure,
} from "./bindings.js";
import { migrationObjectForUpload } from "./wrangler-binding-plan.js";
import { applySecrets, prepareSecretBindings } from "./secrets.js";
import { planRateLimitBindings, type RateLimitBindingPlan } from "../../cloudflare/resources/rate-limits.js";
import { parseBootstrapDirective, type BootstrapDirective } from "./bootstrap-profile.js";
import {
  ensurePagesProject,
  startPagesAssetUpload,
  createPagesDeployment,
  postcheckPagesDeployment,
} from "./pages.js";
import { reconcileDomains } from "./domains.js";

export const DEPLOY_STEP_NAMES = [
  "register-assets",
  "complete-assets",
  "create-r2-buckets",
  "create-d1-databases",
  "create-kv-namespaces",
  "create-queues",
  // the Workers sequence puts apply-secrets after the worker/version
  // exist and register-queue-consumers after the cutover.
  "create-hyperdrive-configs",
  "create-vectorize-indexes",
  "create-secrets-stores",
  "ensure-secrets-store-secrets",
  "create-worker",
  "create-version",
  "apply-secrets",
  "activate",
  "register-queue-consumers",
  "apply-workflows",
  "reconcile-schedules",
  "reconcile-rate-limits",
  // Operator-selected: serve the Worker on its workers.dev address. An
  // API-created Worker starts with workers.dev disabled, so without this the
  // deployment succeeds but nothing answers.
  "publish-workers-dev",
  "postcheck",
  // opt-in domain/route/DNS changes. These only run when the release
  // declares a domain/route/DNS intent, and only ever inside the preauthorized
  // envelope (the deploy step's own plan re-verifies). DNS is never auto-applied
  // on an ordinary Worker upgrade.
  "reconcile-domains",
  // Pages direct-upload deploy steps (targetKind "pages"). These are the
  // ONLY steps a Pages release runs; the Workers script/version/steps above are
  // never invoked for a Pages target.
  "pages-create-project",
  "pages-register-assets",
  "pages-deploy",
  "pages-postcheck",
] as const;

export type DeployStepName = (typeof DEPLOY_STEP_NAMES)[number];

export interface DeployStepContext {
  // Server-owned guard, never taken from browser args. Called immediately before
  // a post-cutover write after its provider-dependent preparation reads.
  beforeMutation?: () => Promise<void>;
  trackDomainProgress?: boolean;
  onPreparedBindings?: (bindings: Array<Record<string, unknown>>, runtime: { compatibility_date?: string; compatibility_flags?: string[] }) => void;
  client: CloudflareApiClient;
  accountId: string;
  workerName: string;
  spec: DeploySpec;
  // approved prebuilt bundle identity for the prebuilt path. When
  // present, Worker uploads verify the complete module set against it and never
  // trust client-provided module names; absent for a single-module Worker.
  bundle?: DeployBundle;
  snapshot: TargetSnapshot;
  accessToken: string;
}

export interface DeployStepFail {
  ok: false;
  error: { kind: string; retryAfterSeconds?: number; detail: string };
}

export interface DeployStepOk {
  ok: true;
  result: unknown;
}

export type DeployStepOutcome = DeployStepOk | DeployStepFail;

export type RegisterAssetsResult = AssetSessionStartResult;

export interface CompleteAssetsResult {
  jwt: string;
}

export interface CreateVersionResult {
  versionId: string;
  number?: number;
}

export interface ActivateResult {
  alreadyActive: boolean;
  deploymentId: string;
}

export type ExecuteDeployStep = typeof executeDeployStep;
export function isDeployStepForTarget(target: "workers" | "pages", step: DeployStepName): boolean {
  return target === "pages" ? ["pages-create-project", "pages-register-assets", "pages-deploy", "pages-postcheck", "reconcile-domains"].includes(step) : !step.startsWith("pages-");
}

// graph execution may dispatch only a step that corresponds to a planned,
// safe mutation. Resource-only units never acquire an HTTP/Worker upload path;
// they can execute only their own account-resource create actions. This helper
// is pure so Node and Workers routes share the exact same allowlist; the
// resource -> create-phase table lives in the graph operation catalog.
export function graphStepForResourceAction(
  resource: string,
  action: string,
): DeployStepName | undefined {
  const phase = action === "create" ? graphResourceCreatePhase(resource) : undefined;
  return phase !== undefined && (DEPLOY_STEP_NAMES as readonly string[]).includes(phase) ? (phase as DeployStepName) : undefined;
}

export function isGraphActionStepAllowed(input: {
  unitKind: GraphUnitKind;
  step: DeployStepName;
  resource: string;
  action: string;
}): boolean {
  if (input.unitKind === "resource-only") {
    return graphStepForResourceAction(input.resource, input.action) === input.step;
  }
  // `detach` exists only for removing an operator-chosen custom domain.
  const removable = input.action !== "detach" || input.resource === "worker-custom-domain" || input.resource === "pages-custom-domain";
  if (input.unitKind === "pages-static" || input.unitKind === "pages-functions") {
    return isDeployStepForTarget("pages", input.step) && input.action !== "conflict" && removable;
  }
  return isDeployStepForTarget("workers", input.step) && input.action !== "conflict" && removable;
}

export function versionMessage(spec: DeploySpec): string {
  return `${spec.project.id} v${spec.project.version} ${TAPDEPLOY_MANAGED_MARKER}`;
}

// Official upload manifest: rooted paths ("/...") with 32-hex upload hashes
// distinct from the 64-hex release-integrity SHA.
export async function assetUploadManifest(
  spec: DeploySpec,
): Promise<Record<string, { hash: string; size: number }>> {
  return buildAssetUploadManifest(spec.assets, spec.wrangler.assets?.directory);
}

async function sha256HexString(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function executeDeployStep(
  step: DeployStepName,
  ctx: DeployStepContext,
  args: Record<string, unknown>,
  deps: {
    startSession: typeof startSessionFn;
  } = { startSession: startSessionFn },
): Promise<DeployStepOutcome> {
  if (!isDeployStepForTarget(ctx.spec.targetKind, step)) return fail("step-not-applicable", "this operation is not supported for the approved deployment target");
  // Refuse upgrades requiring unreadable active-secret inheritance before any
  // preparatory write, including resources/assets created before the upload.
  const preparation = new Set<DeployStepName>([
    "register-assets", "create-r2-buckets", "create-d1-databases", "create-kv-namespaces",
    "create-queues", "create-hyperdrive-configs", "create-vectorize-indexes",
    "create-secrets-stores", "ensure-secrets-store-secrets", "create-version",
  ]);
  if (preparation.has(step) || step === "create-worker" || step === "pages-create-project" || step === "pages-deploy") {
    const issues = resourceCapabilityIssues(ctx.spec, ctx.snapshot);
    if (issues.length) return fail("validation", issues.join("; "));
  }
  if (ctx.spec.targetKind === "workers" && (preparation.has(step) || step === "create-worker") && ctx.spec.assets.some(asset => !asset.workersHash || !/^[0-9a-f]{32}$/.test(asset.workersHash))) return fail("asset-integrity-unavailable", "Worker asset upload hashes are missing or invalid; preparation stopped before mutation");
  if (preparation.has(step) && (ctx.snapshot.secretNames ?? []).some(name => !ctx.snapshot.activeBindings?.some(binding => binding.name === name && (binding.type === "secret_text" || binding.type === "secret_key")))) return fail("inherit-source-unavailable", "exact active secret inventory is unavailable; preparation stopped before mutation");
  if (preparation.has(step)) {
    const nonsecretNames = new Set([
      ...Object.keys(ctx.spec.wrangler.vars ?? {}),
      ...[ctx.spec.cloudflare.r2, ctx.spec.cloudflare.d1, ctx.spec.cloudflare.kv, ctx.spec.cloudflare.queues, ctx.spec.cloudflare.workflows ?? [], ctx.spec.cloudflare.hyperdrive, ctx.spec.cloudflare.vectorize, ctx.spec.cloudflare.secretsStore, ctx.spec.cloudflare.runtimeBindings].flatMap(bindings => bindings.map(binding => binding.binding).filter((name): name is string => typeof name === "string")),
      // DO bindings are version metadata too — a secret preserved under
      // the same name must fail here, not as a late binding conflict.
      ...(ctx.spec.wrangler.durableObjects ?? []).map((binding) => binding.name),
      ...(ctx.spec.assets.length ? [ctx.spec.wrangler.assets?.binding ?? "ASSETS"] : []),
    ]);
    if ((ctx.snapshot.secretNames ?? []).some(name => nonsecretNames.has(name))) return fail("inherit-source-unavailable", "a declared nonsecret binding conflicts with a preserved active secret; preparation stopped before mutation");
  }
  if (preparation.has(step) && ctx.snapshot.workerExists) {
    const inventory = ctx.snapshot.activeBindings;
    if (!inventory || ctx.snapshot.activeDeploymentVersionIds?.length !== 1 || inventory.some(b => !preservableBinding(b, ctx.spec.assets.length > 0))) {
      return fail("inherit-source-unavailable", "exact active-version binding preservation cannot be proved; preparation stopped before mutation");
    }
  }
  switch (step) {
    case "register-assets":
      return registerAssets(ctx, args, deps.startSession);
    case "complete-assets":
      return completeAssets(ctx, args, deps.startSession);
    case "create-worker":
      return createWorker(ctx, args);
    case "create-version":
      return createVersion(ctx, args);
    case "activate":
      return activate(ctx, args);
    case "create-r2-buckets":
      return createR2Buckets(ctx, args);
    case "create-d1-databases":
      return createD1Databases(ctx, args);
    case "create-kv-namespaces":
      return createKvNamespaces(ctx, args);
    case "create-queues":
      return createQueues(ctx, args);
    case "register-queue-consumers":
      return registerQueueConsumers(ctx, args);
    case "apply-workflows":
      return applyWorkflows(ctx, args);
    case "create-hyperdrive-configs":
      return createHyperdriveConfigs(ctx, args);
    case "create-vectorize-indexes":
      return createVectorizeIndexes(ctx, args);
    case "create-secrets-stores":
      return createSecretsStores(ctx, args);
    case "ensure-secrets-store-secrets":
      return ensureSecretsStoreSecrets(ctx, args);
    case "apply-secrets":
      return applySecrets(ctx, args);
    case "reconcile-schedules":
      return reconcileSchedules(ctx, args);
    case "reconcile-rate-limits":
      return reconcileRateLimits(ctx, args);
    case "reconcile-domains":
      return reconcileDomains(ctx, args);
    case "publish-workers-dev":
      return publishWorkersDev(ctx, args);
    case "postcheck":
      return postcheck(ctx, args);
    case "pages-create-project":
      return ensurePagesProject(ctx.client, ctx.spec, ctx.snapshot, args);
    case "pages-register-assets":
      return startPagesAssetUpload(ctx.client, ctx.spec);
    case "pages-deploy":
      return createPagesDeployment(ctx.client, ctx.spec, args, ctx.snapshot);
    case "pages-postcheck":
      return postcheckPagesDeployment(ctx.client, ctx.spec, String(args.deploymentId ?? ""), ctx.snapshot);
    default:
      return fail("unknown-step", `unsupported deploy step "${String(step)}"`);
  }
}

async function registerAssets(
  ctx: DeployStepContext,
  _args: Record<string, unknown>,
  startSession: typeof startSessionFn,
): Promise<DeployStepOutcome> {
  // absent optionals are a successful no-op, not a failure. The
  // browser also SKIPs them without a round-trip; the server succeeds so a
  // direct call or retry can never fail a minimal release.
  if (ctx.spec.assets.length === 0) {
    return ok({ skipped: true, buckets: [] } satisfies { skipped: true; buckets: string[][] });
  }
  try {
    const manifest = await assetUploadManifest(ctx.spec);
    const result = await startSession(
      {
        accessToken: ctx.accessToken,
        accountId: ctx.accountId,
        scriptName: ctx.workerName,
        fetcher: (input: string | URL, init?: RequestInit) => fetch(input, init),
      },
      manifest,
    );
    return ok(result satisfies RegisterAssetsResult);
  } catch (error) {
    return toStepFailure(error);
  }
}

// Re-register the exact approved manifest after browser upload. An empty bucket
// set yields a provider JWT for THIS manifest; never trust a browser-chosen JWT
// as proof that a different release's assets were approved.
async function completeAssets(
  ctx: DeployStepContext,
  _args: Record<string, unknown>,
  startSession: typeof startSessionFn,
): Promise<DeployStepOutcome> {
  // absent optionals are a successful no-op, not a failure.
  if (ctx.spec.assets.length === 0) {
    return ok({ skipped: true } satisfies { skipped: true });
  }
  try {
    const result = await startSession({ accessToken: ctx.accessToken, accountId: ctx.accountId, scriptName: ctx.workerName, fetcher: (input, init) => fetch(input, init) }, await assetUploadManifest(ctx.spec));
    if (result.buckets.some(bucket => bucket.length > 0)) return fail("assets-not-ready", "approved asset hashes are still missing; complete the upload before requesting a version");
    if (!result.jwt) return fail("invalid-response", "approved asset completion token is unavailable");
    return ok({ jwt: result.jwt } satisfies CompleteAssetsResult);
  } catch (error) { return toStepFailure(error); }
}

// resolve and verify the module bytes a Worker upload may send. The
// base64 arguments must fit the bounded deploy-step body (base64 expansion
// never breaks the 8 MiB limit), a prebuilt bundle verifies every module
// against the approved identity byte-for-byte, and anything unverified fails
// closed before any provider call.
interface WorkerUploadModules {
  mainName: string;
  main: VersionModuleRef;
  additional: VersionModuleRef[];
}

function encodedBudgetFailure(): DeployStepFail {
  return fail(
    "payload-too-large",
    `encoded module payload exceeds the bounded ${WORKER_UPLOAD_MAX_ENCODED_BYTES}-byte deploy-step upload budget (base64 expansion must stay inside the 8 MiB body)`,
  );
}

function decodeB64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function resolveWorkerUploadModules(
  ctx: DeployStepContext,
  args: Record<string, unknown>,
  requiredMessage: string,
): Promise<{ ok: true; value: WorkerUploadModules } | { ok: false; failure: DeployStepFail }> {
  const scriptB64 = args.scriptB64;
  if (typeof scriptB64 !== "string" || scriptB64.length === 0) {
    return { ok: false, failure: fail("invalid-args", requiredMessage) };
  }
  if (scriptB64.length > WORKER_UPLOAD_MAX_ENCODED_BYTES) {
    return { ok: false, failure: encodedBudgetFailure() };
  }
  const additionalArg = args.additionalModules;
  const additional = additionalArg === undefined ? [] : additionalArg;
  if (!Array.isArray(additional)) {
    return { ok: false, failure: fail("invalid-args", "additionalModules must be an array of { name, contentB64 } entries") };
  }
  if (1 + additional.length > WORKER_UPLOAD_MAX_MODULES) {
    return {
      ok: false,
      failure: fail("payload-too-large", `module count ${1 + additional.length} exceeds the bounded ${WORKER_UPLOAD_MAX_MODULES}-module upload limit`),
    };
  }
  const entries: Array<{ name: string; contentB64: string }> = [];
  let encodedTotal = scriptB64.length;
  for (const entry of additional) {
    const record = (entry ?? {}) as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0 || typeof record.contentB64 !== "string" || record.contentB64.length === 0) {
      return { ok: false, failure: fail("invalid-args", "each additionalModules entry requires a name and a contentB64 string") };
    }
    encodedTotal += record.contentB64.length;
    if (encodedTotal > WORKER_UPLOAD_MAX_ENCODED_BYTES) {
      return { ok: false, failure: encodedBudgetFailure() };
    }
    entries.push({ name: record.name, contentB64: record.contentB64 });
  }
  let mainBytes: Uint8Array<ArrayBuffer>;
  try {
    mainBytes = decodeB64(scriptB64);
  } catch (error) {
    return { ok: false, failure: fail("invalid-args", `scriptB64 is not valid base64: ${String(error)}`) };
  }
  const bundle = ctx.bundle;
  if (bundle) {
    // Prebuilt path: the approved bundle is the only module identity. Client
    // names/sizes/hashes are never trusted; every approved module must arrive
    // exactly once with exact bytes or the upload stops before any provider call.
    if (bundle.targetKind !== "workers" || typeof bundle.mainModule !== "string" || bundle.mainModule.length === 0) {
      return { ok: false, failure: fail("invalid-args", "approved bundle is missing its Worker entry module") };
    }
    const bytesByName = new Map<string, Uint8Array<ArrayBuffer>>([[bundle.mainModule, mainBytes]]);
    for (const entry of entries) {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = decodeB64(entry.contentB64);
      } catch (error) {
        return { ok: false, failure: fail("invalid-args", `additionalModules["${entry.name}"] is not valid base64: ${String(error)}`) };
      }
      if (bytesByName.has(entry.name)) {
        return { ok: false, failure: fail("invalid-args", `additionalModules repeats the module "${entry.name}"`) };
      }
      bytesByName.set(entry.name, bytes);
    }
    const verdict = await verifyDeployBundleModules(
      bundle,
      [...bytesByName].map(([name, bytes]) => ({ name, bytes })),
    );
    if (!verdict.ok) {
      return { ok: false, failure: fail("artifact-mismatch", `module set does not match the approved prebuilt bundle: ${verdict.errors.join("; ")}`) };
    }
    const mimeByName = new Map(bundle.modules.map((module) => [module.name, module.mime]));
    const mainMime = mimeByName.get(bundle.mainModule);
    if (!mainMime) {
      return { ok: false, failure: fail("invalid-args", "approved bundle is missing its entry module MIME type") };
    }
    return {
      ok: true,
      value: {
        mainName: bundle.mainModule,
        main: { name: bundle.mainModule, content: mainBytes, contentType: mainMime },
        additional: entries.map((entry) => ({
          name: entry.name,
          content: bytesByName.get(entry.name) ?? new Uint8Array(0),
          contentType: mimeByName.get(entry.name) ?? "application/octet-stream",
        })),
      },
    };
  }
  // Without an approved bundle identity, additional modules have nothing to be
  // verified against, so they are refused instead of trusted.
  if (entries.length > 0) {
    return { ok: false, failure: fail("invalid-args", "additionalModules require the approved prebuilt bundle identity; unverified client module names are refused") };
  }
  const expectedWorker = ctx.spec.worker;
  if (!expectedWorker) {
    return { ok: false, failure: fail("invalid-args", "approved Worker artifact is unavailable for this release") };
  }
  const [actualSize, actualSha] = await Promise.all([
    Promise.resolve(mainBytes.length),
    sha256HexString(mainBytes),
  ]);
  if (actualSize !== expectedWorker.size || actualSha !== expectedWorker.sha256) {
    return {
      ok: false,
      failure: fail(
        "artifact-mismatch",
        `module bytes do not match the confirmed release artifact (size ${actualSize}/${expectedWorker.size}, sha ${actualSha.slice(0, 8)}…)`,
      ),
    };
  }
  return {
    ok: true,
    value: {
      mainName: MAIN_MODULE_NAME,
      main: { name: MAIN_MODULE_NAME, content: mainBytes, contentType: "application/javascript+module" },
      additional: [],
    },
  };
}

// Create the Worker itself on the first (install) deploy. The provider's
// PUT .../workers/scripts/{name} uploads the script and creates the initial
// version in one call. It is a no-op on a Worker that already exists, so the
// step is idempotent across a retry and never clobbers an upgrade path.
async function createWorker(
  ctx: DeployStepContext,
  args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  if (ctx.snapshot.workerExists) {
    return ok({ skipped: true } satisfies { skipped: true });
  }
  const resolved = await resolveWorkerUploadModules(ctx, args, "create-worker requires scriptB64");
  if (!resolved.ok) {
    return resolved.failure;
  }
  const metadata = buildVersionMetadata(ctx, args, resolved.value.mainName);
  if (!metadata.ok) {
    return metadata.failure;
  }
  try {
    ctx.onPreparedBindings?.(metadata.value.bindings ?? [], metadata.value);
    await ctx.client.createWorker(ctx.workerName, {
      metadata: metadata.value,
      mainModule: resolved.value.main,
      ...(resolved.value.additional.length > 0 ? { additionalModules: resolved.value.additional } : {}),
    });
    // Script PUT's id is the script name, not the uploaded version ID. Resolve
    // the immediately serving version and verify our marker; ambiguous state
    // safely stops (the complete upload may already be serving).
    const [deployments, versions] = await Promise.all([
      ctx.client.listDeployments(ctx.workerName), ctx.client.listVersions(ctx.workerName),
    ]);
    const active = deployments[0]?.versions;
    if (active?.length !== 1 || active[0]?.percentage !== 100) {
      return fail("wrong-version", "first upload serving version could not be resolved unambiguously");
    }
    const version = versions.find(v => v.id === (active[0]?.version_id ?? active[0]?.id));
    if (!version || version.message !== versionMessage(ctx.spec)) {
      return fail("wrong-version", "first upload serving version does not match the approved project/release");
    }
    return ok({ versionId: version.id, number: version.number });
  } catch (error) {
    return toStepFailure(error);
  }
}

async function createVersion(
  ctx: DeployStepContext,
  args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  const resolved = await resolveWorkerUploadModules(ctx, args, "create-version requires scriptB64");
  if (!resolved.ok) {
    return resolved.failure;
  }
  const metadata = buildVersionMetadata(ctx, args, resolved.value.mainName);
  if (!metadata.ok) {
    return metadata.failure;
  }
  try {
    ctx.onPreparedBindings?.(metadata.value.bindings ?? [], metadata.value);
    const version = await ctx.client.createVersion(ctx.workerName, {
      metadata: metadata.value,
      mainModule: resolved.value.main,
      ...(resolved.value.additional.length > 0 ? { additionalModules: resolved.value.additional } : {}),
    });
    return ok({ versionId: version.id, number: version.number });
  } catch (error) {
    return toStepFailure(error);
  }
}

const MAIN_MODULE_NAME = "worker.mjs";

function preservableBinding(binding: Record<string, unknown>, hasNewAssets: boolean): boolean {
  if (typeof binding.name !== "string" || !binding.name) return false;
  const required: Record<string, string[]> = {
    plain_text: ["text"], json: ["json"], r2_bucket: ["bucket_name"], d1: [],
    kv_namespace: ["namespace_id"], queue: ["queue_name"], hyperdrive: ["id"],
    vectorize: ["index_name"], service: ["service"], ai: [], browser: [],
    ratelimit: ["namespace_id", "simple"], secrets_store_secret: ["store_id", "secret_name"],
    // a Workflow binding is static metadata (name/class/script); there is
    // no provider-generated id to drift, so verbatim preservation is exactly
    // provable and a version update must not be refused for carrying one.
    workflow: ["workflow_name", "class_name"],
    // a Durable Object binding is static metadata (name/class) likewise;
    // the namespace is provider-created by the migration, never an id the
    // binding must carry.
    durable_object_namespace: ["class_name"],
  };
  if (binding.type === "assets") return hasNewAssets;
  if (binding.type === "secret_text" || binding.type === "secret_key") return true;
  if (typeof binding.type !== "string" || !Object.hasOwn(required, binding.type)) return false;
  if (binding.type === "d1" && typeof (binding.database_id ?? binding.id) !== "string") return false;
  return required[binding.type]!.every(k => binding[k] !== undefined);
}

// resolve the D1 database id bound under `binding` from the live snapshot
// (the create/preserve step re-reads state after the resource is ensured).
// a declared provider id is verified by id first; a rebound or missing id
// resolves to undefined so the binding is never silently attached to another
// database.
function resolveD1DatabaseId(ctx: DeployStepContext, binding: string): string | undefined {
  const declared = ctx.spec.cloudflare.d1.find((b) => b.binding === binding);
  if (!declared) {
    return undefined;
  }
  if (declared.databaseId !== undefined) {
    return ctx.snapshot.d1Databases.find((d) => d.id === declared.databaseId)?.id;
  }
  const db = ctx.snapshot.d1Databases.find((d) => d.name === declared.databaseName);
  return db?.id;
}

// resolve the KV namespace id bound under `binding` from the live snapshot.
// a declared provider id is verified by id first; it is never treated as
// a title, and a missing/rebound id resolves to undefined.
function resolveKvNamespaceId(ctx: DeployStepContext, binding: string): string | undefined {
  const declared = ctx.spec.cloudflare.kv.find((b) => b.binding === binding);
  if (!declared) {
    return undefined;
  }
  if (declared.namespaceId !== undefined) {
    return ctx.snapshot.kvNamespaces.find((n) => n.id === declared.namespaceId)?.id;
  }
  const ns = ctx.snapshot.kvNamespaces.find((n) => n.name === declared.namespaceName);
  return ns?.id;
}

// resolve the Queue id bound under `binding` from the live snapshot. A
// consumer role does NOT produce a Worker binding — the consumer trigger is
// registered on the queue's consumers subresource instead.
function resolveQueueId(ctx: DeployStepContext, binding: string): { id: string; name: string } | undefined {
  const declared = ctx.spec.cloudflare.queues.find((b) => b.binding === binding);
  if (!declared || declared.role === "consumer") {
    return undefined;
  }
  const queue = ctx.snapshot.queues.find((q) => q.name === declared.queueName);
  return queue ? { id: queue.id, name: queue.name } : undefined;
}

// resolve the Hyperdrive config id bound under `binding` from the live
// snapshot (the create/preserve step re-reads state after the resource is
// ensured).
function resolveHyperdriveConfigId(ctx: DeployStepContext, binding: string): { id: string; name: string } | undefined {
  const declared = ctx.spec.cloudflare.hyperdrive.find((b) => b.binding === binding);
  if (!declared) {
    return undefined;
  }
  const config = ctx.snapshot.hyperdriveConfigs.find((c) => c.name === declared.configName);
  return config ? { id: config.id, name: config.name } : undefined;
}

// resolve the Vectorize index bound under `binding` from the live snapshot
// (the create/preserve step re-reads state after the resource is ensured).
function resolveVectorizeIndex(ctx: DeployStepContext, binding: string): { id: string; name: string } | undefined {
  const declared = ctx.spec.cloudflare.vectorize.find((b) => b.binding === binding);
  if (!declared) {
    return undefined;
  }
  const index = ctx.snapshot.vectorizeIndexes.find((c) => c.name === declared.indexName);
  return index ? { id: index.id, name: index.name } : undefined;
}

// resolve a Secrets Store secret binding from the live snapshot. A secret
// is bound inside its store by `store_id` + `secret_name`.
function resolveSecretsStoreSecret(
  ctx: DeployStepContext,
  binding: string,
): { storeId: string; secretName: string } | undefined {
  const declared = ctx.spec.cloudflare.secretsStore.find((b) => b.binding === binding);
  if (!declared || !declared.secretName) {
    return undefined;
  }
  const store = ctx.snapshot.secretsStores.find((s) => s.name === declared.storeName);
  if (!store) {
    return undefined;
  }
  return { storeId: store.id, secretName: declared.secretName };
}

function buildVersionMetadata(
  ctx: DeployStepContext,
  args: Record<string, unknown>,
  mainModuleName: string,
): { ok: true; value: import("../../cloudflare/models/workers.js").VersionMetadata } | { ok: false; failure: DeployStepFail } {
  if (!ctx.spec.wrangler.compatibility_date || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.spec.wrangler.compatibility_date)) return { ok: false, failure: fail("runtime-unavailable", "approved Worker compatibility date is required before upload") };
  // the limited bootstrap directive (profile + mode + PRIVATE_VERIFIED
  // proof) is strictly parsed before any binding is assembled; a malformed or
  // proof-less directive refuses before any provider write.
  let bootstrapDirective: BootstrapDirective | undefined;
  if (args.bootstrap !== undefined) {
    const parsed = parseBootstrapDirective(args.bootstrap);
    if (!parsed.ok) return { ok: false, failure: fail("bootstrap-refused", `${parsed.refusal.code}: ${parsed.refusal.detail}`) };
    bootstrapDirective = parsed.value;
  }
  const secrets = prepareSecretBindings(ctx, args.secrets, bootstrapDirective);
  if (!secrets.ok) return { ok: false, failure: secrets.failure as DeployStepFail };
  const has = (items: Array<{ name: string; id: string }> | undefined, name: string) => items?.some(item => item.name === name && typeof item.id === "string" && item.id.length > 0) === true;
  const hasId = (items: Array<{ name: string; id: string }> | undefined, id: string) => items?.some(item => item.id === id && typeof item.id === "string" && item.id.length > 0) === true;
  const missing = ctx.spec.cloudflare.r2.some(b => !has(ctx.snapshot.r2Buckets, b.bucketName)) ||
    ctx.spec.cloudflare.d1.some(b => b.databaseId !== undefined ? !hasId(ctx.snapshot.d1Databases, b.databaseId) : !has(ctx.snapshot.d1Databases, b.databaseName)) ||
    ctx.spec.cloudflare.kv.some(b => b.namespaceId !== undefined ? !hasId(ctx.snapshot.kvNamespaces, b.namespaceId) : !has(ctx.snapshot.kvNamespaces, b.namespaceName)) ||
    ctx.spec.cloudflare.queues.some(b => !has(ctx.snapshot.queues, b.queueName)) ||
    ctx.spec.cloudflare.hyperdrive.some(b => !has(ctx.snapshot.hyperdriveConfigs, b.configName)) ||
    ctx.spec.cloudflare.vectorize.some(b => !has(ctx.snapshot.vectorizeIndexes, b.indexName)) ||
    ctx.spec.cloudflare.secretsStore.some(b => {
      const store = ctx.snapshot.secretsStores?.find(store => store.name === b.storeName);
      return !store?.id || !b.secretName || !ctx.snapshot.secretsStoreSecrets?.some(secret => secret.store_id === store.id && secret.secretName === b.secretName);
    });
  if (missing) return { ok: false, failure: fail("validation", "required approved resource identities are missing; ensure resources before any code upload") };
  const bindings: Array<Record<string, unknown>> = [...secrets.bindings];
  for (const service of ctx.spec.wrangler.services ?? []) {
    bindings.push({ type: "service", name: service.binding, service: service.service, ...(service.entrypoint ? { entrypoint: service.entrypoint } : {}) });
  }
  for (const r2 of ctx.spec.wrangler.r2_buckets ?? []) {
    bindings.push({ type: "r2_bucket", name: r2.binding, bucket_name: r2.bucket_name });
  }
  // D1 databases and KV namespaces are bound by their resolved identity.
  // For KV the provider binding carries the namespace id; for D1 it carries the
  // database id (the resolved spec holds the chosen name; the id comes from the
  // live resource identity after the create/preserve step re-reads state).
  for (const d1 of ctx.spec.wrangler.d1_databases ?? []) {
    const id = resolveD1DatabaseId(ctx, d1.binding);
    if (id) {
      bindings.push({ type: "d1", name: d1.binding, id });
    }
  }
  for (const kv of ctx.spec.wrangler.kv_namespaces ?? []) {
    const id = resolveKvNamespaceId(ctx, kv.binding);
    if (id) {
      // KV binding uses the namespace id; also carry the namespace name for
      // postcheck identity verification.
      bindings.push({ type: "kv_namespace", name: kv.binding, namespace_id: id });
    }
  }
  // Queue producer bindings carry the queue name (official binding shape
  // {name, queue_name, type:"queue"}). Consumer triggers are NOT bound here —
  // they are registered on the queue's consumers subresource.
  for (const queue of ctx.spec.wrangler.queues ?? []) {
    // a consumer-only queue carries no producer binding and is never bound
    // in the version metadata; only entries with an exact binding identity do.
    if (queue.binding === undefined) continue;
    const resolved = resolveQueueId(ctx, queue.binding);
    if (resolved) {
      bindings.push({ type: "queue", name: queue.binding, queue_name: resolved.name });
    }
  }
  // Workflow bindings carry the account-unique workflow name and the
  // exported class (official binding shape {name, workflow_name, class_name,
  // type:"workflow", script_name?}). The definition itself is applied through
  // the Workflows API after this version is active (apply-workflows), never
  // through the metadata.
  for (const workflow of ctx.spec.wrangler.workflows ?? []) {
    bindings.push({
      type: "workflow",
      name: workflow.binding,
      workflow_name: workflow.name,
      class_name: workflow.class_name,
      ...(workflow.script_name !== undefined ? { script_name: workflow.script_name } : {}),
    });
  }
  // Durable Object bindings carry the class (official binding shape
  // {name, class_name, type:"durable_object_namespace"}). Own script only —
  // script_name is omitted exactly as wrangler sends it for the carrying
  // script; a foreign script never reaches the projection (plan refusal).
  for (const durableObject of ctx.spec.wrangler.durableObjects ?? []) {
    bindings.push({ type: "durable_object_namespace", name: durableObject.name, class_name: durableObject.class_name });
  }
  // Hyperdrive config bindings carry the config id (official binding shape
  // {id, name, type:"hyperdrive"}).
  for (const hd of ctx.spec.wrangler.hyperdrive ?? []) {
    const resolved = resolveHyperdriveConfigId(ctx, hd.binding);
    if (resolved) {
      bindings.push({ type: "hyperdrive", name: hd.binding, id: resolved.id });
    }
  }
  // Vectorize index bindings carry the index name (official binding shape
  // {index_name, name, type:"vectorize"}).
  for (const vz of ctx.spec.wrangler.vectorize ?? []) {
    const resolved = resolveVectorizeIndex(ctx, vz.binding);
    if (resolved) {
      bindings.push({ type: "vectorize", name: vz.binding, index_name: vz.index_name });
    }
  }
  // Secrets Store bindings carry the store id + secret name (official
  // binding shape {name, secret_name, store_id, type:"secrets_store_secret"}).
  // The secret `value` is never part of a binding.
  for (const ss of ctx.spec.wrangler.secrets_store_secrets ?? []) {
    const resolved = resolveSecretsStoreSecret(ctx, ss.binding);
    if (resolved) {
      bindings.push({
        type: "secrets_store_secret",
        name: ss.binding,
        store_id: resolved.storeId,
        secret_name: resolved.secretName,
      });
    }
  }
  // rate-limit metadata bindings (official binding shape
  // {name, type:"ratelimit", namespace_id, simple:{limit, period}}). These are
  // version metadata only: no account/zone rate-limit rule is ever created,
  // updated, or deleted here. Re-validated at build time so a direct step call
  // also fails closed before any provider write (the plan already refused).
  const declaredRateLimits = ctx.spec.wrangler.ratelimits ?? [];
  if (declaredRateLimits.length > 0) {
    let planned: RateLimitBindingPlan;
    try {
      planned = planRateLimitBindings(declaredRateLimits, []);
    } catch (error) {
      return { ok: false, failure: fail("validation", error instanceof Error ? error.message : "invalid rate-limit declaration") };
    }
    for (const binding of planned.bindings) {
      bindings.push({ type: "ratelimit", name: binding.name, namespace_id: binding.namespace_id, simple: { limit: binding.simple.limit, period: binding.simple.period } });
    }
  }
  // runtime bindings (Workers AI / Browser Rendering) are binding-only —
  // no account resource identity. They carry just the binding name (official
  // shapes {type:"ai", name} and {type:"browser", name}).
  for (const ai of ctx.spec.wrangler.ai ?? []) {
    bindings.push({ type: "ai", name: ai.binding });
  }
  for (const br of ctx.spec.wrangler.browser ?? []) {
    bindings.push({ type: "browser", name: br.binding });
  }
  const vars = ctx.spec.wrangler.vars ?? {};
  for (const [name, text] of Object.entries(vars)) {
    bindings.push({ type: "plain_text", name, text: String(text) });
  }
  const hasAssets = ctx.spec.assets.length > 0;
  if (hasAssets) {
    const bindingName = ctx.spec.wrangler.assets?.binding ?? "ASSETS";
    bindings.push({ type: "assets", name: bindingName });
  }
  // Copy only exact-active verified nonsecret bindings not deliberately authored
  // by this release. Unknown/secret/old-asset preservation was blocked above.
  for (const existing of ctx.snapshot.activeBindings ?? []) {
    if (!bindings.some(binding => binding.name === existing.name)) bindings.push({ ...existing });
  }
  if (new Set(bindings.map(binding => binding.name)).size !== bindings.length) return { ok: false, failure: fail("binding-conflict", "Worker credential/resource/plaintext binding names must not overlap; no code upload performed") };
  // the validated pure new-class migrations ride the atomic version
  // upload as the single migration object the provider accepts (Cloudflare
  // 10021 rejects the wrangler-style array). Only a single validated entry is
  // supported; multi-tag histories are refused with an actionable message
  // instead of a provider 400 (see migrationObjectForUpload).
  const migrationEntries = Array.isArray(ctx.spec.wrangler.migrations)
    ? (ctx.spec.wrangler.migrations as Array<{ tag?: unknown; new_classes?: unknown; new_sqlite_classes?: unknown }>)
    : [];
  const migrationObject = migrationEntries.length === 0 ? { ok: true as const } : migrationObjectForUpload(migrationEntries);
  if (!migrationObject.ok) return { ok: false, failure: fail("validation", (migrationObject as { detail: string }).detail) };
  const metadata: import("../../cloudflare/models/workers.js").VersionMetadata = {
    main_module: mainModuleName,
    ...(ctx.spec.wrangler.compatibility_date
      ? { compatibility_date: ctx.spec.wrangler.compatibility_date }
      : {}),
    ...(ctx.spec.wrangler.compatibility_flags
      ? { compatibility_flags: ctx.spec.wrangler.compatibility_flags }
      : {}),
    ...(bindings.length > 0 ? { bindings } : {}),
    ...("migration" in migrationObject && migrationObject.migration ? { migrations: migrationObject.migration } : {}),
    annotations: { "workers/message": versionMessage(ctx.spec) },
  };
  if (hasAssets) {
    const assetJwt = args.assetJwt;
    if (typeof assetJwt !== "string" || assetJwt.length === 0) {
      return { ok: false, failure: fail("invalid-args", "create-version requires assetJwt for an assets release") };
    }
    const config: { html_handling?: string; not_found_handling?: string; run_worker_first?: boolean | string[] } = {};
    const wranglerAssets = ctx.spec.wrangler.assets;
    if (typeof wranglerAssets?.html_handling === "string") {
      config.html_handling = wranglerAssets.html_handling;
    }
    if (typeof wranglerAssets?.not_found_handling === "string") {
      config.not_found_handling = wranglerAssets.not_found_handling;
    }
    if (wranglerAssets?.run_worker_first !== undefined) config.run_worker_first = wranglerAssets.run_worker_first;
    metadata.assets = {
      jwt: assetJwt,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  }
  return { ok: true, value: metadata };
}

function deploymentVersionIds(versions: { version_id?: string; id?: string }[] | undefined): string[] {
  return (versions ?? []).map((v) => v.version_id ?? v.id ?? "").filter((s) => s.length > 0);
}

function exclusivelyActive(versions: { version_id?: string; id?: string; percentage?: number }[] | undefined, expected: string): boolean {
  return versions?.length === 1 && (versions[0]?.version_id ?? versions[0]?.id) === expected && versions[0]?.percentage === 100;
}

async function activate(
  ctx: DeployStepContext,
  args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  const versionId = args.versionId;
  if (typeof versionId !== "string" || versionId.length === 0) {
    return fail("invalid-args", "activate requires versionId");
  }
  try {
    const [versions, deployments] = await Promise.all([
      ctx.client.listVersions(ctx.workerName),
      ctx.client.listDeployments(ctx.workerName),
    ]);
    if (!versions.some((v) => v.id === versionId)) {
      return fail("wrong-version", `version ${versionId} is not a known uploaded version`);
    }
    const active = deployments[0];
    const activeTargets = exclusivelyActive(active?.versions, versionId);
    if (active && activeTargets) {
      // Duplicate execute is safe: the confirmed target is already live.
      return ok({ alreadyActive: true, deploymentId: active.id });
    }
    if (active?.id !== ctx.snapshot.activeDeploymentId) {
      return fail("wrong-version", "active deployment changed after the verified snapshot; refusing cutover");
    }
    const deployment = await ctx.client.createDeployment(ctx.workerName, {
      strategy: "percentage",
      versions: [{ version_id: versionId, percentage: 100 }],
      annotations: { "workers/message": versionMessage(ctx.spec) },
    });
    return ok({ alreadyActive: false, deploymentId: deployment.id });
  } catch (error) {
    return toStepFailure(error);
  }
}

async function reconcileSchedules(
  ctx: DeployStepContext,
  _args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  // The resolved spec.cloudflare.cron is the authoritative target (manifest
  // cloudflare.cron winding up to the wrangler triggers.crons fallback). The
  // server re-plans on every step, so it owns the value rather than trusting
  // the browser argument, which would drop wrangler-declared schedules.
  const target = ctx.spec.cloudflare.cron ?? [];
  try {
    const current = (await ctx.client.getSchedules(ctx.workerName)).crons ?? [];
    // A release that declares no schedules must never clear existing ones.
    if (target.length === 0) {
      return ok({ unchanged: true, crons: current });
    }
    if (cronsEqual(current, target)) {
      return ok({ unchanged: true, crons: target });
    }
    await ctx.beforeMutation?.();
    const result = await ctx.client.updateSchedules(ctx.workerName, target);
    return ok({ unchanged: false, crons: result.crons ?? target });
  } catch (error) {
    return toStepFailure(error);
  }
}

export interface PublishWorkersDevResult {
  published: boolean;
  skipped?: boolean;
  // "no-account-subdomain": the account has no `<name>.workers.dev` yet.
  reason?: "no-account-subdomain";
  // Built only from provider-read values after the flag was read back as enabled.
  url?: string;
}

// Enable the Worker on workers.dev when the operator asked for it. Nothing is
// guessed: the address is built from the account subdomain the provider returns
// and only after the Worker's own flag reads back as enabled. The Worker's
// preview-URL flag is preserved as found.
async function publishWorkersDev(
  ctx: DeployStepContext,
  args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  if (args.publish !== true) {
    return ok({ published: false, skipped: true } satisfies PublishWorkersDevResult);
  }
  try {
    let subdomain: string | undefined;
    try {
      subdomain = await ctx.client.getAccountSubdomain();
    } catch (error) {
      if ((error as { kind?: string }).kind !== "not-found") throw error;
    }
    if (!subdomain) {
      return ok({ published: false, reason: "no-account-subdomain" } satisfies PublishWorkersDevResult);
    }
    const current = await ctx.client.getScriptSubdomain(ctx.workerName);
    if (!current.enabled) {
      await ctx.beforeMutation?.();
      await ctx.client.setScriptSubdomain(ctx.workerName, { enabled: true, previews_enabled: current.previews_enabled });
    }
    if (!(await ctx.client.getScriptSubdomain(ctx.workerName)).enabled) {
      return fail("validation", "workers.dev was not enabled for the Worker; check it in the Cloudflare dashboard");
    }
    const label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ctx.workerName) ? ctx.workerName : undefined;
    return ok({ published: true, ...(label ? { url: `https://${label}.${subdomain}.workers.dev` } : {}) } satisfies PublishWorkersDevResult);
  } catch (error) {
    return toStepFailure(error);
  }
}

async function postcheck(
  ctx: DeployStepContext,
  args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  const expectedVersionId = args.expectedVersionId;
  if (typeof expectedVersionId !== "string") {
    return fail("invalid-args", "postcheck requires expectedVersionId");
  }
  try {
    const [deployments, versions] = await Promise.all([
      ctx.client.listDeployments(ctx.workerName),
      ctx.client.listVersions(ctx.workerName),
    ]);
    const active = deployments[0];
    const activeVersionIds = deploymentVersionIds(active?.versions);
    const deployed = exclusivelyActive(active?.versions, expectedVersionId);
    // A non-deployed target is a factual report to the browser, not a hidden
    // failure: the browser surfaces it as a failed cutover. The installer must
    // never silently treat a wrong live version as success.
    // The cutover alone does not prove the resulting bindings: the fresh
    // snapshot's deployed bindings must resolve to the approved identities.
    const bindings = verifyDeployedBindings(ctx.spec, ctx.snapshot);
    return ok({
      deployed,
      activeDeploymentId: active?.id,
      latestVersionId: versions[0]?.id,
      activeVersionIds,
      bindingsVerified: bindings.ok,
      bindingMismatches: bindings.mismatches,
    });
  } catch (error) {
    return toStepFailure(error);
  }
}

function cronsEqual(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
