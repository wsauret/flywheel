/**
 * Tests for the unified buildCommand on the Claude engine.
 *
 * Verifies that a single buildCommand produces correct CLI flags for all roles
 * (worker, dispatcher, evaluator) using --input-format stream-json with stdin pipes.
 */

import { describe, it, expect } from "bun:test";
import { buildCommand } from "../src/orchestration/engines/providers/claude";

describe("unified buildCommand", () => {
  it("produces --input-format stream-json and --output-format stream-json (no -p)", () => {
    const cmd = buildCommand({});
    expect(cmd.args).toContain("--input-format");
    expect(cmd.args).toContain("stream-json");
    expect(cmd.args).toContain("--output-format");
    // Verify --input-format stream-json appears as a pair
    const inputIdx = cmd.args.indexOf("--input-format");
    expect(cmd.args[inputIdx + 1]).toBe("stream-json");
    const outputIdx = cmd.args.indexOf("--output-format");
    expect(cmd.args[outputIdx + 1]).toBe("stream-json");
    // No -p flag
    expect(cmd.args).not.toContain("-p");
  });

  it("returns stdinPrompt: true", () => {
    const cmd = buildCommand({});
    expect(cmd.stdinPrompt).toBe(true);
  });

  it("with dispatcher tools returns --tools Write", () => {
    const cmd = buildCommand({ tools: "Write" });
    const toolsIdx = cmd.args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(cmd.args[toolsIdx + 1]).toBe("Write");
  });

  it("with evaluator tools returns --tools Read,Bash,Write,Grep,Glob", () => {
    const cmd = buildCommand({ tools: "Read,Bash,Write,Grep,Glob" });
    const toolsIdx = cmd.args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(cmd.args[toolsIdx + 1]).toBe("Read,Bash,Write,Grep,Glob");
  });

  it("with worker toolScoping derives --tools from ToolScopingConfig", () => {
    const cmd = buildCommand({
      toolScoping: { read: true, bash: true, write: true, edit: false },
    });
    const toolsIdx = cmd.args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    const toolsArg = cmd.args[toolsIdx + 1];
    expect(toolsArg).toContain("Read");
    expect(toolsArg).toContain("Bash");
    expect(toolsArg).toContain("Write");
    expect(toolsArg).not.toContain("Edit");
  });

  it("respects --model override", () => {
    const cmd = buildCommand({ model: "haiku" });
    const modelIdx = cmd.args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd.args[modelIdx + 1]).toBe("haiku");
  });

  it("respects --effort override", () => {
    const cmd = buildCommand({ effort: "low" });
    const effortIdx = cmd.args.indexOf("--effort");
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(cmd.args[effortIdx + 1]).toBe("low");
  });

  it("respects --system-prompt override", () => {
    const cmd = buildCommand({ systemPrompt: "You are a dispatcher." });
    const sysIdx = cmd.args.indexOf("--system-prompt");
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(cmd.args[sysIdx + 1]).toBe("You are a dispatcher.");
  });

  it("omits --no-session-persistence (incompatible with stream-json)", () => {
    const cmd = buildCommand({
      systemPrompt: "test",
      tools: "Write",
      effort: "low",
      model: "sonnet",
    });
    expect(cmd.args).not.toContain("--no-session-persistence");
  });

  it("includes --resume <sessionId> when provided", () => {
    const cmd = buildCommand({ resumeSessionId: "sess-123" });
    const resumeIdx = cmd.args.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(cmd.args[resumeIdx + 1]).toBe("sess-123");
  });

  it("omits --model when not provided", () => {
    const cmd = buildCommand({});
    expect(cmd.args).not.toContain("--model");
  });

  it("omits --effort when not provided", () => {
    const cmd = buildCommand({});
    expect(cmd.args).not.toContain("--effort");
  });

  it("omits --system-prompt when not provided", () => {
    const cmd = buildCommand({});
    expect(cmd.args).not.toContain("--system-prompt");
  });

  it("omits --resume when not provided", () => {
    const cmd = buildCommand({});
    expect(cmd.args).not.toContain("--resume");
  });

  it("omits --tools when neither tools nor toolScoping provided", () => {
    const cmd = buildCommand({});
    expect(cmd.args).not.toContain("--tools");
  });

  it("explicit tools string takes precedence over toolScoping", () => {
    const cmd = buildCommand({
      tools: "Write",
      toolScoping: { read: true, bash: true, write: true, edit: true },
    });
    const toolsIdx = cmd.args.indexOf("--tools");
    expect(cmd.args[toolsIdx + 1]).toBe("Write");
  });

  it("always includes --dangerously-skip-permissions", () => {
    const cmd = buildCommand({});
    expect(cmd.args).toContain("--dangerously-skip-permissions");
  });

  it("command is 'claude'", () => {
    const cmd = buildCommand({});
    expect(cmd.command).toBe("claude");
  });

  it("worker toolScoping always includes Write for handoff", () => {
    const cmd = buildCommand({
      toolScoping: { read: true, bash: false, write: false, edit: false },
    });
    const toolsIdx = cmd.args.indexOf("--tools");
    const toolsArg = cmd.args[toolsIdx + 1];
    expect(toolsArg).toContain("Write");
    expect(toolsArg).toContain("Read");
    expect(toolsArg).not.toContain("Bash");
  });
});
