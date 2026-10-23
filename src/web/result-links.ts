// The addresses a successful deploy ends with, each told apart by what it is:
// a custom domain the user bound (which may still be setting up), the Worker's
// workers.dev address, or a Pages site's address. Derived from the verified
// addresses and the approved plan, never guessed.

import type { GraphPlan } from "./api.js";
import type { DomainTarget } from "./V3DomainStatus.js";

export interface ResultLink {
  url: string;
  kind: "domain" | "workers-dev" | "pages";
  /** Set for a custom domain: what to watch. */
  domain?: DomainTarget;
}

const DOMAIN_RESOURCES = { "worker-custom-domain": "worker", "pages-custom-domain": "pages" } as const;

/** The custom domains the plan binds or moves, with the Pages project of a Pages one. */
function plannedDomains(plan: GraphPlan | null): DomainTarget[] {
  return (plan?.units ?? []).flatMap((unit) => {
    const project = (unit.diffs ?? []).find((diff) => diff.resource === "pages-project")?.name ?? unit.name;
    return (unit.diffs ?? []).flatMap((diff) => {
      const kind = DOMAIN_RESOURCES[diff.resource as keyof typeof DOMAIN_RESOURCES];
      if (!kind || (diff.action !== "attach" && diff.action !== "update") || typeof diff.name !== "string") return [];
      return [{ hostname: diff.name.toLowerCase(), kind, ...(kind === "pages" && project ? { project } : {}) }];
    });
  });
}

const hostOf = (url: string): string => new URL(url).hostname.toLowerCase();

export function resultLinks(urls: readonly string[], plan: GraphPlan | null): ResultLink[] {
  const domains = new Map(plannedDomains(plan).map((domain) => [domain.hostname, domain]));
  return urls.map((url) => {
    const host = hostOf(url);
    const domain = domains.get(host);
    if (domain) return { url, kind: "domain", domain };
    return { url, kind: host.endsWith(".workers.dev") ? "workers-dev" : "pages" };
  });
}
