import { moduleServiceHandle } from "../../../../infra/module-service.js"
import { errorMessage } from "../../../../infra/error-message.js"
import type { ModuleProcessServices } from "../../../app-service/module-service-host.js"
import { readSubagentRuns } from "../history/subagent-run-projection.js"
import type { SubagentResult } from "./control-actions.js"
import { parentHost } from "../../../session/live-session-control.js"
import { subagentsRuntime } from "./runtime-binding.js"

export interface SubagentContinuationService {
  resume(childSessionId: string): Promise<SubagentResult>
  /** The process-service contract requires disposal; this resolver holds no resources. */
  dispose(): void
}

export const subagentContinuationService = moduleServiceHandle<SubagentContinuationService>("subagents")

type ContinuationServices = Pick<ModuleProcessServices, "executionEnvironment" | "sessionManager" | "sessionStore" | "eventStore" | "projectionReader" | "directories" | "enabled">

/** Reattaches a child to its parent's live host without starting a parent turn. */
export function createSubagentContinuationService(services: ContinuationServices): SubagentContinuationService {
  return {
    dispose() {},
    async resume(childSessionId) {
      if (!services.enabled()) return { outcome: "error", content: "Subagent execution is unavailable" }
      try {
        const child = await services.sessionManager.read(childSessionId)
        if (child?.kind !== "subagent") return { outcome: "error", content: "Subagent session was not found" }
        const run = (await readSubagentRuns(services.projectionReader, childSessionId)).at(-1)
        if (!run?.parentSessionId || !run.parentConversationId) return { outcome: "error", content: "Subagent recorded execution context is incomplete" }
        const host = await parentHost({
          manager: services.sessionManager, sessionStore: services.sessionStore, eventReader: services.eventStore,
          openChatRunner: (id) => services.executionEnvironment().openChatRunner(id),
        }, run.parentSessionId, run.parentConversationId)
        const runtime = (await host?.modules())?.get(subagentsRuntime)
        if (!runtime || runtime.conversationId !== run.parentConversationId) return {
          outcome: "error", content: `Resume parent '${run.parentSessionId}' first: the child's parent host is not running.`,
        }
        const environment = services.executionEnvironment()
        const initial = (await environment.authAdmission.admit(childSessionId)).workflowDeps
        const { bindWorkflowDepsToSession } = await import("../../../workflow-host/deps.js")
        const deps = bindWorkflowDepsToSession(initial, {
          capture: async () => (await environment.authAdmission.admit(childSessionId)).workflowDeps,
          current: () => environment.authAdmission.current(childSessionId).workflowDeps,
        })
        const { createSessionRoleResolver } = await import("../../../config/session-role-resolver.js")
        const resolveRoles = createSessionRoleResolver({ reader: services.projectionReader, projectRoot: services.directories.projectRoot, sessionId: childSessionId, userDataRoot: deps.userDataRoot, capture: deps.captureProviderConnection })
        return runtime.resume(childSessionId, {
          createRunner: deps.createAgent,
          modelInfos: deps.modelInfos, modelsClient: deps.modelsClient,
          usageProfile: deps.usageProfile, authProfileId: deps.activeProfileId ?? "default",
          captureRuntimeConfig: deps.captureRuntimeConfig,
          captureProviderConnection: deps.captureProviderConnection,
          awaitModelAccessSettled: deps.awaitModelAccessSettled,
          resolveRoles,
          moduleSelection: deps.moduleSelection,
        })
      } catch (error) {
        return { outcome: "error", content: `Subagent resume was not admitted: ${errorMessage(error)}` }
      }
    },
  }
}
