// Official Workers resource API supports version-specific inheritance; legacy
// script uploads do not. Never substitute mutable latest or deploy implicitly.
import type { Fetcher } from "./client.js";
import { encodeVersionModuleParts, type VersionCreateRequest, type WorkerVersionMeta } from "../models/workers.js";
import { assertAccountId, assertScriptName, buildApiUrl } from "./url-guard.js";
import { makeCloudflareError, makeInvalidResponseError, makeNetworkError } from "./errors.js";
import { routeFor } from "./routes.js";

export async function uploadWithActiveInheritance(account: string | undefined, name: string, req: VersionCreateRequest, fetcher: Fetcher, token: string): Promise<WorkerVersionMeta> {
  if (!account) throw makeInvalidResponseError("account is required");
  assertAccountId(account);
  assertScriptName(name);
  if (req.metadata.main_module !== req.mainModule.name || req.metadata.keep_assets) throw makeInvalidResponseError("unsupported inherited upload metadata");
  for (const binding of req.metadata.bindings ?? []) {
    if (binding.type === "inherit" && (typeof binding.version_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(binding.version_id))) throw makeInvalidResponseError("inheritance requires an exact immutable version UUID");
  }
  // the JSON version API receives the same validated module set. Bytes
  // travel base64-encoded (this API dialect requires it) but are never text
  // decoded, and the bounded shared encoder refuses oversize or unverified
  // names before any network call.
  const encoded = encodeVersionModuleParts(req);
  if (!encoded.ok) throw makeInvalidResponseError(`inherited version upload refused: ${encoded.errors.join("; ")}`);
  const modules = encoded.parts.map((part) => {
    let binary = "";
    for (let offset = 0; offset < part.bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...part.bytes.subarray(offset, offset + 0x8000));
    }
    return { name: part.name, content_type: part.mime, content_base64: btoa(binary) };
  });
  const base = routeFor("listWorkerResources").path({ accountId: account });
  const call = async (path: string, method: "GET" | "POST", body?: unknown) => {
    let response: Response;
    try { response = await fetcher(buildApiUrl(path), { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch (error) { throw makeNetworkError(error); }
    let envelope;
    try { envelope = await response.json(); } catch { throw makeInvalidResponseError("invalid Workers resource response"); }
    if (!response.ok) throw makeCloudflareError(response, envelope);
    if (envelope?.success !== true) throw makeInvalidResponseError("Workers resource request unsuccessful");
    return envelope;
  };
  const matches: Array<{ id: string; name: string }> = [];
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const envelope = await call(`${base}?page=${page}&per_page=100`, "GET");
    if (!Array.isArray(envelope.result)) throw makeInvalidResponseError("Workers resource list unavailable");
    for (const worker of envelope.result) {
      if (!worker || typeof worker.id !== "string" || typeof worker.name !== "string") throw makeInvalidResponseError("invalid Worker resource identity");
      if (worker.name === name) matches.push(worker);
    }
    const pages = envelope.result_info?.total_pages;
    if (pages !== undefined && (!Number.isSafeInteger(pages) || pages < 1)) throw makeInvalidResponseError("invalid Worker identity pagination");
    if ((typeof pages === "number" && page >= pages) || (pages === undefined && envelope.result.length < 100)) { complete = true; break; }
  }
  if (!complete || matches.length !== 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(matches[0]!.id)) throw makeInvalidResponseError("Worker identity could not be resolved uniquely");
  const id = matches[0]!.id;
  const verified = await call(routeFor("getWorkerResource").path({ accountId: account, workerId: id }), "GET");
  if (verified.result?.id !== id || verified.result?.name !== name) throw makeInvalidResponseError("Worker identity changed before upload");
  const { main_module, bindings, compatibility_date, compatibility_flags, annotations, assets } = req.metadata;
  const resourceBindings = bindings?.map(binding => {
    if (binding.type === "d1") {
      const { id: legacyId, ...rest } = binding;
      const database_id = binding.database_id ?? legacyId;
      if (typeof database_id !== "string" || !database_id) throw makeInvalidResponseError("D1 identity unavailable");
      return { ...rest, database_id };
    }
    return binding;
  });
  const result = (await call(routeFor("createWorkerResourceVersion").path({ accountId: account, workerId: id }), "POST", {
    main_module, bindings: resourceBindings, compatibility_date, compatibility_flags, annotations, assets,
    modules,
  })).result;
  if (!result || typeof result.id !== "string" || !result.id) throw makeInvalidResponseError("prepared version identity unavailable");
  return { id: result.id, ...(typeof result.number === "number" ? { number: result.number } : {}) };
}
