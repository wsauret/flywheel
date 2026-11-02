import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as ripgrep from "../../../../../src/orchestration/agent-runtime/tools/ripgrep.js";
import { handleSearchError, searchDefinition } from "../../../../../src/orchestration/agent-runtime/tools/search.js";
import { FileReadLedger } from "../../../../../src/orchestration/agent-runtime/tools/file-read-ledger.js";
import { canonicalMutationPath } from "../../../../../src/infra/file-mutation-queue.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { makeContext } from "./_fixtures.js";

type GrepInput = Omit<Parameters<typeof ripgrep.grep>[0], "cpuLimitMs" | "timeoutMs">;
const grep = (options: GrepInput) => ripgrep.grep({ cpuLimitMs: 30_000, timeoutMs: 30_000, ...options });

describe("search tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-search-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("contract inputSchema exposes content-search controls", () => {
    const properties = searchDefinition.inputSchema.properties;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) throw new Error("search schema properties are missing");
    expect(Object.keys(properties)).toEqual(expect.arrayContaining([
      "pattern",
      "path",
      "glob",
      "type",
      "case_insensitive",
      "multiline",
      "context",
      "output_mode",
      "limit",
      "tail",
    ]));
    if (!("output_mode" in properties) || !("path" in properties)) throw new Error("search schema properties are missing");
    expect(properties.output_mode).toMatchObject({ enum: ["matching_files", "content", "count"] });
    const outputMode = properties.output_mode;
    if (typeof outputMode !== "object" || outputMode === null || !("description" in outputMode) || typeof outputMode.description !== "string") throw new Error("output_mode description is missing");
    expect(outputMode.description).toContain("matching_files");
    expect(outputMode.description).not.toContain("file_paths");
    const pathProperty = properties.path;
    if (typeof pathProperty !== "object" || pathProperty === null || !("description" in pathProperty) || typeof pathProperty.description !== "string") throw new Error("path description is missing");
    expect(pathProperty.description).toContain("Single file or directory");
    expect(pathProperty.description).toContain("independent search tool calls in the same response");
    expect(searchDefinition.promptGuidelines).toBeUndefined();
    expect(searchDefinition.promptExamples).toContain('"path":"src tests"');
    expect(searchDefinition.promptExamples).toContain('"path":"src"');
    expect(searchDefinition.promptExamples).toContain('"path":"tests"');
    expect(searchDefinition.description).toContain("Use multiple independent search tool calls");
  });

  it("records matched lines as seen in the read ledger without a content hash", async () => {
    const target = path.join(tmpDir, "one.txt");
    fs.writeFileSync(target, "alpha needle\nbeta\ngamma\n");
    const readLedger = new FileReadLedger();
    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "content" },
      makeContext({ executionCwd: tmpDir, readLedger }),
    );
    expect(result.outcome).toBe("ok");
    const canonical = canonicalMutationPath(target);
    expect(readLedger.staleness(canonical, fs.readFileSync(target), { start: 1, end: 1 })).toBeUndefined();
    expect(readLedger.staleness(canonical, fs.readFileSync(target), { start: 3, end: 3 })).toEqual({ kind: "uncovered", lines: { start: 3, end: 3 } });
  });

  it("shows and records matches below a subdirectory root by their execution-directory paths", async () => {
    const older = path.join(tmpDir, "src", "sub", "a-old.ts");
    const newer = path.join(tmpDir, "src", "sub", "b-new.ts");
    fs.mkdirSync(path.dirname(older), { recursive: true });
    fs.writeFileSync(older, "needle\nbeta\n");
    fs.writeFileSync(newer, "needle\n");
    fs.utimesSync(older, new Date("2026-01-01"), new Date("2026-01-01"));
    fs.utimesSync(newer, new Date("2026-06-01"), new Date("2026-06-01"));
    const readLedger = new FileReadLedger();
    const context = makeContext({ executionCwd: tmpDir, readLedger });

    // The newer file ranks first only when its date is read from the right file.
    const files = await searchDefinition.execute({ pattern: "needle", path: "src" }, context);
    expect(files.content).toEndWith("\n\nsrc/sub/b-new.ts\nsrc/sub/a-old.ts");

    const content = await searchDefinition.execute({ pattern: "needle", path: "src", output_mode: "content" }, context);
    expect(content.content).toContain("# src/sub/a-old.ts");
    expect(readLedger.staleness(canonicalMutationPath(older), fs.readFileSync(older), { start: 1, end: 1 })).toBeUndefined();

    const counts = await searchDefinition.execute({ pattern: "needle", path: "src/sub", output_mode: "count" }, context);
    expect(counts.content).toContain("src/sub/a-old.ts: 1");
  });

  it("returns content matches with file headings and line numbers", async () => {
    fs.writeFileSync(path.join(tmpDir, "one.txt"), "alpha needle\nbeta\n");
    fs.writeFileSync(path.join(tmpDir, "two.txt"), "gamma\n");

    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "content" },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("1 match(es) in 1 file(s)");
    expect(result.content).toContain("# one.txt");
    expect(result.content).toContain("*1|alpha needle");
  });

  it("merges overlapping context windows so each line renders once", async () => {
    fs.writeFileSync(path.join(tmpDir, "clustered.txt"), "needle one\nfiller a\nneedle two\nfiller b\nneedle three\n");

    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "content", context: 2 },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("ok");
    // Five lines total; the three overlapping windows must not repeat any of them.
    if (typeof result.content !== "string") throw new Error("expected text search output");
    expect(result.content.split("filler a").length - 1).toBe(1);
    expect(result.content.split("needle two").length - 1).toBe(1);
    expect(result.content.split("# clustered.txt").length - 1).toBe(1);
    // Match lines keep the * marker even where windows overlap; context keeps the space.
    expect(result.content).toContain("*3|needle two");
    expect(result.content).toContain(" 2|filler a");
  });

  it("rejects context values outside the bounded whole-line contract", async () => {
    for (const context of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101]) {
      const result = await searchDefinition.execute(
        { pattern: "needle", path: ".", output_mode: "content", context },
        makeContext({ executionCwd: tmpDir }),
      );
      expect(result.outcome).toBe("error");
      expect(result.content).toContain("context must be a whole number from 0 through 100");
    }
  });

  it("prunes artifact and ignored directories by default, keeps ignored files, and searches a pruned directory when targeted", async () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules", "dep"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".flywheel", "agent-outputs"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.mkdirSync(path.join(tmpDir, "results"));
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "results/\n*.log\n");
    fs.writeFileSync(path.join(tmpDir, ".git", "config"), "needle in git\n");
    fs.writeFileSync(path.join(tmpDir, "results", "run.txt"), "needle in ignored directory\n");
    fs.writeFileSync(path.join(tmpDir, "debug.log"), "needle in ignored file\n");
    fs.writeFileSync(path.join(tmpDir, "src.txt"), "needle in source\n");
    fs.writeFileSync(path.join(tmpDir, "build"), "needle in build file\n");
    fs.writeFileSync(path.join(tmpDir, "node_modules", "dep", "index.js"), "needle in dep\n");
    fs.writeFileSync(path.join(tmpDir, ".flywheel", "agent-outputs", "old-search.txt"), "needle in breadcrumb\n");

    const swept = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "content" },
      makeContext({ executionCwd: tmpDir }),
    );
    expect(swept.content).toContain("src.txt");
    // A FILE named like an excluded directory is not pruned.
    expect(swept.content).toContain("needle in build file");
    expect(swept.content).toContain("needle in ignored file");
    expect(swept.content).not.toContain("needle in dep");
    expect(swept.content).not.toContain("agent-outputs");
    expect(swept.content).not.toContain("needle in git");
    expect(swept.content).not.toContain("needle in ignored directory");
    expect(swept.content).toEndWith("[Did not enter 4 artifact or ignored directories: .flywheel/, .git/, node_modules/, results/; name one in 'path' to look inside it.]");

    const targetedIgnored = await searchDefinition.execute(
      { pattern: "needle", path: "results", output_mode: "content" },
      makeContext({ executionCwd: tmpDir }),
    );
    expect(targetedIgnored.content).toContain("needle in ignored directory");

    // Explicit targeting bypasses the exclusion: a root inside the tree...
    const targetedDir = await searchDefinition.execute(
      { pattern: "needle", path: "node_modules", output_mode: "content" },
      makeContext({ executionCwd: tmpDir }),
    );
    expect(targetedDir.content).toContain("needle in dep");

    // ...and a single file is never excluded.
    const targetedFile = await searchDefinition.execute(
      { pattern: "needle", path: ".flywheel/agent-outputs/old-search.txt", output_mode: "content" },
      makeContext({ executionCwd: tmpDir }),
    );
    expect(targetedFile.content).toContain("needle in breadcrumb");
  });

  it("searches linked directories under their logical paths", async () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-search-outside-"));
    try {
      fs.writeFileSync(path.join(externalDir, "outside.txt"), "external needle\n");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(externalDir, path.join(tmpDir, "external-link"), linkType);
      fs.symlinkSync(externalDir, path.join(tmpDir, "alias-link"), linkType);

      const result = await searchDefinition.execute(
        { pattern: "needle", path: ".", output_mode: "content" },
        makeContext({ executionCwd: tmpDir }),
      );

      expect(result.outcome).toBe("ok");
      expect(result.content).toContain("# external-link/outside.txt");
      expect(result.content).toContain("# alias-link/outside.txt");
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });
  it("does not search linked regular files during directory discovery", async () => {
    if (process.platform === "win32") return;
    const target = path.join(tmpDir, "target.txt");
    fs.writeFileSync(target, "linked-file needle\n");
    fs.symlinkSync(target, path.join(tmpDir, "file-link"), "file");
    const result = await searchDefinition.execute(
      { pattern: "linked-file", path: ".", output_mode: "content" },
      makeContext({ executionCwd: tmpDir }),
    );
    expect(result.content).not.toContain("file-link");
  });

  it("rejects credential roots below a linked ancestor and keeps explicit roots searchable", async () => {
    const linkedParent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-search-protected-"));
    const protectedRoot = path.join(linkedParent, "auth");
    try {
      fs.mkdirSync(protectedRoot);
      fs.writeFileSync(path.join(linkedParent, "public.txt"), "public needle\n");
      fs.writeFileSync(path.join(protectedRoot, "secret.txt"), "protected needle\n");
      const nestedProtectedRoot = path.join(protectedRoot, "nested");
      fs.mkdirSync(nestedProtectedRoot);
      fs.writeFileSync(path.join(nestedProtectedRoot, "nested-secret.txt"), "nested protected needle\n");
      fs.writeFileSync(path.join(tmpDir, "sibling.txt"), "sibling needle\n");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(linkedParent, path.join(tmpDir, "home-link"), linkType);
      const context = makeContext({ executionCwd: tmpDir, protectedTraversalRoots: [fs.realpathSync.native(protectedRoot)] });
      const discovered = await searchDefinition.execute(
        { pattern: "needle", path: ".", output_mode: "count" },
        context,
      );
      expect(discovered.content).toContain("sibling.txt: 1");
      expect(discovered.content).toContain("home-link/public.txt: 1");
      expect(discovered.content).not.toContain("home-link/auth/secret.txt");
      expect(discovered.content).not.toContain("home-link/auth/nested/nested-secret.txt");
      expect(discovered.content).toContain("protected credential root");
      const explicit = await searchDefinition.execute(
        { pattern: "protected", path: "home-link/auth", output_mode: "content" },
        context,
      );
      expect(explicit.content).toContain("secret.txt");
      expect(explicit.content).toContain("nested/nested-secret.txt");
    } finally {
      fs.rmSync(linkedParent, { recursive: true, force: true });
    }
  });

  it("names the files holding matches the visible window dropped", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "needle 1\nneedle 2\nneedle 3\n");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "needle 4\nneedle 5\n");

    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "content", limit: 2 },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.content).toContain("showing 2");
    expect(result.content).toContain("Matches not shown:");
    expect(result.content).toMatch(/[ab]\.txt \(\d+\)/);
  });

  it("count mode returns exact per-file match counts (grep -c analogue)", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "needle\nfiller\nneedle\nneedle\n");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "needle\nfiller\n");

    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "count" },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("4 match(es) in 2 file(s)");
    // Per-file counts, highest first.
    if (typeof result.content !== "string") throw new Error("expected text search output");
    expect(result.content.indexOf("a.txt: 3")).toBeGreaterThan(-1);
    expect(result.content.indexOf("b.txt: 1")).toBeGreaterThan(result.content.indexOf("a.txt: 3"));
  });

  it("tail returns the last N matches with an exact total (grep | tail analogue)", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => {
      const id = String(i + 1).padStart(2, "0");
      return `event match-${id}\nnoise ${id}`;
    });
    fs.writeFileSync(path.join(tmpDir, "app.log"), `${lines.join("\n")}\n`);

    const tail = await searchDefinition.execute(
      { pattern: "match-", path: "app.log", tail: true, limit: 3 },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(tail.outcome).toBe("ok");
    expect(tail.content).toContain("10 match(es) in 1 file(s); showing last 3.");
    expect(tail.content).toContain("match-08");
    expect(tail.content).toContain("match-09");
    expect(tail.content).toContain("match-10");
    expect(tail.content).not.toContain("match-07");

    // When everything fits, the summary carries no "showing last" suffix.
    const all = await searchDefinition.execute(
      { pattern: "match-", path: "app.log", tail: true },
      makeContext({ executionCwd: tmpDir }),
    );
    expect(all.content).toContain("10 match(es) in 1 file(s)");
    expect(all.content).not.toContain("showing last");
    expect(all.content).toContain("match-01");
  });

  it("reads numeric tail as the last N lines before validation and refuses conflicting limits", async () => {
    fs.writeFileSync(path.join(tmpDir, "app.log"), "needle one\nneedle two\nneedle three\n");
    const tools = new Map([["search", searchDefinition]]);
    const context = makeContext({ executionCwd: tmpDir });
    for (const limit of [undefined, 2]) {
      const prepared = prepareToolCall({ id: "tail", name: "search", input: { pattern: "needle", path: "app.log", tail: 2, ...(limit === undefined ? {} : { limit }) } }, tools, { ok: true });
      const result = await executePreparedTool(prepared, context);
      expect(result.outcome).toBe("ok");
      expect(result.content).toStartWith("Note:");
      expect(result.content).toContain("tail");
      expect(result.content).toContain("showing last 2");
      expect(result.content).not.toContain("needle one");
      expect(result.content).toContain("needle three");
    }
    const conflict = prepareToolCall({ id: "tail-conflict", name: "search", input: { pattern: "needle", tail: 2, limit: 3 } }, tools, { ok: true });
    expect((await executePreparedTool(conflict, context)).outcome).toBe("error");
  });

  it("reads the literal option as fixed strings and composes it with path repairs", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "one.txt"), "a.b [x] (y) {z} ^$ *+? | \\\naxb x y z\n");
    const tools = new Map([["search", searchDefinition]]);
    const context = makeContext({ executionCwd: tmpDir });
    const pattern = "a.b [x] (y) {z} ^$ *+? | \\";
    const prepared = prepareToolCall({ id: "literal", name: "search", input: { pattern, literal: true, path: "src/*.txt", output_mode: "content" } }, tools, { ok: true });
    const result = await executePreparedTool(prepared, context);
    expect(result.outcome).toBe("ok");
    expect(result.content).toStartWith("Note:");
    expect(result.content).toContain("literal");
    expect(result.content).toContain("glob");
    expect(result.content).toContain(`*1|${pattern}`);
    expect(result.content).not.toContain("axb");
    const regex = prepareToolCall({ id: "regex", name: "search", input: { pattern: "a.b", literal: false, path: "src/one.txt", output_mode: "count" } }, tools, { ok: true });
    const regexResult = await executePreparedTool(regex, context);
    expect(regexResult.outcome).toBe("ok");
    expect(regexResult.content).toStartWith("Note:");
    expect(regexResult.content).toContain("2 match(es)");
    expect(regex.input.pattern).toBe("a.b");
  });

  it("rejects tail combined with non-content output modes", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "needle\n");
    const ctx = makeContext({ executionCwd: tmpDir });

    for (const mode of ["matching_files", "count"]) {
      const result = await searchDefinition.execute(
        { pattern: "needle", path: ".", tail: true, output_mode: mode },
        ctx,
      );
      expect(result.outcome).toBe("error");
      expect(result.content).toContain("tail implies content");
    }
  });

  it("reports search-specific errors for missing and empty patterns", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const missing = await searchDefinition.execute({}, ctx);
    expect(missing.outcome).toBe("error");
    expect(missing.content).toContain("search was called without a 'pattern' string");

    const empty = await searchDefinition.execute({ pattern: " " }, ctx);
    expect(empty.outcome).toBe("error");
    expect(empty.content).toContain("search was called with an empty 'pattern'");
  });

  it("reports invalid output_mode", async () => {
    fs.writeFileSync(path.join(tmpDir, "one.txt"), "alpha needle\n");

    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "file_paths" },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("matching_files");
  });

  it("reports invalid regex errors under the search tool name", async () => {
    fs.writeFileSync(path.join(tmpDir, "one.txt"), "alpha\n");

    const result = await searchDefinition.execute(
      { pattern: "[", path: "." },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Invalid regex in 'pattern'");
    expect(result.content).toContain("regex parse error");
    expect(result.content).toContain("neither the Rust regex engine nor PCRE2");
  });

  it("reruns look-around and backreference patterns with PCRE2 and names files it could not search", async () => {
    fs.writeFileSync(path.join(tmpDir, "one.txt"), "foo foo\nxfoo bar\n");
    fs.writeFileSync(path.join(tmpDir, "bad.txt"), `${"a".repeat(28)}!\n`);
    const context = makeContext({ executionCwd: tmpDir });

    const repeated = await searchDefinition.execute({ pattern: String.raw`(?<!x)(foo)\s+\1`, path: ".", output_mode: "content" }, context);
    expect(repeated.outcome).toBe("ok");
    expect(repeated.content).toStartWith("Note: the pattern uses features that the default regex engine does not support");
    expect(repeated.content).toContain("one.txt");
    expect(repeated.content).toContain("foo foo");
    expect(repeated.content).not.toContain("xfoo bar");

    const pathological = await searchDefinition.execute({ pattern: "(?=a)(a+)+$|foo", path: ".", output_mode: "count" }, context);
    expect(pathological.content).toContain("PCRE2");
    expect(pathological.content).toContain("1 file(s) could not be searched with this pattern, so counts exclude them");
    expect(pathological.content).toContain("match limit exceeded");
  });

  it("sets fullContent on the result when match limit is hit", async () => {
    fs.writeFileSync(path.join(tmpDir, "one.txt"), "needle one\n");
    fs.writeFileSync(path.join(tmpDir, "two.txt"), "needle two\n");

    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "content", limit: 1 },
      makeContext({ executionCwd: tmpDir, sessionId: "search-session" }),
    );

    expect(result.outcome).toBe("ok");
    expect(typeof result.fullContent).toBe("string");
    // Visible content is truncated to limit=1; fullContent has both matches.
    expect(result.fullContent).toContain("needle one");
    expect(result.fullContent).toContain("needle two");
  });

  it("returns an error when the only file searched is binary", async () => {
    fs.writeFileSync(path.join(tmpDir, "blob.bin"), Buffer.from([0x00, 0x4e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));

    const result = await searchDefinition.execute(
      { pattern: "Needle", path: "blob.bin", output_mode: "content" },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("binary content detected");
    expect(result.content).toContain("blob.bin");
  });

  it("composes skipped-file and traversal diagnostics once when no file matches", async () => {
    const protectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-search-combined-"));
    try {
      fs.writeFileSync(path.join(protectedRoot, "secret.txt"), "absent");
      fs.writeFileSync(path.join(tmpDir, "blob.bin"), Buffer.from([0x00, 0x01, 0x00]));
      const linkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(protectedRoot, path.join(tmpDir, "protected-link"), linkType);
      const result = await searchDefinition.execute(
        { pattern: "never-present", path: ".", output_mode: "content" },
        makeContext({ executionCwd: tmpDir, protectedTraversalRoots: [fs.realpathSync.native(protectedRoot)] }),
      );
      expect(result.content).toContain("No matches found");
      if (typeof result.content !== "string") throw new Error("expected string content");
      expect(result.content.match(/file\(s\) were skipped/g)).toHaveLength(1);
      expect(result.content.match(/linked directory branch\(es\)/g)).toHaveLength(1);
    } finally {
      fs.rmSync(protectedRoot, { recursive: true, force: true });
    }
  });

  it("isolates cyclic and broken linked branches and preserves searchable siblings", async () => {
    if (process.platform === "win32") return;
    fs.writeFileSync(path.join(tmpDir, "sibling.txt"), "sibling needle\n");
    fs.symlinkSync(path.join(tmpDir, "missing"), path.join(tmpDir, "broken"), "dir");
    fs.symlinkSync(tmpDir, path.join(tmpDir, "cycle"), "dir");
    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "content" },
      makeContext({ executionCwd: tmpDir }),
    );
    expect(result.content).toContain("sibling.txt");
    expect(result.content).toContain("linked directory branch");
  });

  it("appends skip count to the summary when matches are found alongside skipped files", async () => {
    fs.writeFileSync(path.join(tmpDir, "text.txt"), "alpha needle\n");
    fs.writeFileSync(path.join(tmpDir, "blob.bin"), Buffer.from([0x00, 0x4e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));

    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "content" },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("1 match(es) in 1 file(s)");
    expect(result.content).toContain("1 file(s) were skipped");
  });

  it("rejects a zero limit instead of silently returning no matches", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "alpha needle\n");

    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", output_mode: "content", limit: 0 },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("limit must be at least 1");
  });

  it("rejects a negative skip", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "alpha needle\n");

    const result = await searchDefinition.execute(
      { pattern: "needle", path: ".", skip: -2 },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("skip must be at least 0");
  });

  it("propagates an abort instead of swallowing it into a generic error result", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "alpha needle\n");
    const controller = new AbortController();
    controller.abort();

    await expect(
      searchDefinition.execute(
        { pattern: "needle", path: "." },
        makeContext({ executionCwd: tmpDir, signal: controller.signal }),
      ),
    ).rejects.toThrow("Aborted");
  });

  it("shares the wall-clock backstop with PCRE2 after the Rust attempt waits for admission", async () => {
    let now = 100;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const search = spyOn(ripgrep, "grep").mockImplementation(async (options) => {
      if (options.engine !== "pcre2") {
        now += 119_999;
        throw new Error("regex parse error: look-around is not supported");
      }
      return { matches: [], totalMatches: 0, filesWithMatches: 0, filesSearched: 1, filesSkipped: 0, traversalIssues: 0 };
    });
    try {
      const signal = new AbortController().signal;
      const result = await searchDefinition.execute(
        { pattern: "(?=a)a", path: "." }, makeContext({ executionCwd: tmpDir, signal }),
      );
      expect(result.outcome).toBe("ok");
      expect(search).toHaveBeenCalledTimes(2);
      expect(search.mock.calls[1]?.[0].timeoutMs).toBe(1);
      expect(search.mock.calls[1]?.[1]).toBe(signal);
    } finally {
      search.mockRestore();
      clock.mockRestore();
    }
  });

  it("ranks concurrent searches over bundled sources without whole-file AST parsing", async () => {
    fs.writeFileSync(path.join(tmpDir, "a-usage.js"), "needle()\n");
    // Distinct filler lines, not one line repeated. The bundle only has to be
    // large enough that parsing it whole would show up, and either shape gives
    // that. But a large run of identical script-like lines is a pathological
    // case for on-access malware scanning: the scan is charged at open(), so
    // every reader pays it and no read strategy avoids it, and it grows
    // quadratically. 50k identical `const filler = 0;` lines cost 8.6s to open
    // on Windows, which is most of this test's budget and none of it ripgrep.
    // The same 50k lines made distinct open in 12ms and model a real bundle
    // more closely.
    fs.writeFileSync(
      path.join(tmpDir, "z-bundle.js"),
      `${Array.from({ length: 50_000 }, (_, i) => `const filler${i} = ${i};`).join("\n")}\nexport function needle() {}\n`,
    );

    const results = await Promise.all(
      Array.from({ length: 6 }, () => searchDefinition.execute(
        { pattern: "needle", path: ".", output_mode: "content", limit: 30 },
        makeContext({ executionCwd: tmpDir }),
      )),
    );

    for (const result of results) {
      expect(result.outcome).toBe("ok");
      if (typeof result.content !== "string") throw new Error("expected text search output");
      expect(result.content.indexOf("z-bundle.js")).toBeLessThan(result.content.indexOf("a-usage.js"));
    }
  });

  it("maps each native stop to its own narrow-your-search guidance", () => {
    const cpu = handleSearchError(new ripgrep.SearchStoppedError("cpu-limit"), "needle", tmpDir, tmpDir);
    const wall = handleSearchError(new ripgrep.SearchStoppedError("wall-backstop"), "needle", tmpDir, tmpDir);

    expect(cpu).toEqual({ outcome: "error", content: expect.stringContaining("stopped after 30s of processing time") });
    expect(wall).toEqual({ outcome: "error", content: expect.stringContaining("stopped after 120s of waiting on file reads") });
    const busy = handleSearchError(new ripgrep.SearchStoppedError("no-worker"), "needle", tmpDir, tmpDir);
    expect(busy).toEqual({ outcome: "error", content: expect.stringContaining("did not start: other searches kept the search capacity busy") });
  });

  describe("matching-file pagination", () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(tmpDir, "a-dense.ts"), "needle();\n".repeat(20));
      fs.writeFileSync(path.join(tmpDir, "b-sparse.ts"), "// heading\nneedle();\n");
      fs.writeFileSync(path.join(tmpDir, "c-definition.ts"), "// heading\nexport function needle() {}\n");
      fs.utimesSync(path.join(tmpDir, "a-dense.ts"), 1, 1);
      fs.utimesSync(path.join(tmpDir, "b-sparse.ts"), 2, 2);
    });

    it("returns one representative line per file without treating density as a file limit", async () => {
      const result = await grep({ pattern: "needle", path: tmpDir, mode: "filesWithMatches", maxCount: 5 });
      expect(result.matches).toEqual([
        { path: path.join(tmpDir, "a-dense.ts"), lineNumber: 1, line: "needle();" },
        { path: path.join(tmpDir, "b-sparse.ts"), lineNumber: 2, line: "needle();" },
        { path: path.join(tmpDir, "c-definition.ts"), lineNumber: 2, line: "export function needle() {}" },
      ]);
      expect(result.totalMatches).toBe(3);
      expect(result.filesWithMatches).toBe(3);
      expect(result.limitReached).toBeUndefined();
    });

    it("counts offset and maxCount in files and never repeats a path between pages", async () => {
      const pages: string[] = [];
      const relativeToRoot = (absolute: string) => path.relative(tmpDir, absolute);
      for (const offset of [0, 1, 2, 3]) {
        const page = await grep({ pattern: "needle", path: tmpDir, mode: "filesWithMatches", maxCount: 1, offset });
        expect(page.totalMatches).toBe(3);
        expect(page.filesWithMatches).toBe(3);
        expect(page.matches).toHaveLength(offset < 3 ? 1 : 0);
        expect(page.limitReached).toBe(offset < 2 ? true : undefined);
        pages.push(...page.matches.map((match) => relativeToRoot(match.path)));
      }
      expect(pages).toEqual(["a-dense.ts", "b-sparse.ts", "c-definition.ts"]);
    });

    it("applies file pagination to an explicitly targeted dense file", async () => {
      const target = path.join(tmpDir, "a-dense.ts");
      for (const [offset, maxCount, expected] of [[0, 5, 1], [1, 5, 0], [0, 0, 0]] as const) {
        const result = await grep({ pattern: "needle", path: target, mode: "filesWithMatches", offset, maxCount });
        expect(result.matches).toHaveLength(expected);
        expect(result.totalMatches).toBe(1);
        expect(result.filesWithMatches).toBe(1);
        expect(result.limitReached).toBe(maxCount === 0 ? true : undefined);
      }
    });

    it("ranks native representative definition evidence and wires matching_files skip", async () => {
      const result = await searchDefinition.execute(
        { pattern: "needle", path: ".", output_mode: "matching_files", limit: 5 },
        makeContext({ executionCwd: tmpDir }),
      );
      expect(result.outcome).toBe("ok");
      expect(result.content).toContain("best: c-definition.ts [def]");
      if (typeof result.content !== "string") throw new Error("expected text search output");
      expect(result.content.split("\n\n")[1]?.split("\n")).toEqual([
        "c-definition.ts", "b-sparse.ts", "a-dense.ts",
      ]);
      const page = await searchDefinition.execute(
        { pattern: "needle", path: ".", output_mode: "matching_files", limit: 5, skip: 1 },
        makeContext({ executionCwd: tmpDir }),
      );
      expect(page.outcome).toBe("ok");
      expect(page.content).toContain("c-definition.ts [def]");
      expect(page.content).toContain("b-sparse.ts");
      expect(page.content).not.toContain("a-dense.ts");
    });

    it("keeps exact count scans uncapped and content and tail in line units", async () => {
      const counted = await grep({ pattern: "needle", path: tmpDir, mode: "count", maxCount: 1, offset: 1 });
      expect(counted.totalMatches).toBe(22);
      expect(counted.matches.map((match) => match.matchCount)).toEqual([20, 1, 1]);
      expect(counted.matches.every((match) => match.line === "" && match.lineNumber === 0)).toBe(true);
      expect(counted.limitReached).toBeUndefined();
      const content = await grep({ pattern: "needle", path: tmpDir, mode: "content", maxCount: 2, offset: 19 });
      expect(content.matches.map((match) => `${path.relative(tmpDir, match.path)}:${match.lineNumber}`)).toEqual(["a-dense.ts:20", "b-sparse.ts:2"]);
      const tail = await grep({ pattern: "needle", path: tmpDir, mode: "content", maxCount: 2, tail: true });
      expect(tail.totalMatches).toBe(22);
      expect(tail.matches.map((match) => `${path.relative(tmpDir, match.path)}:${match.lineNumber}`)).toEqual(["b-sparse.ts:2", "c-definition.ts:2"]);
    });
  });
});
