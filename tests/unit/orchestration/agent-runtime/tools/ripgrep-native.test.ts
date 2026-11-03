import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { grep as nativeGrep, SearchStoppedError } from "../../../../../src/orchestration/agent-runtime/tools/ripgrep.js";

type GrepInput = Omit<Parameters<typeof nativeGrep>[0], "cpuLimitMs" | "timeoutMs"> & { cpuLimitMs?: number; timeoutMs?: number };
const grep = (options: GrepInput, signal?: AbortSignal) => nativeGrep({ cpuLimitMs: 30_000, timeoutMs: 30_000, ...options }, signal);

describe("native ripgrep", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-search-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("native grep rejects with a wall-backstop stop when the wall-clock limit is exhausted", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "alpha needle\n");

    await expect(grep({ pattern: "needle", path: tmpDir, timeoutMs: 0 })).rejects.toEqual(new SearchStoppedError("wall-backstop"));
  });

  it("selects PCRE2 for look-around and backreferences without changing result controls", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "heading\nfoo foo\nfoo foo\nbetween\nFOO FOO\nend\n");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "foo foo\n");
    const pattern = String.raw`(?<!x)(\w+)\s+\1(?=$)`;
    await expect(grep({ pattern, path: tmpDir })).rejects.toThrow("Regex error");
    for (const controls of [
      { mode: "content", contextBefore: 1, contextAfter: 1 },
      { mode: "content", maxCount: 2, offset: 1 },
      { mode: "content", maxCount: 2, offset: 1, tail: true },
      { mode: "count", maxCount: 1, offset: 1 },
      { mode: "filesWithMatches", maxCount: 1, offset: 1 },
    ] as const) {
      for (const multiline of [false, true]) {
        const options = { path: tmpDir, ignoreCase: true, ...controls, multiline };
        const expected = await grep({ ...options, pattern: "foo foo" });
        const actual = await grep({ ...options, pattern, engine: "pcre2" });
        expect(actual).toEqual(expected);
      }
    }
    const target = path.join(tmpDir, "a.txt");
    const multiline = await grep({ pattern: "foo foo\\n(?=between)", engine: "pcre2", path: target, multiline: true });
    expect(multiline.matches.map((match) => match.lineNumber)).toEqual([3]);
    for (const [content, multilinePattern] of [
      ["foo\nfoo\nfoo\n", "foo"],
      ["foo\nfoo\nend\n", "foo\\nfoo"],
      ["foo\nfoobar\nbar\n", "foo\\nfoo|bar\\nbar"],
    ] as const) {
      fs.writeFileSync(target, content);
      for (const controls of [{ mode: "count" }, { maxCount: 1 }, { maxCount: 1, offset: 1 }, { maxCount: 1, tail: true }] as const) {
        const options = { pattern: multilinePattern, path: target, multiline: true, ...controls };
        expect(await grep({ ...options, engine: "pcre2" })).toEqual(await grep(options));
      }
    }
    await expect(grep({ pattern, engine: "pcre2", path: tmpDir, timeoutMs: 0 })).rejects.toBeInstanceOf(SearchStoppedError);
  });

  it("retains matches and reports files that exceed PCRE2's match limit", async () => {
    const failed = path.join(tmpDir, "bad.txt");
    fs.writeFileSync(failed, `${"a".repeat(28)}!\n`);
    fs.writeFileSync(path.join(tmpDir, "good.txt"), "aaaa\n");
    const result = await grep({ pattern: "(a+)+$", engine: "pcre2", path: tmpDir, mode: "count" });
    expect(result.totalMatches).toBe(1);
    expect(result.matches.map((match) => match.matchCount)).toEqual([1]);
    expect(result.searchFailures).toEqual([{ path: failed, reason: expect.stringContaining("match limit exceeded") }]);
    await expect(grep({ pattern: "(a+)+$", engine: "pcre2", path: failed })).rejects.toThrow("match limit exceeded");
    fs.writeFileSync(failed, `foo\n${"a".repeat(28)}!\n`);
    const pattern = "foo|(?=a)(a+)+$";
    for (const multiline of [false, true]) {
      for (const searchPath of [failed, tmpDir]) {
        for (const mode of ["filesWithMatches", "content"] as const) {
          const matched = await grep({ pattern, engine: "pcre2", path: searchPath, mode, multiline, maxCount: 1 });
          expect(matched.matches.map((match) => match.line)).toEqual(["foo"]);
          expect(matched.matches[0]?.path).toBe(failed);
          expect(matched.searchFailures).toBeUndefined();
        }
      }
      await expect(grep({ pattern, engine: "pcre2", path: failed, mode: "count", multiline, maxCount: 1 }))
        .rejects.toThrow("match limit exceeded");
    }
  });

  it("stops pathological PCRE2 searches at the processing-time limit and releases their workers", async () => {
    const target = path.join(tmpDir, "bad.txt");
    const literal = path.join(tmpDir, "good.txt");
    fs.writeFileSync(target, `${"a".repeat(150_000)}!\n`);
    fs.writeFileSync(literal, "needle\n");
    for (let index = 0; index < 4; index++) {
      await expect(grep({
        pattern: "(?=a)a+(?<!a)", engine: "pcre2", path: target, cpuLimitMs: 10, timeoutMs: 10_000, maxCount: 1,
      })).rejects.toEqual(new SearchStoppedError("cpu-limit"));
    }
    const controller = new AbortController();
    const aborted = grep({ pattern: "(?=a)a+(?<!a)", engine: "pcre2", path: target, maxCount: 1 }, controller.signal);
    const timer = setTimeout(() => controller.abort(), 2);
    try {
      await expect(aborted).rejects.toThrow("Aborted");
    } finally {
      clearTimeout(timer);
    }
    // A stopped search's worker frees when its thread next runs, after the
    // promise settled. Its wall limit is hard, so a result proves that the
    // call found a worker within 1 s, far below the 10 s and 30 s at which
    // the stopped searches' workers would free on their own.
    const result = await grep({ pattern: "needle", path: literal, timeoutMs: 1_000 });
    expect(result.totalMatches).toBe(1);

    // More long searches than the native search pool holds must not hold a
    // waiting call past its own wall limit, and that call reports busy
    // workers, not slow storage. A long search takes its worker only when its
    // supervisor thread runs, and on a loaded runner the waiting call's
    // supervisor can run first; a call that still finds a free worker shows
    // that the pool is not full yet, so it is sent again. The waiting call's
    // deadline leaves room for its supervisor thread to start: on a saturated
    // 4-core Windows Server runner a new thread can first run more than 20 ms
    // later, and a supervisor that starts past its deadline reports the wall
    // limit instead.
    const saturating = new AbortController();
    const long = Array.from({ length: os.availableParallelism() + 4 }, () =>
      grep({ pattern: "(?=a)a+(?<!a)", engine: "pcre2", path: target, timeoutMs: 10_000, maxCount: 1 }, saturating.signal).catch((error: unknown) => error));
    try {
      let waited: number;
      let stopped: unknown;
      do {
        waited = performance.now();
        stopped = await grep({ pattern: "needle", path: literal, timeoutMs: 200 }).then(() => undefined, (error: unknown) => error);
      } while (stopped === undefined);
      expect(stopped).toEqual(new SearchStoppedError("no-worker"));
      expect(performance.now() - waited).toBeLessThan(1_000);
    } finally {
      saturating.abort();
    }
    for (const error of await Promise.all(long)) expect(String(error)).toContain("Aborted");
  });

  it("reports file-absolute line numbers and context for matches past the 8MB segment boundary", async () => {
    // 150k 64-byte lines (~9.6MB) push the match into the second scan segment.
    const lines = 150_000;
    fs.writeFileSync(path.join(tmpDir, "big.txt"), `${"x".repeat(63)}\n`.repeat(lines) + "alpha needle\n");

    const result = await grep({
      pattern: "needle",
      path: path.join(tmpDir, "big.txt"),
      mode: "content",
      context: 1,
    });

    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.lineNumber).toBe(lines + 1);
    expect(result.matches[0]?.contextBefore?.[0]?.lineNumber).toBe(lines);
  });

  it("native grep rejects when the abort signal is already aborted", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "alpha needle\n");
    const controller = new AbortController();
    controller.abort();

    await expect(grep({ pattern: "needle", path: tmpDir }, controller.signal)).rejects.toThrow();
  });

  it("applies offset and limit across files in path order (parallel aggregation)", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "needle one\nneedle two\n");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "needle three\n");

    const result = await grep({
      pattern: "needle",
      path: tmpDir,
      mode: "content",
      maxCount: 2,
      offset: 1,
    });

    // grep resolves the native root-relative paths against the searched root.
    expect(result.matches.map((m) => `${m.path}:${m.lineNumber}`)).toEqual([`${path.join(tmpDir, "a.txt")}:2`, `${path.join(tmpDir, "b.txt")}:1`]);
    expect(result.totalMatches).toBe(3);
    expect(result.filesWithMatches).toBe(2);
  });
});
