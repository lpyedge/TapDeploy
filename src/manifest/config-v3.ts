// TapDeploy v3 standalone project configuration contract (prebuilt ZIP flow).
//
// The release ZIP's final `wrangler.jsonc` is the deployment source of truth;
// this config is intentionally minimal. It declares the app identity, the two
// allowed ZIP sources (HTTPS URL / local ZIP), the pre-authorized symbolic
// `capabilities` (mapped to the code-owned scope registry — never raw OAuth
// scope IDs) and opt-in advanced clauses (`inputs` / `units` / `install`).
//
// It is portable across Workers and Node (the JSON schema is a static import,
// never read via node:fs). No scripts, hooks, commands, raw OAuth scopes or
// arbitrary API endpoints can be expressed: the schema is
// `additionalProperties:false` everywhere and a code-owned semantic guard
// (defence in depth) rejects smuggled shapes. `schemaVersion` is the constant 3;
// no older config shape is accepted.

import validateSchema from "./config-v3-validator.generated.js";
import { isPrivateHost } from "../release/url.js";
import type { ScopeCapability } from "../auth/scope-registry.js";

// ---------------------------------------------------------------------------
// Constants / capability registry
// ---------------------------------------------------------------------------

/** Default unit id for the implicit single-Wrangler layout (no `units[]`). */
export const DEFAULT_V3_UNIT_ID = "main" as const;

// Bounded parse limits for config text (size and JSON nesting depth).
export const CONFIG_V3_MAX_BYTES = 64 * 1024;
const CONFIG_V3_MAX_DEPTH = 16;

/**
 * Symbolic capability IDs an author may pre-declare. These are the TapDeploy
 * capability vocabulary — NOT raw OAuth scopes (AC-style rule: the config can
 * never author a scope request). The scope planner derives the actual scope bundle from the
 * code-owned scope registry using the mapping below.
 */
export const V3_CAPABILITIES = [
  "workers",
  "pages",
  "r2",
  "d1",
  "kv",
  "queues",
  "hyperdrive",
  "vectorize",
  "secrets-store",
  "workers-ai",
  "browser-rendering",
  "routes",
  "dns",
  "zone",
  "workflows",
  "durable-objects",
] as const;

export type V3Capability = (typeof V3_CAPABILITIES)[number];

export interface V3CapabilityMeta {
  /** Underlying registry capabilities (src/auth/scope-registry.ts) this symbol needs. */
  scopeCapabilities: ScopeCapability[];
  note: string;
}

/**
 * Capability -> registry mapping. `workflows` and `durable-objects` deploy
 * inside the unit's Worker script (Workflow/DO classes and migrations are
 * Worker version metadata), so they require the same `workers-scripts.admin`
 * capability as `workers`; the registry has no separate OAuth row for them.
 */
export const V3_CAPABILITY_META: Record<V3Capability, V3CapabilityMeta> = {
  workers: { scopeCapabilities: ["worker-admin"], note: "Deploy/upgrade the unit's Worker script (Workers Scripts Admin)." },
  pages: { scopeCapabilities: ["page-write"], note: "List/create a Pages project and deploy direct uploads." },
  r2: { scopeCapabilities: ["r2-write"], note: "List/create R2 buckets." },
  d1: { scopeCapabilities: ["d1-write"], note: "List/create D1 databases." },
  kv: { scopeCapabilities: ["kv-write"], note: "List/create KV namespaces." },
  queues: { scopeCapabilities: ["queues-write"], note: "List/create Queues and manage consumers." },
  hyperdrive: { scopeCapabilities: ["hyperdrive-write"], note: "List the account's Hyperdrive configs (never created: they hold the user's own database credentials)." },
  vectorize: { scopeCapabilities: ["vectorize-write"], note: "List/create Vectorize indexes." },
  "secrets-store": { scopeCapabilities: ["secrets-store-write"], note: "List Secrets Stores and their secret names (never created)." },
  "workers-ai": { scopeCapabilities: ["ai-write"], note: "Account-level Workers AI management (a runtime binding alone needs nothing)." },
  "browser-rendering": { scopeCapabilities: ["browser-rendering-write"], note: "Account-level Browser Rendering management (a runtime binding alone needs nothing)." },
  routes: { scopeCapabilities: ["workers-routes-write"], note: "Zone-scoped Workers routes." },
  dns: { scopeCapabilities: ["dns-write"], note: "DNS records for zone-scoped domains." },
  zone: { scopeCapabilities: ["zone-read"], note: "Enumerate zones so a zone can be selected (DNS Write does not imply Zone Read)." },
  workflows: { scopeCapabilities: ["worker-admin"], note: "Workflow carrier runs as a Worker script; no separate OAuth scope exists." },
  "durable-objects": { scopeCapabilities: ["worker-admin"], note: "DO classes/migrations ship in the Worker version; no separate OAuth scope exists." },
};

/** Versioned install profiles. Unknown kinds are rejected prewrite (strict enum). */
export const INSTALL_POLICY_KINDS = ["private-r2-owner-bootstrap/v1"] as const;
export type InstallPolicyKind = (typeof INSTALL_POLICY_KINDS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfigV3Source {
  defaultUrl?: string;
  /** Defaults to true when omitted (canonicalized for the deterministic ID). */
  allowLocalZip?: boolean;
  expectedSha256?: string;
}

type ConfigV3InputType =
  | "string"
  | "text"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "secret"
  | "select"
  | "multiselect";

/** A choice of a `select` / `multiselect`: a plain value, or a value with its own label. */
type ConfigV3InputOption = string | number | { label: string; value: string | number | boolean };

export interface ConfigV3Input {
  /** Also the name of the Worker variable (or secret) the value is bound to. */
  key: string;
  type: ConfigV3InputType;
  label: string;
  description?: string;
  placeholder?: string;
  /** Must be filled at install. Default true. On upgrade an empty value always keeps what is deployed. */
  required?: boolean;
  /** Not asked again on upgrade: the deployed value stays. Default false. */
  upgradeKeep?: boolean;
  /** Secret only: TapDeploy generates a random value once and the user never enters it. Default false. */
  generate?: boolean;
  options?: ConfigV3InputOption[];
  validation?: {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    values?: Array<string | number>;
  };
}

type ConfigV3ResourceKind = "r2" | "kv" | "d1" | "queue" | "vectorize";

/** An account resource the app uses, created before any Worker or Pages site is deployed. */
interface ConfigV3Resource {
  kind: ConfigV3ResourceKind;
  name: string;
  /** Create it when missing. Default true; false requires it to exist already. */
  create?: boolean;
  /** Upgrade keeps the Worker bound to what it uses today. Default true; false lets the user bind another one. */
  upgradeKeep?: boolean;
  // Vectorize only: the index configuration used when the index is created.
  dimensions?: number;
  metric?: "cosine" | "euclidean" | "dot-product";
}

interface ConfigV3Unit {
  id: string;
  kind: "worker" | "pages";
  /** ZIP-relative path to the unit's final wrangler.jsonc. */
  wrangler: string;
  dependsOn?: string[];
}

export interface ConfigV3InstallPolicy {
  kind: InstallPolicyKind;
  unitId: string;
  r2Binding: string;
  rootSecret: string;
  armSecret: string;
  /** Fixed non-sensitive state marker; written by the guarded built-in profile only. */
  armValue: "yes";
  ownerKey: string;
  markerKey: string;
  initialPasswordKey: string;
  readinessPath?: string;
}

interface ConfigV3Install {
  policies: ConfigV3InstallPolicy[];
}

export interface ConfigV3 {
  schemaVersion: 3;
  app: { id: string; name: string; description?: string };
  source: ConfigV3Source;
  capabilities: V3Capability[];
  inputs?: ConfigV3Input[];
  units?: ConfigV3Unit[];
  resources?: ConfigV3Resource[];
  install?: ConfigV3Install;
}

// ---------------------------------------------------------------------------
// Planner view of the units
// ---------------------------------------------------------------------------

/** Id of the planner unit that holds the config's `resources`; no declared unit may use it. */
const RESOURCES_UNIT_ID = "resources" as const;

interface PlannedResource {
  kind: ConfigV3ResourceKind;
  name: string;
  mode: "ensure" | "bind-existing";
  dimensions?: number;
  metric?: "cosine" | "euclidean" | "dot-product";
  upgradeKeep: boolean;
}

/** A unit as the planner sees it: a Worker or Pages site, or the one resource-only unit. */
export interface PlannedUnit {
  id: string;
  kind: "worker" | "pages" | "resources";
  wrangler?: string;
  resources?: PlannedResource[];
  dependsOn?: string[];
}

/**
 * The units the planner works with, or undefined for the implicit single unit
 * (no `units`, no `resources`). The config's `resources` become one resource-only
 * unit; a Worker that binds one of them is ordered after it by the planner, so
 * no dependency has to be declared. `resources` without `units` means one Worker
 * at the ZIP root; an empty `units` list means the release only provisions resources.
 */
export function plannedUnits(config: Pick<ConfigV3, "units" | "resources">): PlannedUnit[] | undefined {
  const resources = config.resources ?? [];
  if (config.units === undefined && resources.length === 0) return undefined;
  const declared: PlannedUnit[] = (config.units ?? [{ id: DEFAULT_V3_UNIT_ID, kind: "worker", wrangler: "wrangler.jsonc" }]).map((unit) => ({ ...unit }));
  if (resources.length === 0) return declared;
  const resourceUnit: PlannedUnit = {
    id: RESOURCES_UNIT_ID,
    kind: "resources",
    resources: resources.map((resource) => ({
      kind: resource.kind,
      name: resource.name,
      mode: resource.create === false ? "bind-existing" : "ensure",
      ...(resource.dimensions !== undefined ? { dimensions: resource.dimensions } : {}),
      ...(resource.metric !== undefined ? { metric: resource.metric } : {}),
      upgradeKeep: resource.upgradeKeep !== false,
    })),
  };
  return [resourceUnit, ...declared];
}

// ---------------------------------------------------------------------------
// Custom domains for HTTP services
// ---------------------------------------------------------------------------

/**
 * Capabilities every config with an HTTP service (a Worker or Pages unit)
 * implies: the operator may bind their own domain to that service, which needs
 * the zone list (`zone`) and DNS record management (`dns`). They are added to
 * the declared set automatically; a config never has to list them.
 */
const HTTP_DOMAIN_CAPABILITIES = ["zone", "dns"] as const satisfies readonly V3Capability[];

/** True when the config deploys at least one HTTP-reachable unit (Worker or Pages). */
export function configHasHttpUnits(config: Pick<ConfigV3, "units" | "capabilities">): boolean {
  if (config.units) return config.units.length > 0;
  return config.capabilities.includes("workers") || config.capabilities.includes("pages");
}

/** The declared capabilities plus the custom-domain capabilities an HTTP service implies; sorted, unique. */
export function effectiveCapabilities(config: Pick<ConfigV3, "units" | "capabilities">): V3Capability[] {
  const all = new Set<V3Capability>(config.capabilities);
  if (configHasHttpUnits(config)) for (const capability of HTTP_DOMAIN_CAPABILITIES) all.add(capability);
  return [...all].sort();
}

// ---------------------------------------------------------------------------
// Bounded parse (size + depth)
// ---------------------------------------------------------------------------

export interface ConfigV3ParseIssue {
  field: string;
  message: string;
}

function byteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  // Fallback for non-Web runtimes.
  return Buffer.byteLength(text, "utf8");
}

function measureDepth(value: unknown): number {
  let max = 0;
  const pending = [{ value, depth: 1 }];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.value === null || typeof node.value !== "object") continue;
    max = Math.max(max, node.depth);
    if (max > CONFIG_V3_MAX_DEPTH) return max;
    for (const child of Object.values(node.value as Record<string, unknown>)) {
      pending.push({ value: child, depth: node.depth + 1 });
    }
  }
  return max;
}

/**
 * Parse v3 config text with explicit size + depth bounds. This is the only
 * accepted way to turn user config text into an object; it fails closed on
 * size/depth overrun. Schema validation and semantic checks happen afterwards
 * via `validateConfigV3Entry`.
 */
export function parseConfigV3Text(
  text: string,
): { ok: true; value: unknown } | { ok: false; issue: ConfigV3ParseIssue } {
  if (typeof text !== "string") {
    return { ok: false, issue: { field: "$", message: "config must be text" } };
  }
  const bytes = byteLength(text);
  if (bytes > CONFIG_V3_MAX_BYTES) {
    return {
      ok: false,
      issue: {
        field: "$",
        message: `config is ${(bytes / 1024).toFixed(1)} KiB; the limit is ${CONFIG_V3_MAX_BYTES / 1024} KiB`,
      },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, issue: { field: "$", message: `invalid JSON: ${(e as Error).message}` } };
  }
  const depth = measureDepth(value);
  if (depth > CONFIG_V3_MAX_DEPTH) {
    return {
      ok: false,
      issue: { field: "$", message: `config nesting too deep (${depth} > ${CONFIG_V3_MAX_DEPTH})` },
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Schema validator
// ---------------------------------------------------------------------------

interface ConfigV3ValidationError {
  instancePath: string;
  message: string;
}

export function validateConfigV3(
  input: unknown,
): { ok: true; config: ConfigV3 } | { ok: false; errors: ConfigV3ValidationError[] } {
  // Precompiled from the JSON Schema (scripts/generate-config-validator.mjs):
  // the Workers runtime forbids compiling a schema at runtime.
  if (validateSchema(input)) {
    return { ok: true, config: input as ConfigV3 };
  }
  const errors = (validateSchema.errors ?? []).map((e) => ({
    instancePath: e.instancePath || "/",
    message: e.message ?? "invalid",
  }));
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Semantic safety guard (defence in depth beyond schema additionalProperties)
// ---------------------------------------------------------------------------

interface ConfigV3SafetyIssue {
  field: string;
  detail: string;
}

// Keys that must never appear anywhere: executable hooks, raw OAuth scopes,
// arbitrary endpoints/proxies and free-form control-flow bags.
const DENY_KEYS = new Set([
  "script",
  "scripts",
  "hook",
  "hooks",
  "postinstall",
  "preinstall",
  "command",
  "commands",
  "shell",
  "exec",
  "eval",
  "condition",
  "then",
  "loop",
  "fetch",
  "rawscope",
  "requestedscopes",
  "oauthscopes",
  "scopeids",
  "scopes",
  "permissions",
  "apiurl",
  "endpoint",
  "endpoints",
  "apiendpoint",
  "cloudflareendpoint",
  "cfapi",
  "proxy",
  "http",
  "https",
]);

// Only https URLs may be expressed anywhere in a config. Strings starting with
// one of these schemes are rejected outright (arbitrary HTTP / local / smuggled
// executable URLs fail closed).
const BAD_SCHEME = /^(?:http:\/\/|file:|data:|javascript:)/i;

function checkDefaultUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "malformed URL";
  }
  if (url.protocol !== "https:") return "only https is allowed";
  if (url.username || url.password) return "credentials in the URL are not allowed";
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) return "private/local host is not allowed";
  return null;
}

function walk(node: unknown, path: string, visit: (key: string, value: unknown, path: string) => void): void {
  if (node === null || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    visit(k, v, `${path}.${k}`);
    if (v !== null && typeof v === "object") walk(v, `${path}.${k}`, visit);
  }
}

function findDependencyCycle(units: ConfigV3Unit[]): string | null {
  const byId = new Map(units.map((u) => [u.id, u]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, stack: string[]): string | null => {
    const current = state.get(id);
    if (current === "visiting") return [...stack, id].join(" -> ");
    if (current === "done") return null;
    state.set(id, "visiting");
    const unit = byId.get(id);
    for (const dep of unit?.dependsOn ?? []) {
      const found = visit(dep, [...stack, id]);
      if (found) return found;
    }
    state.set(id, "done");
    return null;
  };
  for (const unit of units) {
    const found = visit(unit.id, []);
    if (found) return found;
  }
  return null;
}

function unitDependencyDepth(units: ConfigV3Unit[]): number {
  const byId = new Map(units.map((u) => [u.id, u]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cyclic input: callers check cycles separately
    visiting.add(id);
    const unit = byId.get(id);
    const d = 1 + Math.max(0, ...(unit?.dependsOn ?? []).map((dep) => depth(dep)));
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  return Math.max(0, ...units.map((u) => depth(u.id)));
}

/**
 * Reject config shapes the schema cannot catch on its own (smuggled executable
 * fields, raw OAuth scopes, arbitrary endpoints, non-https URLs) plus the
 * cross-field semantic rules (source completeness, unique ids, DAG validity,
 * install-policy references, capability duplication).
 */
export function assertConfigV3Safe(config: ConfigV3): ConfigV3SafetyIssue[] {
  const issues: ConfigV3SafetyIssue[] = [];

  // Deny keys + dangerous URL schemes, anywhere in the value tree.
  walk(config, "$", (key, value, path) => {
    const norm = key.toLowerCase();
    if (DENY_KEYS.has(norm)) {
      issues.push({ field: path, detail: `config must not contain executable/scope/endpoint field "${key}"` });
    }
    if (typeof value === "string" && BAD_SCHEME.test(value.trim())) {
      issues.push({ field: path, detail: `only https URLs are allowed; "${value.trim().slice(0, 24)}..." is not` });
    }
  });

  // Source completeness + URL policy (defence in depth beyond the schema).
  if (config.source && typeof config.source === "object") {
    const { defaultUrl, allowLocalZip } = config.source;
    if (allowLocalZip === false && !defaultUrl) {
      issues.push({ field: "source.defaultUrl", detail: "defaultUrl is required when allowLocalZip is false" });
    }
    if (defaultUrl) {
      const problem = checkDefaultUrl(defaultUrl);
      if (problem) issues.push({ field: "source.defaultUrl", detail: problem });
    }
  }

  // Capabilities: non-empty, unique (schema enforces too; guard is defence in depth).
  const caps = Array.isArray(config.capabilities) ? config.capabilities : [];
  if (caps.length === 0) {
    issues.push({ field: "capabilities", detail: "at least one capability is required" });
  }
  if (new Set(caps).size !== caps.length) {
    issues.push({ field: "capabilities", detail: "capabilities must be unique" });
  }

  // secret inputs double as Worker binding names (no separate mapping
  // language). A key the provider could never bind fails fast here instead of
  // at version upload.
  for (const input of config.inputs ?? []) {
    if (input.type === "secret" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.key)) {
      issues.push({ field: `inputs.${input.key}`, detail: `secret input key "${input.key}" must be a valid Worker binding name` });
    }
  }

  // Units: unique ids, unique wrangler paths, valid dependencies, acyclic DAG.
  const units = config.units;
  if (units && units.length > 0) {
    const ids = units.map((u) => u.id);
    if (new Set(ids).size !== ids.length) {
      issues.push({ field: "units", detail: "unit ids must be unique" });
    }
    if (ids.includes(RESOURCES_UNIT_ID)) {
      issues.push({ field: "units", detail: `unit id "${RESOURCES_UNIT_ID}" is reserved for the config's resources` });
    }
    const wranglerPaths = units.map((u) => u.wrangler);
    if (new Set(wranglerPaths).size !== wranglerPaths.length) {
      issues.push({ field: "units", detail: "unit wrangler paths must be unique" });
    }
    for (const unit of units) {
      for (const dep of unit.dependsOn ?? []) {
        if (!ids.includes(dep)) {
          issues.push({ field: `units.${unit.id}.dependsOn`, detail: `unknown unit id "${dep}"` });
        }
      }
    }
    const cycle = findDependencyCycle(units);
    if (cycle) {
      issues.push({ field: "units", detail: `dependency cycle: ${cycle}` });
    } else {
      const depth = unitDependencyDepth(units);
      if (depth > units.length) {
        issues.push({ field: "units", detail: `dependency depth ${depth} exceeds unit count ${units.length}` });
      }
    }
  }

  if (units && units.length === 0 && (config.resources ?? []).length === 0) {
    issues.push({ field: "units", detail: "an empty units list needs resources to create" });
  }

  // Resources: unique, and a Vectorize index that TapDeploy creates needs its shape.
  const resources = config.resources ?? [];
  const pairs = resources.map((r) => `${r.kind}:${r.name}`);
  if (new Set(pairs).size !== pairs.length) {
    issues.push({ field: "resources", detail: "duplicate resources" });
  }
  for (const resource of resources) {
    if (resource.kind !== "vectorize" && (resource.dimensions !== undefined || resource.metric !== undefined)) {
      issues.push({ field: "resources", detail: `dimensions/metric apply only to vectorize resources ("${resource.name}")` });
    }
    if (resource.kind === "vectorize" && resource.create !== false && (resource.dimensions === undefined || resource.metric === undefined)) {
      issues.push({ field: "resources", detail: `vectorize index "${resource.name}" needs dimensions and metric to be created (or set create to false)` });
    }
  }

  // Install policies reference a real unit (or the implicit default unit).
  if (config.install) {
    const knownUnitIds = new Set((units ?? []).map((u) => u.id));
    const kindUnitPairs = new Set<string>();
    for (const policy of config.install.policies ?? []) {
      const target = policy.unitId;
      if (units && units.length > 0) {
        if (!knownUnitIds.has(target)) {
          issues.push({ field: "install.policies.unitId", detail: `unknown unit id "${target}"` });
        }
      } else if (target !== DEFAULT_V3_UNIT_ID) {
        issues.push({
          field: "install.policies.unitId",
          detail: `unitId must be "${DEFAULT_V3_UNIT_ID}" when the implicit single unit is used`,
        });
      }
      const pair = `${policy.kind}:${target}`;
      if (kindUnitPairs.has(pair)) {
        issues.push({ field: "install.policies", detail: `duplicate policy "${pair}"` });
      }
      kindUnitPairs.add(pair);
      if (!caps.includes("r2")) {
        issues.push({
          field: "install.policies",
          detail: `${policy.kind} manages R2 objects but capability "r2" is not declared`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Composite entry validation (mirrors src/core/config-entry.ts for v3)
// ---------------------------------------------------------------------------

export interface ConfigV3EntryResult {
  ok: boolean;
  config?: ConfigV3;
  errors: ConfigV3ParseIssue[];
}

/**
 * Validate a raw v3 config object (already parsed + size/depth bounded against
 * the v3 schema and the semantic safety guard). Returns field-level errors.
 * Browser and server share this entry point so the client gives immediate UX
 * feedback while the server stays authoritative.
 */
export function validateConfigV3Entry(input: unknown): ConfigV3EntryResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ field: "$", message: "config must be a JSON object" }] };
  }
  const validated = validateConfigV3(input);
  if (!validated.ok) {
    return {
      ok: false,
      errors: validated.errors.map((e) => ({ field: e.instancePath || "/", message: e.message })),
    };
  }
  const safety = assertConfigV3Safe(validated.config);
  if (safety.length > 0) {
    return {
      ok: false,
      errors: safety.map((e) => ({ field: e.field, message: e.detail })),
    };
  }
  return { ok: true, config: validated.config, errors: [] };
}

// ---------------------------------------------------------------------------
// Deterministic identity over canonical normalized bytes
// ---------------------------------------------------------------------------

/**
 * Canonical v3 serialization: sorted object keys recursively, with the
 * documented defaults materialized (`source.allowLocalZip` defaults to true,
 * an explicitly empty `inputs` array is equivalent to omitting it). The same
 * logical config always yields the same bytes.
 */
export function canonicalizeConfigV3(config: ConfigV3): string {
  if (config === null || typeof config !== "object") {
    return JSON.stringify(config);
  }
  const withDefaults: Record<string, unknown> = { ...(config as unknown as Record<string, unknown>) };
  const source: Record<string, unknown> = { ...((config.source ?? {}) as Record<string, unknown>) };
  if (source.allowLocalZip === undefined) {
    source.allowLocalZip = true;
  }
  withDefaults.source = source;
  if (Array.isArray(withDefaults.inputs) && withDefaults.inputs.length === 0) {
    delete withDefaults.inputs;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(withDefaults).sort()) {
    sorted[key] = canonicalizeValue(withDefaults[key]);
  }
  return JSON.stringify(sorted);
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  // crypto.subtle is available on both Workers and Node; no node:crypto import
  // keeps the bundle portable.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeConfigV3Id(config: ConfigV3): Promise<string> {
  return sha256Hex(canonicalizeConfigV3(config));
}
