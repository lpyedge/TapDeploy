// The addresses a successful deploy ends with, each told apart by what it is:
// a custom domain the user bound (which may still be setting up), the Worker's
// workers.dev address, or a Pages site's address. Derived from the verified
// addresses and the approved plan, never guessed.

import type { DomainsEnvelope, GraphPlan } from "./api.js";
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

/** The Workers and Pages projects a plan deploys, by the names they end up with. */
export function deployedTargets(plan: GraphPlan | null): { workers: string[]; pagesProjects: string[] } {
  const units = plan?.units ?? [];
  const named = (unit: GraphPlan["units"][number], resource: string) => (unit.diffs ?? []).find((diff) => diff.resource === resource)?.name;
  return {
    workers: units.flatMap((unit) => (unit.kind === "worker" ? [named(unit, "worker")].filter((name): name is string => typeof name === "string") : [])),
    pagesProjects: units.flatMap((unit) => (unit.kind.startsWith("pages") ? [named(unit, "pages-project") ?? unit.name] : [])),
  };
}

/**
 * The custom domains the account says are bound to what was just deployed: the
 * ones this deploy added and the ones an upgrade kept. (`*.pages.dev` is the
 * project's own address, not a custom domain.)
 */
export function boundDomains(facts: DomainsEnvelope, plan: GraphPlan | null): DomainTarget[] {
  const { workers, pagesProjects } = deployedTargets(plan);
  return [
    ...facts.workerDomains.filter((domain) => domain.service !== undefined && workers.includes(domain.service)).map((domain): DomainTarget => ({ hostname: domain.hostname.toLowerCase(), kind: "worker" })),
    ...pagesProjects.flatMap((project) => (facts.pagesDomains[project] ?? []).filter((hostname) => !hostname.endsWith(".pages.dev")).map((hostname): DomainTarget => ({ hostname: hostname.toLowerCase(), kind: "pages", project }))),
  ];
}

/** The verified addresses plus the custom domains bound to the deployment (kept ones too), each told apart; custom domains first. */
export function resultLinks(urls: readonly string[], plan: GraphPlan | null, bound: readonly DomainTarget[] = []): ResultLink[] {
  const domains = new Map([...plannedDomains(plan), ...bound].map((domain) => [domain.hostname, domain]));
  const links = urls.map((url): ResultLink => {
    const domain = domains.get(hostOf(url));
    if (domain) return { url, kind: "domain", domain };
    return { url, kind: hostOf(url).endsWith(".workers.dev") ? "workers-dev" : "pages" };
  });
  const listed = new Set(links.map((link) => hostOf(link.url)));
  const kept = bound.filter((domain) => !listed.has(domain.hostname)).map((domain): ResultLink => ({ url: `https://${domain.hostname}/`, kind: "domain", domain }));
  return [...links.filter((link) => link.kind === "domain"), ...kept, ...links.filter((link) => link.kind !== "domain")];
}
