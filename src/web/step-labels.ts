// Human labels for what the UI shows from server-approved plans: plan diffs
// (resource + action + name) and deploy phases. UI-only: the identifiers
// themselves stay the protocol, and an unknown value falls back to the raw id
// so nothing approved is ever hidden.

export const STEP_STATE_LABEL: Record<string, string> = {
  pending: "Waiting",
  running: "In progress",
  waiting: "Still processing at Cloudflare",
  done: "Done",
  error: "Failed",
};

const RESOURCE_LABEL: Record<string, string> = {
  worker: "Worker",
  deployment: "Deployment",
  "static-assets": "Static assets",
  "workers-dev": "workers.dev address",
  secret: "Secret",
  schedule: "Cron schedule",
  "rate-limit": "Rate limit",
  r2: "R2 bucket",
  kv: "KV namespace",
  d1: "D1 database",
  queue: "Queue",
  "queue-consumer": "Queue consumer",
  workflow: "Workflow",
  hyperdrive: "Hyperdrive config",
  vectorize: "Vectorize index",
  "secrets-store": "Secrets Store",
  "worker-route": "Route",
  "worker-custom-domain": "Custom domain",
  "pages-custom-domain": "Custom domain",
  "dns-record": "DNS record",
  "pages-project": "Pages project",
};

const ACTION_LABEL: Record<string, string> = {
  create: "Create",
  update: "Update",
  preserve: "Keep",
  // Bound in this unit, created by another unit of the same release.
  skip: "Use",
  conflict: "Conflict",
  attach: "Bind",
  detach: "Unbind",
};

export type DiffTone = "create" | "update" | "keep" | "conflict";

export function resourceLabel(resource: string): string {
  return RESOURCE_LABEL[resource] ?? resource;
}

export function describeDiff(diff: { resource: string; action: string; name?: string }): { action: string; tone: DiffTone; subject: string; name?: string } {
  const tone: DiffTone = diff.action === "create" || diff.action === "attach" ? "create" : diff.action === "update" || diff.action === "detach" ? "update" : diff.action === "conflict" ? "conflict" : "keep";
  return {
    action: ACTION_LABEL[diff.action] ?? diff.action,
    tone,
    subject: resourceLabel(diff.resource),
    ...(diff.name ? { name: diff.name } : {}),
  };
}

const PHASE_LABEL: Record<string, string> = {
  "create-r2-buckets": "Create R2 bucket",
  "create-d1-databases": "Create D1 database",
  "create-kv-namespaces": "Create KV namespace",
  "create-queues": "Create queue",
  "create-hyperdrive-configs": "Create Hyperdrive config",
  "create-vectorize-indexes": "Create Vectorize index",
  "create-secrets-stores": "Create Secrets Store",
  "ensure-secrets-store-secrets": "Prepare Secrets Store secrets",
  "apply-secrets": "Apply Worker secrets",
  "register-assets": "Register static assets",
  "complete-assets": "Upload static assets",
  "create-worker": "Upload Worker code",
  "create-version": "Upload new Worker version",
  activate: "Activate the new version",
  "register-queue-consumers": "Register queue consumer",
  "apply-workflows": "Apply Workflow",
  "reconcile-schedules": "Set cron schedules",
  "reconcile-rate-limits": "Set rate limits",
  "reconcile-domains": "Apply domain or route",
  "publish-workers-dev": "Publish on workers.dev",
  postcheck: "Verify the live Worker",
  "pages-create-project": "Create Pages project",
  "pages-register-assets": "Upload site files",
  "pages-deploy": "Create Pages deployment",
  "pages-postcheck": "Verify the Pages deployment",
};

export function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? phase;
}
