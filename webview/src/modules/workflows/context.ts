import { createContext, useContext } from "solid-js"
import type { WorkflowPlace, WorkflowAgentViewTarget } from "./navigation.js"
import type { WorkflowInspectionSubscription, WorkflowReading } from "./inspection.js"
import type { WebModuleClientHost } from "../../web-module-client.js"
import type { WorkflowCardChoices } from "../../../../src/protocol/client/workflow-card.js"
import type { WorkflowSurface } from "../../../../src/protocol/client/workflow-surface.js"

export interface WorkflowsClient {
  choices(key: string): WorkflowCardChoices | undefined
  choose(key: string, choices: WorkflowCardChoices): void
  readonly host: WebModuleClientHost
  readonly subscribe: (workflowId: string, notify: (reading: WorkflowReading) => void, surface?: WorkflowSurface) => WorkflowInspectionSubscription
  readonly open: (workflowId: string, target?: WorkflowAgentViewTarget) => void
  readonly place: () => WorkflowPlace | undefined
  readonly control: (workflowId: string, kind: "interrupt" | "resume" | "restart" | "stop") => void
}
const Context = createContext<WorkflowsClient>()
export const WorkflowsProvider = Context.Provider
export function useWorkflows() {
  const value = useContext(Context)
  if (!value) throw new Error("Workflows client is not mounted")
  return value
}
