import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GrepMatch, GrepResult } from "../../../../../src/orchestration/agent-runtime/tools/ripgrep.js";
import {
  formatContentOutput,
  formatMatchingFilesOutput,
  validateSearchInput,
} from "../../../../../src/orchestration/agent-runtime/tools/search.js";
import type { RankOptions } from "../../../../../src/orchestration/agent-runtime/tools/search-ranking.js";
import { makeContext } from "./_fixtures.js";

function asString(content: string | unknown): string {
  if (typeof content !== "string") throw new Error("expected string content");
  return content;
}

function grepResult(matches: GrepMatch[], over?: Partial<GrepResult>): GrepResult {
  const files = new Set(matches.map((m) => m.path)).size;
  return {
    matches,
    totalMatches: matches.length,
    filesWithMatches: files,
    filesSearched: files,
    filesSkipped: 0,
    traversalIssues: 0,
    ...over,
  };
}

const RANK_ON: RankOptions = { rankingEnabled: true, preferTests: false };
const RANK_OFF: RankOptions = { rankingEnabled: false, preferTests: false };

describe("search ranking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-search-ranking-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Ranking is ON by default (benchmark gate passed). These drive the observable
  // units the executor composes (formatContentOutput / formatMatchingFilesOutput)
  // with rankingEnabled: true.
  describe("ranking-on content output", () => {
    it("orders the definition before the usage in content mode", () => {
      const matches: GrepMatch[] = [
        { path: "src/b.ts", lineNumber: 4, line: "target()" },
        { path: "src/a.ts", lineNumber: 1, line: "export function target() {}" },
      ];
      const out = formatContentOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, 0, RANK_ON);
      const content = asString(out.content);
      const defIdx = content.indexOf("export function target");
      const useIdx = content.indexOf("target()");
      expect(defIdx).toBeGreaterThan(-1);
      expect(defIdx).toBeLessThan(useIdx);
      expect(content).toContain("*1|export function target");
    });

    it("keeps a demoted import line visible (not suppressed)", () => {
      const matches: GrepMatch[] = [
        { path: "src/a.ts", lineNumber: 2, line: "import { target } from \"./x\"" },
        { path: "src/a.ts", lineNumber: 5, line: "export function target() {}" },
      ];
      const out = formatContentOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, 0, RANK_ON);
      const content = asString(out.content);
      expect(content).toContain("import { target }");
      expect(content).toContain("export function target");
      // Same-file matches merge into one block in ascending line order, so the
      // import (line 2) renders before the definition (line 5); ranking still
      // decides which matches survive selection and which file leads.
      expect(content.indexOf("import { target")).toBeLessThan(content.indexOf("export function target"));
      expect(content.split("# src/a.ts").length - 1).toBe(1);
    });

    it("soft-weights source above test in content and matching_files modes", () => {
      const matches: GrepMatch[] = [
        { path: "tests/x.test.ts", lineNumber: 1, line: "target()" },
        { path: "src/x.ts", lineNumber: 1, line: "target()" },
      ];
      const content = asString(
        formatContentOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, 0, RANK_ON).content,
      );
      expect(content.indexOf("src/x.ts")).toBeLessThan(content.indexOf("tests/x.test.ts"));

      // matching_files comparator is keyed on the comparator, not the rank stage.
      const files = asString(
        formatMatchingFilesOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, RANK_ON).content,
      );
      const srcAt = files.indexOf("src/x.ts");
      const testAt = files.indexOf("tests/x.test.ts");
      expect(srcAt).toBeGreaterThan(-1);
      expect(testAt).toBeGreaterThan(-1);
      expect(srcAt).toBeLessThan(testAt);
    });

    it("carries a best-target [def] summary clause in matching_files mode", () => {
      const matches: GrepMatch[] = [
        { path: "src/y.ts", lineNumber: 1, line: "target()" },
        { path: "src/x.ts", lineNumber: 1, line: "export function target() {}" },
      ];
      const out = formatMatchingFilesOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, RANK_ON);
      const content = asString(out.content);
      const summaryLine = content.split("\n")[0] ?? "";
      expect(summaryLine).toContain("; best: src/x.ts [def]");
      // The [def] token never appears inside a content line.
      const bodyLines = content.split("\n").slice(2);
      for (const line of bodyLines) expect(line).not.toContain("[def]");
    });

    it("trims content to the char budget and keeps trimmed matches in fullContent", () => {
      const matches: GrepMatch[] = [];
      const big = "z".repeat(400);
      for (let i = 0; i < 30; i++) matches.push({ path: `src/f${i}.ts`, lineNumber: 1, line: `${big}-${i}` });
      const out = formatContentOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, 0, RANK_ON);
      const content = asString(out.content);
      // Visible content bounded near the smallest budget (2500) plus framing; not the full dump.
      expect(content.length).toBeLessThan(6000);
      expect(content).toContain("; showing");
      // A match trimmed from the visible window is still recoverable in fullContent.
      expect(typeof out.fullContent).toBe("string");
      const trimmedTail = `${big}-29`;
      expect(content).not.toContain(trimmedTail);
      expect(out.fullContent).toContain(trimmedTail);
    });

    it("renders the same numbered line before and after ranking", () => {
      const matches: GrepMatch[] = [{ path: "src/a.ts", lineNumber: 7, line: "export function target() {}" }];
      const ranked = asString(
        formatContentOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, 0, RANK_ON).content,
      );
      const unranked = asString(
        formatContentOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, 0, {
          rankingEnabled: false,
          preferTests: false,
        }).content,
      );
      const numberedLine = (output: string): string => output.split("\n").find((line) => line.startsWith("*7")) ?? "";
      expect(numberedLine(ranked)).toBe(numberedLine(unranked));
      expect(numberedLine(ranked)).toBe("*7|export function target() {}");
    });

    it("ranks files before windowing so late source definitions reach page one", () => {
      const matches: GrepMatch[] = [];
      for (let i = 0; i < 20; i++) {
        matches.push({ path: `tests/f${i}.test.ts`, lineNumber: 1, line: "target()" });
      }
      matches.push({ path: "src/target.ts", lineNumber: 1, line: "export function target() {}" });

      const ranked = asString(
        formatContentOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, 0, RANK_ON).content,
      );
      const unranked = asString(
        formatContentOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, 0, RANK_OFF).content,
      );

      expect(ranked).toContain("# src/target.ts");
      expect(ranked).toContain("export function target");
      expect(unranked).not.toContain("# src/target.ts");
    });

    it("parses the prefer_tests ranking toggle", async () => {
      const normal = await validateSearchInput({ pattern: "target" }, { executionCwd: tmpDir });
      const preferred = await validateSearchInput({ pattern: "target", prefer_tests: true }, { executionCwd: tmpDir });
      if (normal.kind !== "ok") throw new Error(normal.result.content.toString());
      if (preferred.kind !== "ok") throw new Error(preferred.result.content.toString());

      expect(normal.rank.preferTests).toBe(false);
      expect(preferred.rank.preferTests).toBe(true);
    });
  });

  // The rankingEnabled:false path (the benchmark-harness off-baseline and the
  // revert switch) must behave exactly as the old window/round-robin code did:
  // no char-budget trim, pure mtime-descending file order, and no [def]/best clause.
  describe("ranking-off (flag) output", () => {
    it("does not char-cap content (no budget trim when ranking is off)", () => {
      // One file so the whole set sits inside a single file-window group; with
      // ranking on this would trim near the 5000-char single-file budget, but
      // the default path must emit every selected match uncapped.
      const matches: GrepMatch[] = [];
      const big = "z".repeat(400);
      for (let i = 0; i < 30; i++) matches.push({ path: "src/f.ts", lineNumber: i + 1, line: `${big}-${i}` });

      const off = asString(
        formatContentOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, 0, RANK_OFF).content,
      );
      const on = asString(
        formatContentOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, 0, RANK_ON).content,
      );

      // The off path is bounded only by limit/round-robin (~30 * 400 chars),
      // far past any char budget; the on path is capped near the budget.
      expect(off.length).toBeGreaterThan(10000);
      expect(on.length).toBeLessThan(6000);
      // Every match survives the default path, including the tail the budget drops.
      expect(off).toContain(`${big}-0`);
      expect(off).toContain(`${big}-29`);
      expect(on).not.toContain(`${big}-29`);
      // No budget drop occurred, so no "; showing" truncation note.
      expect(off).toContain("30 match(es) in 1 file(s)");
      expect(off).not.toContain("; showing");
    });

    it("orders matching_files by mtime descending with no [def]/best clause", () => {
      // newer.ts written second so it is the more-recent file; older.ts first.
      const olderPath = path.join(tmpDir, "older.ts");
      const newerPath = path.join(tmpDir, "newer.ts");
      fs.writeFileSync(olderPath, "export function target() {}\n");
      fs.writeFileSync(newerPath, "target()\n");
      const now = Date.now();
      fs.utimesSync(olderPath, new Date(now - 60_000), new Date(now - 60_000));
      fs.utimesSync(newerPath, new Date(now), new Date(now));

      const matches: GrepMatch[] = [
        { path: "older.ts", lineNumber: 1, line: "export function target() {}" },
        { path: "newer.ts", lineNumber: 1, line: "target()" },
      ];
      const content = asString(
        formatMatchingFilesOutput(matches, grepResult(matches), makeContext({ executionCwd: tmpDir }), 200, RANK_OFF).content,
      );

      // mtime-descending: the newer (usage-only) file precedes the older
      // definition-holding file -- the opposite of the ranking-on promotion.
      expect(content.indexOf("newer.ts")).toBeLessThan(content.indexOf("older.ts"));
      // No definition promotion / [def] / best clause leaks into the default path.
      expect(content).not.toContain("[def]");
      expect(content).not.toContain("; best:");
      expect(content.split("\n")[0]).toContain("Found matches in 2 file(s)");
    });
  });
});
