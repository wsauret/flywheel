import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import { mountAgentGroup } from "../../app/render-ownership-fixture.js"
import { fakeWebModuleHost } from "../../app/client-context-fixture.js"
import type { WebModuleClient } from "../../web-module-client.js"
import { WorkflowsProvider, type WorkflowsClient } from "./context.js"
import { WorkflowActivity } from "./activity.js"
import { createSignal } from "solid-js"
import type { WorkflowCardChoices } from "../../../../src/protocol/client/workflow-card.js"

/** Mounts module activity through the same extension slot the ordinary transcript uses. */
export function mountWorkflowActivity(initial: Extract<FrontendOutputBlock, { kind: "agentGroup" }>, options?: Pick<WorkflowsClient, "subscribe"> & Partial<Pick<WorkflowsClient, "control">>) {
  const openedWorkflows: string[] = []
  const [choices, setChoices] = createSignal<ReadonlyMap<string, WorkflowCardChoices>>(new Map())
  const host = fakeWebModuleHost()
  const context: WorkflowsClient = {
    choices: key => choices().get(key), choose: (key, value) => setChoices(current => new Map(current).set(key, value)),
    host, place: () => undefined, control: options?.control ?? (() => {}), open: id => { openedWorkflows.push(id) },
    subscribe: options?.subscribe ?? ((_id, notify) => { notify({ detail: undefined, view: undefined, live: [] }); return Object.assign(() => {}, { update() {} }) }),
  }
  const extension: WebModuleClient = {
    provide: render => render(), header: () => undefined, surface: () => undefined, input: () => undefined, coversConversation: () => false, openUri: () => false, move: () => false, back: () => false,
    block: { matches: block => block.kind === "agentGroup" && block.containerKind === "workflow", render: props => <WorkflowsProvider value={context}><WorkflowActivity {...props} /></WorkflowsProvider> },
  }
  return { ...mountAgentGroup(initial, extension), openedWorkflows: () => openedWorkflows }
}
