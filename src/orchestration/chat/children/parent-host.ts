import { NO_MODULE_RUNTIMES, type ModuleRuntimes } from "../../../infra/definitions/modules/module-runtime.js"
import type { AsyncEventStateReadSurface } from "../../../infra/substrate/store/event-store-types.js"
import type { SessionMetadataReader } from "../../session/metadata/schemas.js"
import type { BackgroundWorkTracking } from "../../session/control/background-work/background-work.js"
import { liveChildRun, liveWorkflowControl } from "../../session/control/live-session-control.js"
import type { SessionStore } from "../../session-store/types.js"
import type { ChatRunner } from "../runner-types.js"

/** The assembled parent host that owns child execution and tracking. */
interface ParentHost {
  modules(): Promise<ModuleRuntimes>
  readonly backgroundTasks: BackgroundWorkTracking | undefined
}

/** Resolves a child's parent host, attaching a chat idle without starting a turn.
 *  A subagent must already have a live host. An agent of a workflow is waited
 *  for while its workflow runs it, because a successor resumes the agent's
 *  children as the workflow's resume assembles the agent again. */
export async function parentHost(deps: {
  readonly manager: SessionMetadataReader
  readonly sessionStore: SessionStore
  readonly eventReader: AsyncEventStateReadSurface
  readonly openChatRunner?: (sessionId: string) => Promise<ChatRunner | undefined>
}, parentSessionId: string, conversationId: string | undefined): Promise<ParentHost | undefined> {
  const parent = await deps.manager.read(parentSessionId)
  if (parent?.kind === "subagent") {
    const child = liveChildRun(deps.eventReader, parentSessionId)?.child
    const modules = await child?.modules()
    return modules && child ? { modules: async () => modules, backgroundTasks: child.backgroundTasks } : undefined
  }
  const entry = deps.sessionStore.get(parentSessionId)
  if (parent?.kind === "workflow-agent") {
    if (conversationId !== undefined && parent.conversationId !== conversationId) return undefined
    const member = await liveWorkflowControl(deps.eventReader, parent.workflowMembership.workflowId)?.memberHost(parent.conversationId)
    return member ? { modules: async () => member.modules, backgroundTasks: member.backgroundTasks } : undefined
  }
  if (parent?.kind !== "chat") return undefined
  const runner = (entry?.kind === "chat" ? entry.runner : undefined) ?? await deps.openChatRunner?.(parentSessionId)
  if (!runner) return undefined
  return {
    modules: async () => runner.moduleRuntimes && runner.moduleRuntimes !== NO_MODULE_RUNTIMES ? runner.moduleRuntimes : await runner.hold(),
    backgroundTasks: runner.backgroundTasks,
  }
}
