import { describe, expect, it } from "bun:test";
import { checkQuality, gradeChecks, parseCheckTags } from "../../../src/orchestration/modules/development/benchmark/implement-task/check-grade.js";

const TAGS = parseCheckTags({ "new-core": "core", "new-serious": "serious", "new-edge": "edge", "unrun-core": "core" }, "task/checks.json");

describe("core-quality grade", () => {
  it("credits passing new checks, ignores passing existing tests, deducts broken ones, and keeps edge checks apart", () => {
    const grade = gradeChecks(TAGS, new Map([
      ["new-core", true],
      ["new-serious", true],
      ["new-edge", false],
      // unrun-core is absent from the results, so it failed.
      ["existing-pass-1", true],
      ["existing-pass-2", true],
      ["existing-broken", false],
    ]));
    expect(grade).toEqual({ essential: { passed: 2, total: 3 }, broken: 1, edge: { passed: 0, total: 1 } });
    expect(checkQuality(grade)).toBe(2 / 4);
  });

  it("scores a run that reported no check at 0 and a run that passed every new check without breaking anything at 1", () => {
    expect(checkQuality(gradeChecks(TAGS, new Map()))).toBe(0);
    const passing = gradeChecks(TAGS, new Map([["new-core", true], ["new-serious", true], ["unrun-core", true], ["new-edge", false], ["existing", true]]));
    expect(checkQuality(passing)).toBe(1);
  });

  it("refuses a tag list with an unknown tag or with no core or serious check", () => {
    expect(() => parseCheckTags({ a: "minor" }, "task/checks.json")).toThrow("task/checks.json must map each check id to core, serious, or edge");
    expect(() => parseCheckTags({ a: "edge" }, "task/checks.json")).toThrow("task/checks.json tags no core or serious check");
  });
});
