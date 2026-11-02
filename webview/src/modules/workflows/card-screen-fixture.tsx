import { createComponent, createRoot } from "solid-js"
import type { LoadedWorkflowView } from "../../../../src/protocol/workflow-view-protocol-types.js"
import type { WorkflowDetail } from "../../../../src/protocol/modules/workflows.js"
import { fakeClientActions, fakeWebModuleHost } from "../../app/client-context-fixture.js"
import type { WorkflowAgentViewTarget } from "./navigation.js"
import { WorkflowsProvider, type WorkflowsClient } from "./context.js"
import { WorkflowCardScreen } from "./card-screen.js"
import { createElement, insert, nodes, textContent } from "../../app/render-ownership-host-fixture.js"
import { workflowDetail } from "../../../../tests/helpers/runtime-views.js"

/** Mounts the passive aggregate card, with no selected session or session hold. */
export function mountCardScreen(view: LoadedWorkflowView | undefined, overrides: Partial<WorkflowDetail> = {}) {
  return createRoot(dispose => {
    const opened: WorkflowAgentViewTarget[] = []
    const controls: { readonly workflowId: string; readonly control: string }[] = []
    const detail = workflowDetail({
      workflowId: "workflow", title: "Probe each surface", workflowDefinitionId: "probe", executionCwd: "/scratch",
      launchedFrom: { parentSessionId: "chat", conversationId: "conversation", toolUseId: "toolu_run" }, readability: view ? "readable" : "unavailable",
      admittedActions: ["workflow.interrupt", "workflow.stop"], ...overrides,
    })
    const host = fakeWebModuleHost({ actions: fakeClientActions({ working: () => false }) })
    const context: WorkflowsClient = { host, subscribe: () => Object.assign(() => {}, { update() {} }), open: (_id, target) => { if (target) opened.push(target) }, place: () => undefined, control: (workflowId, control) => { controls.push({ workflowId, control }) }, choices: () => undefined, choose() {} }
    const root = createElement("root")
    insert(root, createComponent(WorkflowsProvider, { value: context, get children() { return <WorkflowCardScreen workflowId="workflow" reading={() => ({ detail, view, live: [] })} view={() => view} onOpen={target => opened.push(target)} onBack={() => {}} /> } }))
    const tree = () => nodes(root).find(node => node.properties.role === "tree")
    return {
      opened, controls, dispose, text: () => textContent(root),
      selected: () => nodes(root).filter(node => node.properties["aria-selected"] === true).map(textContent),
      key(key: string) { const handler = tree()?.properties.onKeyDown; if (typeof handler !== "function") throw new Error("No tree"); handler({ key, preventDefault() {} }) },
      labels: () => nodes(root).filter(node => node.properties.class === "workflow-action").map(node => node.properties["aria-label"]),
      click(label: string) { const handler = nodes(root).find(node => node.properties.class === "workflow-action" && node.properties["aria-label"] === label)?.properties.onClick; if (typeof handler !== "function") throw new Error(`No ${label} control`); handler() },
    }
  })
}
