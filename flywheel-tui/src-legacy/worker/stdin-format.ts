import { buildAddUserMessage } from "./droid-jsonrpc-adapter.js";

/**
 * Format a message for Claude's --input-format stream-json mode.
 * Claude expects NDJSON lines with type "user" and a message object.
 */
export function formatClaudeStdinMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/**
 * Format a message for Droid's --input-format stream-jsonrpc mode.
 * Droid expects JSON-RPC 2.0 `droid.add_user_message` requests.
 */
export function formatDroidStdinMessage(text: string): string {
  return buildAddUserMessage(text);
}

/**
 * Engine-aware stdin message formatter.
 *
 * Routes to the correct format based on engine ID. Engines that support
 * streaming input (`supportsStreamingInput: true`) use this to wrap
 * user messages for mid-turn injection and initial prompt delivery.
 */
export function formatStdinMessage(engineId: string, text: string): string {
  if (engineId === "droid") return formatDroidStdinMessage(text);
  return formatClaudeStdinMessage(text);
}
