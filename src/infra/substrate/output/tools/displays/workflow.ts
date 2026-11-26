import { workflowDetail } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

export const workflowDisplay: ToolDisplay = {
  name: "workflow",
  action: "ui_meta",
  displayName: "Workflow",
  verbs: { progressive: "Running workflow", past: "Ran workflow" },
  isOptimistic: false,
  streamingInput: {
    bodyFields: {},
    presentationFields: ["source", "workflow_display_name", "summary", "task_summary"],
  },
  rendersAsAgentBlock: true,
  getDetail: workflowDetail,
};
