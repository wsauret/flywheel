import type { DispatcherInput } from "./schemas.js";

const BUDGET_TOTAL = 102_400;
const MAX_CONTEXT_ENTRIES = 10;

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
