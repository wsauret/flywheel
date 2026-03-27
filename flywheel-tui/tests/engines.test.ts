import { describe, it, expect } from "bun:test";
import { claudeEngine } from "../src/engines/providers/claude/index";
import { opencodeEngine } from "../src/engines/providers/opencode/index";
import {
  getEngine,
  getAllEngines,
  isEngineAvailable,
  getEngineInstallInstructions,
} from "../src/engines/core/registry";

// ---------------------------------------------------------------------------
// Engine: claude
// ---------------------------------------------------------------------------

describe("Engine: claude", () => {
  it("builds command with --print and --output-format stream-json (no --input-format for plain-text stdin)", () => {
    const cmd = claudeEngine.buildCommand({ prompt: "do stuff" });

    expect(cmd.command).toBe("claude");
    expect(cmd.args).toContain("--print");
    expect(cmd.args).toContain("--output-format");
    expect(cmd.args).toContain("stream-json");
    // Worker receives plain-text prompt on stdin — --input-format stream-json
    // would cause Claude Code to reject the input with a JSON parse error.
    expect(cmd.args).not.toContain("--input-format");
  });

  it("passes model via --model flag when provided", () => {
    const cmd = claudeEngine.buildCommand({
      prompt: "do stuff",
      model: "opus",
    });

    expect(cmd.args).toContain("--model");
    expect(cmd.args).toContain("opus");
  });

  it("uses stdin for prompt delivery", () => {
    const cmd = claudeEngine.buildCommand({ prompt: "do stuff" });

    expect(cmd.stdinPrompt).toBe(true);
  });

  it("omits --model when model is undefined", () => {
    const cmd = claudeEngine.buildCommand({ prompt: "do stuff" });

    expect(cmd.args).not.toContain("--model");
  });

  it("supports --resume for session resumption", () => {
    const cmd = claudeEngine.buildCommand({
      prompt: "continue",
      resumeSessionId: "sess-123",
    });

    expect(cmd.args).toContain("--resume");
    expect(cmd.args).toContain("sess-123");
  });
});

// ---------------------------------------------------------------------------
// Engine: opencode
// ---------------------------------------------------------------------------

describe("Engine: opencode", () => {
  it("builds command with 'run' and --format json", () => {
    const cmd = opencodeEngine.buildCommand({ prompt: "do stuff" });

    expect(cmd.command).toBe("opencode");
    expect(cmd.args).toContain("run");
    expect(cmd.args).toContain("--format");
    expect(cmd.args).toContain("json");
  });

  it("passes model via --model flag when provided", () => {
    const cmd = opencodeEngine.buildCommand({
      prompt: "do stuff",
      model: "anthropic/claude-opus-4-6",
    });

    expect(cmd.args).toContain("--model");
    expect(cmd.args).toContain("anthropic/claude-opus-4-6");
  });

  it("uses stdin for prompt delivery", () => {
    const cmd = opencodeEngine.buildCommand({ prompt: "do stuff" });

    expect(cmd.stdinPrompt).toBe(true);
  });

  it("omits --model when model is undefined", () => {
    const cmd = opencodeEngine.buildCommand({ prompt: "do stuff" });

    expect(cmd.args).not.toContain("--model");
  });

  it("supports --session for session resumption", () => {
    const cmd = opencodeEngine.buildCommand({
      prompt: "continue",
      resumeSessionId: "sess-456",
    });

    expect(cmd.args).toContain("--session");
    expect(cmd.args).toContain("sess-456");
  });
});

// ---------------------------------------------------------------------------
// Engine registry
// ---------------------------------------------------------------------------

describe("Engine registry", () => {
  it("getEngine('claude') returns claude engine", () => {
    const engine = getEngine("claude");
    expect(engine.metadata.id).toBe("claude");
    expect(engine.metadata.name).toBe("Claude Code");
  });

  it("getEngine('opencode') returns opencode engine", () => {
    const engine = getEngine("opencode");
    expect(engine.metadata.id).toBe("opencode");
    expect(engine.metadata.name).toBe("OpenCode");
  });

  it("throws on unknown engine", () => {
    expect(() => getEngine("nonexistent")).toThrow(/Unknown engine/);
  });

  it("lists all engines", () => {
    const engines = getAllEngines();
    expect(engines.length).toBeGreaterThanOrEqual(2);

    const ids = engines.map((e) => e.metadata.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("opencode");
  });
});

// ---------------------------------------------------------------------------
// Engine metadata: description and order
// ---------------------------------------------------------------------------

describe("Engine metadata", () => {
  it("claude metadata includes description and order", () => {
    const engine = getEngine("claude");
    expect(engine.metadata.description).toBe("Anthropic's Claude Code CLI");
    expect(engine.metadata.order).toBe(2);
  });

  it("opencode metadata includes description and order", () => {
    const engine = getEngine("opencode");
    expect(engine.metadata.description).toBe("OpenCode AI CLI");
    expect(engine.metadata.order).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Engine: claude — tool scoping
// ---------------------------------------------------------------------------

describe("Engine: claude — tool scoping", () => {
  it("adds --tools with only allowed tools when toolScoping provided (Write always included for handoff)", () => {
    const cmd = claudeEngine.buildCommand({
      prompt: "do stuff",
      toolScoping: { read: true, bash: false, write: false, edit: false },
    });

    expect(cmd.args).toContain("--tools");
    const flagIdx = cmd.args.indexOf("--tools");
    const toolsArg = cmd.args[flagIdx + 1];
    // Write is always included for handoff file writing, even when write:false
    expect(toolsArg).toBe("Read,Write");
  });

  it("includes all tools when all scoping booleans are true", () => {
    const cmd = claudeEngine.buildCommand({
      prompt: "do stuff",
      toolScoping: { read: true, bash: true, write: true, edit: true },
    });

    expect(cmd.args).toContain("--tools");
    const flagIdx = cmd.args.indexOf("--tools");
    const toolsArg = cmd.args[flagIdx + 1];
    // Should contain all four tool names
    expect(toolsArg).toContain("Read");
    expect(toolsArg).toContain("Bash");
    expect(toolsArg).toContain("Write");
    expect(toolsArg).toContain("Edit");
  });

  it("lists multiple allowed tools comma-separated (Write always appended for handoff)", () => {
    const cmd = claudeEngine.buildCommand({
      prompt: "do stuff",
      toolScoping: { read: true, bash: true, write: false, edit: false },
    });

    const flagIdx = cmd.args.indexOf("--tools");
    const toolsArg = cmd.args[flagIdx + 1];
    // Write is always included for handoff file writing
    expect(toolsArg).toBe("Read,Bash,Write");
  });

  it("omits --tools when toolScoping is undefined (backward compat)", () => {
    const cmd = claudeEngine.buildCommand({ prompt: "do stuff" });

    expect(cmd.args).not.toContain("--tools");
  });

  it("sets supportsToolScoping: true in metadata", () => {
    expect(claudeEngine.metadata.supportsToolScoping).toBe(true);
  });

  it("sets supportsStreamingInput: true in metadata", () => {
    expect(claudeEngine.metadata.supportsStreamingInput).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine: opencode — tool scoping
// ---------------------------------------------------------------------------

describe("Engine: opencode — tool scoping", () => {
  it("returns promptPrefix when toolScoping restricts tools", () => {
    const cmd = opencodeEngine.buildCommand({
      prompt: "do stuff",
      toolScoping: { read: true, bash: true, write: false, edit: false },
    });

    expect(cmd.promptPrefix).toBeDefined();
    expect(cmd.promptPrefix).toContain("Write");
    expect(cmd.promptPrefix).toContain("Edit");
    expect(cmd.promptPrefix).toContain("Do NOT");
  });

  it("does not add promptPrefix when all tools allowed", () => {
    const cmd = opencodeEngine.buildCommand({
      prompt: "do stuff",
      toolScoping: { read: true, bash: true, write: true, edit: true },
    });

    expect(cmd.promptPrefix).toBeUndefined();
  });

  it("does not add promptPrefix when toolScoping is undefined (backward compat)", () => {
    const cmd = opencodeEngine.buildCommand({ prompt: "do stuff" });

    expect(cmd.promptPrefix).toBeUndefined();
  });

  it("does not add CLI flags for tool scoping (no --tools)", () => {
    const cmd = opencodeEngine.buildCommand({
      prompt: "do stuff",
      toolScoping: { read: true, bash: false, write: false, edit: false },
    });

    expect(cmd.args).not.toContain("--tools");
    expect(cmd.args).not.toContain("--disallowedTools");
  });

  it("sets supportsToolScoping: false in metadata", () => {
    expect(opencodeEngine.metadata.supportsToolScoping).toBe(false);
  });

  it("sets supportsStreamingInput: false in metadata", () => {
    expect(opencodeEngine.metadata.supportsStreamingInput).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine availability
// ---------------------------------------------------------------------------

describe("Engine availability", () => {
  it("isEngineAvailable returns true when CLI binary is in PATH", () => {
    // "claude" or "opencode" may be installed; test whichever is available
    // We verify the function works by checking against Bun.which directly
    const claudeInPath = (() => {
      try { return Bun.which("claude") !== null; } catch { return false; }
    })();
    expect(isEngineAvailable("claude")).toBe(claudeInPath);
  });

  it("isEngineAvailable returns false for nonexistent engine ID", () => {
    expect(isEngineAvailable("nonexistent-engine-xyz")).toBe(false);
  });

  it("getEngineInstallInstructions returns install command for valid engine", () => {
    const instructions = getEngineInstallInstructions("claude");
    expect(instructions).toBe("npm install -g @anthropic-ai/claude-code");
  });

  it("getEngineInstallInstructions returns undefined for unknown engine", () => {
    const instructions = getEngineInstallInstructions("nonexistent");
    expect(instructions).toBeUndefined();
  });
});
