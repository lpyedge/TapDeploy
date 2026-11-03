import { canonicalJson } from "../planning/digest.js";
export function publicBindingProof(bindings: Record<string, unknown>[], active: Record<string, unknown>[] = []): Record<string, unknown>[] {
  return bindings.map(binding => {
    const source = binding.type === "inherit" ? active.find(b => b.name === binding.name) : binding;
    if (!source) throw new Error("exact inherited binding proof unavailable");
    if (source.type === "secret_text" || source.type === "secret_key") return { name: source.name, type: source.type };
    if (source.type === "d1") {
      const rest = { ...source };
      delete rest.id;
      return { ...rest, database_id: source.database_id ?? source.id };
    }
    return source;
  });
}
export function matchesBindingProof(expected: Record<string, unknown>[], actual: Record<string, unknown>[]): boolean {
  if (actual.some(binding => binding.type === "inherit")) return false;
  const normalized = publicBindingProof(actual);
  const names = expected.map(b => b.name);
  if (new Set(names).size !== names.length || normalized.length !== expected.length || new Set(normalized.map(b => b.name)).size !== normalized.length) return false;
  return expected.every(binding => {
    const found = normalized.find(b => b.name === binding.name);
    return !!found && Object.entries(binding).every(([key, value]) => canonicalJson(found[key]) === canonicalJson(value));
  });
}
export interface RuntimeProof { compatibility_date?: string; compatibility_flags: string[] }
export function matchesRuntimeProof(expected: RuntimeProof, actual: unknown): boolean {
  if (typeof expected.compatibility_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expected.compatibility_date)) return false;
  if (!actual || typeof actual !== "object") return false;
  const runtime = actual as Record<string, unknown>;
  const flags = runtime.compatibility_flags ?? [];
  return runtime.compatibility_date === expected.compatibility_date && Array.isArray(flags) && flags.every(flag => typeof flag === "string") && canonicalJson([...flags].sort()) === canonicalJson([...expected.compatibility_flags].sort());
}

// Which active bindings an upgrade can carry verbatim into the next version
// when the release does not declare them: only kinds whose copy is exact
// (every identifying field present). Secrets are inherited by name. A
// static-assets binding is not carried and does not block: assets belong to
// the code, so the release brings its own or none.
const CARRIED_FIELDS: Record<string, string[]> = {
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

function carriableBinding(binding: Record<string, unknown>): boolean {
  if (typeof binding.name !== "string" || !binding.name) return false;
  if (binding.type === "secret_text" || binding.type === "secret_key") return true;
  if (typeof binding.type !== "string" || !Object.hasOwn(CARRIED_FIELDS, binding.type)) return false;
  if (binding.type === "d1" && typeof (binding.database_id ?? binding.id) !== "string") return false;
  return CARRIED_FIELDS[binding.type]!.every(k => binding[k] !== undefined);
}

/** The active bindings an upgrade cannot carry into the next version; any one refuses it before a write. */
export function uncarriableBindings(active: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return active.filter(binding => binding.type !== "assets" && !carriableBinding(binding));
}
