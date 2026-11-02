import { singleLine, strField, type ToolInput } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

function stepDetail(input: ToolInput, _executionCwd: string): string | null {
  const stepId = strField(input, "step_id");
  if (!stepId) return null;
  const args = strField(input, "arguments");
  const preview = args ? singleLine(args) : null;
  const shortPreview = preview && preview.length > 60 ? `${preview.slice(0, 59)}…` : preview;
  return shortPreview ? `${stepId} — ${shortPreview}` : stepId;
}

export const stepDisplay: ToolDisplay = {
  name: "step",
  action: "ui_meta",
  displayName: "Step",
  verbs: { progressive: "Loading step", past: "Loaded step" },
  isOptimistic: false,
  getDetail: stepDetail,
};
