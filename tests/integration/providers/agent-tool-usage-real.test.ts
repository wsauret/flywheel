/**
 * Integration tests verifying LLMs correctly use agent tools end-to-end.
 *
 * Each test runs the full agent loop with a real API call and asserts
 * the model used the expected tool(s) to accomplish the task. This catches
 * prompt/schema regressions that unit tests cannot detect.
 *
 * Requires the auth profile that FLYWHEEL_LIVE_AUTH_PROFILE names, with an
 * account that can serve the live model; the suite fails, and names what the profile can serve, when
 * none can.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { temporaryDirectories } from "../../helpers/directories.js";
import { runLiveAgentLoop, toolNamesUsed, toolWasUsed } from "./_live-agent-loop.js";
import { LIVE_MODEL } from "./_live-client.js";

const TIMEOUT = 120_000;
const LOOP_TIMEOUT = 90_000;
const temporaryDirectory = temporaryDirectories();

describe(`Agent tool usage with ${LIVE_MODEL} (real API)`, () => {
  it("uses write tool to create a new file", async () => {
    const tmpDir = temporaryDirectory("agent-tool-test-");
    const { result, events } = await runLiveAgentLoop({
      label: "uses write tool to create a new file",
      instruction:
        "Create a new file at greeting.txt containing exactly 'Hello, World!'. " +
        "Use the write tool. Do NOT use bash. After creating the file, stop.",
      executionCwd: tmpDir,
      timeoutMs: LOOP_TIMEOUT,
    });

    expect(result.kind).toBe("completed");

    const filePath = path.join(tmpDir, "greeting.txt");
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("Hello, World!");

    expect(toolWasUsed(events, "write")).toBe(true);
  }, TIMEOUT);

  it("uses read then edit to modify an existing file", async () => {
    const tmpDir = temporaryDirectory("agent-tool-test-");
    const filePath = path.join(tmpDir, "config.ts");
    fs.writeFileSync(filePath, 'const API_URL = "http://localhost:3000";\nconst TIMEOUT = 5000;\n');

    const { result, events } = await runLiveAgentLoop({
      label: "uses read then edit to modify an existing file",
      instruction:
        `Read the file at ${filePath}, then use the edit tool to change the TIMEOUT value from 5000 to 10000. ` +
        "Do NOT use bash or write. After editing, stop.",
      executionCwd: tmpDir,
      timeoutMs: LOOP_TIMEOUT,
    });

    expect(result.kind).toBe("completed");

    const updated = fs.readFileSync(filePath, "utf-8");
    expect(updated).toContain("10000");
    expect(updated).not.toContain("5000");

    expect(toolWasUsed(events, "read")).toBe(true);
    expect(toolWasUsed(events, "edit")).toBe(true);
  }, TIMEOUT);

  it("uses search to find a pattern across files", async () => {
    const tmpDir = temporaryDirectory("agent-tool-test-");
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "a.ts"), 'export function fetchData() { return "data"; }\n');
    fs.writeFileSync(path.join(srcDir, "b.ts"), 'export function processData() { return null; }\n');
    fs.writeFileSync(path.join(srcDir, "c.ts"), 'export const VERSION = "1.0.0";\n');

    const { result, events } = await runLiveAgentLoop({
      label: "uses search to find a pattern across files",
      instruction:
        `Search the directory ${srcDir} for files containing the word "Data" (case-insensitive). ` +
        "Use the search tool with case_insensitive: true. " +
        "Do NOT use bash, grep, or rg. Report which files matched, then stop.",
      executionCwd: tmpDir,
      timeoutMs: LOOP_TIMEOUT,
    });

    expect(result.kind).toBe("completed");

    expect(toolWasUsed(events, "search")).toBe(true);
  }, TIMEOUT);

  it("uses bash with cwd parameter", async () => {
    const tmpDir = temporaryDirectory("agent-tool-test-");
    const subDir = path.join(tmpDir, "subproject");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, "marker.txt"), "found-me");

    const { result, events } = await runLiveAgentLoop({
      label: "uses bash with cwd parameter",
      instruction:
        `List the files in ${subDir} using bash with the cwd parameter set to "${subDir}". ` +
        "Use: bash(command=\"ls\", cwd=\"" + subDir + "\"). " +
        "Report what you find, then stop.",
      executionCwd: tmpDir,
      timeoutMs: LOOP_TIMEOUT,
    });

    expect(result.kind).toBe("completed");

    expect(toolWasUsed(events, "bash")).toBe(true);
  }, TIMEOUT);

  it("write tool blocks overwriting unread files", async () => {
    const tmpDir = temporaryDirectory("agent-tool-test-");
    const filePath = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(filePath, "original content");

    const { result, events } = await runLiveAgentLoop({
      label: "write tool blocks overwriting unread files",
      instruction:
        `Without reading it first, try to overwrite the file at ${filePath} using the write tool with content 'overwritten'. ` +
        "The write tool should reject this because the file exists and was not read in this run. " +
        "After the rejection, use read and edit to change the content to 'modified via edit' instead. " +
        "Do NOT use bash.",
      executionCwd: tmpDir,
      timeoutMs: LOOP_TIMEOUT,
    });

    expect(result.kind).toBe("completed");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("modified via edit");

    expect(toolWasUsed(events, "write")).toBe(true);
    expect(toolWasUsed(events, "edit")).toBe(true);
  }, TIMEOUT);

  it("edit tool uses read-provided line anchors", async () => {
    const tmpDir = temporaryDirectory("agent-tool-test-");
    const filePath = path.join(tmpDir, "guarded.txt");
    fs.writeFileSync(filePath, "line one\nline two\nline three\n");

    const { result, events } = await runLiveAgentLoop({
      label: "edit tool uses read-provided line anchors",
      instruction:
        `Change "line two" to "line TWO" in ${filePath}. ` +
        "Read the file first to get its line anchors, then use the edit tool with those anchors. " +
        "Do NOT use bash or write.",
      executionCwd: tmpDir,
      timeoutMs: LOOP_TIMEOUT,
    });

    expect(result.kind).toBe("completed");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("line TWO");
    expect(content).toContain("line one");
    expect(content).toContain("line three");

    const toolNames = toolNamesUsed(events);
    const readIdx = toolNames.indexOf("read");
    const editIdx = toolNames.indexOf("edit");
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(editIdx).toBeGreaterThan(readIdx);
  }, TIMEOUT);
});
