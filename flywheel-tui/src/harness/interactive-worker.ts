/**
 * InteractiveWorker — persistent multi-turn chat using executeTurn() directly.
 *
 * Unlike HarnessSpawner which creates a fresh agent loop per step and expects
 * task_complete, the InteractiveWorker manages its own message history array
 * and calls executeTurn() per user message to support multi-turn conversation.
 *
 * Key design:
 * - Builds its own turn loop around executeTurn() with persistent message history
 * - Does NOT include the task_complete tool — conversation continues until shutdown
 * - Uses a serial queue (mutex) to prevent concurrent turns from corrupting history
 * - Includes DoomLoopDetector per-message with maxTurnsPerMessage limit
 * - Emits NDJSON-compatible events via onStdout callback
 * - Supports AbortSignal for graceful shutdown
 */

import * as fs from "node:fs";
import type {
  LLMProvider,
  Message,
  StreamOptions,
  ToolDefinition,
  UsageInfo,
  AssistantMessage,
  TextContent,
  ToolCallContent,
  ToolResultContent,
  ToolResultMessage,
  UserMessage,
} from "./llm.js";
import type { ToolContext } from "./tools/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import { createToolRegistry } from "./tools/registry.js";
import { normalizeTools } from "./intent-trace.js";
import { DoomLoopDetector, extractToolSignature } from "./doom-loop.js";
import { estimateTokens } from "./context.js";
import { truncateHistory } from "./agent-loop.js";
import {
  executeTurn,
  type CollectedToolCall,
  type ToolCallResult,
  type TurnResult,
} from "./turn-executor.js";
import {
  createChatTools,
  createProvider,
  buildWorkspaceSystemPrompt,
  emitText,
  emitThinking,
  emitToolUse,
  emitToolResult,
  emitUsage,
  emitCompletion,
} from "./shared.js";
import { loadConfig } from "../config/loader.js";
import { CONFIG_FILES } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InteractiveWorkerOptions {
  /** Model override. If not provided, resolved from config via loadConfig(). */
  model?: string;
  /** API key override. If not provided, uses ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Max tokens per LLM response. Default: 16384. */
  maxTokens?: number;
  /** Max turns per sendMessage call before aborting. Default: 25. */
  maxTurnsPerMessage?: number;
  /** Working directory for tool execution. */
  cwd?: string;
  /** Environment variables for tool execution. */
  env?: Record<string, string>;
  /** AbortSignal for graceful shutdown. */
  abortSignal?: AbortSignal;
  /** NDJSON event callback — compatible with OpenTUIAdapter pipeline. */
  onStdout?: (chunk: string) => void;
  /** Custom system prompt instructions appended to the default. */
  customInstructions?: string;
}

export interface InteractiveWorkerHandle {
  /** Send a user message and trigger agent turns until the agent responds. */
  sendMessage(text: string): Promise<void>;
  /** Abort current turn and shut down the worker. */
  shutdown(): void;
  /** Whether the worker is currently processing a message. */
  isRunning(): boolean;
  /** Returns a summary of the last 5 user messages, capped at ~2000 tokens. */
  getConversationSummary(): string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_MAX_TURNS_PER_MESSAGE = 25;
const DEFAULT_MODEL = "claude-sonnet-4-6";
const SUMMARY_MAX_MESSAGES = 5;
const SUMMARY_MAX_TOKENS = 2000;
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build assistant message from turn results for conversation history. */
function buildAssistantMessage(turn: TurnResult): AssistantMessage {
  const content: (TextContent | ToolCallContent)[] = [];

  if (turn.textContent) {
    content.push({ type: "text", text: turn.textContent });
  }

  for (const call of turn.toolCalls) {
    content.push({
      type: "tool_call",
      id: call.id,
      name: call.name,
      arguments: call.input,
    });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return { role: "assistant", content };
}

/** Build tool result message from turn results for conversation history. */
function buildToolResultMessage(results: ToolCallResult[]): ToolResultMessage {
  const content: ToolResultContent[] = results.map((r) => ({
    type: "tool_result" as const,
    tool_use_id: r.toolCallId,
    content: r.content,
    is_error: r.isError || undefined,
  }));
  return { role: "tool_result", content };
}

// ---------------------------------------------------------------------------
// Serial queue (mutex) for preventing concurrent turns
// ---------------------------------------------------------------------------

function createMutex(): { acquire(): Promise<() => void> } {
  let chain = Promise.resolve();

  return {
    acquire(): Promise<() => void> {
      let release: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prev = chain;
      chain = next;
      return prev.then(() => release!);
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Resolve model from config via loadConfig(). */
function resolveModel(modelOverride?: string): string {
  if (modelOverride) return modelOverride;

  try {
    const configPath = CONFIG_FILES.find((p) => fs.existsSync(p));
    const { config } = loadConfig(configPath);
    return config.worker.model ?? config.model ?? DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

/**
 * Create an interactive worker for persistent multi-turn chat.
 *
 * Uses executeTurn() directly with its own message history — not runAgentLoop().
 * Validates ANTHROPIC_API_KEY at creation time.
 */
export function createInteractiveWorker(
  options: InteractiveWorkerOptions = {},
): InteractiveWorkerHandle {
  // Resolve and validate API key
  const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Set the ANTHROPIC_API_KEY environment variable " +
      "or pass apiKey in options to use the interactive worker. " +
      "Callers can fall back to a different engine when this error is thrown.",
    );
  }

  // Resolve model from config
  const model = resolveModel(options.model);
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxTurnsPerMessage = options.maxTurnsPerMessage ?? DEFAULT_MAX_TURNS_PER_MESSAGE;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? {};
  const onStdout = options.onStdout;

  // Create provider and tools (no task_complete)
  const provider: LLMProvider = createProvider(apiKey);
  const tools = createChatTools();
  const registry: ToolRegistry = createToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  const toolDefs = normalizeTools(
    registry.toLLMDefinitions() as ToolDefinition[],
  );

  // Persistent state
  const messages: Message[] = [];
  let systemPrompt: string | null = null;
  let running = false;
  const mutex = createMutex();

  // AbortController for shutdown
  const shutdownController = new AbortController();

  // Wire external abort signal
  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      shutdownController.abort();
    } else {
      options.abortSignal.addEventListener("abort", () => {
        shutdownController.abort();
      }, { once: true });
    }
  }

  // Tool context
  const toolContext: ToolContext = {
    cwd,
    env,
    get abortSignal() { return shutdownController.signal; },
  };

  /** Lazy-initialize the system prompt. */
  async function ensureSystemPrompt(): Promise<string> {
    if (systemPrompt === null) {
      systemPrompt = await buildWorkspaceSystemPrompt(options.customInstructions);
    }
    return systemPrompt;
  }

  /** Run agent turns for a single user message until the agent produces a text response. */
  async function runTurns(): Promise<void> {
    const prompt = await ensureSystemPrompt();
    const doomDetector = new DoomLoopDetector();

    for (let turn = 0; turn < maxTurnsPerMessage; turn++) {
      if (shutdownController.signal.aborted) return;

      const streamOptions: StreamOptions = {
        model,
        system: prompt,
        messages: [...messages],
        tools: toolDefs,
        maxTokens,
        abortSignal: shutdownController.signal,
      };

      let turnResult: TurnResult;

      try {
        turnResult = await executeTurn({
          provider,
          registry,
          streamOptions,
          toolContext,
          onTextDelta: (text) => emitText(onStdout, text),
          onThinking: (thinking) => emitThinking(onStdout, thinking),
          onToolUse: (call) => emitToolUse(onStdout, call),
          onToolResult: (result) => emitToolResult(onStdout, result),
        });
      } catch (err) {
        // On context overflow, truncate and retry once
        if (isContextLengthError(err) && messages.length > 4) {
          messages.splice(0, messages.length, ...truncateHistory(messages));
          continue;
        }
        throw err;
      }

      // Emit usage
      if (turnResult.usage) {
        emitUsage(onStdout, turnResult.usage);
      }

      // Add assistant response to history
      messages.push(buildAssistantMessage(turnResult));
      if (turnResult.toolResults.length > 0) {
        messages.push(buildToolResultMessage(turnResult.toolResults));
      }

      // If agent made tool calls, record in doom detector and continue
      if (turnResult.toolCalls.length > 0) {
        for (const call of turnResult.toolCalls) {
          const sig = extractToolSignature(call.name, call.input);
          doomDetector.recordToolCall(call.name, sig);
        }

        const warning = doomDetector.getWarning();
        if (warning) {
          // Break the doom loop — inject warning and stop
          messages.push({
            role: "user",
            content: `[System: ${warning} Stopping automatic tool execution.]`,
          } satisfies UserMessage);
          return;
        }

        // Agent used tools but no text — continue to get a response
        continue;
      }

      // Agent produced a text response with no tool calls — done
      emitCompletion(onStdout);
      return;
    }

    // Exceeded max turns per message — doom loop protection
    messages.push({
      role: "user",
      content: `[System: Maximum of ${maxTurnsPerMessage} turns per message reached. Stopping automatic tool execution.]`,
    } satisfies UserMessage);
  }

  // Handle interface
  const handle: InteractiveWorkerHandle = {
    async sendMessage(text: string): Promise<void> {
      if (shutdownController.signal.aborted) {
        throw new Error("InteractiveWorker has been shut down");
      }

      const release = await mutex.acquire();
      running = true;
      try {
        messages.push({ role: "user", content: text } satisfies UserMessage);
        await runTurns();
      } finally {
        running = false;
        release();
      }
    },

    shutdown(): void {
      shutdownController.abort();
    },

    isRunning(): boolean {
      return running;
    },

    getConversationSummary(): string {
      const userMessages: string[] = [];
      for (const msg of messages) {
        if (msg.role === "user") {
          const text = typeof msg.content === "string"
            ? msg.content
            : msg.content.map((c) => ("text" in c ? c.text : "")).join("");

          // Skip system-injected messages
          if (text.startsWith("[System:")) continue;

          userMessages.push(text);
        }
      }

      // Take last N user messages
      const recent = userMessages.slice(-SUMMARY_MAX_MESSAGES);

      // Cap at ~2000 tokens
      const maxChars = SUMMARY_MAX_TOKENS * CHARS_PER_TOKEN;
      let totalChars = 0;
      const capped: string[] = [];

      for (let i = recent.length - 1; i >= 0; i--) {
        const msg = recent[i]!;
        if (totalChars + msg.length > maxChars && capped.length > 0) break;
        capped.unshift(msg);
        totalChars += msg.length;
      }

      return capped.join("\n\n");
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Error detection (local copy to avoid circular dependency with agent-loop)
// ---------------------------------------------------------------------------

function isContextLengthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /context.*(length|limit|window).*exceed/i.test(msg)
    || /too many tokens/i.test(msg)
    || /maximum context length/i.test(msg);
}