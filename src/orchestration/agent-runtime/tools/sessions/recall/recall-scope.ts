import type { RecallScope } from "../../../../../protocol/transcript/conversation-recall.js";

export const normalizeRecallScope = (scope?: unknown): RecallScope =>
  typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";
