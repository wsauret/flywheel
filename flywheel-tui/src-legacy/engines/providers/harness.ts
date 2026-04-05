/**
 * Harness (Agent Harness) engine.
 *
 * In-process engine that runs the agent loop directly via HarnessSpawner.
 * No subprocess — the harness tools, LLM provider, and agent loop all
 * execute in the main Bun process.
 *
 * Unlike Claude/Droid/OpenCode, the harness manages its own tools
 * internally (supportsToolScoping: false, supportsStreamingInput: false).
 * The EngineCommand returned by buildCommand() is synthetic — the
 * HarnessSpawner ignores the command/args and runs runAgentLoop() directly.
 */

import type {
  DispatcherCommandOptions,
  Engine,
  EngineCommand,
  EngineCommandOptions,
  EngineMetadata,
  EvaluatorCommandOptions,
  ModelInfo,
} from "../core/types.js";

export const metadata: EngineMetadata = {
  id: "harness",
  name: "Harness",
  cliBinary: "harness",
  defaultModel: "claude-sonnet-4-6",
  installCommand: "Built-in — no installation required",
  description: "Built-in agent harness (in-process)",
  order: 4,
  supportsToolScoping: false,
  supportsStreamingInput: false,
};

const MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", family: "opus", isAlias: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", family: "sonnet", isAlias: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", family: "haiku", isAlias: true },
];

export function buildCommand(options: EngineCommandOptions): EngineCommand {
  const args: string[] = [];

  if (options.model?.trim()) {
    args.push("--model", options.model.trim());
  }

  return {
    command: metadata.cliBinary,
    args,
    stdinPrompt: true,
  };
}

export function buildDispatcherCommand(options: DispatcherCommandOptions): EngineCommand {
  const args: string[] = [];

  const model = options.model?.trim() || metadata.defaultModel;
  args.push("--model", model);

  return {
    command: metadata.cliBinary,
    args,
    stdinPrompt: true,
  };
}

export function buildEvaluatorCommand(options: EvaluatorCommandOptions): EngineCommand {
  const args: string[] = [];

  const model = options.model?.trim() || metadata.defaultModel;
  args.push("--model", model);

  return {
    command: metadata.cliBinary,
    args,
    stdinPrompt: true,
  };
}

async function listModels(_provider?: string): Promise<ModelInfo[]> {
  return MODELS;
}

export const harnessEngine: Engine = {
  metadata,
  buildCommand,
  buildDispatcherCommand,
  buildEvaluatorCommand,
  listModels,
};
