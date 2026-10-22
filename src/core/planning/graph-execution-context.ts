import { openSeal, sealJson, type SealedEnvelope } from "../../auth/keys.js";
import { canonicalJson } from "./digest.js";

const MAX_RELEASE_CONTEXT_BYTES = 256 * 1024;
const MAX_EXECUTION_CONTEXT_BYTES = 512 * 1024;

type JsonRecord = Record<string, unknown>;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every((key) => !forbiddenKeys.has(key));
}
function text(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function bounded(value: unknown, limit: number): boolean {
  try { return new TextEncoder().encode(canonicalJson(value)).byteLength <= limit; } catch { return false; }
}

export interface VerifiedReleaseContext {
  kind: "tapdeploy-verified-prebuilt-release/v1";
  nonce: string; configHash: string; appId: string; sourceKind: string; sourcePolicyDigest: string;
  archiveSha256: string; manifestDigest: string; expiresAt: number; units: JsonRecord[]; combinedUnitRootDigest: string;
}
export interface GraphExecutionContext {
  kind: "tapdeploy-graph-execution/v1";
  protocolVersion: 1; nonce: string; configHash: string; appId: string; accountId: string; expiresAt: number;
  sourceKind: string; sourcePolicyDigest: string; archiveSha256: string; manifestDigest: string;
  graphPlanDigest: string; canonicalNonsecretGraphPlan: JsonRecord; topoOrder: string[];
  dependencies: Array<{ dependent: string; dependency: string }>;
  expectedPerUnitReferences: JsonRecord; approvedDiffsWithActionIds: JsonRecord[];
  perUnitCanonicalSpecs: JsonRecord; perUnitWranglerAndBundleProofs: JsonRecord;
  capabilityClosure: JsonRecord; costPosture: JsonRecord; approvedMode: string; executionContextDigest: string;
  optionalBootstrapPolicyIdentity?: JsonRecord;
}
export interface GraphPhaseReceipt {
  kind: "tapdeploy-graph-phase-receipt/v1";
  nonce: string; configHash: string; accountId: string; sourcePolicyDigest: string; graphPlanDigest: string;
  executionContextDigest: string; unitId: string; actionId: string; phase: string; stateHash: string; expiresAt: number;
  versionId?: string;
}

function isVerifiedReleaseContext(value: unknown): value is VerifiedReleaseContext {
  if (!record(value) || value.kind !== "tapdeploy-verified-prebuilt-release/v1" || !Array.isArray(value.units) || value.units.length > 128) return false;
  return [value.nonce, value.configHash, value.appId, value.sourceKind, value.sourcePolicyDigest, value.archiveSha256, value.manifestDigest, value.combinedUnitRootDigest].every((v) => text(v)) && finite(value.expiresAt) && value.units.every(record) && bounded(value, MAX_RELEASE_CONTEXT_BYTES);
}
function isGraphExecutionContext(value: unknown): value is GraphExecutionContext {
  if (!record(value) || value.kind !== "tapdeploy-graph-execution/v1" || value.protocolVersion !== 1 || !Array.isArray(value.topoOrder) || value.topoOrder.length > 128 || !Array.isArray(value.dependencies) || value.dependencies.length > 16384 || !value.dependencies.every(edge => record(edge) && text(edge.dependent) && text(edge.dependency)) || !Array.isArray(value.approvedDiffsWithActionIds) || value.approvedDiffsWithActionIds.length > 2048) return false;
  const strings = [value.nonce,value.configHash,value.appId,value.accountId,value.sourceKind,value.sourcePolicyDigest,value.archiveSha256,value.manifestDigest,value.graphPlanDigest,value.approvedMode,value.executionContextDigest];
  return strings.every((v) => text(v)) && finite(value.expiresAt) && value.topoOrder.every((v) => text(v)) && [value.canonicalNonsecretGraphPlan,value.expectedPerUnitReferences,value.perUnitCanonicalSpecs,value.perUnitWranglerAndBundleProofs,value.capabilityClosure,value.costPosture].every(record) && (value.optionalBootstrapPolicyIdentity === undefined || record(value.optionalBootstrapPolicyIdentity)) && value.approvedDiffsWithActionIds.every(record) && bounded(value, MAX_EXECUTION_CONTEXT_BYTES);
}
export function isGraphPhaseReceipt(value: unknown): value is GraphPhaseReceipt {
  if (!record(value) || value.kind !== "tapdeploy-graph-phase-receipt/v1" || !finite(value.expiresAt)) return false;
  if (value.versionId !== undefined && !text(value.versionId)) return false;
  return [value.nonce,value.configHash,value.accountId,value.sourcePolicyDigest,value.graphPlanDigest,value.executionContextDigest,value.unitId,value.actionId,value.phase,value.stateHash].every((v) => text(v)) && bounded(value, 16 * 1024);
}

export async function sealVerifiedReleaseContext(key: CryptoKey, context: VerifiedReleaseContext): Promise<SealedEnvelope> {
  if (!isVerifiedReleaseContext(context)) throw new Error("VERIFIED_RELEASE_CONTEXT_INVALID");
  return sealJson(key, context);
}

export async function openVerifiedReleaseContext(
  key: CryptoKey,
  envelope: unknown,
  expected: Pick<VerifiedReleaseContext, "nonce" | "configHash" | "sourcePolicyDigest">,
  sessionExpiresAt: number,
): Promise<VerifiedReleaseContext | null> {
  if (!record(envelope)) return null;
  const value = await openSeal<unknown>(key, envelope as unknown as SealedEnvelope);
  return isVerifiedReleaseContext(value) && value.expiresAt > Date.now() && value.expiresAt <= sessionExpiresAt &&
      value.nonce === expected.nonce && value.configHash === expected.configHash && value.sourcePolicyDigest === expected.sourcePolicyDigest ? value : null;
}

export async function sealGraphPhaseReceipt(key: CryptoKey, receipt: GraphPhaseReceipt): Promise<SealedEnvelope> {
  if (!isGraphPhaseReceipt(receipt)) throw new Error("GRAPH_PHASE_RECEIPT_INVALID");
  return sealJson(key, receipt);
}

export async function openGraphPhaseReceipt(
  key: CryptoKey,
  envelope: unknown,
  expected: Omit<GraphPhaseReceipt, "kind" | "expiresAt">,
  sessionExpiresAt: number,
): Promise<GraphPhaseReceipt | null> {
  if (!record(envelope)) return null;
  const value = await openSeal<unknown>(key, envelope as unknown as SealedEnvelope);
  if (!isGraphPhaseReceipt(value) || value.expiresAt <= Date.now() || value.expiresAt > sessionExpiresAt) return null;
  return Object.entries(expected).every(([key, item]) => value[key as keyof GraphPhaseReceipt] === item) ? value : null;
}

export async function graphExecutionContextDigest(context: Omit<GraphExecutionContext, "executionContextDigest">): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(context));
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function sealGraphExecutionContext(key: CryptoKey, context: GraphExecutionContext): Promise<SealedEnvelope> {
  if (!isGraphExecutionContext(context) || context.executionContextDigest !== await graphExecutionContextDigest(Object.fromEntries(Object.entries(context).filter(([k]) => k !== "executionContextDigest")) as Omit<GraphExecutionContext,"executionContextDigest">)) throw new Error("GRAPH_CONTEXT_INVALID");
  return sealJson(key, context);
}
export async function openGraphExecutionContext(key: CryptoKey, envelope: unknown, expected: Pick<GraphExecutionContext,"nonce"|"configHash"|"accountId"|"sourcePolicyDigest">, sessionExpiresAt: number): Promise<GraphExecutionContext | null> {
  if (!record(envelope)) return null;
  const value = await openSeal<unknown>(key, envelope as unknown as SealedEnvelope);
  if (!isGraphExecutionContext(value) || value.expiresAt <= Date.now() || value.expiresAt > sessionExpiresAt) return null;
  if (value.nonce !== expected.nonce || value.configHash !== expected.configHash || value.accountId !== expected.accountId || value.sourcePolicyDigest !== expected.sourcePolicyDigest) return null;
  const digest = await graphExecutionContextDigest(Object.fromEntries(Object.entries(value).filter(([k]) => k !== "executionContextDigest")) as Omit<GraphExecutionContext,"executionContextDigest">);
  return digest === value.executionContextDigest ? value : null;
}
