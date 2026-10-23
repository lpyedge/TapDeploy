// The V3 step panels are presentational: all state, effects and the machine
// stay in V3Flow. These tests pin the pure helpers they export and the markup
// that depends only on props (no browser).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GraphPlan } from "../../src/web/api.js";
import { V3ConfigurePanel, changeableSecrets, declaredConfigInputs, inputError } from "../../src/web/V3ConfigurePanel.js";
import { V3ReleasePanel } from "../../src/web/V3ReleasePanel.js";
import { secretProblem, secretPromptsFor } from "../../src/web/V3DeployPanel.js";

const noop = () => undefined;

describe("declaredConfigInputs / inputError", () => {
  const config = JSON.stringify({
    inputs: [
      { key: "workerName", type: "string", label: "Worker name", validation: { minLength: 3, pattern: "^[a-z0-9-]+$" } },
      { key: "region", type: "select", options: [{ label: "EU", value: "eu" }, { value: "us" }, "asia"] },
      { key: "nickname", type: "string", required: false, upgradeKeep: true },
      { key: "API_KEY", type: "secret" },
      { type: "string" },
    ],
  });

  it("lists non-secret declared inputs with defaults and keeps options", () => {
    const inputs = declaredConfigInputs(config);
    expect(inputs.map((input) => input.key)).toEqual(["workerName", "region", "nickname"]);
    expect(inputs[1]).toMatchObject({ label: "region", options: [{ label: "EU", value: "eu" }, { label: "us", value: "us" }, { label: "asia", value: "asia" }] });
    expect(inputs[1]).not.toHaveProperty("required");
    expect(inputs[2]).toMatchObject({ required: false, upgradeKeep: true });
  });

  it("returns no inputs for invalid or input-less config text", () => {
    expect(declaredConfigInputs("not json")).toEqual([]);
    expect(declaredConfigInputs("{}")).toEqual([]);
  });

  it("lists the secrets an upgrade may replace: the ones the user enters that upgrade still asks for", () => {
    const secrets = JSON.stringify({ inputs: [
      { key: "ADMIN_PASSWORD", type: "secret", label: "Admin password" },
      { key: "FIRST_ONLY", type: "secret", upgradeKeep: true },
      { key: "SALT", type: "secret", generate: true },
    ] });
    expect(changeableSecrets(secrets).map((input) => input.key)).toEqual(["ADMIN_PASSWORD"]);
  });

  it("validates required (per mode), length, pattern and the worker-name shape", () => {
    const def = { key: "x", type: "string" as const, label: "x", validation: { minLength: 3, maxLength: 8, pattern: "[a-z]+" } };
    expect(inputError(def, "install", "")).toBe("required");
    expect(inputError(def, "upgrade", "")).toBeNull();
    expect(inputError({ ...def, required: false }, "install", "")).toBeNull();
    expect(inputError(def, "install", "ab")).toBe("at least 3 characters");
    expect(inputError(def, "install", "abcdefghi")).toBe("at most 8 characters");
    expect(inputError(def, "install", "ab1d")).toBe("invalid format");
    expect(inputError({ ...def, validation: { pattern: "(" } }, "install", "abcd")).toBe("invalid declared pattern");
    const name = { key: "workerName", type: "string" as const, label: "Worker name" };
    expect(inputError(name, "install", "Bad Name")).toBe("lowercase letters, digits and dashes, max 63");
    expect(inputError(name, "install", "good-name")).toBeNull();
  });
});

describe("secretPromptsFor", () => {
  const config = JSON.stringify({
    inputs: [
      { key: "TOKEN", type: "secret", label: "API token" },
      { key: "SALT", type: "secret", generate: true },
      { key: "PLAIN", type: "string" },
    ],
  });
  const plan = (diffs: Array<{ resource: string; action: string; name?: string }>): GraphPlan => ({
    ok: true, blocked: false, digest: "d", guards: [],
    cost: { operations: [], requiresConfirmation: false, confirmed: false, blockedUnknownCost: false },
    units: [{ unitId: "main", kind: "worker", name: "api", requiresBundle: true, diffs }],
  });

  it("prompts only for secrets the plan creates and whose policy is prompt", () => {
    const prompts = secretPromptsFor(config, plan([
      { resource: "secret", action: "create", name: "TOKEN" },
      { resource: "secret", action: "create", name: "SALT" },
      { resource: "secret", action: "preserve", name: "OLD" },
      { resource: "worker", action: "create", name: "api" },
    ]));
    expect(prompts.map((prompt) => [prompt.name, prompt.label, prompt.replacing])).toEqual([["TOKEN", "API token", false]]);
  });

  it("an undeclared created secret defaults to prompt; no plan means no prompts", () => {
    const names = (prompts: ReturnType<typeof secretPromptsFor>) => prompts.map((prompt) => [prompt.name, prompt.label]);
    expect(names(secretPromptsFor(config, plan([{ resource: "secret", action: "create", name: "EXTRA" }])))).toEqual([["EXTRA", "EXTRA"]]);
    expect(secretPromptsFor(config, null)).toEqual([]);
    expect(names(secretPromptsFor("not json", plan([{ resource: "secret", action: "create", name: "X" }])))).toEqual([["X", "X"]]);
  });

  it("an update (a secret the user chose to change on upgrade) is prompted as a replacement and validated", () => {
    const rules = JSON.stringify({ inputs: [{ key: "ADMIN_PASSWORD", type: "secret", label: "Admin password", required: false, validation: { minLength: 8, pattern: "adm_.+" } }] });
    const [prompt] = secretPromptsFor(rules, plan([{ resource: "secret", action: "update", name: "ADMIN_PASSWORD" }]));
    expect(prompt).toMatchObject({ name: "ADMIN_PASSWORD", replacing: true });
    expect(secretProblem(prompt!, "")).toBeNull();
    expect(secretProblem(prompt!, "adm_1")).toBe("at least 8 characters");
    expect(secretProblem(prompt!, "other-password")).toBe("invalid format");
    expect(secretProblem(prompt!, "adm_secret1")).toBeNull();
  });
});

describe("panel markup from props alone", () => {
  const release = (overrides: Partial<Parameters<typeof V3ReleasePanel>[0]> = {}) =>
    renderToStaticMarkup(createElement(V3ReleasePanel, {
      releaseMode: "url", onReleaseMode: noop, assetUrl: "", onAssetUrl: noop, source: null, fileKey: 0,
      fileInputRef: { current: null }, busy: false, prepareDisabled: true, onFile: noop, onPrepare: noop, ...overrides,
    }));

  it("release: URL mode shows the URL box, file mode the picker; Verify follows prepareDisabled", () => {
    const url = release();
    expect(url).toContain('data-testid="v3-asset-url"');
    expect(url).not.toContain('data-testid="v3-local-zip-browse"');
    expect(url).toMatch(/data-testid="v3-prepare"[^>]*>Verify release from link</);
    expect(url).toMatch(/<button[^>]*disabled=""[^>]*data-testid="v3-prepare"|<button[^>]*data-testid="v3-prepare"[^>]*disabled=""/);
    const file = release({ releaseMode: "file", source: { label: "release.zip" }, prepareDisabled: false });
    expect(file).toContain('data-testid="v3-local-zip-browse"');
    expect(file).toContain('value="release.zip"');
    expect(file).toContain("Verify release.zip");
    expect(file).not.toMatch(/disabled=""[^>]*data-testid="v3-prepare"/);
  });

  const configure = (overrides: Partial<Parameters<typeof V3ConfigurePanel>[0]> = {}) =>
    renderToStaticMarkup(createElement(V3ConfigurePanel, {
      sourceLabel: "release.zip", releaseUnits: [{ unitId: "main", kind: "worker", name: "api" }], workerUnitCount: 1,
      showModeToggle: true, modeIntent: "install", onModeIntent: noop, renameAllowed: true, workerNameDef: undefined,
      visibleInputs: [], inputValues: { workerName: "api" }, onInputValue: noop, secretsToChange: [], replacedSecrets: [], onReplaceSecret: noop, upgradeTargets: null,
      upgradeTargetsLoading: false, upgradeTargetsError: null, onSwitchToUpgrade: noop, continueDisabled: false, onBack: noop, onContinue: noop, ...overrides,
    }));

  it("configure: name box on install, dropdown only for upgrade with live targets, fallback note on listing failure", () => {
    expect(configure()).toContain('data-testid="v3-input-workerName"');
    const upgrade = configure({ modeIntent: "upgrade", upgradeTargets: [{ name: "live-one" }, { name: "live-two" }] });
    expect(upgrade).toContain('data-testid="v3-upgrade-target"');
    expect(upgrade).toContain("live-two");
    expect(upgrade).not.toContain('data-testid="v3-input-workerName"');
    const failed = configure({ modeIntent: "upgrade", upgradeTargetsError: "boom" });
    expect(failed).toContain('data-testid="v3-input-workerName"');
    expect(failed).toContain("Could not list account Workers (boom); type the exact name instead.");
  });

  it("configure: New with a name that already exists warns and offers the switch to Upgrade", () => {
    const taken = configure({ upgradeTargets: [{ name: "api" }] });
    expect(taken).toContain('data-testid="v3-name-taken"');
    expect(taken).toContain('data-testid="v3-switch-to-upgrade"');
    expect(configure({ upgradeTargets: [{ name: "other" }] })).not.toContain('data-testid="v3-name-taken"');
    expect(configure({ modeIntent: "upgrade", upgradeTargets: [{ name: "api" }] })).not.toContain('data-testid="v3-name-taken"');
  });

  it("configure: several workers keep release names; invalid name shows its error", () => {
    const multi = configure({ workerUnitCount: 2, renameAllowed: false });
    expect(multi).toContain("names stay release-declared");
    expect(multi).not.toContain('data-testid="v3-input-workerName"');
    const invalid = configure({ inputValues: { workerName: "Bad Name!" } });
    expect(invalid).toContain('data-testid="v3-input-workerName-error"');
  });
});
