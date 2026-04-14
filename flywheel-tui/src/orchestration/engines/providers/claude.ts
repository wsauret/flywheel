import type { Engine, EngineCommand, EngineCommandOptions, EngineMetadata } from "../core/types.js";

export const metadata: EngineMetadata = {
  id: "claude",
  name: "Claude Code",
  cliBinary: "claude",
  defaultModel: "claude-opus-4-6[1m]",
  installCommand: "npm install -g @anthropic-ai/claude-code",
  description: "Anthropic's Claude Code CLI",
  supportsStreamingInput: true,
  // Claude Code delivers thinking as complete blocks, not streaming tokens.
  // The adapter uses this to emit a synthetic "thinking" activity event during silence.
  syntheticThinkingMs: 500,
};

const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  task: "Task",
};

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
    args.push("--model", resolveModel(options.model));
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

// Bare aliases ("opus", "sonnet") resolve to 1M-context variants by default.
// Append `[200k]` to force the smaller context window. Full model IDs pass through unchanged.
const ALIAS_TO_1M: Record<string, string> = {
  opus:   "claude-opus-4-6[1m]",
  sonnet: "claude-sonnet-4-6[1m]",
};

const ALIAS_200K: Record<string, string> = {
  "opus[200k]":   "opus",
  "sonnet[200k]": "sonnet",
};

export function resolveModel(raw: string): string {
  const key = raw.toLowerCase().trim();
  if (ALIAS_200K[key]) return ALIAS_200K[key];
  if (ALIAS_TO_1M[key]) return ALIAS_TO_1M[key];
  return raw;
}

// metadata and buildCommand are exported individually for direct unit testing
// and composed into claudeEngine for production use via the registry.
export const claudeEngine: Engine = { metadata, buildCommand };
