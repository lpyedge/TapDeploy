import { describe, expect, it } from "vitest";

import { safeErrorMessage } from "../../src/web/deploy-shared.js";

describe("safeErrorMessage", () => {
  it("keeps plain words and step or error names readable", () => {
    const text = "invalid-response; resource creation identity unavailable (create-r2-buckets)";
    expect(safeErrorMessage(text)).toBe(text);
  });

  it("redacts ids, JWT segments and keys", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    const message = safeErrorMessage(`token ${jwt} and id 0123456789abcdef0123456789abcdef and key sk_live_4eC39HqLyjWDarjtT1zdp7dc and AAAABBBBCCCCDDDDEEEEFFFF`);
    for (const secret of ["eyJhbGci", "0123456789abcdef0123456789abcdef", "sk_live_4eC39", "AAAABBBBCCCC"]) expect(message).not.toContain(secret);
    expect(message).toContain("[redacted]");
  });
});
