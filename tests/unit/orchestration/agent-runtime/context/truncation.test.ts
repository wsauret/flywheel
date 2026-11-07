import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limitOutput } from "../../../../../src/orchestration/agent-runtime/compaction/truncation.js";
import { Effect } from "effect";
import { codeModeServices, codeToolOver } from "../../../../helpers/code-mode-worker.js";

const codeModeService = codeModeServices();

describe("limitOutput", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "flywheel-truncation-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns original output when under 30KB", async () => {
    const output = "short output";
    const result = await limitOutput({ content: output, executionCwd: testDir, projectRoot: testDir, artifactScopeId: "sess-short" });
    expect(result.text).toBe(output);
    expect(result.truncated).toBe(false);
    expect(result.semanticTruncated).toBe(false);
    expect(result.byteTruncated).toBe(false);
  });

  test("the universal Code breadcrumb contains the full return with only bounded console Logs", async () => {
    const returned = "full-return-".repeat(6_000);
    const tool = codeToolOver(new Map(), codeModeService());
    const result = await tool.execute({
      source: `console.log("retained"); console.log("x".repeat(60_000)); console.log("not-retained"); return ${JSON.stringify(returned)}`,
    }, {
      executionCwd: testDir, userDataRoot: `${testDir}/.test-account`, projectRoot: testDir, artifactScopeId: "code-full", retrievalSessionId: "code-full", toolUseId: "outer",
      createNestedToolDispatchBatch: () => ({
        execute: () => Effect.die(new Error("No nested call expected")),
        unsettled: () => [],
        close: () => Effect.void,
      }),
    });
    expect(typeof result.content).toBe("string");
    const limited = await limitOutput({
      content: String(result.content), executionCwd: testDir, projectRoot: testDir, artifactScopeId: "code-full", toolName: "code",
    });
    expect(limited.byteTruncated).toBe(true);
    expect(limited.text).toContain("Full output saved to");
    const directory = join(testDir, ".flywheel", "agent-outputs", "code-full");
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const full = readFileSync(join(directory, files[0]!), "utf8");
    const [savedReturn, logs] = full.split("\n\nLogs:\n");
    expect(savedReturn).toBe(returned);
    expect(logs?.length).toBeLessThan(200);
    expect(logs).toBe("retained\n[2 more console lines dropped after the 51200-byte retention budget]");
  });

  test("keeps the first and last portions of large output around a bytes-omitted marker", async () => {
    const large = "A".repeat(15_000) + "MIDDLE".repeat(5_000) + "Z".repeat(15_000);
    const result = await limitOutput({ content: large, executionCwd: testDir, projectRoot: testDir, artifactScopeId: "sess-large" });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("A".repeat(100));
    expect(result.text).toContain("Z".repeat(100));
    expect(result.text).toContain("bytes omitted");
  });

  test("saves full output to per-session subdirectory when truncated", async () => {
    const output = "B".repeat(50_000);
    const artifactScopeId = "test-session-123";
    const result = await limitOutput({ content: output, executionCwd: testDir, projectRoot: testDir, artifactScopeId });
    expect(result.truncated).toBe(true);

    const sessionDir = join(testDir, ".flywheel", "agent-outputs", artifactScopeId);
    expect(existsSync(sessionDir)).toBe(true);
    const files = readdirSync(sessionDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^output_.*\.txt$/);
  });

  test("truncated message includes cwd-relative path to saved file", async () => {
    const output = "C".repeat(50_000);
    const result = await limitOutput({ content: output, executionCwd: testDir, projectRoot: testDir, artifactScopeId: "sess-1" });
    expect(result.text).toContain("Full output saved to .flywheel/agent-outputs/sess-1/");
    expect(result.text).not.toContain(testDir);
  });

  test("stores breadcrumbs under the project root when tools run in a nested directory", async () => {
    const output = "P".repeat(50_000);
    const projectRoot = join(testDir, "project");
    const executionCwd = join(projectRoot, "package");
    const artifactScopeId = "sess-project-root";
    mkdirSync(executionCwd, { recursive: true });

    const result = await limitOutput({ content: output, executionCwd, projectRoot, artifactScopeId });

    const sessionDir = join(projectRoot, ".flywheel", "agent-outputs", artifactScopeId);
    expect(existsSync(sessionDir)).toBe(true);
    expect(result.text).toContain("Full output saved to ../.flywheel/agent-outputs/sess-project-root/");
  });

  test("keeps the whole result, notice included, within maxBytes when the saved path is long", async () => {
    const executionCwd = join(testDir, ...Array.from({ length: 60 }, (_, i) => `nested-directory-${i}`));
    const result = await limitOutput({ content: "L".repeat(50_000), maxBytes: 2_000, executionCwd, projectRoot: testDir, artifactScopeId: "sess-deep", capabilities: () => true });
    expect(result.text.length).toBeLessThanOrEqual(2_000);
    expect(result.text).toStartWith("LLL");
    expect(result.text).toEndWith("; grep it with the search tool if you need the removed content]");
  });

  test("names only the retrieval tool that the reading agent holds", async () => {
    const notice = async (held: readonly string[]) => (await limitOutput({ content: "N".repeat(50_000), executionCwd: testDir, projectRoot: testDir, artifactScopeId: "sess-capabilities", capabilities: (term) => held.includes(term) })).text;
    expect(await notice(["read"])).toEndWith("; read it with offset and limit if you need the removed content]");
    expect(await notice(["bash"])).toEndWith("; inspect it with a shell command if you need the removed content]");
    expect(await notice([])).toEndWith("[Output was truncated. The rest of the output is not available with your tools.]");
    // A reader whose tools are unknown, such as crash recovery, is told where the file is and no tool.
    const unknown = (await limitOutput({ content: "U".repeat(50_000), executionCwd: testDir, projectRoot: testDir, artifactScopeId: "sess-unknown" })).text;
    expect(unknown).toMatch(/\n\[Full output saved to \.flywheel\/agent-outputs\/sess-unknown\/[^;\]]+\]$/);
  });

  test("uses toolName as breadcrumb filename prefix", async () => {
    const output = "E".repeat(50_000);
    const result = await limitOutput({ content: output, executionCwd: testDir, projectRoot: testDir, artifactScopeId: "sess-tool", toolName: "bash" });
    expect(result.truncated).toBe(true);
    const sessionDir = join(testDir, ".flywheel", "agent-outputs", "sess-tool");
    const files = readdirSync(sessionDir);
    expect(files[0]).toMatch(/^bash_.*\.txt$/);
  });

  test("writes breadcrumb with fullContent verbatim even when content is small", async () => {
    const sessionId = "sess-semantic";
    const result = await limitOutput({
      content: "summary line",
      fullContent: "FULL_RAW_PAYLOAD",
      executionCwd: testDir,
      projectRoot: testDir,
      artifactScopeId: sessionId,
      toolName: "search",
    });
    expect(result.truncated).toBe(true);
    expect(result.semanticTruncated).toBe(true);
    expect(result.byteTruncated).toBe(false);
    expect(result.text).toContain("summary line");
    expect(result.text).toContain("Full output saved to");
    const sessionDir = join(testDir, ".flywheel", "agent-outputs", sessionId);
    const files = readdirSync(sessionDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^search_.*\.txt$/);
    const savedName = files[0];
    if (!savedName) throw new Error("expected saved output");
    const savedPath = join(sessionDir, savedName);
    expect(readFileSync(savedPath, "utf8")).toBe("FULL_RAW_PAYLOAD");
  });

  test("names a file the tool already retained and writes no breadcrumb", async () => {
    const retained = join(testDir, "scratch", "bash-foreground.log");
    const result = await limitOutput({
      content: "X".repeat(50_000),
      retainedFullContent: { path: retained, bytes: 2_000_000, sha256: "a".repeat(64) },
      executionCwd: testDir,
      projectRoot: testDir,
      artifactScopeId: "sess-retained",
      toolName: "bash",
      capabilities: () => true,
    });
    expect(result.truncated).toBe(true);
    expect(result.semanticTruncated).toBe(true);
    expect(result.byteTruncated).toBe(true);
    expect(result.fullContentPath).toBe(retained);
    expect(result.text).toEndWith("\n[Full output saved to scratch/bash-foreground.log; grep it with the search tool if you need the removed content]");
    expect(existsSync(join(testDir, ".flywheel", "agent-outputs"))).toBe(false);
  });

  test("byte-caps content while still saving fullContent as canonical", async () => {
    const sessionId = "sess-both";
    const bigContent = "X".repeat(50_000);
    const result = await limitOutput({
      content: bigContent,
      fullContent: "ORIGINAL_RAW",
      executionCwd: testDir,
      projectRoot: testDir,
      artifactScopeId: sessionId,
    });
    expect(result.truncated).toBe(true);
    expect(result.semanticTruncated).toBe(true);
    expect(result.byteTruncated).toBe(true);
    expect(result.text.length).toBeLessThan(bigContent.length);
    const sessionDir = join(testDir, ".flywheel", "agent-outputs", sessionId);
    const files = readdirSync(sessionDir);
    expect(files.length).toBe(1);
    const savedName = files[0];
    if (!savedName) throw new Error("expected saved output");
    const savedPath = join(sessionDir, savedName);
    expect(readFileSync(savedPath, "utf8")).toBe("ORIGINAL_RAW");
  });
});
