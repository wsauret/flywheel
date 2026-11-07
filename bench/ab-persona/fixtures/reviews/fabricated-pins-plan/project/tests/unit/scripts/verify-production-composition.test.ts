import { describe, expect, test } from "bun:test";
import { parseVerifierArguments } from "../../../scripts/verify-production-composition.js";

describe("production composition verifier arguments", () => {
  test("uses standalone mode when no arguments are supplied", () => {
    expect(parseVerifierArguments([])).toEqual({ mode: "standalone" });
  });

  test("accepts exactly one explicit binary path", () => {
    expect(parseVerifierArguments(["--binary", "/tmp/flywheel-bin"])).toEqual({
      mode: "binary",
      path: "/tmp/flywheel-bin",
    });
  });

  test.each([
    [["--binary"], "--binary requires a path"],
    [["--binary", ""], "--binary requires a path"],
    [["--binary", "/tmp/flywheel-bin", "extra"], "Usage:"],
    [["--unknown"], "Usage:"],
  ])("rejects invalid arguments %j", (args, message) => {
    expect(() => parseVerifierArguments(args)).toThrow(message);
  });
});
