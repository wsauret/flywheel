import type { RuntimeTool } from "../agent-runtime/tools/types.js"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import { applyPatchDefinition } from "../agent-runtime/tools/apply-patch.js"
import { editDefinition } from "../agent-runtime/tools/edit.js"
import { readDefinition, wholeFileReadDefinition } from "../agent-runtime/tools/read.js"
import { writeDefinition } from "../agent-runtime/tools/write.js"
import type { FirstPartyModule } from "../modules.js"

function policy(tool: RuntimeTool, order: number): Omit<ToolDeclaration, "registrations"> {
  return {
    category: "core",
    action: tool.action,
    cloneInheritance: "inherit",
    learningReviewExecutable: false,
    semanticBundle: "file-media",
    personaBaseline: true,
    personaOrder: order,
    registryOrder: order,
  }
}

function declaration(tool: RuntimeTool, order: number): ToolDeclaration {
  return { ...policy(tool, order), registrations: { [tool.name]: { capabilities: [], create: () => ({ tool }) } } }
}

/** One file edit tool. The serving model's interaction profile selects the
 *  string edit or the `apply_patch` registration. */
const edit = {
  ...policy(editDefinition, 1),
  registrations: {
    [editDefinition.name]: { capabilities: [], interactionContract: "file-edit:edit", create: () => ({ tool: editDefinition }) },
    [applyPatchDefinition.name]: { capabilities: [], interactionContract: "file-edit:apply_patch", create: () => ({ tool: applyPatchDefinition }) },
  },
} satisfies ToolDeclaration

/** An agent of a workflow reads whole files, so the evidence for its handoff is the code itself. Every other agent
 *  reads a large code file as its structural summary. The request's purpose
 *  is the one place that knows the agent kind, so the read tool takes no
 *  input for it, and both behaviors advertise one description: every agent
 *  of a chat tree shares one engine host, which fixes the tool bytes at
 *  launch (ARCH-CONTEXT-018). */
const read = {
  ...policy(readDefinition, 3),
  registrations: {
    [readDefinition.name]: {
      capabilities: [],
      create: ({ kernel }) => ({ tool: kernel.purpose.kind === "workflow-agent" ? wholeFileReadDefinition : readDefinition }),
    },
  },
} satisfies ToolDeclaration

export const fileToolsModule = {
  id: "file-tools",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "tools" as const, id: editDefinition.name, value: { kind: "tool" as const, name: editDefinition.name, declaration: edit } },
    { domain: "tools" as const, id: readDefinition.name, value: { kind: "tool" as const, name: readDefinition.name, declaration: read } },
    { domain: "tools" as const, id: writeDefinition.name, value: { kind: "tool" as const, name: writeDefinition.name, declaration: declaration(writeDefinition, 6) } },
    { domain: "settings", id: "file-tools", value: { control: "binary", group: "Tools", label: "File tools", description: "Disabling File tools removes model file access." } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
