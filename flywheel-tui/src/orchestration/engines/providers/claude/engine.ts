import type {
  Engine,
  EngineMetadata,
  RunnerOptions,
} from "../../core/types.js";
import { canonicalize } from "../../../../infra/canonical-name.js";
import type { EngineCommand, EngineCommandOptions } from "./engine-types.js";
import type { ProcessSpawner } from "./subprocess/spawner.js";
import { SubprocessRunner } from "./subprocess-runner.js";
import { BunProcessSpawner } from "./subprocess/bun-spawner.js";

interface SubprocessEngineConfig {
  cliBinary: string;
  installCommand: string;
  supportsStreamingInput: boolean;
}

const metadata: EngineMetadata = {
  id: "claude",
  name: "Claude Code",
  defaultModel: "claude-opus-4-7[1m]",
  description: "Anthropic's Claude Code CLI",
  parity: {
    resumeMode: "provider_session",
    handoffMode: "generic_file_write",
    progressMode: "builtin_todo",
    toolExecutionMode: "provider_native",
    taskScopeMode: "subagent",
    supportsExternalToolResults: true,
  },
  // Claude Code delivers thinking as complete blocks, not streaming tokens.
  // The adapter uses this to emit a synthetic "thinking" activity event during silence.
  syntheticThinkingMs: 500,
  supportsPooling: true,
};

const subprocessConfig: SubprocessEngineConfig = {
  cliBinary: "claude",
  installCommand: "npm install -g @anthropic-ai/claude-code",
  supportsStreamingInput: true,
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

  if (options.tools && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  }

  if (options.settings?.trim()) {
    args.push("--settings", options.settings.trim());
  }

  return {
    command: subprocessConfig.cliBinary,
    args,
    stdinPrompt: true,
  };
}

function resolveModel(raw: string): string {
  const key = canonicalize(raw);
  if (key.endsWith("[200k]")) return raw.slice(0, -6);
  if (key.startsWith("claude-") && !key.includes("[")) return `${raw}[1m]`;
  return raw;
}

type SpawnerFactory = () => ProcessSpawner;

const defaultSpawnerFactory: SpawnerFactory = () => new BunProcessSpawner();

export function createClaudeEngine(spawnerFactory?: SpawnerFactory): Engine {
  const factory = spawnerFactory ?? defaultSpawnerFactory;
  return {
    metadata,
    createRunner(options: RunnerOptions) {
      return new SubprocessRunner({
        options,
        buildCommand,
        spawner: factory(),
      });
    },
  };
}
