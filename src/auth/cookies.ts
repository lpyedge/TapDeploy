export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) {
      out[name] = value;
    }
  }
  return out;
}

// The `__Host-` prefix (RFC 6265bis) requires the Secure attribute, which
// browsers only accept over HTTPS. The public origin is HTTPS everywhere except
// http://localhost during development (the only plain-HTTP origin the auth
// config accepts), where the prefix is dropped so the browser keeps the cookie.
export function cookieName(base: string, publicOrigin: string): string {
  return publicOrigin.startsWith("https://") ? `__Host-${base}` : base;
}
