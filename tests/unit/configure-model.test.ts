import { describe, expect, it } from "vitest";
import { buildPlanRequest, httpUnitsFor, hyperdriveReady, hyperdriveUnitsFor, planInputs } from "../../src/web/configure-model.js";
import type { DeclaredInput } from "../../src/web/config-inputs.js";
import type { NameRow } from "../../src/web/name-choices.js";
import { EMPTY_DRAFT } from "../../src/web/domain-choices.js";

const units = [
  { unitId: "api", kind: "worker", name: "notes-api", hyperdrive: ["DB"] },
  { unitId: "site", kind: "pages", name: "notes-site" },
  { unitId: "resources", kind: "resources", name: "" },
];
const pagesName: NameRow = { key: "pages:site", kind: "pages", releaseName: "notes-site", mode: "input", value: "my-site", options: [], exists: false };

describe("units a choice addresses", () => {
  it("a renamable Worker takes the operator's name, a Pages site its chosen project name, resources none", () => {
    expect(httpUnitsFor(units, true, "my-api", [pagesName])).toEqual([
      { unitId: "api", kind: "worker", target: "my-api" },
      { unitId: "site", kind: "pages", target: "my-site" },
    ]);
    expect(httpUnitsFor(units, false, "my-api", [])).toEqual([
      { unitId: "api", kind: "worker", target: "notes-api" },
      { unitId: "site", kind: "pages", target: "notes-site" },
    ]);
  });

  it("lists the units with Hyperdrive bindings and when every binding has a choice", () => {
    const hyperdrive = hyperdriveUnitsFor(units, true, "my-api");
    expect(hyperdrive).toEqual([{ unitId: "api", target: "my-api", bindings: ["DB"] }]);
    expect(hyperdriveReady(hyperdrive, {})).toBe(false);
    expect(hyperdriveReady(hyperdrive, { api: { DB: "" } })).toBe(false);
    expect(hyperdriveReady(hyperdrive, { api: { DB: "prod-db" } })).toBe(true);
    expect(hyperdriveReady([], {})).toBe(true);
  });
});

describe("plan inputs", () => {
  const shown: DeclaredInput[] = [
    { key: "REGION", type: "select", label: "Region" },
    { key: "NOTE", type: "string", label: "Note", required: false },
  ];

  it("sends the Worker name and every non-empty shown input, never empty or hidden ones", () => {
    expect(planInputs(true, { workerName: "my-api", REGION: "eu", NOTE: "", HIDDEN: "x" }, shown)).toEqual({ workerName: "my-api", REGION: "eu" });
    expect(planInputs(false, { workerName: "my-api" }, shown)).toEqual({});
  });
});

describe("buildPlanRequest", () => {
  const base = {
    accountId: "acct", releaseProof: "proof", configText: "{}", inputs: {}, mode: "install" as const,
    httpUnits: [], domainDrafts: {}, domainFacts: null, recordsByZone: {}, hyperdriveUnits: [], hyperdriveChoices: {},
    names: [], replacedSecrets: [], paidRiskConfirmed: false,
  };

  it("carries only what the operator chose", () => {
    expect(buildPlanRequest(base)).toEqual({ accountId: "acct", releaseProof: "proof", config: { text: "{}" }, mode: "install", paidRiskConfirmed: false });
  });

  it("adds inputs, Hyperdrive picks, renamed resources and (on upgrade only) the secrets to replace", () => {
    const request = buildPlanRequest({
      ...base,
      inputs: { REGION: "eu" },
      hyperdriveUnits: [{ unitId: "api", target: "my-api", bindings: ["DB"] }],
      hyperdriveChoices: { api: { DB: "prod-db" } },
      names: [{ key: "r2:media", kind: "r2", releaseName: "media", mode: "input", value: "photos", options: [], exists: false }],
      replacedSecrets: ["TOKEN"],
      paidRiskConfirmed: true,
    });
    expect(request).toMatchObject({ inputs: { REGION: "eu" }, bindings: { api: { hyperdrive: { DB: "prod-db" } } }, names: { "r2:media": "photos" }, paidRiskConfirmed: true });
    expect(request).not.toHaveProperty("replaceSecrets");
    expect(buildPlanRequest({ ...base, mode: "upgrade", replacedSecrets: ["TOKEN"] }).replaceSecrets).toEqual(["TOKEN"]);
  });

  it("adds the domain choices", () => {
    const request = buildPlanRequest({
      ...base,
      httpUnits: [{ unitId: "api", kind: "worker", target: "my-api" }],
      domainDrafts: { api: { ...EMPTY_DRAFT, bind: true, zone: "example.com", sub: "www" } },
      domainFacts: { accountId: "acct", zones: ["example.com"], workerDomains: [], pagesDomains: {} },
    });
    expect(request.domains).toEqual({ api: { bind: [{ hostname: "www.example.com", zone: "example.com" }] } });
  });
});
