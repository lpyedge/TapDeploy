// Shared base64 encoder for browser, Node and Workers. Upload hashes and
// provider bodies need the base64 *text* of large files; building it through
// String.fromCharCode/btoa copies every byte through a UTF-16 string. This
// emits ASCII bytes directly and uses the native encoder when the runtime has one.

const ALPHABET = new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
const PAD = 61;

// ASCII bytes of base64(bytes), followed by `suffix` verbatim (the hash input
// is base64 text + file extension).
export function base64Ascii(bytes: Uint8Array, suffix: Uint8Array = new Uint8Array(0)): Uint8Array {
  const length = bytes.length;
  const encodedLength = Math.ceil(length / 3) * 4;
  const out = new Uint8Array(encodedLength + suffix.length);
  let o = 0;
  let i = 0;
  for (; i + 2 < length; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = ALPHABET[v >> 18]!;
    out[o++] = ALPHABET[(v >> 12) & 63]!;
    out[o++] = ALPHABET[(v >> 6) & 63]!;
    out[o++] = ALPHABET[v & 63]!;
  }
  const rest = length - i;
  if (rest === 1) {
    const v = bytes[i]! << 16;
    out[o++] = ALPHABET[v >> 18]!;
    out[o++] = ALPHABET[(v >> 12) & 63]!;
    out[o++] = PAD;
    out[o] = PAD;
  } else if (rest === 2) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out[o++] = ALPHABET[v >> 18]!;
    out[o++] = ALPHABET[(v >> 12) & 63]!;
    out[o++] = ALPHABET[(v >> 6) & 63]!;
    out[o] = PAD;
  }
  out.set(suffix, encodedLength);
  return out;
}

type NativeBase64 = { toBase64?: () => string };

export function base64String(bytes: Uint8Array): string {
  const native = (bytes as NativeBase64).toBase64;
  return typeof native === "function" ? native.call(bytes) : new TextDecoder().decode(base64Ascii(bytes));
}
