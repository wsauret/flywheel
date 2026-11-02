import { strField, type ToolInput } from "../detail-helpers.js";
import { normalizeMemoryTitle } from "../memory-title.js";
import type { ToolDisplay, ToolPresentation } from "../types.js";


/** The one action a whole batch shares, or undefined when the batch mixes actions. */
function batchAction(operations: readonly unknown[]): string | undefined {
  const actions = operations.map((operation) => {
    if (typeof operation !== "object" || operation === null || !("action" in operation)) return undefined;
    return typeof operation.action === "string" ? operation.action : undefined;
  });
  return actions.length > 0 && actions.every((candidate) => candidate === actions[0]) ? actions[0] : undefined;
}

/** The action and count a call describes: a batch speaks for its operations, a
 *  bare call for its single action. */
function memoryScope(input: ToolInput) {
  const operations = Array.isArray(input.operations) ? input.operations : null;
  if (!operations || operations.length === 0) return { action: strField(input, "action"), plural: false };
  return { action: batchAction(operations), plural: operations.length !== 1 };
}

const PRESENTATION_VERBS = {
  add: "Add",
  replace: "Replace",
  remove: "Remove",
};

/** Memory has one operation family, so every call names an operation: an
 *  unrecognized action is a change to memory whose title still reads. */
function memoryPresentation(input: ToolInput): ToolPresentation {
  const { action, plural } = memoryScope(input);
  const verb = action === "add" ? PRESENTATION_VERBS.add
    : action === "replace" ? PRESENTATION_VERBS.replace
      : action === "remove" ? PRESENTATION_VERBS.remove
        : "Change";
  return {
    name: `${verb} ${plural ? "Memories" : "Memory"}`,
    detail: normalizeMemoryTitle(input.title) ?? "",
  };
}

export const memoryDisplay: ToolDisplay = {
  name: "memory",
  action: "ui_meta",
  displayName: "Update memory",
  verbs: { progressive: "Changing memory", past: "Changed memory" },
  isOptimistic: false,
  getPresentation: memoryPresentation,
};