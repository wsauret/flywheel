import { describe, it, expect } from "bun:test";
import { formatStageProgress } from "../src/tui/utils/format";

describe("formatStageProgress", () => {
  it("formats plan stage 1 of 3", () => {
    expect(formatStageProgress({ stage: 1, total: 3, stageName: "plan" })).toBe("Plan (1/3)");
  });

  it("formats work stage 2 of 3", () => {
    expect(formatStageProgress({ stage: 2, total: 3, stageName: "work" })).toBe("Work (2/3)");
  });

  it("formats review stage 3 of 3", () => {
    expect(formatStageProgress({ stage: 3, total: 3, stageName: "review" })).toBe("Review (3/3)");
  });

  it("returns empty string when info is null", () => {
    expect(formatStageProgress(null)).toBe("");
  });

  it("returns empty string when info is undefined", () => {
    expect(formatStageProgress(undefined)).toBe("");
  });

  it("returns empty string when stage is 0", () => {
    expect(formatStageProgress({ stage: 0, total: 3, stageName: "plan" })).toBe("");
  });

  it("returns empty string when total is 0", () => {
    expect(formatStageProgress({ stage: 1, total: 0, stageName: "plan" })).toBe("");
  });
});
