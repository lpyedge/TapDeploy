// Configure-step names for the release's resources and Pages projects.
//
// Install: each name is editable and starts at the release's suggestion; an
// existing name is reused. Upgrade: a resource the config marks `onUpgrade: "change"` stays
// editable, starting at what the Worker binds today; any other resource the
// Worker binds is locked; the rest are picked from the account's existing names.
// The server re-validates every name and refuses a silent rebind.

import type { InventoryEnvelope, ReleaseResourceName } from "./api.js";

export interface NameRow {
  key: string;
  kind: string;
  releaseName: string;
  /** input: editable; locked: bound today (read-only); select: pick an existing one. */
  mode: "input" | "locked" | "select";
  value: string;
  options: string[];
  /** The chosen name already exists and will be reused. */
  exists: boolean;
  error?: string;
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

export function nameRows(
  resources: readonly ReleaseResourceName[],
  mode: "install" | "upgrade",
  inventory: InventoryEnvelope | null,
  values: Readonly<Record<string, string>>,
): NameRow[] {
  return resources.map((item) => {
    const options = inventory?.names[item.kind] ?? [];
    const bound = mode === "upgrade" ? inventory?.bindings?.find((live) => live.kind === item.kind && item.bindings.some((binding) => binding.binding === live.binding)) : undefined;
    if (mode === "install" || item.changeOnUpgrade) {
      const value = values[item.key] ?? bound?.name ?? item.name;
      return {
        key: item.key, kind: item.kind, releaseName: item.name, mode: "input", value, options,
        exists: options.includes(value),
        // The release's own name is taken as published; a changed name must be valid.
        ...(value === item.name || NAME_RE.test(value) ? {} : { error: "3–63 lowercase letters, digits or dashes" }),
      };
    }
    if (bound) return { key: item.key, kind: item.kind, releaseName: item.name, mode: "locked", value: bound.name, options: [bound.name], exists: true };
    const value = values[item.key] ?? (options.includes(item.name) ? item.name : "");
    return {
      key: item.key, kind: item.kind, releaseName: item.name, mode: "select", value, options, exists: true,
      ...(value ? {} : { error: inventory ? "choose the existing one to keep using" : "loading…" }),
    };
  });
}

/** The plan request's `names`: only the rows whose name differs from the release's. */
export function requestNames(rows: readonly NameRow[]): Record<string, string> | undefined {
  const names = Object.fromEntries(rows.filter((row) => row.value && row.value !== row.releaseName).map((row) => [row.key, row.value]));
  return Object.keys(names).length > 0 ? names : undefined;
}
