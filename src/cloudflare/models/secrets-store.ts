// Cloudflare central Secrets Store shapes returned/consumed by the v4
// management API.
//
// A Secrets Store has two distinct levels: the account-level **store** (a
// named container) and the **secrets** inside it (a name + a write-only value
// with a scope list). The provider NEVER returns a secret `value` — it exists
// only to create/modify a secret, and the installer must never log or persist
// it. A Worker binds a specific secret by `store_id` + `secret_name` via the
// `secrets_store_secret` binding type, which is a different product from a
// Worker version secret.

export interface SecretsStore {
  id: string;
  name: string;
  account_id?: string;
  created?: string;
  modified?: string;
}

export interface SecretsStoreSecret {
  id: string;
  name: string;
  store_id: string;
  created?: string;
  modified?: string;
}
