// The sealed-graph flow for one loaded config: release -> configure -> deploy.
// Both ZIP sources converge on retained exact bytes; prepare sends those
// identical bytes; plan forwards the server proof opaquely; steps forward the
// sealed context/approval with rehashed bytes and chained receipts. Typed
// body/token/unsupported errors surface; there is no fallback path. The server
// stays authoritative everywhere: this component only collects choices.

import { useEffect, useRef, useState } from "react";
import {
  checkConfigCoverage,
  failure,
  fetchGraphPlan,
  getDomains,
  getHyperdriveConfigs,
  getInventory,
  getTargets,
  isAuthFailure,
  prepareReleaseZip,
  type AccountSummary,
  type GraphPlan,
  type ReleaseResourceName,
} from "./api.js";
import { V3FlowMachine, type V3MachineSnapshot, type V3Stage } from "./v3-flow-machine.js";
import { runGraphDeploy, type GraphStepStatus } from "./graph-deploy-runner.js";
import { safeErrorMessage } from "./deploy-shared.js";
import { fetchReleaseBytes, type V3RetainedSource } from "./release.js";
import { ReleaseAnalysisCancelled, startReleaseAnalysis, type ReleaseAnalysisJob } from "./compute/client.js";
import { RELEASE_MAX_BYTES } from "../core/upload-limits.js";
import { formatBytes } from "./lib/guarded-fetch.js";
import { releasePolicyFromConfigText } from "./compute/release-policy.js";
import { releaseRefusalMessage } from "./compute/refusal-message.js";
import { V3ReleasePanel, type ReleaseStage } from "./V3ReleasePanel.js";
import { V3DeployPanel } from "./V3DeployPanel.js";
import { V3ConfigurePanel } from "./V3ConfigurePanel.js";
import { V3DomainsPanel } from "./V3DomainsPanel.js";
import { V3HyperdrivePanel } from "./V3HyperdrivePanel.js";
import { V3NamesPanel } from "./V3NamesPanel.js";
import { declaredConfigInputs, declaredSecrets, inputError } from "./config-inputs.js";
import { allowsLocalZip, appDisplayName, defaultSourceUrl } from "./config-text.js";
import { buildPlanRequest, httpUnitsFor, hyperdriveReady, hyperdriveUnitsFor, planInputs } from "./configure-model.js";
import { draftErrors } from "./domain-choices.js";
import { nameRows } from "./name-choices.js";
import { secretNeedsFor, secretRows, secretValueProblem, secretsAwaitingValue, unmetSecretNeeds } from "./secret-choices.js";
import { phaseLabel } from "./step-labels.js";
import { useConfigureForm } from "./use-configure-form.js";
import { useLoaded } from "./use-loaded.js";
import { useZoneRecords } from "./use-zone-records.js";
import { workerNameError as checkWorkerName } from "./V3WorkerTarget.js";
import { inputAskedIn } from "../manifest/input-validation.js";

export interface V3FlowProps {
  csrf: string;
  accountId: string;
  accounts: AccountSummary[];
  configText: string;
  appId: string;
  sourceLabel: string;
  onExit: () => void;
  onSignOut: () => void;
  onExpired: () => void;
  onStage?: (stage: V3Stage) => void;
  /** Re-authorize for the current config: persists first, then OAuth. */
  onReauthorize: () => void;
}

const isValidReleaseUrl = (value: string) => /^https:\/\//i.test(value.trim());

/** What the operator confirmed on the review: billable operations, taking over Workers TapDeploy did not deploy. */
interface PlanConfirmations { paidRisk: boolean; takeover: boolean }
const NO_CONFIRMATIONS: PlanConfirmations = { paidRisk: false, takeover: false };

export function V3Flow(props: V3FlowProps) {
  const { csrf, accountId, configText } = props;
  const [machine] = useState(() => new V3FlowMachine());
  const [snap, setSnap] = useState<V3MachineSnapshot>(() => machine.snapshot());
  const form = useConfigureForm();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Review confirmations; each is sealed into the plan approval, so changing one re-plans.
  const [confirmed, setConfirmed] = useState<PlanConfirmations>(NO_CONFIRMATIONS);
  // Secrets the last plan creates on this target (the Worker has none yet):
  // Configure asks for them even when it could not read the Worker's secrets.
  const [planSecretCreates, setPlanSecretCreates] = useState<{ target: string; names: string[] }>({ target: "", names: [] });
  const [statuses, setStatuses] = useState<GraphStepStatus[]>([]);

  // The release comes from one place: a ZIP chosen on this computer when there
  // is one, otherwise the download link. Verifying uses exactly that.
  const [assetUrl, setAssetUrl] = useState(() => defaultSourceUrl(configText));
  const [fileKey, setFileKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [localFile, setLocalFile] = useState<V3RetainedSource | null>(null);
  const [releaseStage, setReleaseStage] = useState<ReleaseStage | null>(null);
  const [stopping, setStopping] = useState(false);
  const [releaseResources, setReleaseResources] = useState<ReleaseResourceName[]>([]);

  // onExpired / onReauthorize / onStage are fresh closures on every parent
  // render; refs keep the coverage probe below from re-running (and wiping the
  // retained source and plan mid-flow) whenever the parent re-renders.
  const onExpiredRef = useRef(props.onExpired);
  onExpiredRef.current = props.onExpired;
  const onReauthorizeRef = useRef(props.onReauthorize);
  onReauthorizeRef.current = props.onReauthorize;
  const onStageRef = useRef(props.onStage);
  onStageRef.current = props.onStage;
  useEffect(() => { onStageRef.current?.(snap.stage); }, [snap.stage]);
  // A step change removes the button the keyboard or screen reader was on:
  // land on the flow heading instead of the top of the document.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const stageSeen = useRef(snap.stage);
  useEffect(() => {
    if (stageSeen.current === snap.stage) return;
    stageSeen.current = snap.stage;
    headingRef.current?.focus();
  }, [snap.stage]);

  // Coverage probe: the one-shot OAuth is bound to the exact config it was
  // granted for. A different config needs its own authorization; the server
  // stays authoritative (plan/step still refuse with config_mismatch), but the
  // probe surfaces the explicit re-authorization state BEFORE any upload or
  // plan instead of a late 409.
  useEffect(() => {
    let cancelled = false;
    setSnap(machine.reset());
    form.reset();
    setReleaseResources([]);
    setConfirmed(NO_CONFIRMATIONS);
    setPlanSecretCreates({ target: "", names: [] });
    setStatuses([]);
    setMessage(null);
    void (async () => {
      try {
        const check = await checkConfigCoverage(csrf, configText);
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
    return () => { cancelled = true; };
  }, [csrf, configText]);

  const fail = (error: unknown) => {
    if (isAuthFailure(error)) {
      props.onExpired();
      return;
    }
    setMessage(safeErrorMessage(error));
  };

  // The ZIP is unpacked and checked in a Worker so the page stays responsive;
  // the server still verifies the same bytes again before any proof exists.
  // The extracted files stay in that Worker (one per source); this flow owns at
  // most one live source and releases it when replaced, removed or unmounted.
  const analysisRef = useRef<ReleaseAnalysisJob | null>(null);
  const liveSourceRef = useRef<V3RetainedSource | null>(null);
  useEffect(() => () => {
    runRef.current += 1;
    prepareAbortRef.current?.abort();
    analysisRef.current?.cancel();
    liveSourceRef.current?.access.dispose();
    deployAbortRef.current?.abort();
  }, []);
  const analyze = async (blob: Blob, label: string): Promise<V3RetainedSource> => {
    const policy = releasePolicyFromConfigText(configText);
    if (!policy) throw new Error("This config is invalid: fix it at the config step.");
    analysisRef.current?.cancel();
    const job = startReleaseAnalysis(blob, policy);
    analysisRef.current = job;
    const analysis = await job.result;
    if (!analysis.ok) {
      const friendly = releaseRefusalMessage(analysis, { bytes: blob.size, expectedSha256: policy.expectedSha256 });
      throw friendly ? new Error(friendly) : failure(analysis.status, analysis.body);
    }
    liveSourceRef.current?.access.dispose();
    const source = { blob, access: analysis.access, label };
    liveSourceRef.current = source;
    return source;
  };
  const releaseSource = () => { liveSourceRef.current?.access.dispose(); liveSourceRef.current = null; };

  // One release run at a time. Cancel (or a newer run) bumps the run number, so a
  // superseded run can neither update the page nor install a source afterwards.
  const runRef = useRef(0);
  const prepareAbortRef = useRef<AbortController | null>(null);
  const cancelRelease = () => {
    runRef.current += 1;
    analysisRef.current?.cancel();
    prepareAbortRef.current?.abort();
    setReleaseStage(null);
    setBusy(false);
  };

  const analyzeInRun = async (run: number, blob: Blob, label: string): Promise<V3RetainedSource | null> => {
    setReleaseStage("analyzing");
    const source = await analyze(blob, label);
    if (run !== runRef.current) {
      source.access.dispose();
      return null;
    }
    return source;
  };

  const loadFile = async (file: File) => {
    if (file.size > RELEASE_MAX_BYTES) {
      setMessage(`This ZIP is ${formatBytes(file.size)}; the installer can verify up to ${formatBytes(RELEASE_MAX_BYTES)}.`);
      return;
    }
    const run = ++runRef.current;
    setBusy(true);
    setMessage(null);
    try {
      const source = await analyzeInRun(run, file, file.name);
      if (source) setLocalFile(source);
    } catch (error) {
      if (run === runRef.current && !(error instanceof ReleaseAnalysisCancelled)) fail(error);
    } finally {
      if (run === runRef.current) { setBusy(false); setReleaseStage(null); }
    }
  };

  const prepare = async () => {
    if (!accountId || !machine.can("RELEASE_READY")) return;
    const run = ++runRef.current;
    setBusy(true);
    setMessage(null);
    form.clearSecrets();
    // Cancel aborts whichever network call this run is in (download or server verify).
    const abort = new AbortController();
    prepareAbortRef.current = abort;
    try {
      let retained = localFile;
      if (!retained) {
        const url = assetUrl.trim();
        if (!isValidReleaseUrl(url)) throw new Error("enter a public HTTPS ZIP URL or choose a ZIP file first");
        setReleaseStage("reading");
        const bytes = await fetchReleaseBytes(url, csrf, abort.signal);
        if (run !== runRef.current) return;
        retained = await analyzeInRun(run, new Blob([bytes as BlobPart]), url);
        if (!retained) return;
      }
      setReleaseStage("verifying");
      const prepared = await prepareReleaseZip(csrf, configText, retained.blob, abort.signal);
      if (run !== runRef.current) return;
      if (!prepared.releaseProof) throw new Error("prepare did not return a release proof");
      const units = prepared.releaseSummary.units ?? [];
      setReleaseResources(prepared.releaseSummary.resources ?? []);
      setSnap(machine.setSource(retained, prepared.releaseProof, units.map((u) => ({ unitId: String(u.unitId), kind: String(u.kind), name: String(u.name), ...(Array.isArray(u.hyperdrive) && u.hyperdrive.length > 0 ? { hyperdrive: u.hyperdrive.map(String) } : {}) }))));
      // Prefill the Worker name from the sealed release; the operator may
      // still change it on the configure stage (the server re-validates).
      form.startRelease(units.find((unit) => unit.kind === "worker" && typeof unit.name === "string" && unit.name)?.name);
    } catch (error) {
      if (run === runRef.current && !(error instanceof ReleaseAnalysisCancelled)) fail(error);
    } finally {
      if (run === runRef.current) { setBusy(false); setReleaseStage(null); }
    }
  };

  // ---- Configure step ------------------------------------------------------
  const configuring = snap.stage === "configure";
  const workerUnits = snap.releaseUnits.filter((unit) => unit.kind === "worker");
  // The Worker name is always operator-editable on install (prefilled from the
  // sealed release) and picker-assisted on upgrade. A flat name cannot address
  // one unit of several: multi-executable releases keep release names.
  const renameAllowed = workerUnits.length === 1;
  const workerName = form.inputValues.workerName ?? "";
  const canFetch = configuring && !!csrf && !!accountId;
  const hasUnit = (kinds: readonly string[]) => snap.releaseUnits.some((unit) => kinds.includes(unit.kind));

  const hyperdrive = useLoaded(canFetch && snap.releaseUnits.some((unit) => (unit.hyperdrive ?? []).length > 0) ? accountId : null, () => getHyperdriveConfigs(csrf, accountId));
  const domainFacts = useLoaded(canFetch && hasUnit(["worker", "pages"]) ? accountId : null, () => getDomains(csrf, accountId, { pagesProjects: snap.releaseUnits.filter((unit) => unit.kind === "pages").map((unit) => unit.name) }));
  const upgradeTargets = useLoaded(canFetch && workerUnits.length === 1 ? accountId : null, async () => (await getTargets(csrf, accountId)).workers.map((worker) => ({ name: worker.name })));
  const inventoryWorker = form.mode === "upgrade" && renameAllowed ? workerName : "";
  const inventoryKinds = [...new Set(releaseResources.map((item) => item.kind))];
  // An upgrade also reads the target's secret names, so Configure knows which secrets it can keep.
  const wantsTargetSecrets = inventoryWorker !== "" && declaredSecrets(configText).some((def) => !def.generate);
  const inventory = useLoaded(canFetch && (inventoryKinds.length > 0 || wantsTargetSecrets) ? `${accountId}|${inventoryWorker}|${inventoryKinds.join(",")}` : null, () => getInventory(csrf, accountId, inventoryKinds, inventoryWorker || undefined));
  const recordsByZone = useZoneRecords(csrf, accountId, [...new Set(Object.values(form.domainDrafts).filter((draft) => draft.bind && draft.zone).map((draft) => draft.zone))]);

  const declaredInputs = declaredConfigInputs(configText);
  const workerNameDef = declaredInputs.find((def) => def.key === "workerName");
  const shownInputs = declaredInputs.filter((def) => def.key !== "workerName" && inputAskedIn(def, form.mode));
  const names = nameRows(releaseResources, form.mode, inventory.data, form.nameValues);
  const httpUnits = httpUnitsFor(snap.releaseUnits, renameAllowed, workerName, names);
  const hyperdriveUnits = hyperdriveUnitsFor(snap.releaseUnits, renameAllowed, workerName);
  const domainErrors = draftErrors(httpUnits, form.domainDrafts, domainFacts.data, recordsByZone, window.location.hostname);
  // New never updates a live Worker (the server refuses it too): an existing
  // name is flagged in the panel with a switch to Upgrade instead of a late refusal.
  const nameTaken = form.mode === "install" && renameAllowed && (upgradeTargets.data ?? []).some((target) => target.name === workerName);
  const secretTarget = `${form.mode}|${workerName}`;
  const secrets = secretRows(configText, form.mode, inventoryWorker !== "" ? inventory.data?.secrets ?? null : null, planSecretCreates.target === secretTarget ? planSecretCreates.names : []);
  // Only a secret the target keeps can be replaced; a missing one is created.
  const replacedSecrets = form.replacedSecrets.filter((key) => secrets.some((row) => !row.required && row.def.key === key));
  const secretsReady = secretsAwaitingValue(secrets, replacedSecrets).every(({ def }) => (form.secretValues[def.key] ?? "") !== "" && secretValueProblem(def, form.secretValues[def.key] ?? "") === null);
  const inputsReady = (!renameAllowed || checkWorkerName(workerNameDef, workerName) === null)
    && shownInputs.every((def) => inputError(def, form.mode, form.inputValues[def.key] ?? "") === null) && secretsReady;
  const configureReady = !busy && !inventory.loading && !upgradeTargets.loading && inputsReady && names.every((row) => !row.error) && Object.keys(domainErrors).length === 0
    && hyperdriveReady(hyperdriveUnits, form.hyperdriveChoices) && machine.can("PLAN_READY") && !nameTaken;

  const plan = async (proof: unknown, inputs: Record<string, string | number | boolean>, confirmations: PlanConfirmations) => {
    setBusy(true);
    setMessage(null);
    try {
      const envelope = await fetchGraphPlan(csrf, buildPlanRequest({
        accountId,
        releaseProof: proof,
        configText,
        inputs,
        mode: form.mode,
        httpUnits,
        domainDrafts: form.domainDrafts,
        domainFacts: domainFacts.data,
        recordsByZone,
        hyperdriveUnits,
        hyperdriveChoices: form.hyperdriveChoices,
        names,
        replacedSecrets,
        paidRiskConfirmed: confirmations.paidRisk,
        takeoverConfirmed: confirmations.takeover,
      }));
      if (envelope.error || !envelope.graphPlan) {
        throw Object.assign(new Error(envelope.detail ?? envelope.error ?? "plan failed"), { kind: envelope.error });
      }
      setSnap(machine.setPlan({
        graphPlan: envelope.graphPlan,
        executionContext: envelope.executionContext,
        approval: envelope.approval,
        ...(envelope.bundleDigests && typeof envelope.bundleDigests === "object" ? { bundleDigests: envelope.bundleDigests as Record<string, string> } : {}),
        ...(envelope.schedulerHints !== undefined ? { schedulerHints: envelope.schedulerHints } : {}),
      }));
      setConfirmed(confirmations);
      setPlanSecretCreates({ target: secretTarget, names: secretNeedsFor(configText, envelope.graphPlan).filter((need) => need.create).map((need) => need.name) });
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

  const continueFromConfigure = async () => {
    if (!configureReady) return;
    const proof = machine.snapshot().releaseProof;
    if (!proof || !inputsReady || !machine.can("PLAN_READY")) return;
    const inputs = planInputs(renameAllowed, form.inputValues, shownInputs);
    setSnap(machine.setInputs(inputs, form.mode));
    await plan(proof, inputs, NO_CONFIRMATIONS);
  };

  // ---- Deploy step ---------------------------------------------------------
  // Stop only holds back future actions: the step in flight finishes (a provider
  // write cannot be taken back mid-request) and nothing already written is undone.
  const deployAbortRef = useRef<AbortController | null>(null);
  const stopDeploy = () => { setStopping(true); deployAbortRef.current?.abort(); };
  const deploy = async () => {
    if (deployAbortRef.current) return;
    const s = machine.snapshot();
    if (!s.source || !s.releaseProof || !s.graphPlan || !s.executionContext || !s.approval) return;
    setStatuses([]);
    setMessage(null);
    // Only the values the approved plan needs travel, never one left over from another choice.
    const secretValues = Object.fromEntries(secretNeedsFor(configText, s.graphPlan as GraphPlan).map((need) => [need.name, form.secretValues[need.name] ?? ""]).filter(([, value]) => value !== ""));
    setSnap(machine.startDeploy());
    const stop = new AbortController();
    deployAbortRef.current = stop;
    setStopping(false);
    const outcome = await runGraphDeploy({
      signal: stop.signal,
      csrf,
      accountId,
      source: s.source,
      configText,
      releaseProof: s.releaseProof,
      graphPlan: s.graphPlan as GraphPlan,
      executionContext: s.executionContext,
      approval: s.approval,
      ...(s.bundleDigests ? { bundleDigests: s.bundleDigests } : {}),
      ...(s.schedulerHints ? { schedulerHints: s.schedulerHints } : {}),
      ...(Object.keys(secretValues).length > 0 ? { secretValues } : {}),
      ...(Object.values(form.domainDrafts).some((draft) => draft.bind && draft.confirmReplace) ? { confirmDomainChanges: true } : {}),
      onStep: (status) => setStatuses((prev) => [...prev.filter((entry) => !(entry.unitId === status.unitId && entry.phase === status.phase)), status]),
    });
    deployAbortRef.current = null;
    setStopping(false);
    if (outcome.authExpired) {
      props.onExpired();
      return;
    }
    if (outcome.ok) {
      setSnap(machine.finishDeploy({ ok: true, ...(outcome.urls ? { urls: outcome.urls } : {}), ...(outcome.publishNote ? { publishNote: outcome.publishNote } : {}), verifiedReceipts: outcome.receipts.length }));
    } else {
      setSnap(machine.finishDeploy({
        ok: false,
        error: stop.signal.aborted ? "You stopped the deployment. Steps that already finished stay live; nothing was rolled back." : (outcome.error ?? "deploy failed"),
        ...(outcome.pending ? { pending: true } : {}),
        ...(outcome.failedAction ? { failedAction: `${phaseLabel(outcome.failedAction.phase)}${outcome.failedAction.name ? ` (${outcome.failedAction.name})` : ""}` } : {}),
        verifiedReceipts: outcome.receipts.length,
      }));
    }
  };

  // Signing out mid-deploy would end the session under the running steps.
  const deploying = snap.deployRunning;
  const graphPlan = (snap.graphPlan ?? null) as GraphPlan | null;
  // A confirmation is sealed into the plan approval, so toggling it re-plans;
  // its checkbox stays visible (checked) once the confirmed plan arrives.
  const paidRisk = graphPlan?.cost.requiresConfirmation === true || undefined;
  const reconfirm = (next: PlanConfirmations) => { setConfirmed(next); if (snap.releaseProof) void plan(snap.releaseProof, snap.inputs, next); };
  const blocked = graphPlan !== null && (graphPlan.blocked || !snap.executionContext || !snap.approval);
  const unmetSecrets = unmetSecretNeeds(secretNeedsFor(configText, graphPlan), form.secretValues);

  return (
    <section className="panel" data-testid="v3-flow">
      <div className="flow-head">
        <div className="min-w-0">
          <h2 className="m-0 outline-none" ref={headingRef} tabIndex={-1}>Install {appDisplayName(configText, props.appId)}</h2>
          <p className="meta m-0 break-all">{props.appId} · config from {props.sourceLabel}</p>
        </div>
        <div className="flex shrink-0 gap-4">
          <button type="button" className="link text-sm" disabled={busy || deploying} onClick={props.onExit} data-testid="v3-exit">Use another config</button>
          {!deploying && <button type="button" className="link text-sm" disabled={busy} onClick={props.onSignOut} data-testid="v3-sign-out">Sign out</button>}
        </div>
      </div>
      {props.accounts.length > 1 && !accountId && (
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
          assetUrl={assetUrl}
          onAssetUrl={setAssetUrl}
          localFile={localFile}
          allowLocalZip={allowsLocalZip(configText)}
          stage={releaseStage}
          onCancel={cancelRelease}
          onClearFile={() => { releaseSource(); setLocalFile(null); setFileKey((k) => k + 1); }}
          fileKey={fileKey}
          fileInputRef={fileInputRef}
          busy={busy}
          prepareDisabled={busy || !accountId || !machine.can("RELEASE_READY") || (!localFile && !isValidReleaseUrl(assetUrl))}
          onFile={(file) => void loadFile(file)}
          onPrepare={() => void prepare()}
        />
      )}
      {snap.coverage === "covered" && configuring && (
        <V3ConfigurePanel
          sourceLabel={snap.source?.label ?? ""}
          releaseUnits={snap.releaseUnits}
          workerUnitCount={workerUnits.length}
          showModeToggle={workerUnits.length > 0}
          modeIntent={form.mode}
          onModeIntent={form.changeMode}
          renameAllowed={renameAllowed}
          workerNameDef={workerNameDef}
          visibleInputs={shownInputs}
          inputValues={form.inputValues}
          onInputValue={form.setInput}
          secretRows={secrets}
          replacedSecrets={replacedSecrets}
          onReplaceSecret={form.replaceSecret}
          secretValues={form.secretValues}
          onSecretValue={form.setSecret}
          upgradeTargets={upgradeTargets.data}
          upgradeTargetsLoading={upgradeTargets.loading}
          upgradeTargetsError={upgradeTargets.error}
          onSwitchToUpgrade={() => form.changeMode("upgrade")}
          required={
            <V3HyperdrivePanel
              units={hyperdriveUnits}
              configs={hyperdrive.data}
              loading={hyperdrive.loading}
              error={hyperdrive.error}
              choices={form.hyperdriveChoices}
              onChoice={form.setHyperdriveChoice}
            />
          }
          hasOptional={names.length > 0 || httpUnits.length > 0}
          optional={
            <>
              <V3NamesPanel rows={names} mode={form.mode} loading={inventory.loading} error={inventory.error} onName={form.setName} />
              <V3DomainsPanel
                units={httpUnits}
                mode={form.mode}
                facts={domainFacts.data}
                factsLoading={domainFacts.loading}
                factsError={domainFacts.error}
                recordsByZone={recordsByZone}
                drafts={form.domainDrafts}
                errors={domainErrors}
                selfHostname={window.location.hostname}
                onDraft={form.setDraft}
              />
            </>
          }
          continueDisabled={!configureReady}
          planning={busy}
          onBack={() => setSnap(machine.backToRelease())}
          onContinue={() => void continueFromConfigure()}
        />
      )}
      <V3DeployPanel
        snap={snap}
        graphPlan={graphPlan}
        csrf={csrf}
        accountId={accountId}
        accounts={props.accounts}
        modeIntent={form.mode}
        statuses={statuses}
        paidRisk={paidRisk}
        paidConfirmed={confirmed.paidRisk}
        onPaidConfirm={(checked) => reconfirm({ ...confirmed, paidRisk: checked })}
        takeoverWorkers={graphPlan?.takeover.workers ?? []}
        takeoverConfirmed={confirmed.takeover}
        onTakeoverConfirm={(checked) => reconfirm({ ...confirmed, takeover: checked })}
        unmetSecrets={unmetSecrets}
        busy={busy}
        blocked={blocked}
        message={message}
        stopping={stopping}
        onStop={stopDeploy}
        onBackToConfigure={() => setSnap(machine.backToConfigure())}
        onDeploy={() => void deploy()}
        onStartOver={() => setSnap(machine.backToRelease())}
      />
    </section>
  );
}
