/**
 * Public API entrypoint for the harness module.
 *
 * External callers should import from this file rather than reaching into
 * harness internals. Internal harness files continue to import each other
 * directly.
 */

// --- agent-loop ---
export { runAgentLoop } from "./agent-loop.js";
export type { AgentLoopOptions, AgentLoopResult } from "./agent-loop.js";

// --- interactive-worker ---
export { createInteractiveWorker } from "./interactive-worker.js";
export type { InteractiveWorkerHandle, InteractiveWorkerOptions } from "./interactive-worker.js";

// --- prompts ---
export { gatherWorkspaceContext, buildSystemPrompt } from "./prompts.js";
export type { WorkspaceContext } from "./prompts.js";

// --- shared ---
export {
  createStandardTools,
  createProvider,
  sanitize,
  emitText,
  emitThinking,
  emitToolUse,
  emitToolResult,
  emitUsage,
  emitCompletion,
} from "./shared.js";

// --- tools ---
export { ensureRipgrepAddon } from "./tools/ripgrep-build.js";
export { createToolRegistry } from "./tools/registry.js";
export type { HarnessTool, ToolContext, ToolResult } from "./tools/types.js";

// --- llm ---
export type { LLMProvider, StreamEvent, StreamOptions, ToolDefinition, UsageInfo } from "./llm.js";
