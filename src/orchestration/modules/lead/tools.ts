import type { ToolDeclaration, ToolFactoryResult } from "../../agent-runtime/tools/tool-registry.js"
import type { KernelToolDeps } from "../../agent-runtime/tools/kernel-tool-deps.js"
import { CHAT_PROGRESS_TOOL_NAME } from "./chat-progress.js"
import { ROUTE_REQUEST_TOOL_NAME } from "./route-request.js"
import { leadRuntime, type LeadRuntime } from "./runtime.js"

/** Every tool that the lead chat has, and the only list of them (ARCH-STRUCTURE-045). The lead's chat profile offers
 *  exactly these names, so a tool joins the lead by one added name here, such as `bash`. `message_session` and
 *  `list_sessions` are here because every session keeps them (ARCH-STRUCTURE-039), and the checkpoint tools because
 *  an always-on chat compacts (PI-AGENT-089). */
export const LEAD_TOOLS: readonly string[] = [
  ROUTE_REQUEST_TOOL_NAME,
  CHAT_PROGRESS_TOOL_NAME,
  "read",
  "search",
  "list",
  "web",
  "ask_user",
  "checkpoint_read",
  "checkpoint_replace",
  "checkpoint_decide",
  "message_session",
  "list_sessions",
]

const NOT_THE_LEAD = "only the lead chat has this tool"

/** A tool of the lead chat: every other chat omits it. */
function leadTool(name: string, registryOrder: number, build: (runtime: LeadRuntime, kernel: KernelToolDeps) => ToolFactoryResult): ToolDeclaration {
  return {
    category: "ambient",
    action: "ui_meta",
    cloneInheritance: "reconstruct",
    learningReviewExecutable: false,
    semanticBundle: null,
    personaBaseline: false,
    registryOrder,
    registrations: {
      [name]: {
        capabilities: [],
        create: ({ kernel, modules }) => {
          const runtime = modules.get(leadRuntime)
          return runtime?.role() === "lead" ? build(runtime, kernel) : { reason: NOT_THE_LEAD }
        },
      },
    },
  }
}

export const routeRequestDeclaration = leadTool(ROUTE_REQUEST_TOOL_NAME, 95, (runtime, kernel) => kernel.sessions
  ? { tool: runtime.routeRequest(kernel.sessions) }
  : { reason: "no session messaging available" })

export const chatProgressDeclaration = leadTool(CHAT_PROGRESS_TOOL_NAME, 96, (runtime) => ({ tool: runtime.chatProgress }))
