import { ASK_USER_TOOL_DEFINITION, createAskUserTool, type AskUserToolDeps } from "../agent-runtime/tools/sessions/ask-user.js"
import type { ToolDeclaration } from "../module-seams.js"
import type { FirstPartyModule } from "../module-catalog.js"

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
      capabilities: ["ask-user"],
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
  attended: true,
  contributions: [
    { domain: "tools", id: "ask_user", value: { kind: "tool", name: "ask_user", declaration: askUser } },
    { domain: "settings", id: "ask-user", value: { control: "binary", group: "Tools", label: "Ask user", description: "Allow agents to ask you structured questions" } },
  ],
} as const satisfies FirstPartyModule
