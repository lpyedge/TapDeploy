// Is a custom domain serving yet? Cloudflare answers the bind immediately, but
// DNS and the certificate follow: a Pages domain stays "pending" in the
// dashboard ("Complete DNS setup") for a few minutes. The result page keeps
// checking instead of letting a working deployment look broken.

export type DomainReadiness =
  | { state: "pending"; status?: string }
  | { state: "live" }
  | { state: "problem"; status: string };

/** Pages reports `active` once DNS and the certificate are done; blocked / error ones need the owner. */
export function pagesReadiness(status: string | undefined): DomainReadiness {
  if (status === "active") return { state: "live" };
  if (status === "blocked" || status === "error" || status === "deactivated") return { state: "problem", status };
  return { state: "pending", ...(status ? { status } : {}) };
}

/**
 * Whether the hostname answers over HTTPS at all. The request is opaque (no
 * CORS), which is enough: it fails while DNS or the certificate is not there
 * yet and resolves once anything answers.
 */
export async function probeHostname(hostname: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(`https://${hostname}/`, { mode: "no-cors", cache: "no-store", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const READINESS_WATCH_MS = 5 * 60 * 1000;

/** Checks start close together and spread out: 5, 10, 20, then every 30 seconds, so a watch costs about a dozen requests. */
export function readinessDelay(attempt: number): number {
  return Math.min(30_000, 5_000 * 2 ** attempt);
}
