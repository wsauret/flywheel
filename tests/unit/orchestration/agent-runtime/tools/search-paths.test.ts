import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { searchDefinition } from "../../../../../src/orchestration/agent-runtime/tools/search.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import type { RuntimeToolInput } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { makeContext } from "./_fixtures.js";
import * as ripgrep from "../../../../../src/orchestration/agent-runtime/tools/ripgrep.js";

// The search path forms a model sends that name no single existing path: a
// missing path, a path list, and a glob. search-paths.ts resolves each one.
describe("search path resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-search-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function dispatchSearch(input: RuntimeToolInput, context = makeContext({ executionCwd: tmpDir })) {
    const prepared = prepareToolCall({ id: "search-call", name: "search", input }, new Map([["search", searchDefinition]]));
    const result = await executePreparedTool(prepared, context);
    if (typeof result.content !== "string") throw new Error("search returned non-text content");
    return { outcome: result.outcome, content: result.content, input: prepared.input };
  }

  function seedRoots(): void {
    for (const [file, text] of [["src/a.ts", "needle"], ["src/lib/a.test.ts", "needle"], ["tests/b.ts", "needle"], ["tests/b.js", "needle"], ["other/c.ts", "needle"], ["node_modules/pkg/d.ts", "needle"]] as const) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, file)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, file), text);
    }
  }

  it("searches the nearest existing parent of a missing path and says so before the results", async () => {
    seedRoots();

    const widened = await dispatchSearch({ pattern: "needle", path: "src/missing/deeper" });
    expect(widened.outcome).toBe("ok");
    expect(widened.content.split("\n")[0]).toBe("[Path 'src/missing/deeper' does not exist; searched its nearest existing parent 'src' instead.]");
    expect(widened.content).toContain("\nsrc/a.ts");
    expect(widened.content).not.toContain("tests/b.ts");

    // Healing still wins over widening when exactly one path fits.
    const healed = await dispatchSearch({ pattern: "needle", path: "lib" });
    expect(healed.content.split("\n")[0]).toBe("[Path 'lib' does not exist; showing 'src/lib' instead.]");
  });

  it("never widens above the execution directory or into a protected directory", async () => {
    seedRoots();
    fs.mkdirSync(path.join(tmpDir, "secret"));

    const above = await dispatchSearch({ pattern: "needle", path: "../agent-tools-search-absent" });
    expect(above.outcome).toBe("error");
    expect(above.content).toContain("does not exist");

    const guarded = await dispatchSearch({ pattern: "needle", path: "secret/missing" }, makeContext({ executionCwd: tmpDir, protectedTraversalRoots: [fs.realpathSync.native(path.join(tmpDir, "secret"))] }));
    expect(guarded.outcome).toBe("error");
    expect(guarded.content).toContain("does not exist");
    fs.mkdirSync(path.join(tmpDir, "fixtures"));
    fs.writeFileSync(path.join(tmpDir, "fixtures", "flywheel.toml"), "needle");
    for (const prefix of ["~", "~somebody"]) {
      const home = await dispatchSearch({ pattern: "needle", path: `${prefix}/${path.basename(tmpDir)}/flywheel.toml` });
      expect(home.outcome).toBe("error");
      expect(home.input.path).not.toBe("fixtures/flywheel.toml");
      expect(home.content).not.toContain("nearest existing parent");
    }
  });

  it("never widens an incomplete uniqueness lookup even when it found no candidates", async () => {
    seedRoots();
    const lookup = spyOn(ripgrep, "listFiles").mockResolvedValue({
      entries: [], truncated: true, nextOffset: 1000, limit: 1000, traversalIssues: 0, entryLimitReached: false,
    });
    try {
      const result = await dispatchSearch({ path: "src/z-target.tsx", pattern: "needle" });
      expect(result.outcome).toBe("error");
      expect(result.input.path).toBe("src/z-target.tsx");
      expect(result.content).not.toContain("nearest existing parent");
    } finally {
      lookup.mockRestore();
    }
  });

  it("heals wrong extensions, project-relative paths, and unique basenames before searching", async () => {
    seedRoots();
    for (const [requested, expected] of [["src/a.tsx", "src/a.ts"], ["wrong/lib/a.test.ts", "src/lib/a.test.ts"]] as const) {
      const result = await dispatchSearch({ path: requested, pattern: "needle" });
      expect(result.outcome).toBe("ok");
      expect(result.content).toStartWith(`[Path '${requested}' does not exist; showing '${expected}' instead.]`);
      expect(result.content).toContain(expected);
    }
    fs.mkdirSync(path.join(tmpDir, "worktree"));
    const result = await dispatchSearch({ path: "src/a.ts", pattern: "needle" }, makeContext({ executionCwd: path.join(tmpDir, "worktree"), projectRoot: tmpDir }));
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("project root");
    const ambiguous = await dispatchSearch({ path: "missing/b.ts", pattern: "needle" });
    expect(ambiguous.outcome).toBe("ok");
    fs.writeFileSync(path.join(tmpDir, "other", "b.ts"), "needle");
    const refused = await dispatchSearch({ path: "missing/b.ts", pattern: "needle" });
    expect(refused.outcome).toBe("error");
    expect(refused.content).toContain("other/b.ts");
    expect(refused.content).toContain("tests/b.ts");
  });

  it("searches every path of a space- or comma-separated path list together", async () => {
    seedRoots();

    for (const listed of ["src tests", "src, tests", "src,tests/b.ts"]) {
      const result = await dispatchSearch({ pattern: "needle", path: listed });
      expect(result.outcome).toBe("ok");
      expect(result.content.split("\n")[0]).toStartWith(`[Path '${listed}' names several paths; searched 'src', 'tests`);
      expect(result.content).toContain("src/a.ts");
      expect(result.content).toContain("tests/b.ts");
      expect(result.content).not.toContain("other/c.ts");
    }

    const filtered = await dispatchSearch({ pattern: "needle", path: "src tests", glob: "*.ts" });
    expect(filtered.input).toMatchObject({ path: ".", glob: "{src/**/*.ts,tests/**/*.ts}" });
    expect(filtered.content).toContain("tests/b.ts");
    expect(filtered.content).not.toContain("tests/b.js");

    const invalidFilter = await dispatchSearch({ pattern: "needle", path: "src tests", glob: {} });
    expect(invalidFilter.outcome).toBe("error");
    expect(invalidFilter.content).toContain("The parameter `glob` type is expected as `string`");

    // The common root would prune node_modules, so an explicit path into it keeps the refusal.
    const pruned = await dispatchSearch({ pattern: "needle", path: "node_modules/pkg src" });
    expect(pruned.outcome).toBe("error");
    expect(pruned.content).toContain("looks like multiple paths");
    expect(pruned.content).toContain("independent search tool calls in the same response");
    // A directory that the repository's ignore rules exclude is pruned the same way.
    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored/\n");
    fs.mkdirSync(path.join(tmpDir, "ignored", "x"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "ignored", "x", "e.ts"), "needle");
    const ignored = await dispatchSearch({ pattern: "needle", path: "ignored/x src" });
    expect(ignored.outcome).toBe("error");
    expect(ignored.content).toContain("looks like multiple paths");
    // A file that only shares a pruned name is never pruned, so it merges.
    fs.writeFileSync(path.join(tmpDir, "other", "build"), "needle");
    const sharedName = await dispatchSearch({ pattern: "needle", path: "other/build src" });
    expect(sharedName.outcome).toBe("ok");
    expect(sharedName.content).toContain("other/build");
    fs.mkdirSync(path.join(tmpDir, "tests,"));
    fs.writeFileSync(path.join(tmpDir, "tests,", "a.ts"), "needle");
    const ambiguous = await dispatchSearch({ path: "tests, src", pattern: "needle" });
    expect(ambiguous.outcome).toBe("error");
    expect(ambiguous.content).toContain("can name different path lists");
    fs.mkdirSync(path.join(tmpDir, "src tests"));
    for (const listed of ["src tests,other", "src tests other"]) {
      const refused = await dispatchSearch({ path: listed, pattern: "needle" });
      expect(refused.outcome).toBe("error");
      expect(refused.content).toContain("can name different path lists");
    }
    fs.mkdirSync(path.join(tmpDir, "unique,"));
    fs.writeFileSync(path.join(tmpDir, "unique,", "a.ts"), "needle");
    const commaName = await dispatchSearch({ path: "unique, src", pattern: "needle" });
    expect(commaName.outcome).toBe("ok");
    expect(commaName.content).toContain("unique,/a.ts");
    expect(commaName.content).toContain("src/a.ts");
    fs.writeFileSync(path.join(tmpDir, "a.txt b.txt"), "needle");
    const cwd = path.join(tmpDir, "worktree");
    fs.mkdirSync(cwd);
    for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(cwd, name), "needle");
    const refused = await dispatchSearch({ path: "a.txt b.txt", pattern: "needle" }, makeContext({ executionCwd: cwd, projectRoot: tmpDir }));
    expect(refused.outcome).toBe("error");
    expect(refused.content).toContain(path.join(tmpDir, "a.txt b.txt"));
    expect(refused.content).toContain("'a.txt', 'b.txt'");
  });

  it("moves a glob in the path into the glob filter", async () => {
    seedRoots();

    const result = await dispatchSearch({ pattern: "needle", path: "src/**/*.test.ts" });
    expect(result.input).toMatchObject({ path: "src", glob: "**/*.test.ts" });
    expect(result.content.split("\n")[0]).toBe("[Path 'src/**/*.test.ts' contains a glob; searched 'src' with glob '**/*.test.ts' instead.]");
    expect(result.content).toEndWith("\n\nsrc/lib/a.test.ts");

    const missingBase = await dispatchSearch({ pattern: "needle", path: "src/gone/*.ts" });
    expect(missingBase.input).toMatchObject({ path: "src", glob: "gone/*.ts" });
    expect(missingBase.content).toContain("No matches found");
    fs.writeFileSync(path.join(tmpDir, "src", "models-dev.ts"), "needle");
    fs.writeFileSync(path.join(tmpDir, "src", "models-dev.js"), "needle");
    const intersection = await dispatchSearch({ pattern: "needle", path: "src/models-dev*", glob: "*.ts" });
    expect(intersection.outcome).toBe("ok");
    expect(intersection.input).toMatchObject({ path: "src", glob: "models-dev*.ts" });
    expect(intersection.content).toContain("\nsrc/models-dev.ts");
    expect(intersection.content).not.toContain("\nsrc/a.ts");
    const directoryPrefix = await dispatchSearch({ pattern: "needle", path: "src/lib/**", glob: "*.ts" });
    expect(directoryPrefix.outcome).toBe("ok");
    expect(directoryPrefix.input).toMatchObject({ path: "src/lib", glob: "**/*.ts" });
    const conflict = await dispatchSearch({ pattern: "needle", path: "src/*.test.ts", glob: "a*" });
    expect(conflict.outcome).toBe("error");
    expect(conflict.content).toContain("cannot combine");
    expect(conflict.content).toContain("*.test.ts");
    expect(conflict.content).toContain("a*");
    const homePath = `~/${path.relative(os.homedir(), path.join(tmpDir, "src")).split(path.sep).join("/")}/**/*.ts`;
    const home = await dispatchSearch({ pattern: "needle", path: homePath });
    expect(home.outcome).toBe("ok");
    expect(home.content).toStartWith(`[Path '${homePath}' was expanded to '`);
    expect(home.content).toContain("src/models-dev.ts");
    expect(home.content).not.toContain("src/models-dev.js");
  });
});
