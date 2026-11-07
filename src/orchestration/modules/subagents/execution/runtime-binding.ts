import { moduleRuntimeHandle } from "../../../../infra/module-runtime.js"
import type { ServingModel } from "../../../agent-runtime/tools/kernel-tool-deps.js"
import type { DefinitionAvailabilitySnapshot } from "../../../app-service/definition-availability.js"
import type { SubagentDispatchDeps } from "./dispatch-deps.js"
import type { SubagentResult } from "./control-actions.js"

type ChildServingAdmission = Pick<SubagentDispatchDeps,
  "createRunner" | "modelInfos" | "modelsClient" |
  "usageProfile" | "authProfileId" | "captureRuntimeConfig" | "captureProviderConnection" | "awaitModelAccessSettled" | "resolveRoles" | "moduleSelection">

/** The dispatch and completion ports of one attached conversation. */
export interface SubagentsRuntime {
  readonly conversationId: string
  /** The dispatch dependencies of one request: the model it serves and the
   *  definition availability of its live selection. */
  readonly toolDeps: (serving: ServingModel, definitionAvailability: DefinitionAvailabilitySnapshot) => SubagentDispatchDeps
  resume(childSessionId: string, admission: ChildServingAdmission): Promise<SubagentResult>
}

export const subagentsRuntime = moduleRuntimeHandle<SubagentsRuntime>("subagents")
