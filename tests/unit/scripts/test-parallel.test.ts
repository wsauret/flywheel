import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { bandFileArguments, classifyBunTestArgs, createShardProgress, defaultHangGuardSeconds, failureOutput, fitsWindowsCommandLine, maxHangGuardSeconds, maxShardCount, parseHangGuardSeconds, parseShardCount, planRequestedTests, planTestBands, runFails, runTestBands, waitForShardExits } from "../../../scripts/test-parallel.js";

function args(...tokens: string[]): string[] {
  return tokens;
}

describe("classifyBunTestArgs", () => {
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
});

describe("parseHangGuardSeconds", () => {
  it("keeps the development default when TEST_HANG_GUARD_SECONDS is unset or empty", () => {
    expect(parseHangGuardSeconds(undefined)).toBe(defaultHangGuardSeconds);
    expect(parseHangGuardSeconds(" ")).toBe(defaultHangGuardSeconds);
  });

  it("gives a slower machine the time it names, up to the maximum", () => {
    expect(parseHangGuardSeconds("600")).toBe(600);
    expect(parseHangGuardSeconds(String(maxHangGuardSeconds))).toBe(maxHangGuardSeconds);
  });

  it.each(["0", "-1", "2.5", "abc", String(maxHangGuardSeconds + 1)])(
    "rejects %s instead of clamping it",
    (override) => {
      expect(parseHangGuardSeconds(override)).toBeNull();
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

describe("runFails", () => {
  const clean = { failed: false, overBudget: false, budgetAdvisory: false, leaked: false };

  it("fails a slow run unless the budget is advisory", () => {
    expect(runFails({ ...clean, overBudget: true })).toBe(true);
    expect(runFails({ ...clean, overBudget: true, budgetAdvisory: true })).toBe(false);
  });

  it("never lets an advisory budget pass a failed or leaking run", () => {
    expect(runFails({ ...clean, overBudget: true, budgetAdvisory: true, failed: true })).toBe(true);
    expect(runFails({ ...clean, overBudget: true, budgetAdvisory: true, leaked: true })).toBe(true);
  });
});

describe("planTestBands", () => {
  const directory = (name: string, count: number) => Array.from({ length: count }, (_, index) => join(name, `${String(index).padStart(3, "0")}.test.ts`));

  it("spreads a large central directory across every worker", () => {
    const before = directory("before", 40);
    const heavy = directory("heavy", 80);
    const after = directory("later", 40);
    const shards = planTestBands([...before, ...heavy, ...after], 4);
    const heavyFiles = new Set(heavy);
    expect(shards.map((shard) => shard.filter((file) => heavyFiles.has(file)).length)).toEqual([20, 20, 20, 20]);
    const files = [...before, ...heavy, ...after];
    expect(shards.flat().toSorted()).toEqual(files);
    expect(shards).toHaveLength(4);
  });

  it("balances an uneven final chunk", () => {
    const files = directory("suite", 31);
    const bands = planTestBands(files, 3);
    expect(bands.flat().toSorted()).toEqual(files);
    expect(bands.map((band) => band.length).toSorted()).toEqual([10, 10, 11]);
  });

  it("omits empty bands and retains single-process execution when requested", () => {
    expect(planTestBands([], 3)).toEqual([]);
    expect(planTestBands(["one.test.ts"], 3)).toEqual([["one.test.ts"]]);
    const files = directory("focused", 7);
    expect(planTestBands(files, 1)).toEqual([files]);
  });

  it("uses file weights to split a heavy region into smaller contiguous bands", () => {
    const files = directory("suite", 12);
    const weights = new Map(files.map((file, index) => [file, index >= 4 && index < 8 ? 10 : 1]));
    const bands = planTestBands(files, 2, (file) => weights.get(file)!);
    expect(bands.flat().toSorted()).toEqual(files);
    expect(bands.map((band) => band.length)).toEqual([6, 6]);
    expect(bands.map((band) => band.reduce((total, file) => total + weights.get(file)!, 0))).toEqual([24, 24]);
  });

  it("adds a band for every worker until each band fits, so every worker runs the same number of bands", () => {
    const files = directory("suite", 12);
    const bands = planTestBands(files, 2, () => 1, (band) => band.length <= 4);
    expect(bands.flat().toSorted()).toEqual(files);
    expect(bands.map((band) => band.length)).toEqual([3, 3, 3, 3]);
  });

  it("splits a single worker's band into contiguous bands in their original order", () => {
    const files = directory("suite", 12);
    expect(planTestBands(files, 1, () => 1, (band) => band.length <= 5)).toEqual([files.slice(0, 4), files.slice(4, 8), files.slice(8)]);
  });
});

describe("fitsWindowsCommandLine", () => {
  // About the length of this repository's test paths, relative and prefixed as `bandFileArguments` writes them.
  const band = (count: number) => ["bun", "--conditions=browser", "test", "--timeout", "20000", ...Array.from({ length: count }, (_, index) => `.\\tests\\unit\\orchestration\\modules\\remote\\${String(index).padStart(4, "0")}-relay-module.test.ts`)];

  it("refuses a band that passes the 32,767-character cap and accepts one under it", () => {
    expect(fitsWindowsCommandLine(band(550))).toBe(false);
    expect(fitsWindowsCommandLine(band(450))).toBe(true);
  });

  it("counts the quotes that an argument with a space needs", () => {
    const filler = "x".repeat(32_767 - "bun ".length - "a b".length - 1);
    expect(fitsWindowsCommandLine(["bun", filler, "ab"])).toBe(true);
    expect(fitsWindowsCommandLine(["bun", filler, "a b"])).toBe(false);
  });
});

describe("bandFileArguments", () => {
  it("names each file relative to the repository, so a band's command line does not grow with the checkout's path", () => {
    const repoRoot = join(tmpdir(), "a checkout whose path is long enough to matter on Windows");
    const files = [join(repoRoot, "tests", "unit", "one.test.ts"), join(repoRoot, "webview", "src", "two.test.tsx")];
    expect(bandFileArguments(files, repoRoot)).toEqual([`.${sep}${join("tests", "unit", "one.test.ts")}`, `.${sep}${join("webview", "src", "two.test.tsx")}`]);
  });
});

describe("runTestBands", () => {
  it("gives the next band to a free worker while retaining the concurrency limit and result order", async () => {
    const bands = Array.from({ length: 4 }, (_, index) => [`${index}.test.ts`]);
    const completions = bands.map(() => Promise.withResolvers<number>());
    const starts = bands.map(() => Promise.withResolvers<void>());
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const result = runTestBands(bands, 2, async (files, bandIndex, workerIndex) => {
      expect([...files]).toEqual(bands[bandIndex]!);
      expect(workerIndex).toBeLessThan(2);
      started.push(bandIndex);
      peak = Math.max(peak, ++active);
      starts[bandIndex]!.resolve();
      try {
        return await completions[bandIndex]!.promise;
      } finally {
        active--;
      }
    });
    expect(started).toEqual([0, 1]);
    completions[1]!.resolve(11);
    await starts[2]!.promise;
    expect(started).toEqual([0, 1, 2]);
    completions[2]!.resolve(22);
    await starts[3]!.promise;
    expect(started).toEqual([0, 1, 2, 3]);
    completions[3]!.resolve(33);
    completions[0]!.resolve(0);
    expect(await result).toEqual([0, 11, 22, 33]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("does not start a worker for an empty suite", async () => {
    let calls = 0;
    expect(await runTestBands([], 4, async () => ++calls)).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("createShardProgress", () => {
  it.each([
    ["crash", "error: process crashed\n", true],
    ["signal", "", true],
    ["failed test run", " 1 pass\n 1 fail\nRan 2 tests across 2 files. [150.00ms]\n", false],
    ["passed test run", " 2 pass\n 0 fail\nRan 2 tests across 2 files. [150.00ms]\n", false],
  ])("finishes only a normal band result: %s", (_kind, output, running) => {
    let now = 0;
    const progress = createShardProgress(() => now);
    progress.append("tests/unit/first.test.ts:\n");
    now = 120;
    progress.append("tests/unit/second.test.ts:\n");
    now = 150;
    progress.finish(output);
    expect(progress.snapshot()).toEqual([
      { file: "tests/unit/first.test.ts", elapsedMs: 120, running: false },
      { file: "tests/unit/second.test.ts", elapsedMs: 30, running },
    ]);
  });

  it("keeps current and completed file wall times across partial stderr chunks", () => {
    let now = 0;
    const progress = createShardProgress(() => now);
    progress.append("bun test v1.4.0\n\ntests/unit/first.test.");
    expect(progress.snapshot()).toEqual([]);
    progress.append("ts:\n(pass) first [1.00ms]\n");
    now = 120;
    progress.append("tests/unit/second.test.tsx:\n");
    now = 150;
    expect(progress.snapshot()).toEqual([
      { file: "tests/unit/first.test.ts", elapsedMs: 120, running: false },
      { file: "tests/unit/second.test.tsx", elapsedMs: 30, running: true },
    ]);
    progress.finish("Ran 2 tests across 2 files. [150.00ms]\n");
    now = 300;
    expect(progress.snapshot().at(-1)).toEqual({ file: "tests/unit/second.test.tsx", elapsedMs: 30, running: false });
  });
});

describe("waitForShardExits", () => {
  it("bounds the wait and identifies only processes that have not settled", async () => {
    const exited = { exited: Promise.resolve(137) };
    const stuck = { exited: new Promise<number>(() => {}) };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        waitForShardExits([exited, stuck], 1),
        new Promise<string>((resolve) => { deadline = setTimeout(() => resolve("wait did not end"), 20); }),
      ]);
      expect(result).toEqual([stuck]);
    } finally {
      clearTimeout(deadline);
    }
  });
});

describe("failureOutput", () => {
  it("prints a band read for its headings as --only-failures would", () => {
    const output = [
      "bun test v1.4.0 (34cbb9a40)",
      "",
      "tests/unit/a.test.ts:",
      "(pass) grp > ok one",
      "error: expect(received).toBe(expected)",
      "(fail) grp > bad [0.23ms]",
      "(skip) grp > sk",
      "(todo) grp > td",
      "",
      "tests\\unit\\b.test.ts:\r",
      "(pass) fine",
      "",
      " 2 pass",
      " 1 fail",
    ].join("\n");
    expect(failureOutput(output)).toBe([
      "bun test v1.4.0 (34cbb9a40)",
      "",
      "tests/unit/a.test.ts:",
      "error: expect(received).toBe(expected)",
      "(fail) grp > bad [0.23ms]",
      "",
      " 2 pass",
      " 1 fail",
    ].join("\n"));
  });
});
