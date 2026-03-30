import { describe, it, expect } from "bun:test";
import { claudeEngine } from "../src/engines/providers/claude/index";
import { opencodeEngine } from "../src/engines/providers/opencode/index";
import { getEngine } from "../src/engines/core/registry";
import type { DispatcherCommandOptions, EngineCommandOptions } from "../src/engines/core/types";

// ---------------------------------------------------------------------------
// Claude engine: dispatcher command building
// ---------------------------------------------------------------------------

describe("Claude engine: buildDispatcherCommand", () => {
  it("builds dispatcher command with all optimization flags", () => {
    const cmd = claudeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.command).toBe("claude");
    expect(cmd.args).toContain("-p");
    expect(cmd.args).toContain("--dangerously-skip-permissions");
    expect(cmd.args).toContain("--no-session-persistence");
    expect(cmd.args).toContain("--effort");
    expect(cmd.args[cmd.args.indexOf("--effort") + 1]).toBe("low");
  });

  it("allows only Write tool via --tools for handoff file writing", () => {
    const cmd = claudeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.args).toContain("--tools");
    const toolsIdx = cmd.args.indexOf("--tools");
    expect(cmd.args[toolsIdx + 1]).toBe("Write");
  });

  it("passes system prompt via --system-prompt flag", () => {
    const cmd = claudeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a smart dispatcher.",
    });

    expect(cmd.args).toContain("--system-prompt");
    const sysIdx = cmd.args.indexOf("--system-prompt");
    expect(cmd.args[sysIdx + 1]).toBe("You are a smart dispatcher.");
  });

  it("passes prompt via -p flag (not stdin)", () => {
    const cmd = claudeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.args).toContain("-p");
    const pIdx = cmd.args.indexOf("-p");
    expect(cmd.args[pIdx + 1]).toBe("dispatch this task");
    expect(cmd.stdinPrompt).toBe(false);
  });

  it("defaults to 'sonnet' model when no model provided", () => {
    const cmd = claudeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.args).toContain("--model");
    const modelIdx = cmd.args.indexOf("--model");
    expect(cmd.args[modelIdx + 1]).toBe("sonnet");
  });

  it("uses custom model when provided", () => {
    const cmd = claudeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
      model: "haiku",
    });

    expect(cmd.args).toContain("--model");
    const modelIdx = cmd.args.indexOf("--model");
    expect(cmd.args[modelIdx + 1]).toBe("haiku");
  });

  it("includes --output-format stream-json but NOT --input-format", () => {
    const cmd = claudeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.args).toContain("--output-format");
    const fmtIdx = cmd.args.indexOf("--output-format");
    expect(cmd.args[fmtIdx + 1]).toBe("stream-json");
    expect(cmd.args).not.toContain("--input-format");
  });

  it("does NOT include --allowedTools (uses --tools instead)", () => {
    const cmd = claudeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.args).not.toContain("--allowedTools");
  });

  it("does NOT include --resume flag", () => {
    const cmd = claudeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.args).not.toContain("--resume");
  });
});

// ---------------------------------------------------------------------------
// OpenCode engine: dispatcher command building
// ---------------------------------------------------------------------------

describe("OpenCode engine: buildDispatcherCommand", () => {
  it("builds dispatcher command with run and --format json", () => {
    const cmd = opencodeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.command).toBe("opencode");
    expect(cmd.args).toContain("run");
    expect(cmd.args).toContain("--format");
    expect(cmd.args).toContain("json");
  });

  it("defaults to 'anthropic/claude-sonnet-4-6' model when no model provided", () => {
    const cmd = opencodeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.args).toContain("--model");
    const modelIdx = cmd.args.indexOf("--model");
    expect(cmd.args[modelIdx + 1]).toBe("anthropic/claude-sonnet-4-6");
  });

  it("uses custom model when provided", () => {
    const cmd = opencodeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
      model: "anthropic/claude-haiku-4-5",
    });

    expect(cmd.args).toContain("--model");
    const modelIdx = cmd.args.indexOf("--model");
    expect(cmd.args[modelIdx + 1]).toBe("anthropic/claude-haiku-4-5");
  });

  it("uses stdin for prompt delivery", () => {
    const cmd = opencodeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.stdinPrompt).toBe(true);
  });

  it("does NOT include --session flag", () => {
    const cmd = opencodeEngine.buildDispatcherCommand({
      prompt: "dispatch this task",
      systemPrompt: "You are a dispatcher.",
    });

    expect(cmd.args).not.toContain("--session");
  });
});

// ---------------------------------------------------------------------------
// Default dispatcher models per engine
// ---------------------------------------------------------------------------

describe("Default dispatcher models", () => {
  it("Claude default dispatcher model is 'sonnet'", () => {
    const cmd = claudeEngine.buildDispatcherCommand({
      prompt: "test",
      systemPrompt: "test",
    });

    const modelIdx = cmd.args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(cmd.args[modelIdx + 1]).toBe("sonnet");
  });

  it("OpenCode default dispatcher model is 'anthropic/claude-sonnet-4-6'", () => {
    const cmd = opencodeEngine.buildDispatcherCommand({
      prompt: "test",
      systemPrompt: "test",
    });

    const modelIdx = cmd.args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(cmd.args[modelIdx + 1]).toBe("anthropic/claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// Worker buildCommand is NOT affected by dispatcher changes
// ---------------------------------------------------------------------------

describe("Worker buildCommand is unchanged", () => {
  it("Claude worker command does NOT contain dispatcher flags", () => {
    const cmd = claudeEngine.buildCommand({ prompt: "do work" });

    // Dispatcher-only flags must NOT appear in worker commands
    expect(cmd.args).not.toContain("--tools");
    expect(cmd.args).not.toContain("--no-session-persistence");
    expect(cmd.args).not.toContain("--effort");
    expect(cmd.args).not.toContain("-p");
    expect(cmd.args).not.toContain("--system-prompt");

    // Worker-specific flags should still be present (no --print for interactive stdin)
    expect(cmd.args).not.toContain("--print");
    expect(cmd.args).toContain("--output-format");
    // --input-format stream-json: worker receives NDJSON-wrapped stdin for streaming pipe
    expect(cmd.args).toContain("--input-format");
    expect(cmd.args).toContain("--dangerously-skip-permissions");
    expect(cmd.stdinPrompt).toBe(true);
  });

  it("OpenCode worker command does NOT contain dispatcher-only flags", () => {
    const cmd = opencodeEngine.buildCommand({ prompt: "do work" });

    // Worker should have run and --format json
    expect(cmd.args).toContain("run");
    expect(cmd.args).toContain("--format");
    expect(cmd.args).toContain("json");
    expect(cmd.stdinPrompt).toBe(true);

    // No model forced when not provided
    expect(cmd.args).not.toContain("--model");
  });

  it("Claude worker with model does not get dispatcher defaults", () => {
    const cmd = claudeEngine.buildCommand({ prompt: "do work", model: "opus" });

    expect(cmd.args).toContain("--model");
    expect(cmd.args).toContain("opus");
    // But no dispatcher flags
    expect(cmd.args).not.toContain("--tools");
    expect(cmd.args).not.toContain("--no-session-persistence");
    expect(cmd.args).not.toContain("--effort");
  });

  it("OpenCode worker with model does not get dispatcher defaults", () => {
    const cmd = opencodeEngine.buildCommand({
      prompt: "do work",
      model: "anthropic/claude-opus-4-6",
    });

    expect(cmd.args).toContain("--model");
    expect(cmd.args).toContain("anthropic/claude-opus-4-6");
    expect(cmd.stdinPrompt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine registry returns engines with buildDispatcherCommand
// ---------------------------------------------------------------------------

describe("Engine registry: dispatcher support", () => {
  it("getEngine('claude') returns engine with buildDispatcherCommand", () => {
    const engine = getEngine("claude");
    expect(typeof engine.buildDispatcherCommand).toBe("function");
  });

  it("getEngine('opencode') returns engine with buildDispatcherCommand", () => {
    const engine = getEngine("opencode");
    expect(typeof engine.buildDispatcherCommand).toBe("function");
  });

  it("Claude engine from registry builds correct dispatcher command", () => {
    const engine = getEngine("claude");
    const cmd = engine.buildDispatcherCommand({
      prompt: "dispatch",
      systemPrompt: "system",
    });

    expect(cmd.command).toBe("claude");
    expect(cmd.args).toContain("--tools");
    expect(cmd.args).toContain("--no-session-persistence");
    expect(cmd.args).toContain("--effort");
  });

  it("OpenCode engine from registry builds correct dispatcher command", () => {
    const engine = getEngine("opencode");
    const cmd = engine.buildDispatcherCommand({
      prompt: "dispatch",
      systemPrompt: "system",
    });

    expect(cmd.command).toBe("opencode");
    expect(cmd.args).toContain("run");
    expect(cmd.args).toContain("--model");
  });
});
