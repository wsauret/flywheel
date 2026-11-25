import { Schema } from "effect";

/** Semantic tool outcomes that can refine a completed row beyond its requested action. */
export const ToolResultActionSchema = Schema.Literals([
  "created",
  "updated",
  "patched",
  "support_file",
  "file_removed",
  "archived",
  "restored",
  "promoted",
  "recommended",
]);

export type ToolResultAction = typeof ToolResultActionSchema.Type;
