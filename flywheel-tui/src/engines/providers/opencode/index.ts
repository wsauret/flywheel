/**
 * OpenCode engine.
 *
 * Command pattern from CodeMachine. Prompt is passed via stdin.
 * Model uses provider/model format (e.g., "anthropic/claude-opus-4-6").
 */

import type { DispatcherCommandOptions, EvaluatorCommandOptions, Engine, EngineCommand, EngineCommandOptions, EngineMetadata, ModelInfo } from "../../core/types";

export const metadata: EngineMetadata = {
  id: "opencode",
  name: "OpenCode",
  cliBinary: "opencode",
  defaultModel: "anthropic/claude-opus-4-6",
  installCommand: "npm i -g opencode-ai@latest",
  description: "OpenCode AI CLI",
  order: 1,
  supportsToolScoping: false,
  // OpenCode does not support mid-execution stdin injection.
  // The initial prompt is sent via stdin, but no additional messages
  // can be injected after startup. Only Claude (with --input-format
  // stream-json) supports streaming input for mid-worker steering.
  supportsStreamingInput: false,
};

/**
 * Human-readable tool names for prompt-based scoping instructions.
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  task: "Task",
};

export function buildCommand(options: EngineCommandOptions): EngineCommand {
  const args: string[] = ["run", "--format", "json"];

  if (options.resumeSessionId?.trim()) {
    args.push("--session", options.resumeSessionId.trim());
  }

  if (options.model?.trim()) {
    args.push("--model", options.model.trim());
  }

  // Tool scoping: OpenCode has no CLI flags for tool restriction.
  // Use a prompt prefix to instruct the model not to use certain tools.
  let promptPrefix: string | undefined;
  if (options.toolScoping) {
    const denied: string[] = [];
    const allowed: string[] = [];
    for (const [key, displayName] of Object.entries(TOOL_DISPLAY_NAMES)) {
      const value = options.toolScoping[key as keyof typeof options.toolScoping];
      if (value === true) {
        allowed.push(displayName);
      } else if (value === false) {
        // Explicitly denied — only deny when set to false, not when undefined
        denied.push(displayName);
      }
      // undefined = not restricted, don't mention in either list
    }
    // Only add prefix if some tools are denied
    if (denied.length > 0) {
      promptPrefix = `IMPORTANT: Do NOT use the following tools: ${denied.join(", ")}. Only use: ${allowed.join(", ")}.`;
    }
  }

  return {
    command: metadata.cliBinary,
    args,
    stdinPrompt: true,
    promptPrefix,
  };
}

/** Default model for dispatcher/evaluator commands (fast Sonnet-class) */
const DISPATCHER_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

/**
 * Build a CLI command optimized for dispatcher/evaluator use.
 *
 * Flags:
 * - `run` — non-interactive mode
 * - `--format json` — NDJSON output
 * - `--model <model>` — fast model (default: anthropic/claude-sonnet-4-6)
 *
 * Prompt is passed via stdin (existing OpenCode pattern).
 * Tool restriction is not natively supported by OpenCode CLI.
 */
export function buildDispatcherCommand(options: DispatcherCommandOptions): EngineCommand {
  const model = options.model?.trim() || DISPATCHER_DEFAULT_MODEL;

  const args: string[] = [
    "run",
    "--format", "json",
    "--model", model,
  ];

  return {
    command: metadata.cliBinary,
    args,
    stdinPrompt: true,
  };
}

/**
 * Build a CLI command for agent-based evaluation.
 *
 * Same as dispatcher but the prompt instructs the model to use Read/Bash/Write
 * for investigation. OpenCode has no CLI-level tool restriction, so this is
 * identical to buildDispatcherCommand — tool scoping is prompt-based.
 */
export function buildEvaluatorCommand(options: EvaluatorCommandOptions): EngineCommand {
  const model = options.model?.trim() || DISPATCHER_DEFAULT_MODEL;

  const args: string[] = [
    "run",
    "--format", "json",
    "--model", model,
  ];

  return {
    command: metadata.cliBinary,
    args,
    stdinPrompt: true,
  };
}

/**
 * Detect the model family from a model ID.
 * e.g., "anthropic/claude-opus-4-6" → "opus", "anthropic/claude-sonnet-4-5" → "sonnet"
 */
function detectFamily(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("opus"))   return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku"))  return "haiku";
  // Non-Claude models: use provider as family
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "other";
}

/**
 * Build a display name from a model ID.
 * e.g., "anthropic/claude-opus-4-6" → "Claude Opus 4.6"
 */
function toDisplayName(modelId: string): string {
  // Strip provider prefix
  const slash = modelId.indexOf("/");
  const bare = slash > 0 ? modelId.slice(slash + 1) : modelId;
  // Capitalize and clean up
  return bare
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

/**
 * Check if a model ID is an unnumbered alias (no date suffix, no version number).
 * e.g., "anthropic/claude-opus-4-6" is an alias, "anthropic/claude-opus-4-6-20250514" is not.
 */
function isUnnumberedAlias(modelId: string): boolean {
  // Dated versions have 8-digit date suffixes
  if (/\d{8}/.test(modelId)) return false;
  // "-latest" suffix models are aliases
  if (modelId.endsWith("-latest")) return true;
  // Models without dates are aliases (e.g., claude-opus-4-6, claude-sonnet-4-5)
  return true;
}

/**
 * Deduplicate models: keep only the shortest/cleanest ID per family.
 * Aliases come first, then dated versions within each family.
 */
function deduplicateModels(models: ModelInfo[]): ModelInfo[] {
  // Group by family
  const byFamily = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = byFamily.get(m.family) ?? [];
    list.push(m);
    byFamily.set(m.family, list);
  }

  const result: ModelInfo[] = [];
  for (const [, familyModels] of byFamily) {
    // Sort: aliases first, then by ID length (shorter = cleaner)
    familyModels.sort((a, b) => {
      if (a.isAlias !== b.isAlias) return a.isAlias ? -1 : 1;
      return a.id.length - b.id.length;
    });
    result.push(...familyModels);
  }

  return result;
}

/** Cache for model lists keyed by provider (avoids repeated CLI calls) */
const modelCache = new Map<string, ModelInfo[]>();

/**
 * List available models by calling `opencode models [provider]`.
 * Falls back to a hardcoded list if the CLI call fails.
 *
 * @param provider - Optional provider filter (e.g., "anthropic"). If omitted, returns all.
 */
async function listModels(provider?: string): Promise<ModelInfo[]> {
  const cacheKey = provider ?? "__all__";
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  try {
    const cmd = provider
      ? ["opencode", "models", provider]
      : ["opencode", "models"];

    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const lines = stdout.trim().split("\n").filter((l) => l.trim());
    if (lines.length === 0) throw new Error("No models returned");

    const models: ModelInfo[] = lines.map((id) => ({
      id: id.trim(),
      name: toDisplayName(id.trim()),
      family: detectFamily(id.trim()),
      isAlias: isUnnumberedAlias(id.trim()),
    }));

    const result = deduplicateModels(models);
    modelCache.set(cacheKey, result);
    return result;
  } catch {
    // Fallback: hardcoded Anthropic models
    const result = FALLBACK_MODELS;
    modelCache.set(cacheKey, result);
    return result;
  }
}

const FALLBACK_MODELS: ModelInfo[] = [
  { id: "anthropic/claude-opus-4-6",   name: "Claude Opus 4.6",   family: "opus",   isAlias: true },
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", family: "sonnet", isAlias: true },
  { id: "anthropic/claude-haiku-4-5",  name: "Claude Haiku 4.5",  family: "haiku",  isAlias: true },
];

export const opencodeEngine: Engine = { metadata, buildCommand, buildDispatcherCommand, buildEvaluatorCommand, listModels };
