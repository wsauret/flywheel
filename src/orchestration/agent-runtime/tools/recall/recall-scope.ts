import type { RecallScope } from "../../../../protocol/conversation-recall.js";

export const normalizeRecallScope = (scope?: unknown): RecallScope =>
  typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";
