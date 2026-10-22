// The pure response parsers fail closed: an upstream body that is not the
// expected container (missing, null, wrong type) is an invalid-response error,
// never an empty list. Only the documented empty container yields [].
import { describe, expect, it } from "vitest";
import * as workers from "../../src/cloudflare/client/parse-workers.js";
import * as resources from "../../src/cloudflare/client/parse-resources.js";
import * as pagesZones from "../../src/cloudflare/client/parse-pages-zones.js";

type Parser = (envelope: { success: boolean; result?: unknown }) => unknown;
const modules = { ...workers, ...resources, ...pagesZones } as unknown as Record<string, Parser>;

// parser -> the one container shape that legitimately means "no items".
const emptyContainer: Record<string, unknown> = {
  parseWorkerList: [],
  parseVersionList: { items: [] },
  parseDeploymentList: { deployments: [] },
  parseD1DatabaseList: [],
  parseKvNamespaceList: [],
  parseQueueList: [],
  parseWorkflowList: [],
  parseHyperdriveConfigList: [],
  parseVectorizeIndexList: [],
  parseSecretsStoreList: [],
  parseSecretsStoreSecretList: [],
  parsePagesProjectList: [],
  parsePagesDeploymentList: [],
  parseZoneList: [],
  parseDnsRecordList: [],
  parseWorkerRouteList: [],
  parseWorkerDomainList: [],
  parsePagesDomainList: [],
};

describe("cloudflare list parsers", () => {
  it("covers every exported list parser", () => {
    expect(Object.keys(modules).filter((name) => /^parse.*List$/.test(name)).sort()).toEqual(Object.keys(emptyContainer).sort());
  });

  it.each(Object.keys(emptyContainer))("%s returns [] only for its empty container", (name) => {
    expect(modules[name]!({ success: true, result: emptyContainer[name] })).toEqual([]);
  });

  it.each(Object.keys(emptyContainer))("%s throws invalid-response instead of returning an empty list", (name) => {
    for (const result of [undefined, null, "x", 1, true, {}]) {
      // `{}` is the empty container of no list parser, `{items: []}`-style containers need their key.
      expect(() => modules[name]!({ success: true, result }), `${name} <- ${JSON.stringify(result)}`).toThrowError(expect.objectContaining({ kind: "invalid-response" }));
    }
  });
});

describe("delete results", () => {
  it("accept an object or null result (custom-domain deletes answer null) and refuse a scalar", () => {
    expect(pagesZones.parseDeleteResult({ success: true, errors: [], messages: [], result: null } as never)).toBeNull();
    expect(pagesZones.parseDeleteResult({ success: true, errors: [], messages: [], result: { id: "x" } } as never)).toBeNull();
    expect(() => pagesZones.parseDeleteResult({ success: true, errors: [], messages: [], result: "deleted" } as never)).toThrow();
  });
});
