import { describe, expect, test } from "bun:test";
import { findDevelopmentMarkers, parseVerifierArguments } from "../../../scripts/verify-production-composition.js";

describe("production composition verifier arguments", () => {
  test("uses standalone mode when no arguments are supplied", () => {
    expect(parseVerifierArguments([])).toEqual({ mode: "standalone" });
  });

  test("accepts exactly one explicit binary path", () => {
    expect(parseVerifierArguments(["--binary", "/scratch/flywheel-bin"])).toEqual({
      mode: "binary",
      path: "/scratch/flywheel-bin",
    });
  });

  test.each([
    [["--binary"], "--binary requires a path"],
    [["--binary", ""], "--binary requires a path"],
    [["--binary", "/scratch/flywheel-bin", "extra"], "Usage:"],
    [["--unknown"], "Usage:"],
  ])("rejects invalid arguments %j", (args, message) => {
    expect(() => parseVerifierArguments(args)).toThrow(message);
  });
});

describe("release build development markers", () => {
  test("names the development descriptor and its definition bundle when a build carries them", () => {
    const build = new TextEncoder().encode(`prelude "flywheel-uat/SKILL.md" rest "Flywheel's own benchmark, simulator, and report tooling"`);
    expect(findDevelopmentMarkers(build)).toEqual(["Flywheel's own benchmark, simulator, and report tooling", "flywheel-uat/SKILL.md"]);
  });

  test("finds nothing in a build that only mentions the module", () => {
    expect(findDevelopmentMarkers(new TextEncoder().encode("the development module is absent from releases; flywheel-uat is one of its skills"))).toEqual([]);
  });

  test("detects the committed development descriptor", async () => {
    const descriptor = await Bun.file(new URL("../../../src/orchestration/modules/development/module.ts", import.meta.url)).bytes();
    expect(findDevelopmentMarkers(descriptor)).toEqual(["Flywheel's own benchmark, simulator, and report tooling"]);
  });
});
