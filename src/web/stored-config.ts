// The nonsecret config text is kept in tab sessionStorage so it survives the
// top-level OAuth redirect, for at most CONFIG_SESSION_TTL_MS after it was
// stored. Only the config lives there (never a token or secret); a stale entry
// is discarded so a long-lived tab cannot replay a config whose one-shot grant
// is gone.

export interface LoadedConfig {
  text: string;
  appId: string;
  sourceLabel: string;
}

const CONFIG_SESSION_KEY = "tapdeploy.config.v3";
const CONFIG_SESSION_TTL_MS = 30 * 60 * 1000;

export function storeConfig(config: LoadedConfig): void {
  try {
    window.sessionStorage.setItem(CONFIG_SESSION_KEY, JSON.stringify({ ...config, storedAt: Date.now() }));
  } catch {
    // sessionStorage unavailable: the config is pasted again after sign-in
  }
}

export function clearStoredConfig(): void {
  try {
    window.sessionStorage.removeItem(CONFIG_SESSION_KEY);
  } catch {
    // ignore
  }
}

export function readStoredConfig(): LoadedConfig | null {
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
