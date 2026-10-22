import { toBase64Url, fromBase64Url, randomBytes } from "./crypto.js";

const NONCE_BYTES = 12;
const VERSION = "v1";
const encoder = new TextEncoder();

export interface SealedEnvelope {
  version: "v1";
  nonce: string;
  ciphertext: string;
}

/**
 * The AES-256-GCM key that seals the session and OAuth-transaction cookies,
 * derived from the OAuth client secret with HKDF-SHA-256 under a dedicated
 * label, so an instance needs no second secret. The derived key is independent
 * of the secret's use at the token endpoint; rotating the client secret signs
 * everyone out (sessions live at most 20 minutes anyway).
 */
export async function deriveSealKey(clientSecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(clientSecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("tapdeploy"), info: encoder.encode("cookie-seal/v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealJson(
  key: CryptoKey,
  value: unknown,
): Promise<SealedEnvelope> {
  const payload = encoder.encode(JSON.stringify(value));
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> },
    key,
    payload as Uint8Array<ArrayBuffer>,
  );
  return {
    version: VERSION,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function openSeal<T>(
  key: CryptoKey,
  envelope: SealedEnvelope,
): Promise<T | null> {
  if (envelope.version !== VERSION) {
    return null;
  }
  try {
    const nonce = fromBase64Url(envelope.nonce);
    const ciphertext = fromBase64Url(envelope.ciphertext);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> },
      key,
      ciphertext as Uint8Array<ArrayBuffer>,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}
