import { createComponent, createMemo, createRoot, createSignal } from "solid-js"
import type { FrontendMutation, FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import type { LoadedWorkflowView, WorkflowAgentLive } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { workflowAgentModel, workflowBriefLine, type WorkflowAgentTarget } from "../../../../src/protocol/client/workflow-agent.js"
import { workflowDetail } from "../../../../tests/helpers/runtime-views.js"
import type { ClientViewState, SessionSummary } from "../../client/view-state.js"
import { ClientContext } from "../../app/client-context.js"
import { fakeClient, fakeClientActions, fakeViewState, fakeWebModuleHost } from "../../app/client-context-fixture.js"
import { fakeRuntimeConnection } from "../../client/runtime-connection-fixture.js"
import { AgentHeader } from "./agent-header.js"
import { Composer } from "../../app/composer.js"
import { PersistentPane } from "../../app/persistent-pane.js"
import { UserMessage } from "../../app/message.js"
import { createBlockDisclosure } from "../../app/block-disclosure.js"
import { createElement, insert, nodes, textContent } from "../../app/render-ownership-host-fixture.js"

/** Mounts module chrome with the ordinary composer and ordinary initial-message renderer. */
export function mountAgentView(view: LoadedWorkflowView, initialLeaf: string, blocks: readonly FrontendOutputBlock[] = [], options: { readonly origin?: "chat" | "card"; readonly runTitle?: string; readonly chat?: Pick<SessionSummary, "title" | "subtitle"> } = {}) {
  return createRoot(dispose => {
    const [live, setLive] = createSignal<readonly WorkflowAgentLive[]>([])
    const [target, setTarget] = createSignal<WorkflowAgentTarget>({ agentNodeId: initialLeaf, follow: true })
    const [currentView, setView] = createSignal(view)
    const [interruptible, setInterruptible] = createSignal(true)
    const [busyKey, setBusyKey] = createSignal("")
    const [row, setRow] = createSignal<SessionSummary>({ id: "member-json", title: "Agent", kind: "workflow-agent", lifecycleState: "active", active: true, working: true, lastUpdated: "", totalsLoading: false, admittedActions: ["session.send", "chat.interrupt", "chat.resume"] })
    const model = createMemo(() => workflowAgentModel(currentView(), target(), undefined, live()))
    const id = () => `member-${target().agentNodeId}`
    const sent: FrontendMutation[] = []
    const connection = fakeRuntimeConnection({
      onDispatch: (mutation) => { sent.push(mutation) },
      mutations: { "chat.interrupt": () => ({ ok: true }), "chat.resume": () => ({ ok: true }) },
    })
    const idle = fakeViewState()
    const state = (): ClientViewState => ({
      ...idle, sessionId: id(), sessions: options.chat ? [{ ...row(), id: "chat", kind: "chat", ...options.chat }] : [], children: [{ ...row(), id: id() }], blocks,
      busy: interruptible(), interruptible: interruptible() && !live().find(agent => agent.sessionId === id())?.interruptedAt,
    })
    const actions = fakeClientActions({
      working: (key) => key === busyKey(), canOpenFiles: false,
      interrupt: () => { void connection.dispatch({ type: "chat.interrupt", sessionId: id() }) },
      resume: () => { void connection.dispatch({ type: "chat.resume", sessionId: id() }) },
    })
    const client = fakeClient({ state, connection, actions })
    const host = fakeWebModuleHost({ state, connection, actions })
    const detail = options.runTitle === undefined ? undefined : workflowDetail({
      workflowId: "workflow", title: options.runTitle, workflowDefinitionId: "work", executionCwd: "/scratch",
      launchedFrom: { parentSessionId: "chat", conversationId: "conversation", toolUseId: "toolu_run" }, admittedActions: [],
    })
    const root = createElement("root")
    const shims = { document: { addEventListener() {}, removeEventListener() {} }, MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} } }
    const originals = Object.keys(shims).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
    for (const [key, value] of Object.entries(shims)) Object.defineProperty(globalThis, key, { configurable: true, value })
    let nexts = 0
    const histories: Array<string | undefined> = []
    const disclosure = createBlockDisclosure()
    insert(root, createComponent(ClientContext.Provider, { value: client, get children() { return <>
      <AgentHeader host={host} place={() => ({ kind: "agent", workflowId: "workflow", chatSessionId: "chat", target: { kind: "agent", ...target() }, origin: options.origin ?? "card" })}
        reading={() => ({ detail, view: currentView(), live: live() })} model={model} back={() => {}} next={() => { nexts += 1 }} history={sessionId => histories.push(sessionId)} />
      {blocks.flatMap(block => block.kind === "userMessage" ? [<UserMessage block={block} sessionId={id()} disclosure={disclosure} onHydrate={() => {}} onImageLoad={() => {}} initialMessageLabel={model() ? workflowBriefLine(model()!, block) : "Request"} />] : [])}
      <PersistentPane active={true} takeover={undefined}><div class="composer-slot"><Composer register={() => {}} input={() => ({ placeholder: "Message this agent", wordsOnly: true, hidden: false })} /></div></PersistentPane>
    </> } }))
    const classed = (name: string) => nodes(root).filter(node => typeof node.properties.class === "string" && node.properties.class.split(" ").includes(name))
    const controls = () => classed("composer-stop")
    return {
      sent, setLive, setView, setRow, setInterruptible, setBusyKey, histories,
      elements: () => nodes(root),
      setLeaf: (agentNodeId: string) => setTarget({ agentNodeId, follow: true }),
      next: () => classed("workflow-agent-next").map(textContent)[0],
      pressNext() { const handler = classed("workflow-agent-next")[0]?.properties.onClick; if (typeof handler !== "function") throw new Error("No Next control"); handler(); return nexts },
      brief: () => classed("initial-message-row").map(textContent)[0],
      band: () => classed("workflow-agent-band").map(textContent)[0],
      names: () => ({ phase: classed("workflow-agent-phase").map(node => textContent(node).replace(/^[·›]/, ""))[0], agent: classed("workflow-agent-name").map(node => textContent(node).replace(/^[·›]/, ""))[0] }),
      line: () => classed("workflow-agent-line").map(textContent)[0],
      setLineWidth(width: number) { const line = classed("workflow-agent-line")[0]; if (!line) throw new Error("No line"); line.clientWidth = width },
      text: () => textContent(root),
      labels: () => controls().map(node => node.properties["aria-label"]), busy: () => controls().map(node => node.properties["aria-busy"]),
      async click(label: string) { const handler = controls().find(node => node.properties["aria-label"] === label)?.properties.onClick; if (typeof handler !== "function") throw new Error(`No ${label} control`); await handler() },
      dispose() { dispose(); for (const [key, original] of originals) { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key) } },
    }
  })
}
