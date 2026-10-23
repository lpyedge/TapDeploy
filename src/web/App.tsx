// Single-page installer UI. Flow: config -> Cloudflare sign-in for exactly that
// config (a direct redirect, no Connect screen) -> release -> configure ->
// deploy. The sealed-graph steps live in the V3 panels; this file owns the
// entry/session state and the V3Flow wiring. The OAuth token is never present in UI JS
// (HttpOnly cookie); only the CSRF token is kept in component state, and it is
// never rendered into the DOM.

import { useEffect, useRef, useState } from "react";
import {
  getAccounts,
  getSession,
  getTargets,
  getDomains,
  getHyperdriveConfigs,
  getInventory,
  type DomainsEnvelope,
  type InventoryEnvelope,
  type ReleaseResourceName,
  isAuthFailure,
  startOAuth,
  checkConfigCoverage,
  fetchGraphPlan,
  prepareReleaseZip,
  type AccountSummary,
  type SessionState,
  type GraphPlan,
} from "./api.js";
import { V3FlowMachine, type V3MachineSnapshot, type V3Stage as V3MachineStage } from "./v3-flow-machine.js";
import { runGraphDeploy, type GraphStepStatus } from "./graph-deploy-runner.js";
import { safeErrorMessage } from "./deploy-shared.js";
import { fetchReleaseBytes, retainV3SourceBytes, type V3RetainedSource } from "./release.js";
import { ConfigEntry } from "./ConfigEntry.js";
import { AccountBar } from "./AccountBar.js";
import { V3ReleasePanel } from "./V3ReleasePanel.js";
import { V3DeployPanel, secretPromptsFor } from "./V3DeployPanel.js";
import { V3ConfigurePanel, declaredConfigInputs, inputError } from "./V3ConfigurePanel.js";
import { V3DomainsPanel } from "./V3DomainsPanel.js";
import { V3HyperdrivePanel } from "./V3HyperdrivePanel.js";
import { V3NamesPanel } from "./V3NamesPanel.js";
import { nameRows, requestNames } from "./name-choices.js";
import { domainRequest, draftErrors, type HttpUnit, type UnitDomainDraft } from "./domain-choices.js";
import { Shell } from "./Shell.js";
import { phaseLabel } from "./step-labels.js";

// A quick link carries the config address: /?config=https://host/tapdeploy.config.json
function readQuickLink(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  return params.has("auth") ? undefined : (params.get("config") ?? undefined);
}

// The nonsecret config text is kept in tab sessionStorage so it survives the
// top-level OAuth redirect, for at most this long after it was stored. Only the
// config lives there (never a token or secret); a stale entry is discarded so a
// long-lived tab cannot replay a config whose one-shot grant is gone.
const CONFIG_SESSION_KEY = "tapdeploy.config.v3";
const CONFIG_SESSION_TTL_MS = 30 * 60 * 1000;

interface LoadedConfig {
  text: string;
  appId: string;
  sourceLabel: string;
}

function storeConfig(config: LoadedConfig) {
  try {
    window.sessionStorage.setItem(CONFIG_SESSION_KEY, JSON.stringify({ ...config, storedAt: Date.now() }));
  } catch {
    // sessionStorage unavailable: the config is pasted again after sign-in
  }
}

function clearStoredConfig() {
  try {
    window.sessionStorage.removeItem(CONFIG_SESSION_KEY);
  } catch {
    // ignore
  }
}

function readStoredConfig(): LoadedConfig | null {
  try {
    const raw = window.sessionStorage.getItem(CONFIG_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { text?: unknown; sourceLabel?: unknown; appId?: unknown; storedAt?: number };
    if (parsed.storedAt && Date.now() - parsed.storedAt > CONFIG_SESSION_TTL_MS) {
      clearStoredConfig();
      return null;
    }
    if (typeof parsed.text !== "string" || !parsed.text || typeof parsed.appId !== "string" || !parsed.appId) return null;
    return { text: parsed.text, appId: parsed.appId, sourceLabel: typeof parsed.sourceLabel === "string" ? parsed.sourceLabel : "restored config" };
  } catch {
    // never block the flow on a corrupt sessionStorage entry
    return null;
  }
}

function oauthStartMessage(error: unknown): string {
  const e = error as { kind?: string; detail?: string; message?: string };
  if (e.kind === "invalid_config" || e.kind === "config_required") {
    return safeErrorMessage(`The installer rejected this config: ${e.detail ?? e.message ?? e.kind}`);
  }
  return safeErrorMessage(e.message ?? "Cloudflare sign-in could not be started on this installer.");
}

export function App() {
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [quickUrl] = useState(readQuickLink);
  // The loaded config once the session is known to cover it; V3Flow owns the rest.
  const [config, setConfig] = useState<LoadedConfig | null>(null);
  const [uiStage, setUiStage] = useState<"release" | "configure" | "deploy">("release");
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [accountId, setAccountId] = useState("");
  // Checking coverage or handing the page over to Cloudflare sign-in.
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // Set right after a completed sign-in: a config that is still not covered
  // then is reported instead of looping back into another sign-in.
  const justAuthorized = useRef(false);

  // OAuth is bound to the exact config text: the server derives the scopes and
  // the browser goes straight to Cloudflare. There is no Connect screen.
  // Resolves true once the browser is leaving for Cloudflare.
  const signIn = async (target: LoadedConfig): Promise<boolean> => {
    if (justAuthorized.current) {
      justAuthorized.current = false;
      clearStoredConfig();
      setConfig(null);
      setBusy(false);
      setAuthError("The Cloudflare authorization that just completed does not cover this config. Load the config again to start over.");
      return false;
    }
    setBusy(true);
    setAuthError(null);
    storeConfig(target);
    try {
      const result = await startOAuth(target.text);
      window.location.assign(result.url);
      return true;
    } catch (error) {
      clearStoredConfig();
      setConfig(null);
      setBusy(false);
      setAuthError(oauthStartMessage(error));
      return false;
    }
  };

  const loadAccounts = (csrf: string) => {
    getAccounts(csrf)
      .then((list) => {
        setAccounts(list);
        // One account: nothing to choose.
        if (list.length === 1) setAccountId(list[0]!.id);
      })
      .catch(() => setAccounts([]));
  };

  // A loaded config continues in this tab when the live session was granted
  // for exactly this text; otherwise the page goes to Cloudflare sign-in.
  const openConfig = async (target: LoadedConfig) => {
    setBusy(true);
    setAuthError(null);
    setNotice(null);
    const live = await getSession().catch(() => null);
    if (live?.authenticated && live.csrf) {
      try {
        const check = await checkConfigCoverage(live.csrf, target.text);
        if (check.matches) {
          if (!session?.authenticated) loadAccounts(live.csrf);
          setSession(live);
          storeConfig(target);
          setUiStage("release");
          setConfig(target);
          setBusy(false);
          return;
        }
        if (check.reason === "invalid_config") {
          setBusy(false);
          setAuthError(safeErrorMessage(`The installer rejected this config: ${check.detail ?? "invalid config"}`));
          return;
        }
      } catch {
        // fall through to a fresh authorization
      }
    }
    await signIn(target);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get("auth");
    if (auth === "error") {
      // A denied/failed grant must not loop back into an automatic sign-in.
      clearStoredConfig();
      const code = errorLabel(params.get("error"));
      setNotice(code === "invalid_scope"
        ? "This installer's Cloudflare OAuth client does not include a permission this app needs (invalid_scope). The instance operator must add it to the client."
        : `Cloudflare authorization was not completed (${code}).`);
    }
    if (auth !== null || params.has("config")) window.history.replaceState({}, "", window.location.pathname);
    justAuthorized.current = auth === "success";
    void (async () => {
      const live = await getSession().catch(() => null);
      setSession(live);
      if (live?.authenticated && live.csrf) loadAccounts(live.csrf);
      const stored = readStoredConfig();
      // Back from Cloudflare (or a reload mid-flow): continue with the stored
      // config; V3Flow re-verifies coverage before anything is uploaded. A
      // stored config without a session goes straight to sign-in (the page
      // stays on the loading state until the browser leaves).
      if (stored && live?.authenticated && live.csrf) {
        setConfig(stored);
      } else if (stored && auth !== "error" && (await signIn(stored))) {
        return;
      }
      setSessionChecked(true);
    })();
  }, []);

  // A session that ends mid-flow (expired cookie, revoked grant) goes straight
  // back to Cloudflare for the same config; nothing is written without a new
  // plan and confirmation.
  const reauthorize = () => {
    if (!config) return;
    setSession(null);
    void signIn(config);
  };

  if (!sessionChecked) {
    return (
      <Shell step={0} notice={notice}>
        <p className="loading" role="status" data-testid="session-loading">Loading…</p>
      </Shell>
    );
  }

  if (config && session?.authenticated && session.csrf) {
    const account = accounts.length > 1 ? <AccountBar accountId={accountId} accounts={accounts} onAccount={setAccountId} /> : undefined;
    return (
      <Shell step={uiStage === "release" ? 1 : uiStage === "configure" ? 2 : 3} notice={notice} account={account}>
        <V3Flow
          csrf={session.csrf}
          accountId={accountId}
          accounts={accounts}
          configText={config.text}
          appId={config.appId}
          sourceLabel={config.sourceLabel}
          onExit={() => { setConfig(null); clearStoredConfig(); }}
          onExpired={reauthorize}
          onReauthorize={reauthorize}
          onStage={(stage) => setUiStage(stage === "done" ? "deploy" : stage)}
        />
      </Shell>
    );
  }

  return (
    <Shell step={0} notice={notice}>
      <ConfigEntry
        initialUrl={quickUrl}
        busy={busy}
        error={authError}
        onLoaded={(text, sourceLabel) => void openConfig({ text, sourceLabel, appId: v3AppId(text) ?? "unknown" })}
      />
    </Shell>
  );
}

function errorLabel(code: string | null): string {
  const known = new Set([
    "access_denied",
    "invalid_scope",
    "unauthorized_client",
    "server_error",
    "temporarily_unavailable",
    "exchange",
    "scope_denied",
  ]);
  return code && known.has(code) ? code : "provider_error";
}

// address-only V3 shape read for entry routing. Not validation: the
// server validates the config authoritatively at OAuth start and at every
// prepare/plan boundary.
function v3AppId(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 3) return null;
  const app = record.app;
  if (!app || typeof app !== "object" || Array.isArray(app)) return null;
  const id = (app as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

interface V3FlowProps {
  csrf: string;
  accountId: string;
  accounts: AccountSummary[];
  configText: string;
  appId: string;
  sourceLabel: string;
  onExit: () => void;
  onExpired: () => void;
  onStage?: (stage: V3MachineStage) => void;
  /** Re-authorize for the current config: persists first, then OAuth. */
  onReauthorize: () => void;
}

/**
 * The stage union lives in the machine module (single source of truth);
 * V3Flow no longer keeps its own copy.
 *
 * bare sealed-graph flow. Both ZIP sources converge on retained exact
 * bytes; prepare sends those identical bytes; plan forwards the server proof
 * opaquely; steps forward the sealed context/approval with rehashed bytes and
 * chained receipts. Typed body/token/unsupported errors surface; there is no
 * fallback path.
 */
function V3Flow(props: V3FlowProps) {
  // Stage reporting is machine-driven (see the snap effect below); the header
  // stepper tracks source/configure/review/deploy through onStage.
  const [assetUrl, setAssetUrl] = useState(() => {
    try {
      const parsed = JSON.parse(props.configText) as { source?: { defaultUrl?: unknown } };
      return typeof parsed.source?.defaultUrl === "string" ? parsed.source.defaultUrl : "";
    } catch {
      return "";
    }
  });
  // Release source is single-select: a URL download or a local file, never a
  // mix. Switching modes keeps the other input untouched but Prepare only
  // ever uses the active one; picking a new file replaces the retained bytes.
  const [releaseMode, setReleaseMode] = useState<"url" | "file">("url");
  const [fileKey, setFileKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [source, setSource] = useState<V3RetainedSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Sealed-graph stage machine: one cached object owns every step's state.
  // Stages advance only through the machine's transition table; the server
  // stays authoritative (prepare/plan/step re-verify everything).
  const [machine] = useState(() => new V3FlowMachine());
  const [snap, setSnap] = useState<V3MachineSnapshot>(() => machine.snapshot());
  const [paidConfirmed, setPaidConfirmed] = useState(false);
  const [statuses, setStatuses] = useState<GraphStepStatus[]>([]);
  // Configure-stage form: operator-editable inputs (worker name prefilled from
  // the sealed release) plus the install/upgrade intent sealed into the plan.
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [modeIntent, setModeIntent] = useState<"install" | "upgrade">("install");
  // Upgrade target discovery: live Workers in the selected account for the
  // upgrade dropdown. Read-only; fetched lazily when upgrade is picked, once
  // per account. A failed fetch degrades to manual entry, never a block.
  const [upgradeTargets, setUpgradeTargets] = useState<Array<{ name: string }> | null>(null);
  const [upgradeTargetsFor, setUpgradeTargetsFor] = useState<string | null>(null);
  const [upgradeTargetsError, setUpgradeTargetsError] = useState<string | null>(null);
  const [upgradeTargetsLoading, setUpgradeTargetsLoading] = useState(false);
  // Custom domains for the HTTP units: the account's zones and bound domains
  // (read once per account), the address records of each chosen zone, and the
  // operator's per-unit draft.
  const [domainFacts, setDomainFacts] = useState<DomainsEnvelope | null>(null);
  const [domainFactsFor, setDomainFactsFor] = useState<string | null>(null);
  const [domainFactsError, setDomainFactsError] = useState<string | null>(null);
  const [domainFactsLoading, setDomainFactsLoading] = useState(false);
  const [recordsByZone, setRecordsByZone] = useState<Record<string, NonNullable<DomainsEnvelope["records"]>>>({});
  const [domainDrafts, setDomainDrafts] = useState<Record<string, UnitDomainDraft>>({});
  // Hyperdrive: the account's configurations and the operator's per-binding choice.
  const [hyperdriveConfigs, setHyperdriveConfigs] = useState<string[] | null>(null);
  const [hyperdriveFor, setHyperdriveFor] = useState<string | null>(null);
  const [hyperdriveError, setHyperdriveError] = useState<string | null>(null);
  const [hyperdriveLoading, setHyperdriveLoading] = useState(false);
  const [hyperdriveChoices, setHyperdriveChoices] = useState<Record<string, Record<string, string>>>({});
  // Resource / Pages project names: the release's renamable items, the
  // operator's choices, and the account inventory (plus, on upgrade, what the
  // target Worker binds today).
  const [releaseResources, setReleaseResources] = useState<ReleaseResourceName[]>([]);
  const [nameValues, setNameValues] = useState<Record<string, string>>({});
  const [inventory, setInventory] = useState<InventoryEnvelope | null>(null);
  const [inventoryFor, setInventoryFor] = useState<string | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  useEffect(() => {
    if (snap.stage !== "configure" || !props.csrf || !props.accountId || hyperdriveFor === props.accountId) return;
    if (!machine.snapshot().releaseUnits.some((u) => (u.hyperdrive ?? []).length > 0)) return;
    let cancelled = false;
    setHyperdriveLoading(true);
    setHyperdriveError(null);
    void getHyperdriveConfigs(props.csrf, props.accountId)
      .then((configs) => { if (!cancelled) { setHyperdriveConfigs(configs); setHyperdriveFor(props.accountId); } })
      .catch((error) => { if (!cancelled) { setHyperdriveConfigs(null); setHyperdriveFor(props.accountId); setHyperdriveError(safeErrorMessage(error)); } })
      .finally(() => { if (!cancelled) setHyperdriveLoading(false); });
    return () => { cancelled = true; };
  }, [snap.stage, props.csrf, props.accountId, hyperdriveFor]);
  useEffect(() => {
    if (snap.stage !== "configure" || !props.csrf || !props.accountId || domainFactsFor === props.accountId) return;
    const pagesProjects = machine.snapshot().releaseUnits.filter((u) => u.kind === "pages").map((u) => u.name);
    if (!machine.snapshot().releaseUnits.some((u) => u.kind === "worker" || u.kind === "pages")) return;
    let cancelled = false;
    setDomainFactsLoading(true);
    setDomainFactsError(null);
    void getDomains(props.csrf, props.accountId, { pagesProjects })
      .then((envelope) => { if (!cancelled) { setDomainFacts(envelope); setDomainFactsFor(props.accountId); } })
      .catch((error) => { if (!cancelled) { setDomainFacts(null); setDomainFactsFor(props.accountId); setDomainFactsError(safeErrorMessage(error)); } })
      .finally(() => { if (!cancelled) setDomainFactsLoading(false); });
    return () => { cancelled = true; };
  }, [snap.stage, props.csrf, props.accountId, domainFactsFor]);
  const chosenZones = [...new Set(Object.values(domainDrafts).filter((draft) => draft.bind && draft.zone).map((draft) => draft.zone))];
  useEffect(() => {
    const missing = chosenZones.filter((zone) => !(zone in recordsByZone));
    if (missing.length === 0 || !props.csrf || !props.accountId) return;
    for (const zone of missing) {
      void getDomains(props.csrf, props.accountId, { zone })
        .then((envelope) => setRecordsByZone((prev) => ({ ...prev, [zone]: envelope.records ?? [] })))
        .catch(() => setRecordsByZone((prev) => ({ ...prev, [zone]: [] })));
    }
  }, [chosenZones.join(","), props.csrf, props.accountId]);
  useEffect(() => {
    if (snap.stage !== "configure") return;
    const units = machine.snapshot().releaseUnits.filter((u) => u.kind === "worker");
    if (units.length !== 1) return;
    if (!props.csrf || !props.accountId || upgradeTargetsFor === props.accountId) return;
    let cancelled = false;
    setUpgradeTargetsLoading(true);
    setUpgradeTargetsError(null);
    void getTargets(props.csrf, props.accountId)
      .then((envelope) => {
        if (cancelled) return;
        setUpgradeTargets(envelope.workers.map((w) => ({ name: w.name })));
        setUpgradeTargetsFor(props.accountId);
      })
      .catch((error) => {
        if (cancelled) return;
        setUpgradeTargets(null);
        setUpgradeTargetsFor(props.accountId);
        setUpgradeTargetsError(safeErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setUpgradeTargetsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [snap.stage, props.csrf, props.accountId, upgradeTargetsFor]);
  // first-install secret values collected in memory only (never
  // persisted, never sealed). Only prompt-policy secrets are asked for;
  // generate-once values are created server-side and never exposed.
  // Coverage probe: the one-shot OAuth is bound to the exact config it was
  // granted for. A different config needs its own authorization; the server
  // stays authoritative (plan/step still refuse with config_mismatch), but the
  // probe surfaces the explicit re-authorization state BEFORE any upload or
  // plan instead of a late 409.
  // onExpired is a fresh closure every parent render; keep it in a ref so the
  // probe below re-runs only when the csrf or config text actually changes.
  // Otherwise any parent re-render (accounts loaded, account picked) would
  // wipe the retained source/plan mid-flow.
  const onExpiredRef = useRef(props.onExpired);
  onExpiredRef.current = props.onExpired;
  const onReauthorizeRef = useRef(props.onReauthorize);
  onReauthorizeRef.current = props.onReauthorize;
  const onStageRef = useRef(props.onStage);
  onStageRef.current = props.onStage;
  useEffect(() => {
    onStageRef.current?.(snap.stage);
  }, [snap.stage]);
  useEffect(() => {
    let cancelled = false;
    setSnap(machine.reset());
    setSecretValues({});
    setInputValues({});
    setDomainDrafts({});
    setHyperdriveChoices({});
    setReleaseResources([]);
    setNameValues({});
    setInventory(null);
    setInventoryFor(null);
    setModeIntent("install");
    setPaidConfirmed(false);
    setStatuses([]);
    setMessage(null);
    void (async () => {
      try {
        const check = await checkConfigCoverage(props.csrf, props.configText);
        if (cancelled) return;
        if (check.matches) {
          setSnap(machine.setCoverage(true));
        } else if (check.reason === "invalid_config") {
          setSnap(machine.setCoverage(false, `This config is invalid: ${check.detail ?? "fix it at the config step."}`));
        } else {
          // The grant belongs to another config (or none): sign in again for this one.
          setSnap(machine.setCoverage(false, "Opening Cloudflare sign-in for this config…"));
          onReauthorizeRef.current();
        }
      } catch (error) {
        if (cancelled) return;
        if (isAuthFailure(error)) {
          onExpiredRef.current?.();
          return;
        }
        // Probe failure fails closed: do not offer upload/plan against an
        // unknown authorization state.
        setSnap(machine.setCoverage(false, `Could not verify that the Cloudflare authorization covers this config (${safeErrorMessage(error)}). Go back to the config and load it again.`));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.csrf, props.configText]);
  // first-install secret values collected in memory only (never
  // persisted, never sealed). Only prompt-policy secrets are asked for;
  // generate-once values are created server-side and never exposed.
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});

  const fail = (error: unknown) => {
    if (isAuthFailure(error)) {
      props.onExpired();
      return;
    }
    setMessage(safeErrorMessage(error));
  };

  const loadFile = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setSource(await retainV3SourceBytes(bytes, file.name));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const isValidReleaseUrl = (value: string) => /^https:\/\//i.test(value.trim());

  const prepare = async () => {
    if (!props.accountId) return;
    if (!machine.can("RELEASE_READY")) return;
    setBusy(true);
    setMessage(null);
    setSecretValues({});
    try {
      let retained = source;
      if (releaseMode === "url") {
        const url = assetUrl.trim();
        if (!isValidReleaseUrl(url)) throw new Error("enter a public HTTPS ZIP URL first");
        const bytes = await fetchReleaseBytes(url, props.csrf);
        retained = await retainV3SourceBytes(bytes, url);
        setSource(retained);
      }
      if (!retained) throw new Error("choose a release ZIP file first");
      const prepared = await prepareReleaseZip(props.csrf, retained.bytes);
      if (!prepared.releaseProof) throw new Error("prepare did not return a release proof");
      setReleaseResources(prepared.releaseSummary.resources ?? []);
      setNameValues({});
      setSnap(machine.setSource(retained, prepared.releaseProof, (prepared.releaseSummary.units ?? []).map((u) => ({ unitId: String(u.unitId), kind: String(u.kind), name: String(u.name), ...(Array.isArray(u.hyperdrive) && u.hyperdrive.length > 0 ? { hyperdrive: u.hyperdrive.map(String) } : {}) }))));
      // Prefill operator-editable names from the sealed release; the operator
      // may still change them on the configure stage (server re-validates).
      setInputValues((prev) => {
        const next = { ...prev };
        for (const unit of prepared.releaseSummary.units ?? []) {
          if (unit.kind === "worker" && next.workerName === undefined && typeof unit.name === "string" && unit.name) {
            next.workerName = unit.name;
            break;
          }
        }
        return next;
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  // Declared non-secret config inputs for the configure stage (the worker name
  // is prefilled from the sealed release). The server re-validates everything; this UI
  // is collection only and never persisted.
  const declaredInputs = declaredConfigInputs(props.configText);
  const appName = (() => {
    try {
      const name = (JSON.parse(props.configText) as { app?: { name?: unknown } }).app?.name;
      return typeof name === "string" && name ? name : props.appId;
    } catch {
      return props.appId;
    }
  })();

  const workerUnits = snap.releaseUnits.filter((u) => u.kind === "worker");
  const showModeToggle = workerUnits.length > 0;
  // The worker name is always operator-editable on install (prefilled from the
  // sealed release) and picker-assisted on upgrade; the server re-validates.
  // A flat name cannot address one unit of several: multi-executable releases
  // keep release names instead of failing late at plan.
  const renameAllowed = workerUnits.length === 1;
  const inventoryWorker = modeIntent === "upgrade" && renameAllowed ? inputValues.workerName ?? "" : "";
  const inventoryKey = `${props.accountId}|${inventoryWorker}`;
  useEffect(() => {
    if (snap.stage !== "configure" || !props.csrf || !props.accountId || releaseResources.length === 0 || inventoryFor === inventoryKey) return;
    let cancelled = false;
    setInventoryLoading(true);
    setInventoryError(null);
    const kinds = [...new Set(releaseResources.map((item) => item.kind))];
    void getInventory(props.csrf, props.accountId, kinds, inventoryWorker || undefined)
      .then((envelope) => { if (!cancelled) { setInventory(envelope); setInventoryFor(inventoryKey); } })
      .catch((error) => { if (!cancelled) { setInventory(null); setInventoryFor(inventoryKey); setInventoryError(safeErrorMessage(error)); } })
      .finally(() => { if (!cancelled) setInventoryLoading(false); });
    return () => { cancelled = true; };
  }, [snap.stage, props.csrf, props.accountId, releaseResources, inventoryKey, inventoryFor, inventoryWorker]);
  // Install names and upgrade picks mean different things: switching mode starts over.
  useEffect(() => { setNameValues({}); }, [modeIntent]);
  const names = nameRows(releaseResources, modeIntent, inventory, nameValues);
  const namesReady = names.every((row) => !row.error);
  const workerNameDef = declaredInputs.find((def) => def.key === "workerName");
  const visibleInputs = declaredInputs.filter((def) => def.key !== "workerName");
  const workerNameError = renameAllowed ? inputError("workerName", inputValues.workerName ?? "", { required: true, validation: workerNameDef?.validation }) : null;
  // New never updates a live Worker (the server refuses it too): an existing
  // name is flagged here with a switch to Upgrade instead of a late refusal.
  const nameTaken = modeIntent === "install" && renameAllowed && (upgradeTargets ?? []).some((target) => target.name === (inputValues.workerName ?? ""));
  const inputsReady = workerNameError === null && visibleInputs.every((def) => inputError(def.key, inputValues[def.key] ?? "", def) === null);
  const httpUnits: HttpUnit[] = snap.releaseUnits.flatMap((unit) => unit.kind === "worker" || unit.kind === "pages"
    ? [{ unitId: unit.unitId, kind: unit.kind, target: unit.kind === "worker" && renameAllowed && inputValues.workerName ? inputValues.workerName : names.find((row) => row.key === `pages:${unit.unitId}`)?.value || unit.name }]
    : []);
  const domainErrors = draftErrors(httpUnits, domainDrafts, domainFacts, recordsByZone, window.location.hostname);
  const domainsReady = Object.keys(domainErrors).length === 0;
  const hyperdriveUnits = snap.releaseUnits.flatMap((unit) => (unit.hyperdrive ?? []).length > 0
    ? [{ unitId: unit.unitId, target: unit.kind === "worker" && renameAllowed && inputValues.workerName ? inputValues.workerName : unit.name, bindings: unit.hyperdrive ?? [] }]
    : []);
  const hyperdriveReady = hyperdriveUnits.every((unit) => unit.bindings.every((binding) => (hyperdriveChoices[unit.unitId]?.[binding] ?? "") !== ""));

  const continueFromConfigure = async () => {
    const snapNow = machine.snapshot();
    if (!snapNow.releaseProof || !inputsReady) return;
    if (!machine.can("PLAN_READY")) return;
    // Empty values are omitted: an untouched optional input must not become an
    // (invalid) empty override server-side. The worker name is always sent
    // when set (it is required in the UI whenever the field is shown).
    const inputs: Record<string, string | number | boolean> = {};
    if (renameAllowed && (inputValues.workerName ?? "") !== "") inputs.workerName = inputValues.workerName as string;
    for (const def of visibleInputs) {
      const value = inputValues[def.key] ?? "";
      if (value !== "") inputs[def.key] = value;
    }
    setSnap(machine.setInputs(inputs, modeIntent));
    await plan(snapNow.releaseProof, inputs, false);
  };

  const plan = async (proof: unknown, inputs: Record<string, string | number | boolean>, paidRiskConfirmed: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const envelope = await fetchGraphPlan(props.csrf, {
        accountId: props.accountId,
        releaseProof: proof,
        config: { text: props.configText },
        ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        mode: modeIntent,
        ...(() => { const domains = domainRequest(httpUnits, domainDrafts, domainFacts, recordsByZone); return domains ? { domains } : {}; })(),
        ...(hyperdriveUnits.length > 0 ? { bindings: Object.fromEntries(hyperdriveUnits.map((unit) => [unit.unitId, { hyperdrive: { ...(hyperdriveChoices[unit.unitId] ?? {}) } }])) } : {}),
        ...(() => { const chosen = requestNames(names); return chosen ? { names: chosen } : {}; })(),
        paidRiskConfirmed,
      });
      if (envelope.error || !envelope.graphPlan) {
        throw Object.assign(new Error(envelope.detail ?? envelope.error ?? "plan failed"), { kind: envelope.error });
      }
      setSnap(machine.setPlan({
        graphPlan: envelope.graphPlan,
        executionContext: envelope.executionContext,
        approval: envelope.approval,
        ...(envelope.bundleDigests && typeof envelope.bundleDigests === "object" ? { bundleDigests: envelope.bundleDigests as Record<string, string> } : {}),
      }));
      setPaidConfirmed(paidRiskConfirmed);
    } catch (error) {
      // Defense in depth: a config that changed under a live session must
      // surface the re-authorization state even if the pre-plan probe was
      // bypassed. Server stays authoritative; this only re-routes the UI.
      if ((error as { kind?: unknown })?.kind === "config_mismatch") {
        setSnap(machine.setCoverage(false, "Opening Cloudflare sign-in for this config…"));
        props.onReauthorize();
        return;
      }
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const deploy = async () => {
    const s = machine.snapshot();
    if (!s.source || !s.releaseProof || !s.graphPlan || !s.executionContext || !s.approval) return;
        setStatuses([]);
    setMessage(null);
    setSnap(machine.startDeploy());
    const outcome = await runGraphDeploy({
      csrf: props.csrf,
      accountId: props.accountId,
      source: s.source,
      configText: props.configText,
      releaseProof: s.releaseProof,
      graphPlan: s.graphPlan as GraphPlan,
      executionContext: s.executionContext,
      approval: s.approval,
      ...(s.bundleDigests ? { bundleDigests: s.bundleDigests } : {}),
      ...(Object.keys(secretValues).length > 0 ? { secretValues: { ...secretValues } } : {}),
      ...(Object.values(domainDrafts).some((draft) => draft.bind && draft.confirmReplace) ? { confirmDomainChanges: true } : {}),
      onStep: (status) => setStatuses((prev) => [...prev.filter((entry) => !(entry.unitId === status.unitId && entry.phase === status.phase)), status]),
    });
    if (outcome.authExpired) {
      props.onExpired();
      return;
    }
    if (outcome.ok) {
      setSnap(machine.finishDeploy({ ok: true, ...(outcome.urls ? { urls: outcome.urls } : {}), ...(outcome.publishNote ? { publishNote: outcome.publishNote } : {}), verifiedReceipts: outcome.receipts.length }));
    } else {
      setSnap(machine.finishDeploy({
        ok: false,
        error: outcome.error ?? "deploy failed",
        ...(outcome.pending ? { pending: true } : {}),
        ...(outcome.failedAction ? { failedAction: `${phaseLabel(outcome.failedAction.phase)}${outcome.failedAction.name ? ` (${outcome.failedAction.name})` : ""}` } : {}),
        verifiedReceipts: outcome.receipts.length,
      }));
    }
  };

  const graphPlan = (snap.graphPlan ?? null) as GraphPlan | null;
  // The confirmation is sealed into the plan approval, so toggling it re-plans;
  // the checkbox stays visible (checked) once the confirmed plan arrives.
  const paidRisk = graphPlan?.cost.requiresConfirmation === true || undefined;
  const blocked = graphPlan !== null && (graphPlan.blocked || !snap.executionContext || !snap.approval);
  const secretPromptNames = secretPromptsFor(props.configText, graphPlan);
  const secretsReady = secretPromptNames.every(({ name }) => (secretValues[name] ?? "").length > 0);

  return (
    <section className="panel" data-testid="v3-flow">
      <div className="flow-head">
        <div className="min-w-0">
          <h2 className="m-0">Install {appName}</h2>
          <p className="meta m-0 break-all">{props.appId} · config from {props.sourceLabel}</p>
        </div>
        <button type="button" className="link text-sm" onClick={props.onExit} data-testid="v3-exit">Use another config</button>
      </div>
      {props.accounts.length > 1 && !props.accountId && (
        <p className="notice" data-testid="v3-account-required">Choose the Cloudflare account to install into (top right).</p>
      )}
      {snap.coverage === "checking" && (
        <p className="meta" role="status" data-testid="v3-coverage-checking">Checking that your Cloudflare sign-in covers this config…</p>
      )}
      {snap.coverage === "mismatch" && (
        <p className={snap.coverageNote?.startsWith("Opening") ? "meta" : "error-block"} role="status" data-testid="v3-coverage-mismatch">
          {snap.coverageNote ?? "This Cloudflare sign-in does not cover this config."}
        </p>
      )}
      {snap.coverage === "covered" && snap.stage === "release" && (
        <V3ReleasePanel
          releaseMode={releaseMode}
          onReleaseMode={(mode) => { setReleaseMode(mode); setSource(null); setFileKey((k) => k + 1); }}
          assetUrl={assetUrl}
          onAssetUrl={setAssetUrl}
          source={source}
          fileKey={fileKey}
          fileInputRef={fileInputRef}
          busy={busy}
          prepareDisabled={busy || !props.accountId || !machine.can("RELEASE_READY") || (releaseMode === "url" ? !isValidReleaseUrl(assetUrl) : !source)}
          onFile={(file) => void loadFile(file)}
          onPrepare={() => void prepare()}
        />
      )}
      {snap.coverage === "covered" && snap.stage === "configure" && (
        <V3ConfigurePanel
          sourceLabel={snap.source?.label ?? ""}
          releaseUnits={snap.releaseUnits}
          workerUnitCount={workerUnits.length}
          showModeToggle={showModeToggle}
          modeIntent={modeIntent}
          onModeIntent={setModeIntent}
          renameAllowed={renameAllowed}
          workerNameDef={workerNameDef}
          visibleInputs={visibleInputs}
          inputValues={inputValues}
          onInputValue={(key, value) => setInputValues((prev) => ({ ...prev, [key]: value }))}
          upgradeTargets={upgradeTargets}
          onSwitchToUpgrade={() => setModeIntent("upgrade")}
          upgradeTargetsLoading={upgradeTargetsLoading}
          upgradeTargetsError={upgradeTargetsError}
          extras={
            <>
            <V3NamesPanel
              rows={names}
              mode={modeIntent}
              loading={inventoryLoading}
              error={inventoryError}
              onName={(key, value) => setNameValues((prev) => ({ ...prev, [key]: value }))}
            />
            <V3HyperdrivePanel
              units={hyperdriveUnits}
              configs={hyperdriveConfigs}
              loading={hyperdriveLoading}
              error={hyperdriveError}
              choices={hyperdriveChoices}
              onChoice={(unitId, binding, config) => setHyperdriveChoices((prev) => ({ ...prev, [unitId]: { ...(prev[unitId] ?? {}), [binding]: config } }))}
            />
            <V3DomainsPanel
              units={httpUnits}
              mode={modeIntent}
              facts={domainFacts}
              factsLoading={domainFactsLoading}
              factsError={domainFactsError}
              recordsByZone={recordsByZone}
              drafts={domainDrafts}
              errors={domainErrors}
              selfHostname={window.location.hostname}
              onDraft={(unitId, draft) => setDomainDrafts((prev) => ({ ...prev, [unitId]: draft }))}
            />
            </>
          }
          continueDisabled={busy || !inputsReady || !namesReady || !domainsReady || !hyperdriveReady || !machine.can("PLAN_READY") || nameTaken}
          onBack={() => { setSnap(machine.backToRelease()); }}
          onContinue={() => void continueFromConfigure()}
        />
      )}
      <V3DeployPanel
        snap={snap}
        graphPlan={graphPlan}
        accountId={props.accountId}
        accounts={props.accounts}
        modeIntent={modeIntent}
        statuses={statuses}
        paidRisk={paidRisk}
        paidConfirmed={paidConfirmed}
        onPaidConfirm={(checked) => { setPaidConfirmed(checked); if (snap.releaseProof) void plan(snap.releaseProof, snap.inputs, checked); }}
        secretPromptNames={secretPromptNames}
        secretValues={secretValues}
        onSecretValue={(name, value) => setSecretValues((prev) => ({ ...prev, [name]: value }))}
        secretsReady={secretsReady}
        busy={busy}
        blocked={blocked}
        message={message}
        onBackToConfigure={() => { setSnap(machine.backToConfigure()); }}
        onDeploy={() => void deploy()}
        onStartOver={() => { setSnap(machine.backToRelease()); }}
      />
    </section>
  );
}
