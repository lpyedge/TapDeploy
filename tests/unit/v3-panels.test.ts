// The V3 step panels are presentational: all state, effects and the machine
// stay in V3Flow. These tests pin the pure helpers they export and the markup
// that depends only on props (no browser).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GraphPlan } from "../../src/web/api.js";
import { V3ConfigurePanel } from "../../src/web/V3ConfigurePanel.js";
import { declaredConfigInputs, inputError, type DeclaredInput } from "../../src/web/config-inputs.js";
import { V3ReleasePanel } from "../../src/web/V3ReleasePanel.js";
import { secretNeedsFor, secretRows, secretValueProblem, secretsReady, suppliedSecretNames, unmetSecretNeeds } from "../../src/web/secret-choices.js";

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

describe("secret choices", () => {
  const config = JSON.stringify({
    inputs: [
      { key: "ADMIN_PASSWORD", type: "secret", label: "Admin password", validation: { minLength: 8, pattern: "adm_.+" } },
      { key: "FIRST_ONLY", type: "secret", label: "First only", upgradeKeep: true },
      { key: "SALT", type: "secret", generate: true },
      { key: "PLAIN", type: "string" },
    ],
  });
  // Optional ones: changeable on upgrade, and one the upgrade does not ask again.
  const optional = JSON.stringify({
    inputs: [
      { key: "TOKEN", type: "secret", label: "Token", required: false },
      { key: "OWNER_SETUP_PASSWORD", type: "secret", label: "Owner password", required: false, upgradeKeep: true },
    ],
  });
  const rows = (...args: Parameters<typeof secretRows> extends [string, ...infer Rest] ? Rest : never) => secretRows(config, ...args).map((row) => [row.def.key, row.kind, row.missing]);
  const optionalRows = (...args: Parameters<typeof secretRows> extends [string, ...infer Rest] ? Rest : never) => secretRows(optional, ...args).map((row) => [row.def.key, row.kind, row.missing]);
  const plan = (diffs: Array<{ resource: string; action: string; name?: string }>): GraphPlan => ({
    ok: true, blocked: false, digest: "d", guards: [],
    cost: { operations: [], requiresConfirmation: false, confirmed: false, blockedUnknownCost: false },
    takeover: { workers: [], confirmed: false },
    units: [{ unitId: "main", kind: "worker", name: "api", requiresBundle: true, diffs }],
  });

  it("install asks for every entered secret, required unless the config says required: false; generated ones never appear", () => {
    expect(rows("install", null, [])).toEqual([["ADMIN_PASSWORD", "required", false], ["FIRST_ONLY", "required", false]]);
    expect(optionalRows("install", null, [])).toEqual([["TOKEN", "optional", false], ["OWNER_SETUP_PASSWORD", "optional", false]]);
  });

  it("upgrade keeps a secret the Worker has (changeable unless upgradeKeep) and asks for one it lacks", () => {
    expect(rows("upgrade", ["ADMIN_PASSWORD", "FIRST_ONLY"], [])).toEqual([["ADMIN_PASSWORD", "kept", false]]);
    expect(rows("upgrade", ["FIRST_ONLY"], [])).toEqual([["ADMIN_PASSWORD", "required", true]]);
    expect(rows("upgrade", [], [])).toEqual([["ADMIN_PASSWORD", "required", true], ["FIRST_ONLY", "required", true]]);
    // A missing optional one may stay empty; one marked upgradeKeep is not asked again at all.
    expect(optionalRows("upgrade", [], [])).toEqual([["TOKEN", "optional", true]]);
    expect(optionalRows("upgrade", ["TOKEN", "OWNER_SETUP_PASSWORD"], [])).toEqual([["TOKEN", "kept", false]]);
  });

  it("with the Worker's secrets unknown, upgrade keeps them unless the last plan creates one", () => {
    expect(rows("upgrade", null, [])).toEqual([["ADMIN_PASSWORD", "kept", false]]);
    expect(rows("upgrade", null, ["FIRST_ONLY"])).toEqual([["ADMIN_PASSWORD", "kept", false], ["FIRST_ONLY", "required", true]]);
  });

  it("ready needs required and changed values, valid; an optional one may stay empty and is then not supplied", () => {
    const upgrade = secretRows(config, "upgrade", ["ADMIN_PASSWORD"], []);
    expect(secretsReady(upgrade, [], {})).toBe(false);
    expect(secretsReady(upgrade, [], { FIRST_ONLY: "x" })).toBe(true);
    expect(secretsReady(upgrade, ["ADMIN_PASSWORD"], { FIRST_ONLY: "x" })).toBe(false);
    expect(secretsReady(upgrade, ["ADMIN_PASSWORD"], { FIRST_ONLY: "x", ADMIN_PASSWORD: "adm_1" })).toBe(false);
    expect(secretsReady(upgrade, ["ADMIN_PASSWORD"], { FIRST_ONLY: "x", ADMIN_PASSWORD: "adm_secret1" })).toBe(true);
    // Supplied: a changed kept one; a required one is created with its value anyway.
    expect(suppliedSecretNames(upgrade, ["ADMIN_PASSWORD"], { FIRST_ONLY: "x", ADMIN_PASSWORD: "adm_secret1" })).toEqual(["ADMIN_PASSWORD"]);
    const install = secretRows(optional, "install", null, []);
    expect(secretsReady(install, [], {})).toBe(true);
    expect(suppliedSecretNames(install, [], {})).toEqual([]);
    expect(suppliedSecretNames(install, [], { TOKEN: "t" })).toEqual(["TOKEN"]);
    const def = upgrade[0]!.def;
    expect(secretValueProblem(def, "")).toBeNull();
    expect(secretValueProblem(def, "adm_1")).toBe("at least 8 characters");
    expect(secretValueProblem(def, "other-password")).toBe("invalid format");
    expect(secretValueProblem(def, "adm_secret1")).toBeNull();
  });

  it("the plan's needs are its secret creates and updates, never generated or preserved ones", () => {
    const needs = secretNeedsFor(config, plan([
      { resource: "secret", action: "create", name: "FIRST_ONLY" },
      { resource: "secret", action: "update", name: "ADMIN_PASSWORD" },
      { resource: "secret", action: "create", name: "SALT" },
      { resource: "secret", action: "preserve", name: "OLD" },
      { resource: "worker", action: "create", name: "api" },
    ]));
    expect(needs.map((need) => [need.name, need.label, need.create])).toEqual([["FIRST_ONLY", "First only", true], ["ADMIN_PASSWORD", "Admin password", false]]);
    expect(secretNeedsFor(config, null)).toEqual([]);
    expect(secretNeedsFor("not json", plan([{ resource: "secret", action: "create", name: "X" }])).map((need) => need.label)).toEqual(["X"]);
    // Unmet: no value, or one that breaks the declared rules.
    expect(unmetSecretNeeds(needs, { FIRST_ONLY: "x", ADMIN_PASSWORD: "adm_1" }).map((need) => need.name)).toEqual(["ADMIN_PASSWORD"]);
    expect(unmetSecretNeeds(needs, { FIRST_ONLY: "x", ADMIN_PASSWORD: "adm_secret1" })).toEqual([]);
  });
});

describe("panel markup from props alone", () => {
  const release = (overrides: Partial<Parameters<typeof V3ReleasePanel>[0]> = {}) =>
    renderToStaticMarkup(createElement(V3ReleasePanel, {
      assetUrl: "", onAssetUrl: noop, localFile: null, allowLocalZip: true, fileKey: 0,
      fileInputRef: { current: null }, busy: false, prepareDisabled: true, stage: null, onCancel: noop, onFile: noop, onClearFile: noop, onPrepare: noop, ...overrides,
    }));

  it("release: a busy flow names its stage in a live region and offers Cancel; an idle one shows neither", () => {
    const idle = release();
    expect(idle).not.toContain("v3-release-cancel");
    expect(idle).toMatch(/role="status"[^>]*data-testid="v3-release-stage"><\/p>/);
    for (const [stage, text] of [["reading", "Downloading the ZIP…"], ["analyzing", "Checking the ZIP in your browser…"], ["verifying", "Verifying with the installer…"]] as const) {
      const busy = release({ busy: true, stage });
      expect(busy).toContain(text);
      expect(busy).toContain('data-testid="v3-release-cancel"');
      expect(busy).toContain('aria-busy="true"');
      expect(busy).not.toMatch(/\d+\s?%/);
    }
  });

  it("release: the link and the file picker share one page; a chosen file takes over, Verify follows prepareDisabled", () => {
    const url = release();
    expect(url).toContain('data-testid="v3-asset-url"');
    expect(url).toContain('data-testid="v3-local-zip-browse"');
    expect(url).not.toContain('v3-local-zip-clear');
    expect(url).toMatch(/data-testid="v3-prepare"[^>]*>Verify release from link</);
    expect(url).toMatch(/<button[^>]*disabled=""[^>]*data-testid="v3-prepare"|<button[^>]*data-testid="v3-prepare"[^>]*disabled=""/);
    const file = release({ localFile: { label: "release.zip" }, prepareDisabled: false });
    expect(file).toMatch(/<input[^>]*disabled=""[^>]*data-testid="v3-asset-url"|<input[^>]*data-testid="v3-asset-url"[^>]*disabled=""/);
    expect(file).toContain("Not used while a ZIP file is chosen.");
    expect(file).toContain("release.zip");
    expect(file).toContain('data-testid="v3-local-zip-clear"');
    expect(file).toContain("Verify release.zip");
    expect(file).not.toMatch(/disabled=""[^>]*data-testid="v3-prepare"/);
  });

  it("release: a config limited to its own link offers no file picker", () => {
    const html = release({ allowLocalZip: false });
    expect(html).toContain('data-testid="v3-asset-url"');
    expect(html).not.toContain("v3-local-zip");
  });

  const configure = (overrides: Partial<Parameters<typeof V3ConfigurePanel>[0]> = {}) =>
    renderToStaticMarkup(createElement(V3ConfigurePanel, {
      sourceLabel: "release.zip", releaseUnits: [{ unitId: "main", kind: "worker", name: "api" }], workerUnitCount: 1,
      showModeToggle: true, modeIntent: "install", onModeIntent: noop, renameAllowed: true, workerNameDef: undefined,
      visibleInputs: [], inputValues: { workerName: "api" }, onInputValue: noop, secretRows: [], replacedSecrets: [], onReplaceSecret: noop, secretValues: {}, onSecretValue: noop, upgradeTargets: null,
      upgradeTargetsLoading: false, upgradeTargetsError: null, onSwitchToUpgrade: noop, continueDisabled: false, planning: false, onBack: noop, onContinue: noop, ...overrides,
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

  it("configure: required inputs are shown, optional ones wait in a collapsed section", () => {
    const inputs: DeclaredInput[] = [
      { key: "REGION", type: "select", label: "Region", options: [{ label: "EU", value: "eu" }] },
      { key: "NOTE", type: "string", label: "Note", required: false },
    ];
    const html = configure({ visibleInputs: inputs });
    const section = /<section class="disclosure"[^>]*data-testid="v3-optional-inputs"[\s\S]*?<\/section>/.exec(html)![0];
    expect(section).toContain('aria-expanded="false"');
    expect(section).toContain("0 of 1 set");
    expect(section).toMatch(/class="disclosure-body" hidden=""[\s\S]*v3-input-NOTE/);
    expect(html.indexOf("v3-input-REGION")).toBeLessThan(html.indexOf("v3-optional-inputs"));
    expect(html).not.toMatch(/disclosure-body[^>]*>[\s\S]*v3-input-REGION[\s\S]*<\/section>/);
    // An invalid optional value keeps its section open so the error cannot hide.
    const invalid = configure({ visibleInputs: [{ key: "N", type: "integer", label: "N", required: false }], inputValues: { workerName: "api", N: "abc" } });
    expect(invalid).toContain('aria-expanded="true"');
  });

  it("configure: secret values are entered here: required ones up front, kept ones behind Change", () => {
    const def: DeclaredInput = { key: "ADMIN_PASSWORD", type: "secret", label: "Admin password" };
    const install = configure({ secretRows: [{ def, kind: "required", missing: false }] });
    expect(install).toMatch(/data-testid="v3-secrets-required"[\s\S]*type="password"[\s\S]*data-testid="v3-secret-ADMIN_PASSWORD"/);
    expect(install).toContain("never with the plan");
    // Upgrade of a Worker that has no such secret: required, and says why.
    const missing = configure({ modeIntent: "upgrade", secretRows: [{ def, kind: "required", missing: true }] });
    expect(missing).toContain('data-testid="v3-secret-ADMIN_PASSWORD-note"');
    expect(missing).toContain("This Worker has no Admin password yet");
    // Upgrade of a Worker that has it: kept, the field appears only once Change is ticked.
    const kept = configure({ modeIntent: "upgrade", secretRows: [{ def, kind: "kept", missing: false }] });
    expect(kept).not.toContain('data-testid="v3-secrets-required"');
    expect(kept).toContain('data-testid="v3-secret-change-ADMIN_PASSWORD"');
    expect(kept).not.toContain('data-testid="v3-secret-ADMIN_PASSWORD"');
    const changing = configure({ modeIntent: "upgrade", secretRows: [{ def, kind: "kept", missing: false }], replacedSecrets: ["ADMIN_PASSWORD"] });
    expect(changing).toContain('data-testid="v3-secret-ADMIN_PASSWORD"');
    expect(changing).toContain("New Admin password");
    // Optional: in the optional section, and empty means not set.
    const optional = configure({ modeIntent: "upgrade", secretRows: [{ def, kind: "optional", missing: true }] });
    expect(optional).not.toContain('data-testid="v3-secrets-required"');
    expect(optional).toMatch(/data-testid="v3-optional-inputs"[\s\S]*data-testid="v3-secrets-optional"/);
    expect(optional).toContain("Leave it empty and it is not set.");
  });

  it("configure: while planning the button shows a spinner and says what it waits for", () => {
    const idle = configure();
    expect(idle).not.toContain("spinner");
    expect(idle).not.toContain('data-testid="v3-planning"');
    const planning = configure({ planning: true, continueDisabled: true });
    expect(planning).toContain('class="spinner"');
    expect(planning).toContain("Checking with Cloudflare…");
    expect(planning).toContain('data-testid="v3-planning"');
  });

  it("configure: several workers keep release names; invalid name shows its error", () => {
    const multi = configure({ workerUnitCount: 2, renameAllowed: false });
    expect(multi).toContain("names stay release-declared");
    expect(multi).not.toContain('data-testid="v3-input-workerName"');
    const invalid = configure({ inputValues: { workerName: "Bad Name!" } });
    expect(invalid).toContain('data-testid="v3-input-workerName-error"');
  });
});
