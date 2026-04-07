/**
 * Claude Code engine.
 *
 * Command pattern from CodeMachine. Prompt is passed via stdin.
 * Model can be a short name (opus, sonnet, haiku) or a full claude model ID.
 */

import type { Engine, EngineCommand, EngineCommandOptions, EngineMetadata, ModelInfo } from "../core/types";

export const metadata: EngineMetadata = {
  id: "claude",
  name: "Claude Code",
  cliBinary: "claude",
  defaultModel: "claude-opus-4-6[1m]",
  installCommand: "npm install -g @anthropic-ai/claude-code",
  description: "Anthropic's Claude Code CLI",
  order: 2,
  supportsToolScoping: true,
  supportsStreamingInput: true,
  // Claude Code delivers thinking as complete blocks, not streaming tokens.
  // The adapter uses this to emit a synthetic "thinking" activity event during silence.
  syntheticThinkingMs: 500,
};

/**
 * Map ToolScopingConfig booleans to Claude CLI tool names.
 * Only tools with `true` are included in the --tools list.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  task: "Task",
};

/**
 * Unified command builder for all roles (worker, dispatcher, evaluator).
 *
 * All roles use --input-format stream-json with stdin pipes (stdinPrompt: true).
 * Does NOT include --no-session-persistence (incompatible with stream-json).
 * Does NOT include -p (prompt delivered via stdin NDJSON).
 *
 * Supports:
 * - --system-prompt when provided (for dispatcher/evaluator)
 * - --tools as explicit string when provided (for dispatcher/evaluator)
 * - --tools derived from ToolScopingConfig when toolScoping provided (for workers)
 * - --resume when resumeSessionId provided (for workers)
 * - --effort when provided
 * - --model when provided
 */
export function buildCommand(options: EngineCommandOptions): EngineCommand {
  const args: string[] = [
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--dangerously-skip-permissions",
  ];

  if (options.resumeSessionId?.trim()) {
    args.push("--resume", options.resumeSessionId.trim());
  }

  if (options.model?.trim()) {
    args.push("--model", options.model.trim());
  }

  if (options.systemPrompt?.trim()) {
    args.push("--system-prompt", options.systemPrompt.trim());
  }

  if (options.effort?.trim()) {
    args.push("--effort", options.effort.trim());
  }

  // Explicit tools string takes precedence over toolScoping
  if (options.tools?.trim()) {
    args.push("--tools", options.tools.trim());
  } else if (options.toolScoping) {
    // Tool scoping: use --tools to restrict available tools
    // Write is ALWAYS included — workers must be able to write the handoff file.
    const allowed: string[] = [];
    for (const [key, cliName] of Object.entries(TOOL_NAME_MAP)) {
      if (options.toolScoping[key as keyof typeof options.toolScoping]) {
        allowed.push(cliName);
      }
    }
    // Ensure Write is always available for handoff file writing
    if (!allowed.includes("Write")) {
      allowed.push("Write");
    }
    if (allowed.length > 0) {
      args.push("--tools", allowed.join(","));
    }
  }

  return {
    command: metadata.cliBinary,
    args,
    stdinPrompt: true,
  };
}

/**
 * Hardcoded model list for Claude Code.
 *
 * Claude Code accepts short aliases (opus, sonnet, haiku) and full model IDs
 * (claude-opus-4-6). No CLI command exists to discover models at runtime.
 * Update this list when new model families ship.
 */
const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6[1m]",   name: "Claude Opus (1M context)",   family: "opus",   isAlias: false },
  { id: "claude-sonnet-4-6[1m]", name: "Claude Sonnet (1M context)", family: "sonnet", isAlias: false },
  { id: "opus",    name: "Claude Opus (200k)",   family: "opus",   isAlias: true },
  { id: "sonnet",  name: "Claude Sonnet (200k)", family: "sonnet", isAlias: true },
  { id: "haiku",   name: "Claude Haiku (200k)",  family: "haiku",  isAlias: true },
];

async function listModels(_provider?: string): Promise<ModelInfo[]> {
  return CLAUDE_MODELS;
}

export const claudeEngine: Engine = { metadata, buildCommand, listModels };
