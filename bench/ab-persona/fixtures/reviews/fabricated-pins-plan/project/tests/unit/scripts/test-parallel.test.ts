import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyBunTestArgs, maxShardCount, parseShardCount, planRequestedTests } from "../../../scripts/test-parallel.js";

function args(...tokens: string[]): string[] {
  return tokens;
}

describe("classifyBunTestArgs", () => {
  it("classifies bare tokens as positionals in their original order", () => {
    expect(classifyBunTestArgs(args("second.test.ts", "first.test.ts"))).toEqual([
      { arg: "second.test.ts", kind: "positional" },
      { arg: "first.test.ts", kind: "positional" },
    ]);
  });

  it("treats the value of a separated value option as an option token", () => {
    expect(classifyBunTestArgs(args("--timeout", "20000", "a.test.ts"))).toEqual([
      { arg: "--timeout", kind: "option" },
      { arg: "20000", kind: "option" },
      { arg: "a.test.ts", kind: "positional" },
    ]);
  });

  it("keeps a test-suffixed separated option value out of the positionals", () => {
    expect(classifyBunTestArgs(args("-t", "renders.test.ts"))).toEqual([
      { arg: "-t", kind: "option" },
      { arg: "renders.test.ts", kind: "option" },
    ]);
  });

  it("consumes no following token for the equals form", () => {
    expect(classifyBunTestArgs(args("--test-name-pattern=x.test.ts", "a.test.ts"))).toEqual([
      { arg: "--test-name-pattern=x.test.ts", kind: "option" },
      { arg: "a.test.ts", kind: "positional" },
    ]);
  });

  it("consumes no following token for a flag that takes no value", () => {
    expect(classifyBunTestArgs(args("--todo", "a.test.ts"))).toEqual([
      { arg: "--todo", kind: "option" },
      { arg: "a.test.ts", kind: "positional" },
    ]);
  });

  it("does not swallow the next option as a value", () => {
    expect(classifyBunTestArgs(args("--timeout", "--todo"))).toEqual([
      { arg: "--timeout", kind: "option" },
      { arg: "--todo", kind: "option" },
    ]);
  });

  it("ends option parsing at -- and keeps the order of later tokens", () => {
    expect(classifyBunTestArgs(args("--todo", "--", "--timeout", "a.test.ts"))).toEqual([
      { arg: "--todo", kind: "option" },
      { arg: "--", kind: "option" },
      { arg: "--timeout", kind: "positional" },
      { arg: "a.test.ts", kind: "positional" },
    ]);
  });

  it("treats a lone dash as a positional", () => {
    expect(classifyBunTestArgs(args("-"))).toEqual([{ arg: "-", kind: "positional" }]);
  });
});

function withRepo(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "flywheel-test-parallel-"));
  try {
    mkdirSync(join(root, "tests/unit/nested"), { recursive: true });
    writeFileSync(join(root, "tests/unit/nested/present.test.ts"), "export {}\n");
    writeFileSync(join(root, "tests/unit/other.test.tsx"), "export {}\n");
    writeFileSync(join(root, "README.md"), "hi\n");
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("planRequestedTests", () => {
  it("reports every missing test path when none of them exist", () => {
    withRepo((root) => {
      const plan = planRequestedTests(args("tests/unit/gone.test.ts", "tests/unit/also-gone.test.tsx"), root);
      expect(plan.missing).toEqual(["tests/unit/gone.test.ts", "tests/unit/also-gone.test.tsx"]);
      expect(plan.files).toEqual([]);
      expect(plan.dirs).toEqual([]);
    });
  });

  it("reports the missing path when it is mixed with an existing one", () => {
    withRepo((root) => {
      const plan = planRequestedTests(args("tests/unit/nested/present.test.ts", "tests/unit/gone.test.ts"), root);
      expect(plan.missing).toEqual(["tests/unit/gone.test.ts"]);
      expect(plan.files).toEqual([join(root, "tests/unit/nested/present.test.ts")]);
    });
  });

  it("reports a missing path-like directory instead of falling back to the full suite", () => {
    withRepo((root) => {
      const plan = planRequestedTests(args("tests/unit/no-such-directory"), root);
      expect(plan.missing).toEqual(["tests/unit/no-such-directory"]);
      expect(plan.files).toEqual([]);
      expect(plan.dirs).toEqual([]);
      expect(plan.passThrough).toEqual([]);
    });
  });

  it("collects existing focused files and directories", () => {
    withRepo((root) => {
      const plan = planRequestedTests(args("tests/unit/other.test.tsx", "tests/unit/nested"), root);
      expect(plan.files).toEqual([join(root, "tests/unit/other.test.tsx")]);
      expect(plan.dirs).toEqual([join(root, "tests/unit/nested")]);
      expect(plan.missing).toEqual([]);
      expect(plan.passThrough).toEqual([]);
    });
  });

  it("requests nothing when no arguments are given, so the caller runs the full unit suite", () => {
    withRepo((root) => {
      expect(planRequestedTests(args(), root)).toEqual({
        files: [],
        dirs: [],
        passThrough: [],
        missing: [],
      });
    });
  });

  it("never treats an option value as a requested path", () => {
    withRepo((root) => {
      const plan = planRequestedTests(args("-t", "gone.test.ts", "--timeout=1000"), root);
      expect(plan.missing).toEqual([]);
      expect(plan.passThrough).toEqual(["-t", "gone.test.ts", "--timeout=1000"]);
    });
  });

  it("passes through an existing non-test file and an unrecognized name filter", () => {
    withRepo((root) => {
      const plan = planRequestedTests(args("README.md", "somefilter"), root);
      expect(plan.missing).toEqual([]);
      expect(plan.files).toEqual([]);
      expect(plan.passThrough).toEqual(["README.md", "somefilter"]);
    });
  });

  it("keeps options and positionals in their original order in passThrough", () => {
    withRepo((root) => {
      const plan = planRequestedTests(args("--todo", "filter-a", "--", "filter-b"), root);
      expect(plan.passThrough).toEqual(["--todo", "filter-a", "--", "filter-b"]);
    });
  });
});

describe("parseShardCount", () => {
  it("uses the default when TEST_SHARDS is unset or empty", () => {
    expect(parseShardCount(undefined, 6)).toBe(6);
    expect(parseShardCount("", 6)).toBe(6);
    expect(parseShardCount("  ", 6)).toBe(6);
  });

  it("accepts a positive integer override up to the maximum", () => {
    expect(parseShardCount("1", 6)).toBe(1);
    expect(parseShardCount("12", 6)).toBe(12);
    expect(parseShardCount(" 3 ", 6)).toBe(3);
    expect(parseShardCount(String(maxShardCount), 6)).toBe(maxShardCount);
  });

  it.each(["0", "-1", "2.5", "1e2", "abc", "4x", "+4", "Infinity", "NaN"])(
    "rejects %s instead of clamping it",
    (override) => {
      expect(parseShardCount(override, 6)).toBeNull();
    },
  );

  // A digit run this long turns into Infinity or a value no allocation can
  // serve, so it has to be rejected as an override rather than reaching the
  // shard array.
  it.each([String(maxShardCount + 1), "99999999999999999999", "9".repeat(400)])(
    "rejects the oversized override %s",
    (override) => {
      expect(parseShardCount(override, 6)).toBeNull();
    },
  );
});
