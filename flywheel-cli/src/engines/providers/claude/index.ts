/**
 * Claude Code engine.
 *
 * Command pattern from CodeMachine. Prompt is passed via stdin.
 * Model can be a short name (opus, sonnet, haiku) or a full claude model ID.
 */

import type { Engine, EngineCommand, EngineCommandOptions, EngineMetadata, ModelInfo } from "../../core/types";

export const metadata: EngineMetadata = {
  id: "claude",
  name: "Claude Code",
  cliBinary: "claude",
  defaultModel: "opus",
  installCommand: "npm install -g @anthropic-ai/claude-code",
  description: "Anthropic's Claude Code CLI",
  order: 2,
};

export function buildCommand(options: EngineCommandOptions): EngineCommand {
  const args: string[] = [
    "--print",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
  ];

  if (options.resumeSessionId?.trim()) {
    args.push("--resume", options.resumeSessionId.trim());
  }

  if (options.model?.trim()) {
    args.push("--model", options.model.trim());
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
  { id: "opus",    name: "Claude Opus (latest)",   family: "opus",   isAlias: true },
  { id: "sonnet",  name: "Claude Sonnet (latest)", family: "sonnet", isAlias: true },
  { id: "haiku",   name: "Claude Haiku (latest)",  family: "haiku",  isAlias: true },
];

async function listModels(_provider?: string): Promise<ModelInfo[]> {
  return CLAUDE_MODELS;
}

export const claudeEngine: Engine = { metadata, buildCommand, listModels };
