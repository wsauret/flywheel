import type { RuntimeTool } from "../agent-runtime/tools/types.js"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import { listDefinition } from "../agent-runtime/tools/list.js"
import { searchDefinition } from "../agent-runtime/tools/search.js"
import type { FirstPartyModule } from "../modules.js"

function declaration(tool: RuntimeTool, order: number): ToolDeclaration {
  return {
    category: "core",
    action: tool.action,
    cloneInheritance: "inherit",
    learningReviewExecutable: false,
    semanticBundle: "file-media",
    personaBaseline: true,
    personaOrder: order,
    registryOrder: order,
    registrations: { [tool.name]: { capabilities: [], create: () => ({ tool }) } },
  }
}

export const discoveryModule = {
  id: "discovery",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "tools", id: "list", value: { kind: "tool", name: "list", declaration: declaration(listDefinition, 2) } },
    { domain: "tools", id: "search", value: { kind: "tool", name: "search", declaration: declaration(searchDefinition, 5) } },
    { domain: "settings", id: "discovery", value: { control: "binary", group: "Tools", label: "Discovery", description: "Allow agents to search file contents and list paths" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
