import type { RuntimeTool } from "../agent-runtime/tools/types.js"
import type { ToolDeclaration } from "../module-seams.js"
import { listDefinition } from "../agent-runtime/tools/search/list.js"
import { searchDefinition } from "../agent-runtime/tools/search/search.js"
import type { FirstPartyModule } from "../modules.js"

/** `summary` gives the tool a short form on an unattended tree, whose agents rarely call it (ARCH-CONTEXT-038). */
function declaration(tool: RuntimeTool, order: number, summary?: string): ToolDeclaration {
  return {
    ...summary === undefined ? {} : { shortForm: { trees: "unattended", summary } },
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
  contributions: [
    { domain: "tools", id: "list", value: { kind: "tool", name: "list", declaration: declaration(listDefinition, 2, "List file and directory paths, shallow or by glob pattern.") } },
    { domain: "tools", id: "search", value: { kind: "tool", name: "search", declaration: declaration(searchDefinition, 5, "Search file contents with ripgrep regex or literal patterns.") } },
    { domain: "settings", id: "discovery", value: { control: "binary", group: "Tools", label: "Discovery", description: "Allow agents to search file contents and list paths" } },
  ],
} as const satisfies FirstPartyModule
