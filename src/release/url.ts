// GitHub release downloads (and the CDN hosts they redirect to) send no CORS
// headers, so a browser cannot fetch them itself. The installer relays exactly
// these hosts, as a bounded stream, for an authenticated session. Every other
// host is fetched by the browser directly and must allow it (CORS).
const RELAYED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
// <owner>/<repo>/releases/download/<tag>/<asset>, releases/latest/download/<asset>
// (GitHub redirects it to the tagged path) or archive/<ref>.
const GITHUB_DOWNLOAD_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(releases\/(latest\/)?download|archive)\/.+/;

export function isRelayedDownloadHost(raw: string): boolean {
  try {
    return RELAYED_DOWNLOAD_HOSTS.has(new URL(raw).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Why the installer will not relay this URL (and every redirect it follows), or null when it may. */
export function relayedDownloadProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "malformed URL";
  }
  if (url.protocol !== "https:") return "only https is allowed";
  if (url.username || url.password) return "credentials in the URL are not allowed";
  if (url.port && url.port !== "443") return "only the default https port is allowed";
  const host = url.hostname.toLowerCase();
  if (!RELAYED_DOWNLOAD_HOSTS.has(host) || isPrivateHost(host)) return `host "${host}" cannot be downloaded through the installer`;
  if (host === "github.com" && !GITHUB_DOWNLOAD_PATH.test(url.pathname)) return "only GitHub release downloads can be fetched from github.com";
  return null;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const v4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;
  if (!host.includes(":")) return v4.test(host);
  // URL canonicalizes IPv6, including dotted IPv4-mapped literals, to hex.
  if (host === "::" || host === "::1" || /^(fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(host)) return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return false;
  const a = parseInt(mapped[1]!, 16), b = parseInt(mapped[2]!, 16);
  return v4.test(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
}
