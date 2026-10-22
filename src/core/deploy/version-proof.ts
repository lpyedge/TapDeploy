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
