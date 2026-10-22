// Cloudflare Pages project + deployment shapes returned / consumed by the
// v4 management API. Pages is a first-class hosting target distinct from
// Workers: a Pages project accepts static assets via the Direct Upload protocol
// (a JWT-scoped asset upload + a multipart deployment create) and has its own
// project / deployment lifecycle. The Installer models only the fields it
// consumes; trailing fields are ignored by the client.

// Summary shape (target discovery / upgrade selection).
export interface PagesProjectSummary {
  id: string;
  name: string;
  subdomain?: string;
  created_on?: string;
  modified_on?: string;
  domains?: string[];
  latestDeployment?: {
    id?: string;
    url?: string;
    environment?: "preview" | "production";
    created_on?: string;
  };
}

// A Pages deployment's build-stage status. The Installer only reads the
// terminal "success" vs anything else; it never polls or mutates stages.
export interface PagesDeploymentStage {
  name?: string;
  status?: string;
  started_on?: string;
  ended_on?: string;
}

// A Pages deployment (GET /deployments/{id} and the entries in
// GET /deployments list). `environment` is the canonical preview|production the
// deploy targeted. `latest_stage.status` tells the postcheck whether the deploy
// actually succeeded rather than staying queued/running.
export interface PagesDeployment {
  id?: string;
  project_id?: string;
  env_vars?: Record<string, { type?: string; value?: string }>;
  project_name?: string;
  url?: string;
  environment?: "preview" | "production";
  created_on?: string;
  modified_on?: string;
  latest_stage?: PagesDeploymentStage;
  deployment_trigger?: {
    type?: string;
    metadata?: { branch?: string; commit_hash?: string };
  };
}

// A Pages project's per-environment configuration. The Installer writes
// environment variables and the binding identities it actually supports
// (R2 / D1 / KV / Queue producer) into `deployment_configs`; unsupported
// binding families (Durable Objects / Services / Analytics Engine) are never
// synthesized and never silently dropped.
export interface PagesDeploymentConfig {
  [key: string]: unknown;
  compatibility_date?: string;
  compatibility_flags?: string[];
  env_vars?: Record<string, { value?: string; type?: string }>;
  kv_namespaces?: Record<string, { namespace_id: string }>;
  d1_databases?: Record<string, { id: string }>;
  r2_buckets?: Record<string, { name: string }>;
  queue_producers?: Record<string, { name: string }>;
  browsers?: Record<string, Record<string, never>>;
}

// A full Pages project (GET /pages/projects/{project_name}).
export interface PagesProject {
  id: string;
  name: string;
  subdomain?: string;
  created_on?: string;
  modified_on?: string;
  domains?: string[];
  production_branch?: string;
  latest_deployment?: PagesDeployment;
  canonical_deployment?: PagesDeployment;
  deployment_configs?: {
    production?: PagesDeploymentConfig;
    preview?: PagesDeploymentConfig;
  };
}

// Request body for POST /pages/projects. `deployment_configs` carries the
// compatibility settings that apply to every new deployment.
export interface PagesProjectCreateRequest {
  name: string;
  production_branch?: string;
  deployment_configs?: {
    production?: PagesDeploymentConfig;
    preview?: PagesDeploymentConfig;
  };
}
