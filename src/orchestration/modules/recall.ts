import { createRecallTool, RECALL_TOOL_DEFINITION } from "../agent-runtime/tools/sessions/recall.js"
import type { ToolDeclaration } from "../module-contract/module-seams.js"
import type { FirstPartyModule } from "../module-contract/module-catalog.js"

const recall = {
  category: "opt-in",
  action: "ui_meta",
  cloneInheritance: "reconstruct",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: false,
  registryOrder: 11,
  registrations: {
    recall: {
      capabilities: [],
      create: ({ kernel }) => kernel.recall ? { tool: createRecallTool(kernel.recall) } : { unusable: { tool: RECALL_TOOL_DEFINITION, reason: "no conversation history available" } },
    },
  },
} as const satisfies ToolDeclaration

export const recallModule = {
  id: "recall",
  dependencies: [],
  contributions: [
    { domain: "tools", id: "recall", value: { kind: "tool", name: "recall", declaration: recall } },
    { domain: "settings", id: "recall", value: { control: "binary", group: "Tools", label: "Recall", description: "Allow agents to recall earlier conversation context" } },
  ],
} as const satisfies FirstPartyModule
