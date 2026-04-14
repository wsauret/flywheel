/**
 * Shared safety-valve truncation for DispatcherInput.
 *
 * If the serialized DispatcherInput exceeds BUDGET_TOTAL (100KB),
 * truncates `available_context` arrays to MAX_CONTEXT_ENTRIES each
 * as a last-resort size reduction.
 */

import type { DispatcherInput } from "./schemas.js";

const BUDGET_TOTAL = 102_400; // 100KB
const MAX_CONTEXT_ENTRIES = 10;

/**
 * Apply budget-aware safety-valve truncation to a DispatcherInput.
 *
 * Mutates `input.available_context` in place if the serialized size
 * exceeds 100KB. Returns whether truncation was applied.
 */
export function applyBudgetTruncation(input: DispatcherInput): boolean {
  if (byteLength(JSON.stringify(input)) <= BUDGET_TOTAL) {
    return false;
  }

  input.available_context = {
    conventions: input.available_context.conventions.slice(0, MAX_CONTEXT_ENTRIES),
    standards: input.available_context.standards.slice(0, MAX_CONTEXT_ENTRIES),
    chatHistory: input.available_context.chatHistory,
  };

  return true;
}

function byteLength(str: string): number {
  return Buffer.byteLength(str, "utf8");
}
