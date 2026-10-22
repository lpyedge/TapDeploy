// Pages direct-upload deploy steps.
//
// A Pages deployment is a distinct path from the Workers scripts/versions/
// deployments API. It:
//   1. ensures the Pages project exists (create on a fresh install; preserve an
//      operator-selected existing project on upgrade),
//   2. resolves the project's short-lived upload JWT so the BROWSER can upload
//      the static assets (the OAuth token never reaches the browser),
//   3. creates the deployment via `POST .../deployments` as multipart/form-data
//      whose `manifest` part maps URL-rooted paths to 32-hex upload hashes (and
//      optionally a `_worker.bundle` part for a prebuilt `_worker.js`),
//   4. post-checks the deployment actually reached a terminal success stage.
//
// The server owns the OAuth-token requests (project ensure + deployment create);
// the browser owns the JWT-scoped asset uploads. No Workers script/version route
// is ever used for a Pages target. Cron schedules and Workers rate-limit
// bindings are REJECTED before mutation for a Pages target — they are not
// supported via the Pages deployment config and must never be silently ported.
// deployment control files are never static assets — `_worker.js` is bound
// to the approved release and rides the `_worker.bundle` part; `_redirects` /
// `_headers` / `_routes.json` / `functions/` are not carried by this release and
// fail closed (manifest + approved-asset guards) instead of being silently
// hashed into the asset manifest.

import type { CloudflareApiClient } from "../../cloudflare/client/index.js";
import type {
  PagesProject,
  PagesDeploymentConfig,
} from "../../cloudflare/models/index.js";
import { canonicalJson } from "../planning/digest.js";
import { PAGES_MAX_ASSET_COUNT, PAGES_UPLOAD_HASH_RE, toPagesAssetPath } from "../../cloudflare/pages/index.js";
import { pagesControlFileAtRoot } from "../../cloudflare/pages/manifest.js";
import type { DeploySpec } from "../deploy-spec.js";
import type { TargetSnapshot } from "../planning/types.js";
import { stepOk as ok, stepFail as fail, toStepFailure, type DeployStepOutcome } from "./bindings.js";
import { resolveSecretActions } from "./secrets.js";
import { randomBase64Url } from "../../auth/crypto.js";
import { PAGES_PROJECT_MARKER } from "../planning/pages-identity.js";

// The Pages deployment create requires the manifest + optional prebuilt worker
// bundle. The browser computes the manifest from byte contents because the
// Pages upload hash is BLAKE3(base64(contents)+extension) which needs the bytes
// (the installer server never holds the asset bytes). This validates that the
// browser-supplied manifest is well-formed and bounded before any write. A
// deployment control file (`_worker.js`, `_redirects`, `_headers`,
// `_routes.json`, `functions/`) is never a static asset — `_worker.js` rides the
// `_worker.bundle` part and the remaining control files are not carried by this
// release, so declaring one in the manifest fails closed.
function validatePagesManifest(
  manifest: unknown,
  allowEmpty = false,
): { ok: true; value: Record<string, string> } | { ok: false; detail: string } {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { ok: false, detail: "Pages manifest must be an object of root path -> 32-hex hash" };
  }
  const entryCount = Object.keys(manifest as Record<string, unknown>).length;
  if (entryCount === 0 && !allowEmpty) {
    return { ok: false, detail: "Pages manifest is empty" };
  }
  if (entryCount > PAGES_MAX_ASSET_COUNT) {
    return { ok: false, detail: `Pages manifest exceeds ${PAGES_MAX_ASSET_COUNT} files` };
  }
  const out: Record<string, string> = {};
  for (const [path, hash] of Object.entries(manifest as Record<string, string>)) {
    if (typeof hash !== "string" || !PAGES_UPLOAD_HASH_RE.test(hash)) {
      return { ok: false, detail: `Pages manifest path "${path}" has an invalid hash` };
    }
    if (!path.startsWith("/")) {
      return { ok: false, detail: `Pages manifest path "${path}" must be root-relative` };
    }
    const control = pagesControlFileAtRoot(path);
    if (control !== undefined) {
      return {
        ok: false,
        detail: `Pages manifest path "${path}" declares the reserved Pages control name "${control}"; control files are never part of the static asset manifest`,
      };
    }
    out[path] = hash;
  }
  return { ok: true, value: out };
}

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// the plan-approved Pages artifact identity. Each approved asset carries
// the publisher-declared 32-hex Pages upload hash (computed from the released
// bytes at manifest derivation time) plus the release content SHA-256/size. The
// browser-supplied deployment manifest must match THIS set exactly.
export interface ApprovedPagesAsset {
  path: string;
  sha256: string;
  size: number;
  pagesHash: string;
}

export type PagesPayloadCheckResult =
  | {
      ok: true;
      manifest: Record<string, string>;
      bundleBytes?: Uint8Array;
    }
  | {
      ok: false;
      kind: "invalid-manifest" | "invalid-args" | "artifact-mismatch";
      detail: string;
    };

// bind the browser-supplied Pages deployment payload to the plan-approved
// release before ANY provider write.
//
// 1. Path binding: the manifest's rooted path set must equal the approved asset
//    set exactly (missing AND extra files fail closed; changed paths fail).
// 2. Hash binding: the Pages upload hash is BLAKE3(base64(contents)+extension),
//    which the installer server cannot recompute without the asset bytes. It is
//    therefore validated against the PUBLISHER-DECLARED 32-hex `pagesHash` that
//    is part of the approved release identity (and the plan digest). An approved
//    asset without a declared `pagesHash` fails closed — the server never treats
//    an arbitrary browser-claimed 32-hex string as proof of approved content.
// 3. Bundle binding: a prebuilt `_worker.js` must be for the approved release —
//    its decoded bytes must match the approved size + SHA-256. A bundle is only
//    accepted when the approved release declares one, and an approved bundle may
//    never be omitted from the deploy request.
export function approvedPagesAssets(
  spec: DeploySpec,
): { ok: true; value: ApprovedPagesAsset[] } | { ok: false; detail: string } {
  const out: ApprovedPagesAsset[] = [];
  const seen = new Set<string>();
  for (const asset of spec.assets) {
    let rooted: string;
    try {
      rooted = toPagesAssetPath(asset.path, spec.wrangler.assets?.directory);
    } catch (error) {
      return {
        ok: false,
        detail: `approved Pages asset "${asset.path}" is not a valid root path: ${String(error)}`,
      };
    }
    const control = pagesControlFileAtRoot(rooted);
    if (control !== undefined) {
      return {
        ok: false,
        detail: `approved Pages asset "${asset.path}" maps to the reserved Pages control path "${rooted}"; control files are never shipped as static assets`,
      };
    }
    if (seen.has(rooted)) {
      return {
        ok: false,
        detail: `approved Pages asset set has duplicate root path "${rooted}"`,
      };
    }
    seen.add(rooted);
    if (typeof asset.pagesHash !== "string" || !PAGES_UPLOAD_HASH_RE.test(asset.pagesHash)) {
      return {
        ok: false,
        detail: `approved Pages asset "${asset.path}" has no publisher-declared 32-hex pagesHash; refusing to accept browser-claimed upload hashes as approved`,
      };
    }
    out.push({ path: rooted, sha256: asset.sha256, size: asset.size, pagesHash: asset.pagesHash });
  }
  return { ok: true, value: out };
}

export async function validatePagesDeploymentPayload(
  spec: DeploySpec,
  args: Record<string, unknown>,
): Promise<PagesPayloadCheckResult> {
  const manifestCheck = validatePagesManifest(
    args.manifest,
    // A `_worker.js`-only release has no static assets, so the manifest is
    // legitimately empty; the exact-set check below still binds it.
    (spec.assets?.length ?? 0) === 0,
  );
  if (!manifestCheck.ok) {
    return { ok: false, kind: "invalid-manifest", detail: manifestCheck.detail };
  }
  const approved = approvedPagesAssets(spec);
  if (!approved.ok) {
    return { ok: false, kind: "invalid-manifest", detail: approved.detail };
  }
  const byPath = new Map<string, ApprovedPagesAsset>();
  for (const asset of approved.value) {
    byPath.set(asset.path, asset);
  }

  // Exact path-set equality: extra or missing asset -> fail before any write.
  const manifest = manifestCheck.value;
  for (const [path, hash] of Object.entries(manifest)) {
    const expected = byPath.get(path);
    if (!expected) {
      return {
        ok: false,
        kind: "invalid-manifest",
        detail: `Pages manifest declares "${path}" which is not part of the approved release asset set`,
      };
    }
    const declared = expected.pagesHash;
    if (hash === declared) {
      continue;
    }
    return {
      ok: false,
      kind: "invalid-manifest",
      detail:
        `Pages manifest hash for "${path}" does not match the approved release (declared ${hash.slice(0, 8)}…, expected ${declared.slice(0, 8)}…)`,
    };
  }
  for (const asset of approved.value) {
    if (manifest[asset.path] === undefined) {
      return {
        ok: false,
        kind: "invalid-manifest",
        detail: `approved Pages asset "${asset.path}" is missing from the deploy manifest`,
      };
    }
  }

  // Bundle binding: exact approved bytes, and only when the release declares one.
  const approvedBundle = spec.workerBundle;
  const workerBundleB64 = args.workerBundleB64;
  if (workerBundleB64 !== undefined) {
    if (!approvedBundle) {
      return {
        ok: false,
        kind: "invalid-args",
        detail: "workerBundleB64 was supplied but the approved release declares no _worker.js bundle",
      };
    }
    if (typeof workerBundleB64 !== "string" || workerBundleB64.length === 0) {
      return {
        ok: false,
        kind: "invalid-args",
        detail: "workerBundleB64 must be a non-empty base64 string",
      };
    }
    let bundleBytes: Uint8Array;
    try {
      bundleBytes = decodeBase64(workerBundleB64);
    } catch (error) {
      return { ok: false, kind: "invalid-args", detail: `workerBundleB64 is not valid base64: ${String(error)}` };
    }
    const [actualSize, actualSha] = await Promise.all([
      Promise.resolve(bundleBytes.length),
      sha256HexBytes(bundleBytes),
    ]);
    if (actualSize !== approvedBundle.size || actualSha !== approvedBundle.sha256) {
      return {
        ok: false,
        kind: "artifact-mismatch",
        detail:
          `bundle bytes do not match the confirmed release artifact (size ${actualSize}/${approvedBundle.size}, sha ${actualSha.slice(0, 8)}…)`,
      };
    }
    return { ok: true, manifest, bundleBytes };
  }
  if (approvedBundle) {
    return {
      ok: false,
      kind: "invalid-args",
      detail: "the approved _worker.js bundle is missing from the deploy request",
    };
  }
  return { ok: true, manifest };
}

// a Pages release must not silently carry Cron schedules or Workers
// rate-limit bindings — neither is supported by the Pages deployment config.
export function rejectUnsupportedPagesResources(
  spec: DeploySpec,
): DeployStepOutcome | undefined {
  if (spec.cloudflare.cron.length > 0) {
    return fail("unsupported-pages-resource", "Cron schedules are not supported for a Pages deployment");
  }
  if (spec.cloudflare.queues.length || spec.cloudflare.hyperdrive.length || spec.cloudflare.vectorize.length || spec.cloudflare.secretsStore.length || spec.cloudflare.runtimeBindings.some(b => b.type === "ai")) {
    return fail("unsupported-pages-resource", "Pages currently supports selected R2/D1/KV and Browser bindings only; other resource configuration is not implemented");
  }
  return undefined;
}

function pagesConfig(spec: DeploySpec, snapshot: TargetSnapshot): PagesDeploymentConfig {
  const out: PagesDeploymentConfig = {
    compatibility_date: spec.wrangler.compatibility_date,
    ...(spec.wrangler.compatibility_flags ? { compatibility_flags: spec.wrangler.compatibility_flags } : {}),
  };
  const vars = { ...spec.wrangler.vars, ...spec.cloudflare.pages?.vars };
  if (Object.hasOwn(vars, PAGES_PROJECT_MARKER) || Object.hasOwn(spec.cloudflare.secrets, PAGES_PROJECT_MARKER)) throw new Error("reserved Pages ownership binding");
  if (Object.keys(vars).length) out.env_vars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { type: "plain_text", value: String(v) }]));
  for (const binding of spec.cloudflare.r2) {
    if (!snapshot.r2Buckets.some(b => b.name === binding.bucketName)) throw new Error("selected Pages R2 identity is unavailable");
    (out.r2_buckets ??= {})[binding.binding] = { name: binding.bucketName };
  }
  for (const binding of spec.cloudflare.d1) {
    const found = snapshot.d1Databases.find(b => b.name === binding.databaseName);
    if (!found) throw new Error("selected Pages D1 identity is unavailable");
    (out.d1_databases ??= {})[binding.binding] = { id: found.id };
  }
  for (const binding of spec.cloudflare.kv) {
    const found = snapshot.kvNamespaces.find(b => b.name === binding.namespaceName);
    if (!found) throw new Error("selected Pages KV identity is unavailable");
    (out.kv_namespaces ??= {})[binding.binding] = { namespace_id: found.id };
  }
  for (const binding of spec.cloudflare.runtimeBindings) {
    if (binding.type === "browser-rendering") (out.browsers ??= {})[binding.binding] = {};
  }
  return out;
}

function configurationMatches(actual: PagesDeploymentConfig | undefined, expected: PagesDeploymentConfig): boolean {
  for (const [field, value] of Object.entries(expected)) {
    if (field !== "env_vars") {
      if (canonicalJson(actual?.[field]) !== canonicalJson(value)) return false;
      continue;
    }
    // Secret values are redacted by the provider. Verify identity/type, never
    // demand their value or expose a generated password in readback failures.
    const vars = value as NonNullable<PagesDeploymentConfig["env_vars"]>;
    if (canonicalJson(Object.keys(actual?.env_vars ?? {}).sort()) !== canonicalJson(Object.keys(vars).sort())) return false;
    for (const [name, variable] of Object.entries(vars)) {
      const read = actual?.env_vars?.[name];
      if (variable.type === "secret_text" ? read?.type !== "secret_text" : canonicalJson(read) !== canonicalJson(variable)) return false;
    }
  }
  return true;
}

// Ensure the Pages project exists. On a fresh install the project is created
// with the resolved name; on an upgrade the operator already selected an
// existing project (the snapshot `pagesProjectExists` is true) so this is a
// preserve no-op. Never deletes or overwrites an unrelated project.
export async function ensurePagesProject(
  client: CloudflareApiClient,
  spec: DeploySpec,
  snapshot: TargetSnapshot,
  args: Record<string, unknown> = {},
): Promise<DeployStepOutcome> {
  const projectName = spec.cloudflare.pages?.projectName;
  if (!projectName) {
    return fail("invalid-args", "Pages release requires a project name");
  }
  const unsupported = rejectUnsupportedPagesResources(spec);
  if (unsupported) return unsupported;
  let approved: PagesDeploymentConfig;
  try { approved = pagesConfig(spec, snapshot); }
  catch { return fail("validation", "selected Pages resource identity is unavailable; no project mutation performed"); }
  try {
    const hasConfig = Object.keys(approved).length > 0;
    const current = snapshot.pagesProjectExists ? await client.getPagesProject(projectName) : undefined;
    const old = current?.deployment_configs?.production ?? {};
    if (current && (current.id !== snapshot.pagesProjectId || current.name !== projectName || old.env_vars?.[PAGES_PROJECT_MARKER]?.type !== "plain_text" || old.env_vars[PAGES_PROJECT_MARKER]!.value !== spec.project.id)) return fail("wrong-project-owner", "Pages project identity/owner changed or automatic adoption was requested; no mutation performed");
    if (!current) (approved.env_vars ??= {})[PAGES_PROJECT_MARKER] = { type: "plain_text", value: spec.project.id };
    const supplied = args.secrets ?? {};
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) return fail("invalid-args", "Pages secrets must be an object");
    for (const name of Object.keys(approved.env_vars ?? {})) {
      if (old.env_vars?.[name]?.type === "secret_text" || Object.hasOwn(spec.cloudflare.secrets, name)) return fail("validation", "Pages plaintext variable conflicts with a protected secret");
    }
    const actions = resolveSecretActions(spec, { ...snapshot, secretNames: Object.entries(old.env_vars ?? {}).filter(([, v]) => v.type === "secret_text").map(([name]) => name) }, supplied as Record<string, unknown>);
    if (actions.some(a => a.action === "fail")) return fail("missing-secret", "a required Pages secret is missing; no project mutation performed");
    for (const action of actions) {
      if (action.action !== "create") continue;
      if (old.env_vars?.[action.name]) return fail("validation", "Pages secret conflicts with an existing nonsecret variable");
      (approved.env_vars ??= {})[action.name] = { type: "secret_text", value: action.policy === "generate-once" ? randomBase64Url(32) : (supplied as Record<string, string>)[action.name]! };
    }
    const configured = hasConfig || actions.some(a => a.action === "create");
    if (snapshot.pagesProjectExists) {
      if (!configured) return ok({ skipped: true, projectName, action: "preserve" });
      const production: PagesDeploymentConfig = {};
      for (const [field, entries] of Object.entries(approved)) {
        // Official PATCH updates individual env-var keys (null deletes); omit
        // preserved secrets altogether rather than resending redacted values.
        production[field] = field === "env_vars" || field === "compatibility_date" || field === "compatibility_flags" ? entries : { ...(old[field] as Record<string, unknown> | undefined), ...(entries as Record<string, unknown>) };
      }
      const expected = { ...old, ...production, env_vars: { ...old.env_vars, ...production.env_vars } };
      if (configurationMatches(old, expected)) return ok({ skipped: true, projectName, action: "preserve", id: current!.id });
      await client.updatePagesProject(projectName, { deployment_configs: { production } });
      const checked = await client.getPagesProject(projectName);
      if (checked.id !== current!.id || checked.name !== projectName || !configurationMatches(checked.deployment_configs?.production, expected)) return fail("validation", "Pages configured identities did not pass readback verification");
      // Preview is omitted from PATCH and verified unchanged, not overwritten.
      if (canonicalJson(checked.deployment_configs?.preview) !== canonicalJson(current!.deployment_configs?.preview)) return fail("validation", "Pages preview configuration changed unexpectedly");
      return ok({ skipped: false, projectName, action: "configure", id: checked.id });
    }
    const pages = spec.cloudflare.pages!;
    // The provider requires an explicit production branch at project create
    // (Cloudflare 8000033). The plan binds the release-declared value or the
    // "main" default; the readback below proves the provider applied it.
    const expectedBranch = pages.productionBranch && pages.productionBranch.length > 0 ? pages.productionBranch : "main";
    const project: PagesProject = await client.createPagesProject({
      name: projectName,
      production_branch: expectedBranch,
      ...(configured ? { deployment_configs: { production: approved, preview: approved } } : {}),
    });
    if (project.production_branch !== expectedBranch) return fail("validation", "Pages production branch was not applied as approved; no further mutation");
    if (configured) {
      const checked = await client.getPagesProject(projectName);
      for (const environment of ["production", "preview"] as const) {
        if (checked.id !== project.id || checked.name !== projectName || !configurationMatches(checked.deployment_configs?.[environment], approved)) return fail("validation", "Pages initial configuration did not pass readback verification");
      }
    }
    return ok({ skipped: false, projectName, action: "create", id: project.id });
  } catch (error) {
    return toStepFailure(error);
  }
}

// Resolve the project's short-lived upload JWT for the browser. This is the only
// server-side step that touches assets; the browser then uploads the static
// files to the account endpoint with this JWT.
export async function startPagesAssetUpload(
  client: CloudflareApiClient,
  spec: DeploySpec,
): Promise<DeployStepOutcome> {
  const unsupported = rejectUnsupportedPagesResources(spec);
  if (unsupported) return unsupported;
  const projectName = spec.cloudflare.pages?.projectName;
  if (!projectName) {
    return fail("invalid-args", "Pages release requires a project name");
  }
  try {
    const { jwt } = await client.getPagesUploadToken(projectName);
    if (!jwt) {
      return fail("invalid-response", "Pages upload token response missing jwt");
    }
    return ok({ jwt } satisfies { jwt: string });
  } catch (error) {
    return toStepFailure(error);
  }
}

// Create the Pages deployment. `args.manifest` is the browser-computed path ->
// 32-hex hash map; `args.workerBundleB64` (optional) is a prebuilt `_worker.js`
// bundle encoded in base64. the payload must correspond to the
// plan-approved release (exact asset set, publisher-declared upload hashes,
// approved bundle bytes) or the step fails BEFORE the provider write.
export async function createPagesDeployment(
  client: CloudflareApiClient,
  spec: DeploySpec,
  args: Record<string, unknown>,
  snapshot?: TargetSnapshot,
): Promise<DeployStepOutcome> {
  const unsupported = rejectUnsupportedPagesResources(spec);
  if (unsupported) return unsupported;
  const projectName = spec.cloudflare.pages?.projectName;
  if (!projectName) {
    return fail("invalid-args", "Pages release requires a project name");
  }
  const check = await validatePagesDeploymentPayload(spec, args);
  if (!check.ok) {
    return fail(check.kind, check.detail);
  }
  // Build the multipart/form-data body with the manifest, and the prebuilt
  // `_worker.js` bundle when the release ships one.
  const form = new FormData();
  form.append("manifest", JSON.stringify(check.manifest));
  if (check.bundleBytes) {
    const bundleArrayBuffer = check.bundleBytes.buffer.slice(
      check.bundleBytes.byteOffset,
      check.bundleBytes.byteOffset + check.bundleBytes.byteLength,
    ) as ArrayBuffer;
    form.append(
      "_worker.bundle",
      new Blob([bundleArrayBuffer], { type: "application/javascript+module" }),
      "_worker.bundle",
    );
  }
  try {
    if (snapshot) {
      const current = await client.getPagesProject(projectName);
      if (current.id !== snapshot.pagesProjectId || current.deployment_configs?.production?.env_vars?.[PAGES_PROJECT_MARKER]?.value !== spec.project.id) return fail("wrong-project-owner", "Pages project identity/owner changed before deployment; no upload performed");
    }
    const deployment = await client.createPagesDeployment(projectName, form);
    return ok({ deploymentId: deployment.id, url: deployment.url });
  } catch (error) {
    return toStepFailure(error);
  }
}

// Post-check that the Pages deployment reached a terminal success stage. The
// installer never silently treats a queued/running/failed deployment as success.
export async function postcheckPagesDeployment(
  client: CloudflareApiClient,
  spec: DeploySpec,
  deploymentId: string,
  snapshot?: TargetSnapshot,
): Promise<DeployStepOutcome> {
  const projectName = spec.cloudflare.pages?.projectName;
  if (!projectName) {
    return fail("invalid-args", "Pages release requires a project name");
  }
  try {
    const deployment = await client.getPagesDeployment(projectName, deploymentId);
    const status = deployment.latest_stage?.status;
    if (deployment.id !== deploymentId || (deployment.project_name && deployment.project_name !== projectName) || deployment.environment !== "production") return fail("validation", "Pages deployment identity/environment did not match the requested production target");
    const succeeded = deployment.latest_stage?.name === "deploy" && status === "success";
    const terminalFailure = ["failure", "failed", "canceled", "cancelled"].includes(status ?? "");
    // The production address (`<subdomain>.pages.dev`) once the deployment is live;
    // the deployment's own hash address otherwise.
    let url = deployment.url ?? null;
    if (snapshot && succeeded) {
      if (deployment.project_id !== snapshot.pagesProjectId || deployment.env_vars?.[PAGES_PROJECT_MARKER]?.value !== spec.project.id) return fail("validation", "Pages deployment does not attest the approved immutable project/owner");
      const current = await client.getPagesProject(projectName);
      if (current.id !== snapshot.pagesProjectId) return fail("validation", "Pages project changed during postcheck");
      if (current.subdomain) url = `https://${current.subdomain}`;
      const desired = pagesConfig(spec, snapshot);
      const actual = current.deployment_configs?.production ?? {};
      const expected = { ...actual, ...desired, env_vars: { ...actual.env_vars, ...desired.env_vars } };
      if (!configurationMatches(actual, expected)) return fail("validation", "Pages approved resource/runtime configuration differs from readback");
      for (const [name, value] of Object.entries(desired.env_vars ?? {})) {
        if (canonicalJson(deployment.env_vars?.[name]) !== canonicalJson(value)) return fail("validation", "Pages deployment variables differ from the approved configuration");
      }
      for (const name of Object.keys(spec.cloudflare.secrets)) {
        if (actual.env_vars?.[name]?.type !== "secret_text" || deployment.env_vars?.[name]?.type !== "secret_text") return fail("validation", "Pages required secret was not attested in the deployment");
      }
    }
    return ok({
      deploymentId,
      succeeded,
      pending: !succeeded && !terminalFailure,
      status: status ?? null,
      url,
    });
  } catch (error) {
    return toStepFailure(error);
  }
}
