import { describe, it, expect } from "bun:test";
import { formatStepProgress } from "../src/tui/utils/format";

describe("formatStepProgress", () => {
  it("formats plan step 1 of 3", () => {
    expect(formatStepProgress({ step: 1, total: 3, stepName: "plan" })).toBe("Plan (1/3)");
  });

  it("formats work step 2 of 3", () => {
    expect(formatStepProgress({ step: 2, total: 3, stepName: "work" })).toBe("Work (2/3)");
  });

  it("formats review step 3 of 3", () => {
    expect(formatStepProgress({ step: 3, total: 3, stepName: "review" })).toBe("Review (3/3)");
  });

  it("returns empty string when info is null", () => {
    expect(formatStepProgress(null)).toBe("");
  });

  it("returns empty string when info is undefined", () => {
    expect(formatStepProgress(undefined)).toBe("");
  });

  it("returns empty string when step is 0", () => {
    expect(formatStepProgress({ step: 0, total: 3, stepName: "plan" })).toBe("");
  });

  it("returns empty string when total is 0", () => {
    expect(formatStepProgress({ step: 1, total: 0, stepName: "plan" })).toBe("");
  });
});
