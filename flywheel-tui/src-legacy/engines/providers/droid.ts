/**
 * Droid (Factory CLI) engine.
 *
 * Subprocess-based engine using `droid exec`.
 *
 * Architecture mirrors Claude's two-tier approach:
 * - Dispatcher/Evaluator: one-shot positional prompt with `--output-format
 *   stream-json` and `--enabled-tools` whitelist (fast, focused).
 * - Worker: interactive JSON-RPC mode (`--input-format stream-jsonrpc
 *   --output-format stream-jsonrpc`) with stdin pipe for multi-turn
 *   conversations and mid-turn message injection. A protocol adapter
 *   (droid-jsonrpc-adapter.ts) translates JSON-RPC ↔ flat NDJSON so the
 *   rest of Flywheel's pipeline (NDJSONParser, CompletionDetector,
 *   StructuredEventParser) works unchanged.
 *
 * Key differences from Claude:
 * - Tool names: Write→Create, Bash→Execute
 * - Completion signal: translated from `droid_working_state_changed: idle`
 *   to `{"type":"completion"}` by the JSON-RPC adapter
 * - Session init: JSON-RPC `droid.initialize_session` (not CLI flags)
 * - Permissions: --auto high (replaces --dangerously-skip-permissions)
 * - Tool scoping: --enabled-tools (whitelist) / --disabled-tools (blacklist)
 *
 * Model resolution:
 * - Factory BYOK requires custom model IDs (e.g., "custom:Opus-4.6-(Anthropic)-0")
 *   rather than built-in model names (which route through Factory billing).
 * - Custom models are read from ~/.factory/settings.json at runtime and cached.
 * - All model strings are resolved through the custom model map before being
 *   passed to --model / JSON-RPC params.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DispatcherCommandOptions,
  EvaluatorCommandOptions,
  Engine,
  EngineCommand,
  EngineCommandOptions,
  EngineMetadata,
  ModelInfo,
} from "../core/types";

export const metadata: EngineMetadata = {
  id: "droid",
  name: "Droid",
  cliBinary: "droid",
  defaultModel: "claude-opus-4-6",
  installCommand: "curl -fsSL https://app.factory.ai/cli | sh",
  description: "Factory's AI coding agent CLI",
  order: 3,
  supportsToolScoping: true,
  // Worker uses JSON-RPC mode with stdin pipe for multi-turn + mid-turn injection.
  // The droid-jsonrpc-adapter translates JSON-RPC ↔ flat NDJSON transparently.
  supportsStreamingInput: true,
};

/**
 * Map Flywheel ToolScopingConfig keys to Droid tool names.
 *
 * Droid uses different tool names from Claude:
 * - Claude "Write" → Droid "Create" (file creation/writing)
 * - Claude "Bash"  → Droid "Execute" (shell command execution)
 * - Claude "Read"  → Droid "Read"
 * - Claude "Edit"  → Droid "Edit"
 * - Claude "Task"  → Droid "Task"
 */
const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  bash: "Execute",
  write: "Create",
  edit: "Edit",
  task: "Task",
};

/** All Droid tool names that exist. Used to compute disabled set. */
const ALL_DROID_TOOLS = ["Read", "LS", "Execute", "Edit", "ApplyPatch", "Grep", "Glob", "Create", "Task"];

// ---------------------------------------------------------------------------
// Custom model discovery from ~/.factory/settings.json
// ---------------------------------------------------------------------------

interface FactoryCustomModel {
  model: string;
  id: string;
  displayName: string;
  provider: string;
}

interface FactorySettings {
  customModels?: FactoryCustomModel[];
}

/** Cached mapping from base model name → custom model ID. */
let customModelMap: Map<string, string> | undefined;
/** Cached ModelInfo[] for listModels(). */
let discoveredModels: ModelInfo[] | undefined;

const FACTORY_SETTINGS_PATH = join(homedir(), ".factory", "settings.json");

/** Family classification heuristics based on model name. */
function inferFamily(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  if (lower.includes("gpt")) return "gpt";
  if (lower.includes("gemini")) return "gemini";
  return "other";
}

/**
 * Load custom models from Factory settings (synchronous, cached).
 *
 * Reads ~/.factory/settings.json once and builds a map from base model names
 * (e.g., "claude-opus-4-6") to custom model IDs (e.g., "custom:Opus-4.6-(Anthropic)-0").
 * Also builds the ModelInfo[] list for listModels().
 *
 * Returns the map. If the file doesn't exist or is malformed, returns an empty map
 * and falls back to built-in model names (which may hit Factory billing).
 */
function loadCustomModels(): Map<string, string> {
  if (customModelMap) return customModelMap;

  customModelMap = new Map();
  discoveredModels = [];

  try {
    const raw = fs.readFileSync(FACTORY_SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw) as FactorySettings;

    if (Array.isArray(settings.customModels)) {
      for (const cm of settings.customModels) {
        if (cm.id && cm.model) {
          customModelMap.set(cm.model, cm.id);
          discoveredModels.push({
            id: cm.id,
            name: cm.displayName || cm.model,
            family: inferFamily(cm.model),
            isAlias: false,
          });
        }
      }
    }
  } catch {
    // File missing or malformed — fall through to built-in names
  }

  return customModelMap;
}

/**
 * Resolve a model string to its custom ID if one exists.
 *
 * Lookup order:
 * 1. If the model already starts with "custom:", return as-is (already resolved).
 * 2. Exact match in customModelMap (e.g., "claude-opus-4-6" → "custom:Opus-4.6-(Anthropic)-0").
 * 3. Fuzzy match by family keyword (e.g., "opus" matches the first model containing "opus").
 * 4. Fall through — return the original string unchanged.
 */
export function resolveModel(model: string): string {
  if (model.startsWith("custom:")) return model;

  const map = loadCustomModels();

  // Exact match on base model name
  const exact = map.get(model);
  if (exact) return exact;

  // Fuzzy match: user may pass "opus", "sonnet", "haiku" as shorthand
  const lower = model.toLowerCase();
  for (const [baseModel, customId] of map) {
    if (baseModel.toLowerCase().includes(lower) || lower.includes(baseModel.toLowerCase())) {
      return customId;
    }
  }

  return model;
}

export function buildCommand(options: EngineCommandOptions): EngineCommand {
  // Worker uses JSON-RPC mode for interactive multi-turn with stdin pipe.
  // The JSON-RPC adapter (droid-jsonrpc-adapter.ts) translates the protocol.
  // Session init and prompt delivery happen via JSON-RPC stdin messages,
  // not CLI flags — so we only pass the bare minimum flags here.
  const args: string[] = [
    "exec",
    "--input-format", "stream-jsonrpc",
    "--output-format", "stream-jsonrpc",
    "--auto", "high",
  ];

  // Model is passed via JSON-RPC initialize_session, but also set here
  // as a fallback / for process identification in `ps` output.
  const model = resolveModel(options.model?.trim() || metadata.defaultModel);
  args.push("--model", model);

  // Tool scoping: compute disabled tools for --disabled-tools flag.
  // Create is ALWAYS included — workers must be able to write the handoff file.
  if (options.toolScoping) {
    const allowed: string[] = [];
    for (const [key, droidName] of Object.entries(TOOL_NAME_MAP)) {
      if (options.toolScoping[key as keyof typeof options.toolScoping]) {
        allowed.push(droidName);
      }
    }
    if (!allowed.includes("Create")) {
      allowed.push("Create");
    }
    if (allowed.length > 0) {
      const disabled = ALL_DROID_TOOLS.filter(t => !allowed.includes(t));
      if (disabled.length > 0) {
        args.push("--disabled-tools", disabled.join(","));
      }
    }
  }

  return {
    command: metadata.cliBinary,
    args,
    // Prompt is delivered via JSON-RPC stdin (initialize_session + add_user_message),
    // not as a positional argument. The orchestrator writes the JSON-RPC init
    // sequence followed by the user message to the stdin pipe.
    stdinPrompt: true,
  };
}

/**
 * Build a one-shot CLI command for the dispatcher.
 *
 * Mirrors Claude's `--print --tools Write` pattern: the dispatcher's only
 * job is to write a JSON handoff file, so we whitelist only the Create tool.
 * This prevents the LLM from wandering (Skill lookups, file reads, etc.)
 * and keeps dispatcher turns fast (~5s).
 *
 * Flags:
 * - `exec` — non-interactive mode
 * - `--output-format stream-json` — NDJSON output for TUI streaming
 * - `--auto high` — non-interactive permissions
 * - `--enabled-tools Create` — ONLY file writing (handoff file)
 * - `--model <model>` — resolved custom model or engine default
 * - positional prompt — one-shot
 */
export function buildDispatcherCommand(options: DispatcherCommandOptions): EngineCommand {
  const model = resolveModel(options.model?.trim() || metadata.defaultModel);

  const args: string[] = [
    "exec",
    "--output-format", "stream-json",
    "--auto", "high",
    "--enabled-tools", "Create",
    "--model", model,
  ];

  // Droid doesn't have a --system-prompt flag, so we prepend it to the user prompt
  const fullPrompt = options.systemPrompt
    ? `${options.systemPrompt}\n\n${options.prompt}`
    : options.prompt;

  args.push(fullPrompt);

  return {
    command: metadata.cliBinary,
    args,
    stdinPrompt: false,
  };
}

/**
 * Build a one-shot CLI command for agent-based evaluation.
 *
 * Like the dispatcher but with read/investigation tools whitelisted so the
 * evaluator can check outputs, grep for files, and re-run commands.
 * No Edit/ApplyPatch — evaluators must not modify the codebase.
 *
 * Mirrors Claude's `--tools Read,Bash,Write,Grep,Glob`.
 */
export function buildEvaluatorCommand(options: EvaluatorCommandOptions): EngineCommand {
  const model = resolveModel(options.model?.trim() || metadata.defaultModel);

  const args: string[] = [
    "exec",
    "--output-format", "stream-json",
    "--auto", "high",
    "--enabled-tools", "Read,Execute,Create,Grep,Glob",
    "--model", model,
  ];

  const fullPrompt = options.systemPrompt
    ? `${options.systemPrompt}\n\n${options.prompt}`
    : options.prompt;

  args.push(fullPrompt);

  return {
    command: metadata.cliBinary,
    args,
    stdinPrompt: false,
  };
}

/**
 * Return available models for Droid.
 *
 * Reads custom models from ~/.factory/settings.json. Falls back to a static
 * list of known built-in models if the settings file is missing.
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6",    name: "Claude Opus 4.6",    family: "opus",   isAlias: true },
  { id: "claude-sonnet-4-6",  name: "Claude Sonnet 4.6",  family: "sonnet", isAlias: true },
  { id: "claude-haiku-4-5",   name: "Claude Haiku 4.5",   family: "haiku",  isAlias: true },
];

async function listModels(_provider?: string): Promise<ModelInfo[]> {
  loadCustomModels();
  return discoveredModels && discoveredModels.length > 0 ? discoveredModels : FALLBACK_MODELS;
}

export const droidEngine: Engine = { metadata, buildCommand, buildDispatcherCommand, buildEvaluatorCommand, listModels };
