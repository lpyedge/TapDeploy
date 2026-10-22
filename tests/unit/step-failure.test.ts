// Provider failures reach the operator as a stable kind plus the numeric
// Cloudflare code; known account plan limits get an actionable sentence. The
// provider's raw message never crosses into the step result.
import { afterEach, describe, expect, it, vi } from "vitest";
import { toStepFailure } from "../../src/core/deploy/bindings.js";

afterEach(() => vi.restoreAllMocks());

describe("toStepFailure", () => {
  it("explains the Workers Free cron-trigger limit and keeps the code", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = toStepFailure(Object.assign(new Error("limit"), { kind: "unknown", status: 400, detail: { code: 10072, message: "This account has reached the Workers Free limit of 5 cron triggers per account. https://dash.cloudflare.com/acct/workers/plans" } }));
    expect(failure.ok).toBe(false);
    expect(failure.error.detail).toContain("cron triggers");
    expect(failure.error.detail).toContain("(Cloudflare error 10072)");
    expect(failure.error.detail).not.toContain("dash.cloudflare.com");
  });

  it("an unknown provider code keeps the generic text plus the code", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = toStepFailure(Object.assign(new Error("x"), { kind: "unknown", status: 400, detail: { code: 12345, message: "secret-ish provider text" } }));
    expect(failure.error.detail).toBe("Cloudflare API error (Cloudflare error 12345)");
  });

  it("a provider error without a code is unchanged", () => {
    expect(toStepFailure(Object.assign(new Error("x"), { kind: "forbidden" })).error.detail).toBe("Cloudflare API denied access");
  });
});
