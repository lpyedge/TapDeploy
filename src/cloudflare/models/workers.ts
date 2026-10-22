// Worker script, version, deployment, asset-session, secret and schedule shapes
// returned/consumed by the Cloudflare v4 management API. These are the fields
// the Installer reads or sends; trailering fields are ignored by the client.
// the version-upload module set, its wire bounds and the single validated
// encoder live here so multipart, inherited-JSON and step adapters share one form.

export interface WorkerScriptMeta {
  id: string;
  created_on: string;
  modified_on: string;
  etag?: string;
  workers_dev?: boolean;
  compatibility_date?: string;
}

export interface WorkerVersionMeta {
  id: string;
  number?: number;
  created_on?: string;
  modified_on?: string;
  deployment_id?: string;
  message?: string;
  resources?: Record<string, unknown>;
  metadata?: {
    author_email?: string;
    author_id?: string;
    created_on?: string;
    modified_on?: string;
    source?: string;
    hasPreview?: boolean;
  };
  annotations?: Record<string, string>;
}

export interface WorkerDeploymentVersion {
  version_id: string;
  percentage?: number;
  // Deprecated mirror of version_id for older callers (steps/snapshot).
  // New code must use version_id.
  id?: string;
}

export interface WorkerDeployment {
  id: string;
  script_id: string;
  author_id: string;
  created_on?: string;
  modified_on?: string;
  source?: string;
  strategy?: string;
  versions: WorkerDeploymentVersion[];
  annotations?: Record<string, string>;
}

export interface WorkerSecretMetadata {
  name: string;
  type: "secret_text";
}

export interface WorkerScheduleMetadata {
  crons: string[];
}

// workers.dev publication state of one Worker (`previews_enabled` covers the
// per-version preview URLs, which the installer never changes).
export interface WorkerSubdomainState {
  enabled: boolean;
  previews_enabled: boolean;
}

export interface WorkerScheduleListResult {
  schedules: { cron: string; created_on?: string; modified_on?: string }[];
}

export interface WorkerSettings {
  bindings?: { name?: string; type?: string }[] & Array<Record<string, unknown>>;
  compatibility_date?: string;
  compatibility_flags?: string[];
  annotations?: Record<string, string>;
}

export interface AssetManifestEntry {
  hash: string;
  size: number;
}

export interface AssetSessionRequest {
  manifest: Record<string, AssetManifestEntry>;
}

export interface AssetSessionResult {
  jwt: string;
  buckets: string[][];
}

export interface WorkerAssetsUploadResult {
  jwt?: string;
}

export interface VersionMetadata {
  main_module: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  bindings?: Array<Record<string, unknown>>;
  // the provider applies exactly one migration object per version upload
  // (Cloudflare 10021 rejects an array). The planner only ever approves pure
  // new-class additions; the step folds a single validated entry into
  // `{ new_tag, new_classes?, new_sqlite_classes? }` and refuses multi-tag
  // histories outright (no silent misorder, no invented old_tag). The step
  // never claims a migration applied, only that the declaring version was
  // created and read back.
  migrations?: {
    old_tag?: string;
    new_tag: string;
    new_classes?: string[];
    new_sqlite_classes?: string[];
    renamed_classes?: Array<{ from: string; to: string }>;
    deleted_classes?: string[];
  };
  assets?: {
    jwt?: string;
    config?: {
      html_handling?: string;
      not_found_handling?: string;
      run_worker_first?: boolean | string[];
    };
  };
  keep_assets?: boolean;
  annotations?: Record<string, string>;
}

// official provider version-metadata binding shapes for carrier features
// projected from the final Wrangler config. These are type aliases (not
// interfaces) so they flow into VersionMetadata.bindings without casts; the
// builders in src/core/deploy/bindings.ts produce exactly these objects and
// refuse anything less specific (durable-object namespaces are not modeled —
// they hard-fail before any provider write).
export type WorkflowBindingMetadata = {
  name: string;
  type: "workflow";
  workflow_name: string;
  class_name: string;
  script_name?: string;
};

export type ServiceBindingMetadata = {
  name: string;
  type: "service";
  service: string;
  environment?: string;
  entrypoint?: string;
  props?: Record<string, unknown>;
};

export interface VersionModuleRef {
  name: string;
  content: Uint8Array | string;
  contentType: string;
}

export interface VersionCreateRequest {
  metadata: VersionMetadata;
  mainModule: VersionModuleRef;
  // additional verified modules (chunks / Wasm). Each becomes its own
  // multipart part (or inherited-JSON module) with a canonical name; the whole
  // set is validated and encoded by the shared bounded encoder below, never
  // rebuilt per call site.
  additionalModules?: VersionModuleRef[];
}

// bounded version-upload transport. The deploy-step API accepts one
// bounded 8 MiB JSON body (src/api/body-limit.ts default) and module bytes
// travel through that body base64-inflated (4/3), so one upload's module budget
// is derived from the body budget minus a bounded JSON-envelope headroom. Every
// encoder (multipart PUT create, multipart POST version, inherited JSON create,
// step adapter) refuses oversize sets explicitly before any provider call;
// verified bounded chunking is a later option, never a silent retry.
const WORKER_UPLOAD_BODY_BUDGET_BYTES = 8 * 1024 * 1024;
const WORKER_UPLOAD_ENVELOPE_HEADROOM_BYTES = 64 * 1024;
/** Base64-encoded module budget that always fits inside the deploy-step body. */
export const WORKER_UPLOAD_MAX_ENCODED_BYTES =
  WORKER_UPLOAD_BODY_BUDGET_BYTES - WORKER_UPLOAD_ENVELOPE_HEADROOM_BYTES;
/** Decoded bytes whose base64 form fits the encoded budget. */
export const WORKER_UPLOAD_MAX_TOTAL_BYTES = (WORKER_UPLOAD_MAX_ENCODED_BYTES / 4) * 3;
/** Bounded module list; per-entry JSON overhead stays inside the envelope headroom. */
export const WORKER_UPLOAD_MAX_MODULES = 128;
const WORKER_UPLOAD_MAX_NAME_LENGTH = 256;

export interface VersionUploadPart {
  name: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface VersionModulePartsResult {
  ok: boolean;
  parts: VersionUploadPart[];
  errors: string[];
}

// Wire MIME for one module part. Mirrors src/release/deploy-bundle.ts
// JS_MODULE_MIME/WASM_MODULE_MIME; the unit suite cross-checks equality.
function moduleContentTypeFor(name: string): string | undefined {
  const slash = name.lastIndexOf("/");
  const dot = name.lastIndexOf(".");
  const extension = dot > slash ? name.slice(dot).toLowerCase() : "";
  if (extension === ".wasm") return "application/wasm";
  if (extension === ".js" || extension === ".mjs") return "application/javascript+module";
  return undefined;
}

// module part names are the wire identity (the provider matches
// metadata.main_module against a part name), so only canonical portable ASCII
// ZIP-relative paths are accepted: no absolute/backslash/traversal names, no
// empty or dot path segments, no control characters. Names come from the
// approved bundle or the single-module entry; anything else fails closed
// instead of uploading an unverified client filename.
function moduleNameProblem(name: string): string | undefined {
  if (name.length === 0) return "module name is empty";
  if (name.length > WORKER_UPLOAD_MAX_NAME_LENGTH) {
    return `module name exceeds ${WORKER_UPLOAD_MAX_NAME_LENGTH} characters`;
  }
  if (name.startsWith("/")) return "module name must be ZIP-relative";
  if (name.includes("\\")) return "module name must not contain a backslash";
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) return "module name must be printable ASCII without spaces";
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return "module name must not contain empty or dot path segments";
  }
  return undefined;
}

// the single validated encoder for a version's module set. It checks the
// metadata binding, canonical unique names, supported ESM/Wasm types, exact
// declared content types, binary-only Wasm (never text-encoded) and the bounded
// size budget, then returns the raw byte parts every upload path appends.
export function encodeVersionModuleParts(req: VersionCreateRequest): VersionModulePartsResult {
  const errors: string[] = [];
  const metadata = req.metadata;
  if (!metadata || typeof metadata.main_module !== "string" || metadata.main_module.length === 0) {
    return { ok: false, parts: [], errors: ["version metadata.main_module is required"] };
  }
  const main = req.mainModule;
  if (!main || typeof main.name !== "string" || main.name.length === 0) {
    return { ok: false, parts: [], errors: ["version main module is required"] };
  }
  if (main.name !== metadata.main_module) {
    return { ok: false, parts: [], errors: ["version main module name must match metadata.main_module"] };
  }
  const refs = [main, ...(req.additionalModules ?? [])];
  if (refs.length > WORKER_UPLOAD_MAX_MODULES) {
    return {
      ok: false,
      parts: [],
      errors: [`module count ${refs.length} exceeds the bounded ${WORKER_UPLOAD_MAX_MODULES}-module upload limit`],
    };
  }
  const parts: VersionUploadPart[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const ref of refs) {
    const name = typeof ref?.name === "string" ? ref.name : "";
    const problem = moduleNameProblem(name);
    if (problem) {
      errors.push(`${problem} ("${name}")`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`DUPLICATE_MODULE: "${name}" appears more than once`);
      continue;
    }
    seen.add(name);
    const mime = moduleContentTypeFor(name);
    if (!mime) {
      errors.push(`UNSUPPORTED_MODULE_TYPE: "${name}" is not an ESM (.js/.mjs) or Wasm (.wasm) module`);
      continue;
    }
    if (typeof ref.contentType === "string" && ref.contentType.length > 0 && ref.contentType !== mime) {
      errors.push(`CONTENT_TYPE_MISMATCH: "${name}" declares "${ref.contentType}" but must be uploaded as "${mime}"`);
      continue;
    }
    let bytes: Uint8Array<ArrayBuffer>;
    if (typeof ref.content === "string") {
      if (mime === "application/wasm") {
        errors.push(`WASM_NOT_BINARY: "${name}" must be provided as binary bytes, never text`);
        continue;
      }
      bytes = new TextEncoder().encode(ref.content);
    } else if (ref.content instanceof Uint8Array) {
      // Blob and digest APIs require the ArrayBuffer-backed view type; the
      // request contract carries concrete module bytes, never a shared view.
      bytes = ref.content as Uint8Array<ArrayBuffer>;
    } else {
      errors.push(`MODULE_CONTENT_MISSING: "${name}" has no byte content`);
      continue;
    }
    totalBytes += bytes.length;
    parts.push({ name, mime, bytes });
  }
  if (errors.length > 0) return { ok: false, parts: [], errors };
  if (totalBytes > WORKER_UPLOAD_MAX_TOTAL_BYTES) {
    return {
      ok: false,
      parts: [],
      errors: [
        `module payload of ${totalBytes} bytes exceeds the bounded ${WORKER_UPLOAD_MAX_TOTAL_BYTES}-byte upload budget; base64 expansion must stay inside the 8 MiB deploy-step body`,
      ],
    };
  }
  return { ok: true, parts, errors: [] };
}

export interface DeploymentCreateRequest {
  strategy: "percentage";
  versions: { version_id: string; percentage: number }[];
  annotations?: Record<string, string>;
}
