// Cloudflare Workflows shapes returned/consumed by the v4 management API.
//
// The account Workflows API is keyed by the workflow NAME (account-unique):
// `PUT /accounts/{account_id}/workflows/{workflow_name}` creates or replaces a
// definition (`{class_name, script_name, schedules?}`), and `GET` returns the
// definition including the live direct schedules. The official PUT response
// does NOT include schedules, so every write is verified by a follow-up GET
// (the exact schedule set is read back, never assumed).

export interface WorkflowSchedule {
  cron: string;
  next_instance?: string;
}

export interface Workflow {
  /** Provider workflow id (stable provider identity). */
  id: string;
  /** Provider workflow name; the account-unique identity TapDeploy addresses. */
  name: string;
  class_name: string;
  script_name: string;
  created_on?: string;
  modified_on?: string;
  triggered_on?: string;
  instances?: number;
  schedules?: WorkflowSchedule[];
  script_deleted?: boolean;
}

// The exact desired definition for PUT. `schedules` is the full direct-schedule
// set (omitted only when the desired set is empty); the provider applies it
// atomically to the workflow.
export interface WorkflowUpdateRequest {
  class_name: string;
  script_name: string;
  schedules?: Array<{ cron: string }>;
}
