/**
 * Claude Code engine.
 *
 * Command pattern from CodeMachine. Prompt is passed via stdin.
 * Model can be a short name (opus, sonnet, haiku) or a full claude model ID.
 */

import type { DispatcherCommandOptions, Engine, EngineCommand, EngineCommandOptions, EngineMetadata, ModelInfo } from "../../core/types";

export const metadata: EngineMetadata = {
  id: "claude",
  name: "Claude Code",
  cliBinary: "claude",
  defaultModel: "opus",
  installCommand: "npm install -g @anthropic-ai/claude-code",
  description: "Anthropic's Claude Code CLI",
  order: 2,
  supportsToolScoping: true,
  supportsStreamingInput: true,
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
};

export function buildCommand(options: EngineCommandOptions): EngineCommand {
  const args: string[] = [
    "--print",
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

  // Tool scoping: use --tools to restrict available tools
  if (options.toolScoping) {
    const allowed: string[] = [];
    for (const [key, cliName] of Object.entries(TOOL_NAME_MAP)) {
      if (options.toolScoping[key as keyof typeof options.toolScoping]) {
        allowed.push(cliName);
      }
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

/** Default model for dispatcher/evaluator commands (fast Sonnet-class) */
const DISPATCHER_DEFAULT_MODEL = "sonnet";

/**
 * Build a CLI command optimized for dispatcher/evaluator use.
 *
 * Flags:
 * - `--print` — non-interactive output (plain text response)
 * - `--tools Write` — only allow file writing (needed for handoff file)
 * - `--model <model>` — fast model (default: sonnet)
 * - `--system-prompt <prompt>` — separate system prompt for prompt caching
 * - `--no-session-persistence` — skip writing session to disk
 * - `--effort low` — reduced reasoning overhead
 * - `-p <prompt>` — pass prompt directly (not via stdin)
 * - `--dangerously-skip-permissions` — skip permission prompts
 */
export function buildDispatcherCommand(options: DispatcherCommandOptions): EngineCommand {
  const model = options.model?.trim() || DISPATCHER_DEFAULT_MODEL;

  const args: string[] = [
    "--print",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--tools", "Write",
    "--model", model,
    "--system-prompt", options.systemPrompt,
    "--effort", "low",
    "-p", options.prompt,
  ];

  return {
    command: metadata.cliBinary,
    args,
    stdinPrompt: false,
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
  { id: "opus",    name: "Claude Opus (latest)",   family: "opus",   isAlias: true },
  { id: "sonnet",  name: "Claude Sonnet (latest)", family: "sonnet", isAlias: true },
  { id: "haiku",   name: "Claude Haiku (latest)",  family: "haiku",  isAlias: true },
];

async function listModels(_provider?: string): Promise<ModelInfo[]> {
  return CLAUDE_MODELS;
}

export const claudeEngine: Engine = { metadata, buildCommand, buildDispatcherCommand, listModels };
