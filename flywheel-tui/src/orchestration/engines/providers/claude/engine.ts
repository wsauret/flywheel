import type {
  Engine,
  EngineMetadata,
  RunnerOptions,
} from "../../core/types.js";
import type { ProcessSpawner } from "./subprocess/spawner.js";
import { SubprocessRunner } from "./subprocess-runner.js";
import { BunProcessSpawner } from "./subprocess/bun-spawner.js";

// --- Claude-engine-internal types ---

interface SubprocessEngineConfig {
  /** The CLI binary to execute (e.g., "claude") */
  cliBinary: string;
  /** Install instructions for the CLI */
  installCommand: string;
  /** Whether this engine supports streaming input via stdin pipe */
  supportsStreamingInput: boolean;
}

export interface EngineCommand {
  command: string;
  args: string[];
  /** Whether the prompt should be passed via stdin (true) or is already in args */
  stdinPrompt: boolean;
  /**
   * Optional prompt prefix for engines that enforce tool scoping via prompt instructions
   * rather than CLI flags. Callers should prepend this to the prompt before passing via stdin.
   */
  promptPrefix?: string;
}

export interface EngineCommandOptions {
  /** Model override (engine-native format, e.g., "opus" for claude) */
  model?: string;
  /** Session ID to resume (worker resume path) */
  resumeSessionId?: string;
  /** Explicit tool restriction (e.g., ["Write"] or ["Read", "Bash", "Write"]). Mapped to --tools flag. */
  tools?: ReadonlyArray<string>;
  /** System prompt (separate from user prompt for caching, passed as --system-prompt flag) */
  systemPrompt?: string;
  /** Effort level override (e.g., "low", "medium", "high") */
  effort?: string;
}

export const metadata: EngineMetadata = {
  id: "claude",
  name: "Claude Code",
  defaultModel: "claude-opus-4-6[1m]",
  description: "Anthropic's Claude Code CLI",
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

  return {
    command: subprocessConfig.cliBinary,
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

// Strips the [200k] suffix back to bare alias (which Claude CLI natively treats as 200k).
const ALIAS_STRIP_CONTEXT_SUFFIX: Record<string, string> = {
  "opus[200k]":   "opus",
  "sonnet[200k]": "sonnet",
};

function resolveModel(raw: string): string {
  const key = raw.toLowerCase().trim();
  if (ALIAS_STRIP_CONTEXT_SUFFIX[key]) return ALIAS_STRIP_CONTEXT_SUFFIX[key];
  if (ALIAS_TO_1M[key]) return ALIAS_TO_1M[key];
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
