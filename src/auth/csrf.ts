import type { SessionPayload } from "./session.js";

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i]! ^ bb[i]!;
  }
  return diff === 0;
}

export function validateCsrf(
  session: SessionPayload,
  headerValue: string | undefined,
): boolean {
  if (!headerValue) {
    return false;
  }
  return timingSafeEqual(session.csrf, headerValue);
}

export function validateOrigin(
  publicOrigin: string,
  originHeader: string | undefined,
): boolean {
  if (!originHeader) {
    // No Origin header is acceptable for same-origin navigation requests that
    // are not cross-site; the CSRF token is the authoritative gate.
    return true;
  }
  return originHeader === publicOrigin;
}
