// Sealed-graph wizard state machine (V3 flow).
//
// Stages mirror the operator journey: release (pick a ZIP) -> configure
// (operator inputs, e.g. worker name, install/upgrade intent) -> deploy
// (sealed plan review + confirm + inline progress + verdict).
//
// One cached object owns every step's state; stages advance only through the
// transition table below, whose guards are checked in a single place. Illegal
// transitions throw (programmer error, fail closed in dev) instead of silently
// rendering a stale plan. The server stays authoritative: every guard here is
// a UX precondition, never a security decision — prepare/plan/step re-verify
// everything. Coverage (one-shot OAuth bound to the exact config) is
// orthogonal and lives alongside the stage.

import type { V3RetainedSource } from "./release.js";

export type V3Stage = "release" | "configure" | "deploy" | "done";
type V3Coverage = "checking" | "covered" | "mismatch";

export type V3MachineEvent =
  | "COVERED"
  | "MISMATCH"
  | "RELEASE_READY"
  | "CONFIGURED"
  | "PLAN_READY"
  | "DEPLOY_FINISHED"
  | "BACK_TO_RELEASE"
  | "BACK_TO_CONFIGURE"
  | "RESET";

export interface V3MachineSnapshot {
  stage: V3Stage;
  coverage: V3Coverage;
  coverageNote: string | null;
  source: V3RetainedSource | null;
  releaseProof: unknown | null;
  releaseUnits: Array<{ unitId: string; kind: string; name: string; hyperdrive?: string[] }>;
  inputs: Record<string, string | number | boolean>;
  modeIntent: "install" | "upgrade";
  graphPlan: unknown | null;
  executionContext: unknown | null;
  approval: unknown | null;
  bundleDigests: Record<string, string> | undefined;
  schedulerHints: unknown | null;
  deployOk: boolean | null;
  deployRunning: boolean;
  deployError: string | null;
  deployUrls: string[];
  deployNote: string | null;
  deployPending: boolean;
  failedAction: string | null;
  verifiedReceipts: number;
}

const initialSnapshot = (): V3MachineSnapshot => ({
  stage: "release",
  coverage: "checking",
  coverageNote: null,
  source: null,
  releaseProof: null,
  releaseUnits: [],
  inputs: {},
  modeIntent: "install",
  graphPlan: null,
  executionContext: null,
  approval: null,
  bundleDigests: undefined,
  schedulerHints: null,
  deployOk: null,
  deployRunning: false,
  deployError: null,
  deployUrls: [],
  deployNote: null,
  deployPending: false,
  failedAction: null,
  verifiedReceipts: 0,
});

// Allowed transitions. Absent (stage, event) pairs are illegal and throw.
// MISMATCH always lands back on release with an emptied cache: the sealed
// release proof is bound to the superseded session and must be re-prepared.
const TRANSITIONS: Record<V3Stage, Partial<Record<V3MachineEvent, V3Stage>>> = {
  release: { COVERED: "release", MISMATCH: "release", RELEASE_READY: "configure", RESET: "release" },
  configure: { COVERED: "configure", MISMATCH: "release", CONFIGURED: "configure", PLAN_READY: "deploy", BACK_TO_RELEASE: "release", RESET: "release" },
  deploy: { MISMATCH: "release", PLAN_READY: "deploy", BACK_TO_RELEASE: "release", BACK_TO_CONFIGURE: "configure", DEPLOY_FINISHED: "done", RESET: "release" },
  done: { BACK_TO_RELEASE: "release", RESET: "release" },
};

function assertTransition(from: V3Stage, event: V3MachineEvent): V3Stage {
  const to = TRANSITIONS[from][event];
  if (!to) {
    throw new Error(`illegal V3 flow transition: ${event} from ${from}`);
  }
  return to;
}

export class V3FlowMachine {
  private snap: V3MachineSnapshot = initialSnapshot();

  snapshot(): V3MachineSnapshot {
    return {
      ...this.snap,
      inputs: { ...this.snap.inputs },
      releaseUnits: this.snap.releaseUnits.map((u) => ({ ...u })),
      bundleDigests: this.snap.bundleDigests ? { ...this.snap.bundleDigests } : undefined,
    };
  }

  /** Precondition check without mutating: backs every button's disabled state. */
  can(event: V3MachineEvent): boolean {
    if (event === "RELEASE_READY" && this.snap.coverage !== "covered") return false;
    if (event === "PLAN_READY" && (this.snap.coverage !== "covered" || !this.snap.releaseProof)) return false;
    return TRANSITIONS[this.snap.stage][event] !== undefined;
  }

  /** Full reset for a new config text: drops every cached step state. */
  reset(): V3MachineSnapshot {
    this.snap = initialSnapshot();
    return this.snapshot();
  }

  setCoverage(covered: boolean, note: string | null = null): V3MachineSnapshot {
    assertTransition(this.snap.stage, covered ? "COVERED" : "MISMATCH");
    if (!covered) {
      // A changed config invalidates everything downstream — and the sealed
      // release proof is bound to the old session's nonce, so even the
      // retained bytes must be re-prepared after re-authorization.
      this.snap = { ...initialSnapshot(), stage: "release", coverage: "mismatch", coverageNote: note };
    } else {
      this.snap = { ...this.snap, coverage: "covered", coverageNote: null };
    }
    return this.snapshot();
  }

  setSource(source: V3RetainedSource, releaseProof: unknown, releaseUnits: Array<{ unitId: string; kind: string; name: string; hyperdrive?: string[] }>): V3MachineSnapshot {
    const to = assertTransition(this.snap.stage, "RELEASE_READY");
    this.snap = { ...this.resetDownstream(this.snap), stage: to, source, releaseProof, releaseUnits };
    return this.snapshot();
  }

  setInputs(inputs: Record<string, string | number | boolean>, modeIntent: "install" | "upgrade"): V3MachineSnapshot {
    assertTransition(this.snap.stage, "CONFIGURED");
    this.snap = { ...this.snap, inputs: { ...inputs }, modeIntent };
    return this.snapshot();
  }

  /** Plan arrived: configure -> deploy (review lives on the deploy stage). */
  setPlan(plan: { graphPlan: unknown; executionContext: unknown; approval: unknown; bundleDigests?: Record<string, string>; schedulerHints?: unknown }): V3MachineSnapshot {
    const to = assertTransition(this.snap.stage, "PLAN_READY");
    this.snap = {
      ...this.snap,
      stage: to,
      graphPlan: plan.graphPlan,
      executionContext: plan.executionContext,
      approval: plan.approval,
      bundleDigests: plan.bundleDigests ? { ...plan.bundleDigests } : undefined,
      schedulerHints: plan.schedulerHints ?? null,
    };
    return this.snapshot();
  }

  startDeploy(): V3MachineSnapshot {
    const snap = this.snapshot();
    if (snap.stage !== "deploy" || snap.deployRunning || !snap.graphPlan || !snap.executionContext || !snap.approval) {
      throw new Error("illegal V3 flow transition: CONFIRM_DEPLOY without a sealed plan");
    }
    this.snap = {
      ...this.snap,
      deployRunning: true,
      deployOk: null,
      deployError: null,
      deployUrls: [],
      deployNote: null,
      deployPending: false,
      failedAction: null,
      verifiedReceipts: 0,
    };
    return this.snapshot();
  }

  finishDeploy(outcome: { ok: boolean; error?: string; urls?: string[]; publishNote?: string; pending?: boolean; failedAction?: string; verifiedReceipts: number }): V3MachineSnapshot {
    const to = assertTransition(this.snap.stage, "DEPLOY_FINISHED");
    this.snap = {
      ...this.snap,
      stage: to,
      deployRunning: false,
      deployOk: outcome.ok,
      deployError: outcome.error ?? null,
      deployUrls: outcome.urls ?? [],
      deployNote: outcome.publishNote ?? null,
      deployPending: outcome.pending ?? false,
      failedAction: outcome.failedAction ?? null,
      verifiedReceipts: outcome.verifiedReceipts,
    };
    return this.snapshot();
  }

  backToRelease(): V3MachineSnapshot {
    const to = assertTransition(this.snap.stage, "BACK_TO_RELEASE");
    this.snap = { ...this.resetDownstream(this.snap), stage: to, source: null, releaseProof: null, releaseUnits: [], inputs: {}, modeIntent: "install" };
    return this.snapshot();
  }

  backToConfigure(): V3MachineSnapshot {
    const to = assertTransition(this.snap.stage, "BACK_TO_CONFIGURE");
    this.snap = { ...this.resetDownstream(this.snap), stage: to };
    return this.snapshot();
  }

  /** Downstream cache cleared whenever an upstream step changes. */
  private resetDownstream(snap: V3MachineSnapshot): V3MachineSnapshot {
    return {
      ...snap,
      graphPlan: null,
      executionContext: null,
      approval: null,
      bundleDigests: undefined,
      schedulerHints: null,
      deployRunning: false,
      deployOk: null,
      deployError: null,
      deployUrls: [],
      deployNote: null,
      deployPending: false,
      failedAction: null,
      verifiedReceipts: 0,
    };
  }
}
