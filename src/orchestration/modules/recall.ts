import { createRecallTool, RECALL_TOOL_DEFINITION } from "../agent-runtime/tools/recall.js"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import type { FirstPartyModule } from "../modules.js"

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
  availability: { kind: "available" },
  contributions: [
    { domain: "tools", id: "recall", value: { kind: "tool", name: "recall", declaration: recall } },
    { domain: "settings", id: "recall", value: { control: "binary", group: "Tools", label: "Recall", description: "Allow agents to recall earlier conversation context" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
