import type { DeployBundle } from "./deploy-bundle.js";

export interface BundleModulePartBytes {
  /** Canonical module name from the approved DeployBundle. */
  name: string;
  /** Raw binary bytes exactly as received; wasm is never text-decoded. */
  bytes: Uint8Array;
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

// server-side re-verification of a module part set against the approved
// bundle identity before any provider call. Every approved module must arrive
// exactly once with the exact size and SHA-256 recomputed here from the raw
// bytes, and no undeclared part may appear. A one-byte corruption, a wasm
// binary mangled through a text round-trip, or a cross-module name/value swap
// fails closed instead of uploading.
export async function verifyDeployBundleModules(
  bundle: DeployBundle,
  parts: ReadonlyArray<BundleModulePartBytes>,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  const byName = new Map<string, Uint8Array>();
  for (const part of parts) {
    if (byName.has(part.name)) {
      errors.push(`DUPLICATE_MODULE: "${part.name}" was provided more than once`);
      continue;
    }
    byName.set(part.name, part.bytes);
  }
  const declared = new Set(bundle.modules.map((m) => m.name));
  for (const part of parts) {
    if (!declared.has(part.name)) {
      errors.push(
        `UNDECLARED_MODULE: "${part.name}" is not part of the approved bundle`,
      );
    }
  }
  for (const module of bundle.modules) {
    const bytes = byName.get(module.name);
    if (bytes === undefined) {
      errors.push(`MISSING_MODULE: "${module.name}" was not provided`);
      continue;
    }
    if (bytes.length !== module.size) {
      errors.push(
        `SIZE_MISMATCH: "${module.name}" expected ${module.size} bytes, got ${bytes.length}`,
      );
    }
    const sha = await sha256HexBytes(bytes);
    if (sha !== module.sha256) {
      errors.push(
        `HASH_DRIFT: "${module.name}" bytes do not match the approved module`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}
