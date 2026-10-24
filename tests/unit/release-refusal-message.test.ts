import { describe, expect, it } from "vitest";
import { RELEASE_MAX_BYTES } from "../../src/core/upload-limits.js";
import { releaseRefusalMessage } from "../../src/web/compute/refusal-message.js";

const refusal = (status: 400 | 403 | 409 | 413, error: string) => ({ status, body: { error } });
const pin = "ab12cd34ef56".padEnd(64, "0");

describe("releaseRefusalMessage", () => {
  it("names the size, the limit and that nothing was uploaded", () => {
    const message = releaseRefusalMessage(refusal(413, "SERVER_ZIP_VERIFY_LIMIT"), { bytes: 20 * 1024 * 1024 })!;
    expect(message).toContain("20.0 MiB");
    expect(message).toContain("8.0 MiB");
    expect(RELEASE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(message).toContain("Nothing was uploaded");
  });
  it("explains a pin mismatch with the pinned prefix, never the full hash", () => {
    const message = releaseRefusalMessage(refusal(409, "SOURCE_POLICY_MISMATCH"), { bytes: 1, expectedSha256: pin })!;
    expect(message).toContain("SHA-256 does not match ab12cd34ef56…");
    expect(message).not.toContain(pin);
    expect(message).toContain("Nothing was uploaded");
  });
  it("leaves a policy mismatch without a pin to the generic rendering", () => {
    expect(releaseRefusalMessage(refusal(409, "SOURCE_POLICY_MISMATCH"), { bytes: 1 })).toBeNull();
  });
  it("explains a config that only accepts its own link", () => {
    expect(releaseRefusalMessage(refusal(403, "SOURCE_ORIGIN_UNATTESTED"), { bytes: 1 })).toContain("download link");
  });
  it("keeps ZIP-content refusals generic so the server's code and detail stay visible", () => {
    expect(releaseRefusalMessage({ status: 400, body: { error: "INVALID_PREBUILT_ZIP", detail: "x" } }, { bytes: 1 })).toBeNull();
    expect(releaseRefusalMessage({ status: 400, body: { error: "INVALID_PER_UNIT_RELEASE", detail: "x" } }, { bytes: 1 })).toBeNull();
  });
});
