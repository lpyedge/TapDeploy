// Single-page installer UI. Flow: config -> Cloudflare sign-in for exactly that
// config (a direct redirect, no Connect screen) -> release -> configure ->
// deploy. The sealed-graph steps live in V3Flow; this file owns the
// entry/session state and hands a covered config to it. The OAuth token is
// never present in UI JS (HttpOnly cookie); only the CSRF token is kept in
// component state, and it is never rendered into the DOM.

import { useEffect, useRef, useState } from "react";
import {
  checkConfigCoverage,
  getAccounts,
  getSession,
  startOAuth,
  type AccountSummary,
  type SessionState,
} from "./api.js";
import { safeErrorMessage } from "./deploy-shared.js";
import { ConfigEntry } from "./ConfigEntry.js";
import { AccountBar } from "./AccountBar.js";
import { Shell } from "./Shell.js";
import { V3Flow } from "./V3Flow.js";
import { v3AppId } from "./config-text.js";
import { clearStoredConfig, readStoredConfig, storeConfig, type LoadedConfig } from "./stored-config.js";

// A quick link carries the config address: /?config=https://host/tapdeploy.config.json
function readQuickLink(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  return params.has("auth") ? undefined : (params.get("config") ?? undefined);
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
