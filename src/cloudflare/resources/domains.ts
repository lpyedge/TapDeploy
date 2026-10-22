// Workers / Pages custom-domain support metadata.
//
// A custom domain attaches a hostname directly to a Worker (Workers Domains
// PUT, covered by Workers Scripts Write) or a Pages project (Pages domains,
// covered by Pages Write). The operator chooses them per HTTP unit; the
// decision and execution live in core/deploy/custom-domains.ts and
// core/deploy/domains.ts. Removal is only ever the operator's explicit choice
// on upgrade, for a binding of the same unit.

import { type ResourceAdapter, type ResourceSupport } from "./types.js";

export const WORKER_CUSTOM_DOMAIN_SUPPORT: ResourceSupport = {
  kind: "worker-custom-domain",
  label: "Worker custom domain",
  install: "create-declared",
  upgrade: "reconcile",
  deletes: "explicit",
  verified: "local-contract",
};

export const PAGES_CUSTOM_DOMAIN_SUPPORT: ResourceSupport = {
  kind: "pages-custom-domain",
  label: "Pages custom domain",
  install: "create-declared",
  upgrade: "reconcile",
  deletes: "explicit",
  verified: "local-contract",
};

export const workerCustomDomainAdapter: ResourceAdapter = {
  support: WORKER_CUSTOM_DOMAIN_SUPPORT,
  mutation: "reconcileDomains",
};

export const pagesCustomDomainAdapter: ResourceAdapter = {
  support: PAGES_CUSTOM_DOMAIN_SUPPORT,
  mutation: "reconcileDomains",
};
