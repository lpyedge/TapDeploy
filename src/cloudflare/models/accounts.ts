// Cloudflare account/profile shapes returned by the v4 management API.
// These are the fields the Installer actually consumes; unknown fields are
// passed through unmodified by the client envelope.

export interface AccountSummary {
  id: string;
  name: string;
  type?: string;
  settings?: Record<string, unknown>;
}

export interface AccountsEnvelope {
  result: AccountSummary[];
}

export interface AccountEnvelope {
  result: AccountSummary;
}