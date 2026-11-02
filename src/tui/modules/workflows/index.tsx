/** @jsxImportSource @opentui/solid */
import { createSignal, type JSX } from "solid-js"
import { Schema } from "effect"
import type { TuiModule } from "../../tui-module.js"
import type { TuiModuleClient, TuiModuleClientHost } from "../../tui-module-client.js"
import type { ViewerHandle } from "../../components/modal-stack.js"
import { createChildSessionViewerInput } from "../../components/child-session-viewer.js"
import { NavigationProvider } from "../../context/navigation.js"
import { parseSessionLink, parseWorkflowLink } from "../../../protocol/client/session-links.js"
import { errorMessage } from "../../../infra/error-message.js"
import type { SessionSurface } from "../../hooks/create-session-surface.js"
import { createWorkflowCards, WorkflowCardsProvider } from "./cards.js"
import { createWorkflowInspection } from "./inspection.js"
import { WorkflowAgentViewer, type WorkflowAgentViewerTarget } from "./agent-viewer.js"
import { WorkflowCardViewer, createWorkflowCardViewerInput } from "./card-viewer.js"
import { WorkflowActivityBlock } from "./activity-block.js"

const Route = Schema.Struct({
  workflowId: Schema.NonEmptyString,
  agentNodeId: Schema.optionalKey(Schema.String),
  follow: Schema.optionalKey(Schema.Boolean),
  historySessionId: Schema.optionalKey(Schema.String),
})
const decodeRoute = Schema.decodeUnknownSync(Route, { onExcessProperty: "error" })

function createWorkflowClient(host: TuiModuleClientHost): TuiModuleClient {
  const cards = createWorkflowCards({
    views: host.domains.workflow_view, live: host.domains.workflow_live, details: host.domains.workflow_detail, roles: host,
    client: host.client, report: (refusal) => host.showToast({ message: refusal.reason, variant: refusal.variant }),
    openAgent: (id, target) => openAgent(id, { kind: "agent", ...target }),
  })
  const provide = (children: () => JSX.Element) => <NavigationProvider value={host.navigateUri}><WorkflowCardsProvider value={cards}>{children()}</WorkflowCardsProvider></NavigationProvider>
  const shared = () => ({
    inspectWorkflow: (workflowId: () => string) => createWorkflowInspection(host.domains, workflowId),
    appService: host.client, title: host.title,
  })
  function openCard(workflowId: string): ViewerHandle {
    const [handle, setHandle] = createSignal<ViewerHandle>()
    const input = createWorkflowCardViewerInput()
    const opened = host.viewerLayer.push(() => provide(() => <WorkflowCardViewer {...shared()} workflowId={workflowId}
      roleView={host.roleView} ensureRoleViews={host.ensureRoleViews}
      input={input} active={() => handle()?.isActive() ?? false} onClose={() => handle()?.close()} showToast={host.showToast}
      onOpenAgent={(target) => openAgent(workflowId, { kind: "agent", ...target }, opened)} onOpenFollowUp={() => openAgent(workflowId, { kind: "followUp" }, opened)} />),
    { onKey: input.onKey, route: { kind: "module", moduleId: "workflows", route: { workflowId } } })
    setHandle(opened)
    return opened
  }
  function openAgent(workflowId: string, target: WorkflowAgentViewerTarget, card?: ViewerHandle): void {
    let surface: SessionSurface | undefined
    const [handle, setHandle] = createSignal<ViewerHandle>()
    const back = () => { handle()?.close() }
    const input = createChildSessionViewerInput({ onClose: back, dispatchCommand: host.dispatchCommand })
    let route: typeof Route.Type = { workflowId, ...(target.kind === "agent" ? { agentNodeId: target.agentNodeId, follow: target.follow ?? false, ...(target.historySessionId ? { historySessionId: target.historySessionId } : {}) } : {}) }
    const opened = host.viewerLayer.push(() => {
      const body = host.viewer(workflowId)
      const navigate = (uri: string) => {
        const child = parseSessionLink(uri)
        if (child && surface?.summary()?.childSessionIds?.includes(child.sessionId)) {
          void host.client.query({ type: "sessionDetail", sessionId: child.sessionId }).then(({ view }) => { if (view) host.openChild(view.row) }, (cause: unknown) => {
            host.showToast({ message: `Open failed for ${child.sessionId}: ${errorMessage(cause)}`, variant: "error" })
          })
        } else host.navigateUri(uri)
      }
      return provide(() => <NavigationProvider value={navigate}><WorkflowAgentViewer {...shared()} workflowId={workflowId} target={target} origin={card ? "card" : "chat"}
        body={host.viewer} createSurface={(id) => (surface = body.createSurface(id))} input={input} active={() => handle()?.isActive() ?? false} focused={() => handle()?.isFocused() ?? false}
        onBack={back} onClose={() => { back(); card?.close() }} showToast={host.showToast} showThinking={body.showThinking} diffColors={body.diffColors}
        onShown={(shown) => { route = { ...route, workflowId, agentNodeId: shown.agentNodeId, follow: shown.follow } }}
        onHistoryShown={(historySessionId) => { const { historySessionId: _previous, ...current } = route; route = { ...current, ...(historySessionId ? { historySessionId } : {}) } }} /></NavigationProvider>)
    }, { onKey: input.onKey, onPaste: input.onPaste, route: () => ({ kind: "module", moduleId: "workflows", route }) })
    setHandle(opened)
  }
  async function open(workflowId: string, agentNodeId?: string, follow?: boolean, historySessionId?: string): Promise<void> {
    const { view } = await host.client.query({ type: "workflowDetail", workflowId })
    if (!view) { host.showToast({ message: "This workflow no longer exists", variant: "error" }); return }
    await host.navigateSession(view.launchedFrom.parentSessionId)
    const card = openCard(workflowId)
    if (agentNodeId !== undefined) openAgent(workflowId, { kind: "agent", agentNodeId, ...(follow === undefined ? {} : { follow }), ...(historySessionId ? { historySessionId } : {}) }, card)
  }
  return {
    provide,
    activity: { matches: (block) => block.containerKind === "workflow", render: (props) => <WorkflowActivityBlock {...props} /> },
    async openUri(uri) {
      const target = parseWorkflowLink(uri)
      if (!target) return false
      await open(target.workflowId, target.agent)
      return true
    },
    async openTarget(target) {
      if (target.kind !== "workflow") return false
      await open(target.workflowId)
      return true
    },
    openSession(session) {
      if (session.kind !== "workflow-agent") return false
      return (async () => {
      const { view: detail } = await host.client.query({ type: "sessionDetail", sessionId: session.id })
      if (detail?.kind !== "workflow-agent") return true
      const membership = detail.row.workflowMembership
      const { view } = await host.client.query({ type: "workflowViewSnapshot", workflowId: membership.workflowId })
      if (view?.attemptsStatus !== "loaded") return true
      if (membership.kind === "historical-follow-up") { openAgent(membership.workflowId, { kind: "followUp" }); return true }
      const attempt = view.attempts.find((candidate) => candidate.id === membership.attemptId)
      const node = view.tree.nodes.find((candidate) => candidate.kind === "agent" && (candidate.id === attempt?.agentNodeId || candidate.currentAttemptId === attempt?.id))
      if (node) openAgent(membership.workflowId, { kind: "agent", agentNodeId: node.id, follow: false, historySessionId: session.id })
      else host.showToast({ message: "This agent is no longer in the workflow.", variant: "error" })
      return true
      })()
    },
    async restore(route) {
      if (route.kind !== "module" || route.moduleId !== "workflows") return false
      const target = decodeRoute(route.route)
      await open(target.workflowId, target.agentNodeId, target.follow, target.historySessionId)
      return true
    },
  }
}

export const workflowsTui = { id: "workflows", createClient: createWorkflowClient } as const satisfies TuiModule
