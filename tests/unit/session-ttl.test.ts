import { describe, expect, it } from "vitest";
import { TOKEN_CLOCK_SKEW_MS, sessionTtlMs } from "../../src/auth/session.js";

const MAX = 20 * 60 * 1000;

describe("sessionTtlMs", () => {
  it.each([
    [30, 30_000 - TOKEN_CLOCK_SKEW_MS],
    [1200, 1_200_000 - TOKEN_CLOCK_SKEW_MS],
    [1215, MAX],
    [3600, MAX],
    [1e12, MAX],
  ])("expires_in %s -> %s ms, never past the token and never over the cap", (expiresIn, expected) => {
    expect(sessionTtlMs(expiresIn, MAX)).toBe(expected);
  });
  it.each([undefined, null, "3600", "soon", Number.NaN, Number.POSITIVE_INFINITY, {}, []])("keeps the conservative cap for an absent or malformed value %j", (value) => {
    expect(sessionTtlMs(value, MAX)).toBe(MAX);
  });
  it.each([0, -1, -3600, 10, TOKEN_CLOCK_SKEW_MS / 1000])("returns null when nothing is left after the clock-skew margin (%s)", (expiresIn) => {
    expect(sessionTtlMs(expiresIn, MAX)).toBeNull();
  });
  it("never exceeds the provider expiry minus the margin for any whole-second token", () => {
    for (let seconds = 16; seconds < 4000; seconds += 7) expect(sessionTtlMs(seconds, MAX)!).toBeLessThanOrEqual(seconds * 1000 - TOKEN_CLOCK_SKEW_MS);
  });
});
