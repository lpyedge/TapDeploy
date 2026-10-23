// The live state of one custom domain on the result page: watches until the
// domain is serving, says plainly what is going on while it is not, and offers
// a manual re-check once the watch gives up.

import { useEffect, useState } from "react";
import { getDomains } from "./api.js";
import { READINESS_POLL_MS, READINESS_WATCH_MS, pagesReadiness, probeHostname, type DomainReadiness } from "./domain-readiness.js";
import { Spinner } from "./Spinner.js";

export interface DomainTarget {
  hostname: string;
  kind: "worker" | "pages";
  /** The Pages project the hostname is bound to. */
  project?: string;
}

export function V3DomainStatus({ csrf, accountId, domain }: { csrf: string; accountId: string; domain: DomainTarget }) {
  const [readiness, setReadiness] = useState<DomainReadiness>({ state: "pending" });
  const [gaveUp, setGaveUp] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setGaveUp(false);
    const check = async (): Promise<DomainReadiness> => {
      if (domain.kind === "pages" && domain.project) {
        const facts = await getDomains(csrf, accountId, { pagesProjects: [domain.project] });
        return pagesReadiness(facts.pagesDomainStatus?.[domain.project]?.[domain.hostname]);
      }
      return (await probeHostname(domain.hostname)) ? { state: "live" } : { state: "pending" };
    };
    const tick = async () => {
      const next = await check().catch((): DomainReadiness => ({ state: "pending" }));
      if (cancelled) return;
      setReadiness(next);
      if (next.state !== "pending") return;
      if (Date.now() - started >= READINESS_WATCH_MS) setGaveUp(true);
      else timer = setTimeout(() => void tick(), READINESS_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [csrf, accountId, domain.hostname, domain.kind, domain.project, round]);

  if (readiness.state === "live") return <p className="domain-status domain-live" role="status" data-testid="v3-domain-live">✓ Live</p>;
  if (readiness.state === "problem") {
    return (
      <p className="domain-status domain-problem" role="status" data-testid="v3-domain-problem">
        Cloudflare reports this domain as “{readiness.status}”. Open it in the Cloudflare dashboard to see what it needs.
      </p>
    );
  }
  return (
    <p className="domain-status domain-pending" role="status" data-testid="v3-domain-pending">
      {gaveUp ? (
        <>
          Still not active after 5 minutes. A new domain can take longer; check its status in the Cloudflare dashboard.{" "}
          <button type="button" className="link" onClick={() => setRound((value) => value + 1)} data-testid="v3-domain-recheck">Check again</button>
        </>
      ) : (
        <>
          <Spinner />Setting up: Cloudflare is verifying DNS and issuing the certificate. This usually takes a few minutes, and this page keeps checking.
          {readiness.status ? ` (Cloudflare status: ${readiness.status})` : ""}
        </>
      )}
    </p>
  );
}
