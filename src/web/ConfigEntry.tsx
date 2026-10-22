// Entry step: the publisher's Config V3 arrives from a single field (an https://
// address, pasted JSON, or a dropped .json file). The text is size-checked and
// parsed with the shared bounded parser, and only its V3 shape is checked here;
// the server validates it authoritatively when authorization starts. There is
// no separate preview or Connect screen: a loaded config goes straight to the
// session check and, when needed, to Cloudflare sign-in.

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { validateConfigUrl } from "../core/config-entry.js";
import { CONFIG_V3_MAX_BYTES as CONFIG_MAX_BYTES, parseConfigV3Text } from "../manifest/config-v3.js";
import { InfoTip } from "./InfoTip.js";
import { formatBytes } from "./lib/guarded-fetch.js";

interface ConfigFieldError {
  field: string;
  message: string;
}

interface ConfigEntryProps {
  /** Quick link (?config=<https url>): prefilled and submitted once on mount. */
  initialUrl?: string;
  /** A V3-shaped config text was loaded. */
  onLoaded: (text: string, sourceLabel: string) => void;
  /** The app is checking the session or redirecting to Cloudflare. */
  busy: boolean;
  /** Authorization could not be started for the last loaded config. */
  error?: string | null;
}

const textBytes = (text: string) => new TextEncoder().encode(text).length;

// From the single input field: an https:// address is a config URL, anything
// else is pasted JSON. http:// is treated as JSON so a clear error (not a
// silent fetch) explains the https-only rule.
function looksLikeConfigUrl(value: string): boolean {
  return /^https:\/\//i.test(value.trim());
}

// Shape gate only (schemaVersion + app id string). Not validation: the server
// is authoritative and rejects anything V3-invalid with a typed error.
function isV3ConfigShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 3) return false;
  const app = record.app;
  return !!app && typeof app === "object" && !Array.isArray(app) && typeof (app as Record<string, unknown>).id === "string";
}

export function ConfigEntry({ initialUrl, onLoaded, busy, error }: ConfigEntryProps) {
  const [text, setText] = useState(initialUrl ?? "");
  const [errors, setErrors] = useState<ConfigFieldError[]>([]);
  const [checking, setChecking] = useState(false);
  const autoStarted = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const handleDrop = async (event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.size > CONFIG_MAX_BYTES) {
      setErrors([{ field: "$", message: `config is ${formatBytes(file.size)}; the limit is ${formatBytes(CONFIG_MAX_BYTES)}` }]);
      return;
    }
    try {
      setText(await file.text());
      setErrors([]);
    } catch {
      setErrors([{ field: "$", message: "could not read the dropped file" }]);
    }
  };

  const accept = (rawText: string, label: string) => {
    const parsed = parseConfigV3Text(rawText);
    if (!parsed.ok) {
      setErrors([parsed.issue]);
      return;
    }
    if (!isV3ConfigShape(parsed.value)) {
      setErrors([{ field: "schemaVersion", message: "only Config V3 (\"schemaVersion\": 3 with an app id) is supported" }]);
      return;
    }
    setErrors([]);
    onLoaded(rawText, label);
  };

  const loadUrl = async (rawUrl: string) => {
    const validated = validateConfigUrl(rawUrl);
    if (!validated.ok) {
      setErrors([{ field: "$source.url", message: validated.error ?? "invalid config URL" }]);
      return;
    }
    try {
      const { fetchConfigText } = await import("./config.js");
      accept(await fetchConfigText(rawUrl), rawUrl);
    } catch (e) {
      const failure = e as { field?: string; message?: string };
      setErrors([{ field: failure.field ?? "$source.url", message: failure.message ?? "could not fetch config URL" }]);
    }
  };

  const submit = async (value: string) => {
    if (!value) {
      setErrors([{ field: "$", message: "paste a tapdeploy.config.json or an https:// address first" }]);
      return;
    }
    if (!looksLikeConfigUrl(value) && textBytes(value) > CONFIG_MAX_BYTES) {
      setErrors([{ field: "$", message: `config is ${formatBytes(textBytes(value))}; the limit is ${formatBytes(CONFIG_MAX_BYTES)}` }]);
      return;
    }
    setChecking(true);
    try {
      if (looksLikeConfigUrl(value)) await loadUrl(value);
      else accept(value, "pasted config");
    } finally {
      setChecking(false);
    }
  };

  const handleGo = (event: FormEvent) => {
    event.preventDefault();
    if (checking || busy) return;
    void submit(text.trim());
  };

  useEffect(() => {
    if (!initialUrl || autoStarted.current) return;
    autoStarted.current = true;
    void submit(initialUrl.trim());
    // Intentionally once on mount: the quick link submits itself a single time.
  }, [initialUrl]);

  const pastedBytes = textBytes(text);
  const working = checking || busy;

  return (
    <section className="panel" data-testid="config-step">
      <h2>
        Install an app into your Cloudflare account
        <InfoTip>
          The publisher's <code>tapdeploy.config.json</code> names the app, where its release comes from and which Cloudflare capabilities
          it needs. It cannot request raw permissions; the installer derives them and Cloudflare shows them to you before you consent.
        </InfoTip>
      </h2>
      <p className="lead">
        Load the app's config. You sign in to Cloudflare once for exactly this config, then pick the release and deploy — all from this tab.
      </p>

      <form className="mt-4" onSubmit={handleGo}>
        <div className="field">
          <label htmlFor="config-input">
            Config address, JSON or file
            <InfoTip>
              Paste an <code>https://…/tapdeploy.config.json</code> address or the JSON itself (up to {formatBytes(CONFIG_MAX_BYTES)}), or drop
              a local <code>.json</code> file onto the box — its content replaces what is there.
            </InfoTip>
          </label>
          <textarea
            id="config-input"
            rows={8}
            spellCheck={false}
            data-testid="config-input"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => void handleDrop(e)}
            placeholder={"https://example.com/tapdeploy.config.json\n\nor paste the tapdeploy.config.json content here — or drop a .json file"}
          />
          <p className={pastedBytes > CONFIG_MAX_BYTES ? "field-error" : "field-hint"} data-testid="config-size">
            {formatBytes(pastedBytes)} of {formatBytes(CONFIG_MAX_BYTES)}
          </p>
        </div>
        {error && <div className="error-block" role="alert" tabIndex={-1} ref={errorRef} data-testid="oauth-start-error">{error}</div>}
        <div className="actionbar">
          <button type="submit" className="primary" disabled={working || text.trim() === ""} data-testid="config-go">
            {busy ? "Opening Cloudflare sign-in…" : checking ? "Loading…" : "Continue with Cloudflare"}
          </button>
          <span className="meta">No token ever reaches this page; the session lives in a short-lived HttpOnly cookie.</span>
        </div>
      </form>

      {errors.length > 0 && (
        <div className="blocked-block" data-testid="config-errors" role="alert">
          <h3>This config can't be used</h3>
          {errors.map((e, i) => (
            <p key={`${e.field}-${i}`}>
              <code>{e.field}</code>: {e.message}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
