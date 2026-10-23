import { describe, expect, it } from "vitest";
import { inputAskedIn, inputOptions, inputProblem, inputRequiredIn, inputValueProblem } from "../../src/manifest/input-validation.js";

const options = [{ label: "Europe", value: "eu" }, { label: "US", value: "us" }, { label: "Three", value: 3 }];

describe("which mode asks for an input", () => {
  it("install asks for every input; upgrade skips the ones marked upgradeKeep", () => {
    expect([{}, { upgradeKeep: false }, { upgradeKeep: true }].map((input) => [inputAskedIn(input, "install"), inputAskedIn(input, "upgrade")])).toEqual([
      [true, true], [true, true], [true, false],
    ]);
  });

  it("is required at install unless required is false, and never on upgrade (empty keeps the deployed value)", () => {
    expect([{}, { required: true }, { required: false }].map((input) => [inputRequiredIn(input, "install"), inputRequiredIn(input, "upgrade")])).toEqual([
      [true, false], [true, false], [false, false],
    ]);
  });

  it("lists options as labelled values, whether written as plain values or objects", () => {
    expect(inputOptions({ options: ["eu", 3, { label: "US", value: "us" }] })).toEqual([
      { label: "eu", value: "eu" }, { label: "3", value: 3 }, { label: "US", value: "us" },
    ]);
    expect(inputOptions({})).toEqual([]);
  });
});

describe("input values", () => {
  it.each([
    ["integer", "12", null], ["integer", "1.5", "a whole number"], ["integer", "-3", null],
    ["number", "1.5", null], ["number", "abc", "a number"], ["number", " ", "a number"],
    ["boolean", "true", null], ["boolean", "yes", "true or false"],
    ["date", "2028-02-29", null], ["date", "2027-02-29", "a date as YYYY-MM-DD"], ["date", "28/02/2027", "a date as YYYY-MM-DD"],
    ["string", "anything", null],
  ] as const)("%s %s", (type, value, problem) => {
    expect(inputValueProblem({ type }, value)).toBe(problem);
  });

  it("select takes one listed option, multiselect a comma-joined set of them", () => {
    expect(inputValueProblem({ type: "select", options: ["eu", "us"] }, "us")).toBeNull();
    expect(inputValueProblem({ type: "select", options }, "eu")).toBeNull();
    expect(inputValueProblem({ type: "select", options }, "3")).toBeNull();
    expect(inputValueProblem({ type: "select", options }, "asia")).toBe("one of the listed options");
    expect(inputValueProblem({ type: "multiselect", options }, "eu,us")).toBeNull();
    expect(inputValueProblem({ type: "multiselect", options }, "eu,eu")).toBe("only the listed options");
    expect(inputValueProblem({ type: "multiselect", options }, "eu,asia")).toBe("only the listed options");
  });

  it("applies the declared range, length, pattern and allowed values", () => {
    expect(inputValueProblem({ type: "integer", validation: { minimum: 1, maximum: 30 } }, "0")).toBe("at least 1");
    expect(inputValueProblem({ type: "integer", validation: { minimum: 1, maximum: 30 } }, "31")).toBe("at most 30");
    expect(inputValueProblem({ type: "string", validation: { minLength: 3, maxLength: 5 } }, "ab")).toBe("at least 3 characters");
    expect(inputValueProblem({ type: "string", validation: { minLength: 3, maxLength: 5 } }, "abcdef")).toBe("at most 5 characters");
    expect(inputValueProblem({ type: "string", validation: { pattern: "sk_[a-z]+" } }, "sk_live")).toBeNull();
    expect(inputValueProblem({ type: "string", validation: { pattern: "sk_[a-z]+" } }, "live")).toBe("invalid format");
    expect(inputValueProblem({ type: "string", validation: { pattern: "(" } }, "x")).toBe("invalid declared pattern");
    expect(inputValueProblem({ type: "string", validation: { values: ["a", 2] } }, "2")).toBeNull();
    expect(inputValueProblem({ type: "string", validation: { values: ["a", 2] } }, "b")).toBe("one of the allowed values");
  });

  it("an empty value is a problem only where the input is required", () => {
    const input = { type: "string" as const };
    expect(inputProblem(input, "install", "")).toBe("required");
    expect(inputProblem({ ...input, required: false }, "install", "")).toBeNull();
    expect(inputProblem(input, "upgrade", "")).toBeNull();
    expect(inputProblem(input, "upgrade", "x")).toBeNull();
  });
});
