/**
 * OpenCode engine.
 *
 * Command pattern from CodeMachine. Prompt is passed via stdin.
 * Model uses provider/model format (e.g., "anthropic/claude-opus-4-6").
 */

import type { Engine, EngineCommand, EngineCommandOptions, EngineMetadata } from "../../core/types";

export const metadata: EngineMetadata = {
  id: "opencode",
  name: "OpenCode",
  cliBinary: "opencode",
  defaultModel: "anthropic/claude-opus-4-6",
  installCommand: "npm i -g opencode-ai@latest",
  description: "OpenCode AI CLI",
  order: 1,
};

export function buildCommand(options: EngineCommandOptions): EngineCommand {
  const args: string[] = ["run", "--format", "json"];

  if (options.resumeSessionId?.trim()) {
    args.push("--session", options.resumeSessionId.trim());
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

export const opencodeEngine: Engine = { metadata, buildCommand };
