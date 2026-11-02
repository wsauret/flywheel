import { createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js"
import { workflowBriefLine } from "../../../../src/protocol/client/workflow-agent.js"
import { parseWorkflowLink } from "../../../../src/protocol/client/session-links.js"
import { controlActionKey, actionKey } from "../../client/action-key.js"
import { summaryOf } from "../../client/view-state.js"
import type { WebModule } from "../../web-module.js"
import type { WebModuleClient, WebModuleClientHost } from "../../web-module-client.js"
import { AgentHeader, agentInput } from "./agent-header.js"
import { WorkflowActivity } from "./activity.js"
import { WorkflowCardScreen } from "./card-screen.js"
import { WorkflowsProvider, type WorkflowsClient } from "./context.js"
import { createWorkflowInspections, type WorkflowReading } from "./inspection.js"
import { createWorkflowAgentAdoption, createWorkflowNavigation } from "./navigation.js"
import type { WorkflowCardChoices } from "../../../../src/protocol/client/workflow-card.js"

function createClient(host: WebModuleClientHost): WebModuleClient {
  const [cardChoices, setCardChoices] = createSignal<ReadonlyMap<string, WorkflowCardChoices>>(new Map())
  const inspections = createWorkflowInspections(host.connection)
  onCleanup(() => inspections.dispose())
  const [reading, setReading] = createSignal<WorkflowReading>({ detail: undefined, view: undefined, live: [] })
  const navigation = createWorkflowNavigation({ reading, selected: () => host.state().sessionId, select: host.selectSession })
  const workflowId = createMemo(() => {
    const row = summaryOf(host.state(), host.state().sessionId)
    return navigation.place()?.workflowId ?? row?.workflowMembership?.workflowId
  })
  createEffect(on(workflowId, id => {
    setReading({ detail: undefined, view: undefined, live: [] })
    if (id !== undefined) onCleanup(inspections.subscribe(id, setReading))
  }))
  createWorkflowAgentAdoption(navigation, () => summaryOf(host.state(), host.state().sessionId), reading)
  const visible = createMemo(() => {
    const place = navigation.place()
    if (!place) return undefined
    const selected = host.state().sessionId
    return selected === (place.kind === "card" ? place.chatSessionId : navigation.sessionId()) ? place : undefined
  })
  const context: WorkflowsClient = {
    choices: key => cardChoices().get(key),
    choose: (key, choices) => setCardChoices(current => new Map(current).set(key, choices)),
    host, subscribe: inspections.subscribe, place: navigation.place,
    open(id, target) {
      const state = untrack(host.state)
      const chat = untrack(reading).detail?.workflowId === id ? untrack(reading).detail?.launchedFrom.parentSessionId : state.rootSessionId ?? state.sessionId
      if (chat === undefined) return
      if (target) navigation.openAgent(id, chat, target, visible()?.kind === "card" ? "card" : "chat")
      else navigation.openCard(id, chat)
    },
    control(id, kind) {
      const key = kind === "stop" ? actionKey("stop", id) : controlActionKey(kind, id)
      void host.actions.run(key, async () => {
        const result = await host.connection.dispatch({ type: `workflow.${kind}`, workflowId: id })
        if ("ok" in result && !result.ok) throw new Error(result.error)
        if ("interrupted" in result && !result.interrupted && result.reason) throw new Error(result.reason)
      })
    },
  }
  return {
    provide: children => <WorkflowsProvider value={context}>{children()}</WorkflowsProvider>,
    header: () => <Show when={visible()?.kind === "agent" ? visible() : undefined}>{place => {
      const agentPlace = () => { const current = place(); if (current.kind !== "agent") throw new Error("Expected agent place"); return current }
      return <AgentHeader host={host} place={agentPlace} reading={reading} model={navigation.model} back={navigation.back} next={() => navigation.move(1)} history={navigation.history} />
    }}</Show>,
    surface: () => <Show when={visible()?.kind === "card" ? visible() : undefined}>{place =>
      <WorkflowCardScreen workflowId={place().workflowId} reading={reading} view={() => { const view = reading().view; return view?.attemptsStatus === "loaded" ? view : undefined }} onOpen={target => context.open(place().workflowId, target)} onBack={navigation.back} />
    }</Show>,
    coversConversation: () => visible()?.kind === "card" || (navigation.place()?.kind === "agent" && navigation.sessionId() === undefined),
    input: () => agentInput(reading(), visible(), navigation.model()),
    openUri(uri) {
      const link = parseWorkflowLink(uri)
      if (!link) return false
      context.open(link.workflowId, link.agent === undefined ? undefined : { kind: "agent", agentNodeId: link.agent, follow: true })
      return true
    },
    openTarget(target) {
      if (target.kind !== "workflow") return false
      context.open(target.workflowId)
      return true
    },
    move: direction => visible()?.kind === "agent" && navigation.move(direction),
    back: navigation.back,
    reveal: navigation.reveal,
    command(command) {
      if (command.type !== "interruptWorkflow") return false
      const id = workflowId()
      if (id) context.control(id, "interrupt")
      return true
    },
    initialMessageLabel: block => {
      if (visible()?.kind !== "agent" || block.injected) return undefined
      const model = navigation.model()
      return model ? workflowBriefLine(model, block) : "Request"
    },
    block: { matches: block => block.kind === "agentGroup" && block.containerKind === "workflow", render: props => <WorkflowActivity {...props} /> },
  }
}

export const workflowsWeb: WebModule = { id: "workflows", createClient }
