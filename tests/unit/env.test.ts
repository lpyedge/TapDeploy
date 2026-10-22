import { describe, expect, it } from "vitest";
import { canonicalOrigin } from "../../src/api/env.js";

describe("canonicalOrigin", () => {
  it("reduces other spellings of an origin to scheme://host[:port]", () => {
    for (const raw of ["https://deploy.example.com/", " https://deploy.example.com ", "https://Deploy.Example.com", "https://deploy.example.com:443/"]) {
      expect(canonicalOrigin(raw), raw).toBe("https://deploy.example.com");
    }
    expect(canonicalOrigin("http://localhost:8787/")).toBe("http://localhost:8787");
  });

  it("keeps anything that is not a bare origin as given, so the auth check refuses it", () => {
    for (const raw of ["https://deploy.example.com/app", "https://deploy.example.com/?x=1", "https://user:pw@deploy.example.com", "deploy.example.com"]) {
      expect(canonicalOrigin(raw), raw).toBe(raw);
    }
    expect(canonicalOrigin("  ")).toBeUndefined();
    expect(canonicalOrigin(undefined)).toBeUndefined();
  });
});
