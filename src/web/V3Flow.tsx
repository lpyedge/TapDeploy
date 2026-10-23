// The sealed-graph flow for one loaded config: release -> configure -> deploy.
// Both ZIP sources converge on retained exact bytes; prepare sends those
// identical bytes; plan forwards the server proof opaquely; steps forward the
// sealed context/approval with rehashed bytes and chained receipts. Typed
// body/token/unsupported errors surface; there is no fallback path. The server
// stays authoritative everywhere: this component only collects choices.

import { useEffect, useRef, useState } from "react";
import {
  checkConfigCoverage,
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
import { fetchReleaseBytes, retainV3SourceBytes, type V3RetainedSource } from "./release.js";
import { V3ReleasePanel } from "./V3ReleasePanel.js";
import { V3DeployPanel, secretProblem, secretPromptsFor } from "./V3DeployPanel.js";
import { V3ConfigurePanel } from "./V3ConfigurePanel.js";
import { V3DomainsPanel } from "./V3DomainsPanel.js";
import { V3HyperdrivePanel } from "./V3HyperdrivePanel.js";
import { V3NamesPanel } from "./V3NamesPanel.js";
import { changeableSecrets, declaredConfigInputs, inputError } from "./config-inputs.js";
import { appDisplayName, defaultSourceUrl } from "./config-text.js";
import { buildPlanRequest, httpUnitsFor, hyperdriveReady, hyperdriveUnitsFor, planInputs } from "./configure-model.js";
import { draftErrors } from "./domain-choices.js";
import { nameRows } from "./name-choices.js";
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
  onExpired: () => void;
  onStage?: (stage: V3Stage) => void;
  /** Re-authorize for the current config: persists first, then OAuth. */
  onReauthorize: () => void;
}

const isValidReleaseUrl = (value: string) => /^https:\/\//i.test(value.trim());

export function V3Flow(props: V3FlowProps) {
  const { csrf, accountId, configText } = props;
  const [machine] = useState(() => new V3FlowMachine());
  const [snap, setSnap] = useState<V3MachineSnapshot>(() => machine.snapshot());
  const form = useConfigureForm();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [paidConfirmed, setPaidConfirmed] = useState(false);
  const [statuses, setStatuses] = useState<GraphStepStatus[]>([]);

  // Release source is single-select: a URL download or a local file, never a
  // mix. Switching modes keeps the other input untouched but Prepare only
  // ever uses the active one; picking a new file replaces the retained bytes.
  const [assetUrl, setAssetUrl] = useState(() => defaultSourceUrl(configText));
  const [releaseMode, setReleaseMode] = useState<"url" | "file">("url");
  const [fileKey, setFileKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [source, setSource] = useState<V3RetainedSource | null>(null);
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
    setPaidConfirmed(false);
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

  const loadFile = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      setSource(await retainV3SourceBytes(new Uint8Array(await file.arrayBuffer()), file.name));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const prepare = async () => {
    if (!accountId || !machine.can("RELEASE_READY")) return;
    setBusy(true);
    setMessage(null);
    form.clearSecrets();
    try {
      let retained = source;
      if (releaseMode === "url") {
        const url = assetUrl.trim();
        if (!isValidReleaseUrl(url)) throw new Error("enter a public HTTPS ZIP URL first");
        retained = await retainV3SourceBytes(await fetchReleaseBytes(url, csrf), url);
        setSource(retained);
      }
      if (!retained) throw new Error("choose a release ZIP file first");
      const prepared = await prepareReleaseZip(csrf, retained.bytes);
      if (!prepared.releaseProof) throw new Error("prepare did not return a release proof");
      const units = prepared.releaseSummary.units ?? [];
      setReleaseResources(prepared.releaseSummary.resources ?? []);
      setSnap(machine.setSource(retained, prepared.releaseProof, units.map((u) => ({ unitId: String(u.unitId), kind: String(u.kind), name: String(u.name), ...(Array.isArray(u.hyperdrive) && u.hyperdrive.length > 0 ? { hyperdrive: u.hyperdrive.map(String) } : {}) }))));
      // Prefill the Worker name from the sealed release; the operator may
      // still change it on the configure stage (the server re-validates).
      form.startRelease(units.find((unit) => unit.kind === "worker" && typeof unit.name === "string" && unit.name)?.name);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
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
  const inventory = useLoaded(canFetch && inventoryKinds.length > 0 ? `${accountId}|${inventoryWorker}|${inventoryKinds.join(",")}` : null, () => getInventory(csrf, accountId, inventoryKinds, inventoryWorker || undefined));
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
  const inputsReady = (!renameAllowed || checkWorkerName(workerNameDef, workerName) === null)
    && shownInputs.every((def) => inputError(def, form.mode, form.inputValues[def.key] ?? "") === null);
  const configureReady = !busy && inputsReady && names.every((row) => !row.error) && Object.keys(domainErrors).length === 0
    && hyperdriveReady(hyperdriveUnits, form.hyperdriveChoices) && machine.can("PLAN_READY") && !nameTaken;

  const plan = async (proof: unknown, inputs: Record<string, string | number | boolean>, paidRiskConfirmed: boolean) => {
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
        replacedSecrets: form.replacedSecrets,
        paidRiskConfirmed,
      }));
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

  const continueFromConfigure = async () => {
    const proof = machine.snapshot().releaseProof;
    if (!proof || !inputsReady || !machine.can("PLAN_READY")) return;
    const inputs = planInputs(renameAllowed, form.inputValues, shownInputs);
    setSnap(machine.setInputs(inputs, form.mode));
    await plan(proof, inputs, false);
  };

  // ---- Deploy step ---------------------------------------------------------
  const deploy = async () => {
    const s = machine.snapshot();
    if (!s.source || !s.releaseProof || !s.graphPlan || !s.executionContext || !s.approval) return;
    setStatuses([]);
    setMessage(null);
    setSnap(machine.startDeploy());
    const outcome = await runGraphDeploy({
      csrf,
      accountId,
      source: s.source,
      configText,
      releaseProof: s.releaseProof,
      graphPlan: s.graphPlan as GraphPlan,
      executionContext: s.executionContext,
      approval: s.approval,
      ...(s.bundleDigests ? { bundleDigests: s.bundleDigests } : {}),
      ...(Object.keys(form.secretValues).length > 0 ? { secretValues: { ...form.secretValues } } : {}),
      ...(Object.values(form.domainDrafts).some((draft) => draft.bind && draft.confirmReplace) ? { confirmDomainChanges: true } : {}),
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
  const secretPrompts = secretPromptsFor(configText, graphPlan);
  const secretsReady = secretPrompts.every((prompt) => (form.secretValues[prompt.name] ?? "").length > 0 && secretProblem(prompt, form.secretValues[prompt.name] ?? "") === null);

  return (
    <section className="panel" data-testid="v3-flow">
      <div className="flow-head">
        <div className="min-w-0">
          <h2 className="m-0">Install {appDisplayName(configText, props.appId)}</h2>
          <p className="meta m-0 break-all">{props.appId} · config from {props.sourceLabel}</p>
        </div>
        <button type="button" className="link text-sm" onClick={props.onExit} data-testid="v3-exit">Use another config</button>
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
          releaseMode={releaseMode}
          onReleaseMode={(mode) => { setReleaseMode(mode); setSource(null); setFileKey((k) => k + 1); }}
          assetUrl={assetUrl}
          onAssetUrl={setAssetUrl}
          source={source}
          fileKey={fileKey}
          fileInputRef={fileInputRef}
          busy={busy}
          prepareDisabled={busy || !accountId || !machine.can("RELEASE_READY") || (releaseMode === "url" ? !isValidReleaseUrl(assetUrl) : !source)}
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
          secretsToChange={changeableSecrets(configText)}
          replacedSecrets={form.replacedSecrets}
          onReplaceSecret={form.replaceSecret}
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
        paidConfirmed={paidConfirmed}
        onPaidConfirm={(checked) => { setPaidConfirmed(checked); if (snap.releaseProof) void plan(snap.releaseProof, snap.inputs, checked); }}
        secretPromptNames={secretPrompts}
        secretValues={form.secretValues}
        onSecretValue={form.setSecret}
        secretsReady={secretsReady}
        busy={busy}
        blocked={blocked}
        message={message}
        onBackToConfigure={() => setSnap(machine.backToConfigure())}
        onDeploy={() => void deploy()}
        onStartOver={() => setSnap(machine.backToRelease())}
      />
    </section>
  );
}
