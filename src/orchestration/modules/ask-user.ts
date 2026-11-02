import { ASK_USER_TOOL_DEFINITION, createAskUserTool, type AskUserToolDeps } from "../agent-runtime/tools/ask-user.js"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import type { FirstPartyModule } from "../modules.js"

const askUser = {
  category: "opt-in",
  action: "ask_user",
  cloneInheritance: "reconstruct",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: false,
  registryOrder: 14,
  registrations: {
    ask_user: {
      capabilities: [],
      create: ({ kernel, modules }) => {
        const controller = kernel.askUser
        if (!controller) return { unusable: { tool: ASK_USER_TOOL_DEFINITION, reason: "no ask-user controller available" } }
        return {
          tool: createAskUserTool(controller, {}),
          // The decisions ask_user advertises belong to the tools that carry them,
          // so they are settled against the planned set, never the wired one.
          refine: (planned) => {
            const bindings: AskUserToolDeps = {}
            for (const contribution of kernel.moduleSnapshot.contributions) {
              if (contribution.domain !== "questionDecisions" || !planned.has(contribution.value.tool)) continue
              const decisions = contribution.value.create({ kernel, modules })
              for (const key of Object.keys(decisions)) {
                if (Object.hasOwn(bindings, key)) throw new Error(`Multiple modules provide the ${key} question decision`)
              }
              Object.assign(bindings, decisions)
            }
            return { tool: createAskUserTool(controller, bindings) }
          },
        }
      },
    },
  },
} as const satisfies ToolDeclaration

export const askUserModule = {
  id: "ask-user",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "tools", id: "ask_user", value: { kind: "tool", name: "ask_user", declaration: askUser } },
    // The kernel identity section says "ask the person" and names no module
    // tool. Only a root chat plans ask_user (PI-AGENT-024), so this line
    // reaches only the session a waiting child depends on.
    { domain: "promptFragments", id: "ask-user-root", value: {
      order: 0,
      render: ({ tools }) => tools.has("ask_user")
        ? "# Asking the person\n\nWhen a child waits on you for a choice that belongs to the person, ask the person with ask_user, then reply to the child with message_session."
        : undefined,
    } },
    { domain: "settings", id: "ask-user", value: { control: "binary", group: "Tools", label: "Ask user", description: "Allow agents to ask you structured questions" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
