import { createComponent, createRoot, createSignal } from "solid-js"
import type { FrontendActivity, ProtocolChatAttachment } from "../../../src/protocol/app-service-types.js"
import { createClientActions } from "../client/actions.js"
import { DraftKeptRefusal } from "../client/session-input.js"
import { createCommandRoster } from "../client/command-choices.js"
import type { RuntimeCommandCatalog } from "../../../src/protocol/command-catalog-protocol-types.js"
import type { InlineSettingAction } from "../client/settings-actions.js"
import type { ClientViewState } from "../client/view-state.js"
import type { FrontendQuestionBlock } from "../client/question-answer.js"
import type { SessionMemory } from "../client/session-residents.js"
import { createSessionChangesController, type ChangesSummaryState } from "../../../src/protocol/client/session-changes.js"
import type { BudgetSummary } from "../../../src/protocol/client/host-contract.js"
import { ClientContext } from "./client-context.js"
import { fakeClient, fakeClientHost, fakePanelSettings, fakeRuntimeSession, fakeSessionSummary, fakeViewState } from "./client-context-fixture.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"
import type { ComposerHandle } from "./composer.js"
import { ConversationBody } from "./conversation-body.js"
import { PersistentPane } from "./persistent-pane.js"
import type { WorkflowAgentAddress } from "../../../src/protocol/client/workflow-addresses.js"
import type { WorkflowAgentModel } from "../../../src/protocol/client/workflow-agent.js"
import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"

const settle = async () => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

/** Mounts the real composer and action boundary with a deferred runtime
 *  acknowledgement. With `catalogLater`, the command catalog has not arrived
 *  when the composer mounts, until `arriveCatalog` publishes it. With
 *  `caret: "end"`, the textarea's caret sits at the end of its value, as a
 *  browser puts it after a programmatic value write; by default it sits at the start. */
export function mountComposerSubmission(options: { readonly catalogLater?: boolean; readonly catalog?: RuntimeCommandCatalog; readonly question?: FrontendQuestionBlock; readonly attentionAtMount?: boolean; readonly caret?: "end" } = {}) {
  const sent: { text: string; attachments: readonly ProtocolChatAttachment[] | undefined }[] = []
  const reports: string[] = []
  const commands: { name: string; args: string | undefined }[] = []
  const opened: string[] = []
  const prompts: string[] = []
  const settings: InlineSettingAction[] = []
  /** The question projection's reading of each session, as the page keeps it:
   *  the open session's pending question follows the selection. */
  const [pendingQuestions, setPendingQuestions] = createSignal<ReadonlyMap<string, FrontendQuestionBlock>>(new Map())
  const projectQuestion = (sessionId: string, block: FrontendQuestionBlock | undefined) => setPendingQuestions((current) => {
    const next = new Map(current)
    if (block === undefined || block.answers !== undefined || block.cancelled === true) next.delete(sessionId)
    else next.set(sessionId, block)
    return next
  })
  if (options.question !== undefined) projectQuestion("chat", options.question)
  const [attention, setAttention] = createSignal(options.attentionAtMount ? { sessionId: "chat", sequence: 1 } : undefined)
  const roleSubscriptions: string[] = []
  const openSession = (): string | undefined => "chat"
  const published: RuntimeCommandCatalog = options.catalog ?? {
    revision: 1,
    builtInCommands: [
      { id: "model-and-effort", title: "Model and effort", description: "The model of the transcript in view", aliases: ["effort"], opens: "models", target: { kind: "transcript-in-view" }, menu: { group: "top", rank: 20 } },
      { id: "model", title: "Models", description: "Every role's model", aliases: [], opens: "models", menu: { group: "top", rank: 30 } },
      { id: "status", title: "Status", description: "Show Flywheel's status", aliases: [], opens: "status", menu: { group: "top", rank: 100 } },
      { id: "bg", title: "Background work", description: "The chat's background work", aliases: [], opens: "background", menu: { group: "top", rank: 200 } },
      { id: "shortcuts", title: "Keyboard shortcuts", description: "Every key chord", aliases: [], opens: "keyboard-shortcuts", menu: { group: "top", rank: 300 } },
      { id: "compact", title: "Compact conversation", description: "Compact", aliases: [], menu: { group: "chat", rank: 100 } },
      { id: "find", title: "Find in transcripts", description: "Search the transcripts", aliases: ["search"], opens: "find", menu: { group: "chat", rank: 200 } },
      { id: "inspect", title: "Inspect", description: "View service status and reauthenticate", aliases: [] },
      { id: "stats", title: "Stats", description: "View session statistics", aliases: [] },
      { id: "review", title: "Review", description: "Probe a change", aliases: ["probe", "examine"] },
      { id: "help", title: "Commands", description: "Every command", aliases: [], opens: "commands", menu: { group: "more", rank: 10 } },
      { id: "profile", title: "Auth profiles", description: "Switch the credential profile", aliases: [], opens: "auth-profiles" },
    ],
    offCommands: [{ id: "drain", aliases: ["sweep"], modules: ["Papercuts"] }],
  }
  const roster = createCommandRoster()
  if (options.catalogLater !== true) roster.accept(published)
  const [listed, setState] = createSignal<ClientViewState>(fakeViewState({
    sessionId: openSession(), rootSessionId: "chat", sessions: [fakeSessionSummary({ id: "chat", kind: "chat", title: "Chat", admittedActions: [] })],
    children: [], blocks: options.question === undefined ? [] : [options.question], windowCurrent: true, localSubmissions: [],
    groups: {}, bodies: {}, streamingToolText: {}, visibleMessageCount: 0,
    atTail: true, hasBefore: false, status: "ready",
    settledOutputPosition: null, appliedOutputPosition: 1, startBlockIndex: 0,
    builtInCommands: roster.builtInCommands,
    offCommands: roster.offCommands,
    commandUsage: [{ name: "inspect", count: 3 }], providers: [], busy: false, interruptible: false,
    roleAssignments: (sessionId) => {
      const selection = sessionId === "child" ? { model: "child-model", effort: "medium" } : sessionId.startsWith("member-") ? { model: "gpt-6-luna", effort: "high" } : undefined
      return selection === undefined ? undefined : { assignments: {}, serving: { slot: { kind: "role", roleId: "chat" }, selection } }
    },
    subscribeRoleAssignments: (sessionId) => { roleSubscriptions.push(sessionId); return () => {} },
    subscribeStatus: () => () => {},
    settings: fakePanelSettings({ compactionThreshold: 270_000, workflowMode: "ask" }),
  }))
  /** A selected workflow child, which no catalog lists (ARCH-PROTOCOL-048), with a
   *  agent running or with none, as the runtime reports it. */
  const [workflow, setWorkflow] = createSignal<{ readonly running: boolean }>()
  const [activity, setActivity] = createSignal<FrontendActivity>()
  /** The item that an open agent view's composer addresses. */
  const [address, setAddress] = createSignal<WorkflowAgentAddress>()
  const [agent, setAgent] = createSignal<WorkflowAgentModel>()
  const [changesSummary, setChangesSummary] = createSignal<ChangesSummaryState>({ status: "idle" })
  const budget: BudgetSummary = { totalsLoading: true, compactionThreshold: 100_000 }
  const state = (): ClientViewState => {
    const pendingQuestion = pendingQuestions().get(listed().sessionId ?? "")
    const current = { ...listed(), ...(pendingQuestion === undefined ? {} : { pendingQuestion }), budget, changes: { ...idleChanges, summary: changesSummary() }, activity: activity(), transcriptAvailable: true }
    const selected = workflow()
    if (selected === undefined) return current
    const memberId = `member-${agent()?.agentNodeId ?? "json"}`
    const memberState = agent()?.state
    return {
      ...current,
      sessionId: memberId,
      children: [fakeSessionSummary({
        id: memberId, kind: "workflow-agent", title: "Debug", parentSessionId: "chat",
        admittedActions: memberState === "done" ? [] : ["session.send", "chat.interrupt", "chat.resume", "session.delete"],
      })],
      interruptible: selected.running && (memberState === undefined || memberState === "running"),
      // The session's reading of the seat in use: the running agent's.
      activeModel: { model: "gpt-6-luna", effort: "high" },
    }
  }
  let accept = () => {}
  let refuse = (_cause: Error) => {}
  // The session's failed-send owner, reduced to the one message it answers:
  // a refused send is what the next recall hands back.
  let failed: { text: string; attachments: readonly ProtocolChatAttachment[] } | undefined
  // While held, a command or a recall waits for `answer`, as one does over a slow link.
  let held: (() => void)[] | undefined
  const answered = () => (held === undefined ? Promise.resolve() : new Promise<void>((resolve) => { held?.push(resolve) }))
  let recalls = 0
  // The session each interrupt reached, in order.
  const interrupts: (string | undefined)[] = []
  const interruptTargets: (readonly string[] | undefined)[] = []
  // The entry each failed-send recall named; Up names none, so the newest returns.
  const recalledEntries: (string | undefined)[] = []
  const questionAnswers: { readonly toolUseId: string; readonly answers: unknown }[] = []
  const questionSkips: string[] = []
  const session = fakeRuntimeSession({
    get sessionId() { return state().sessionId },
    send(text: string, attachments?: readonly ProtocolChatAttachment[]) {
      sent.push({ text, attachments })
      return new Promise<void>((resolve, reject) => {
        accept = resolve
        refuse = (cause) => { failed = { text, attachments: attachments ?? [] }; reject(cause) }
      })
    },
    recallLocal(entryId?: string) {
      recalledEntries.push(entryId)
      const recalled = failed
      failed = undefined
      return recalled === undefined ? undefined : { kind: "input" as const, input: recalled }
    },
    invokeCommand: async (_sessionId, name, args) => { commands.push({ name, args }); await answered(); return { kind: "none" as const } },
    recallQueued: async () => { recalls += 1; await answered(); return "queued words" },
    recordCommandUse: async () => {},
    answer: async (toolUseId, answers) => { questionAnswers.push({ toolUseId, answers }) },
    cancelQuestion: async (toolUseId) => { questionSkips.push(toolUseId) },
    commands: roster,
    interrupt: async (targets) => { interrupts.push(state().sessionId); interruptTargets.push(targets) },
  })
  const connection = fakeRuntimeConnection()
  const idleChanges = createSessionChangesController({ client: connection, sessionId: "chat" }).snapshot
  /** The chat the runtime created for the new chat's first message. */
  let created: string | undefined
  // Every session the fixture opens stays resident, as the page's last eight do.
  const memories = new Map<string, SessionMemory>()
  const memory = (sessionId: string): SessionMemory => {
    const existing = memories.get(sessionId)
    if (existing !== undefined) return existing
    const fresh: SessionMemory = {}
    memories.set(sessionId, fresh)
    return fresh
  }
  const actions = createClientActions({
    session, connection, capabilities: {},
    report: (_severity, message) => { reports.push(message) },
    // A command that opens a surface opens it through the client's own table, as on a page.
    captureSurfaceOpener: () => (surface, _sessionId, opening) => client.openSurface(surface, opening),
  })
  const client = fakeClient({
    connection,
    actions: {
      ...actions,
      applySetting: async (action) => { settings.push(action); return { kind: "applied" } },
    },
    state,
    attention,
    residents: {
      memory, onLeave: () => () => {},
      get destination() { return created === undefined || created !== state().sessionId ? {} : { created: true as const } },
    },
    report: (_severity, message) => { reports.push(message) },
    readingPlace: { restored: undefined, track: () => () => {} },
    openSheet: (id, focus) => { opened.push(focus?.kind === "switch-profile" ? `${id}:${focus.name}` : id) },
    openFind: (query) => { opened.push(query === undefined ? "find" : `find:${query}`) },
    host: fakeClientHost({ capabilities: { keyboardShortcuts: true } }),
    prompt: async (request) => { prompts.push(request.title); return undefined },
  })
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const previousResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver")
  const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver")
  const previousComputedStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle")
  type CapturedKey = { key: string; shiftKey: boolean; preventDefault(): void; stopPropagation(): void }
  const captures = new Set<(event: CapturedKey) => void>()
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    addEventListener(type: string, listener: (event: CapturedKey) => void, capture?: boolean) { if (type === "keydown" && capture) captures.add(listener) },
    removeEventListener(type: string, listener: (event: CapturedKey) => void) { if (type === "keydown") captures.delete(listener) },
  } })
  // Submission tests have no layout engine; the height publisher's own tests drive resize delivery.
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: class {
    observe() {}
    disconnect() {}
  } })
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, writable: true, value: class {
    observe() {}
    disconnect() {}
  } })
  // The transcript measures the sent messages that history reads.
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, writable: true, value: () => ({ lineHeight: "20" }) })
  return createRoot((dispose) => {
    const root = createElement("root")
    let handle: ComposerHandle | undefined
    insert(root, createComponent(ClientContext.Provider, {
      value: client,
      get children() {
        return <PersistentPane active={true} takeover={undefined}>
          <ConversationBody register={(registered: ComposerHandle) => { handle = registered }}
            input={() => address() === undefined && agent() === undefined ? undefined : { placeholder: address()?.placeholder ?? "This agent is read-only", wordsOnly: true, hidden: false }} />
        </PersistentPane>
      },
    }))
    // SAFETY: the fixture renders one composer slot through PersistentPane.
    const slot = nodes(root).find((node) => node.properties.class === "composer-slot")!
    // SAFETY: PersistentPane inserts the slot directly into its resident pane.
    const pane = slot.parent!
    const field = () => {
      const node = nodes(root).find((candidate) => candidate.tag === "textarea" && candidate.parent?.properties.class === "composer-field")
      if (!node) throw new Error("Composer has no textarea")
      return node
    }
    const sendButton = () => {
      const node = nodes(root).find((candidate) => candidate.properties.class === "composer-send")
      if (!node) throw new Error("Composer has no send button")
      return node
    }
    const dispatch = (node: ReturnType<typeof createElement>, name: string, event: unknown) => {
      const handler = node.properties[name]
      if (typeof handler !== "function") throw new Error(`No ${name} handler`)
      handler(event)
    }
    const rows = () => nodes(root).filter((node) => node.properties.role === "option")
    const label = (node: ReturnType<typeof createElement>) => {
      // A setting row shows the label Settings gives it.
      const text = nodes(node).find((candidate) => candidate.properties.class === "panel-label" || candidate.properties.class === "sheet-row-label")
      if (!text) throw new Error("Panel row has no label")
      return textContent(text)
    }
    // The composer reads its textarea's value and caret on edge keys; the
    // memory host keeps the bound value in `properties`.
    const textarea = (): ReturnType<typeof createElement> => {
      const node = field()
      if (!("value" in node)) {
        const caret = () => (options.caret === "end" ? String(node.properties.value ?? "").length : 0)
        Object.defineProperties(node, {
          value: { get: () => node.properties.value ?? "" },
          selectionStart: { get: caret },
          selectionEnd: { get: caret },
          setSelectionRange: { value() {} },
        })
      }
      return node
    }
    const key = (pressed: string) => {
      let stopped = false
      const event = { key: pressed, shiftKey: false, preventDefault() {}, stopPropagation() { stopped = true } }
      for (const capture of captures) capture(event)
      if (!stopped) dispatch(textarea(), "onKeyDown", event)
    }
    let filePicks = 0
    const file = nodes(root).find((node) => node.tag === "input" && node.properties.type === "file")
    if (!file) throw new Error("Composer has no file input")
    Object.defineProperty(file, "click", { value() { filePicks += 1 } })
    return {
      sent, reports, commands, opened, prompts, settings, rows, key, roleSubscriptions, questionAnswers, questionSkips,
      field,
      appendInput: (sessionId: string, text: string) => handle?.appendInput(sessionId, { text }),
      /** The editor's "Add selection to chat". */
      insertText: (text: string) => handle?.insertText(text),
      /** The open transcript shows these messages as sent, oldest first. */
      publishSent: (texts: readonly string[]) => setState((current) => ({ ...current, blocks: texts.map((content, index) => ({ kind: "userMessage" as const, id: `sent-${index}`, content, timestamp: index, pending: false, injected: false })) })),
      completeSubagent: (runOutcome: "completed" | "partial" = "completed") => setState((current) => ({ ...current, children: [fakeSessionSummary({ id: "child", kind: "subagent", parentSessionId: "chat", title: "Finished child", admittedActions: [], runOutcome })] })),
      capture: () => {
        if (!handle || !("capture" in handle) || typeof handle.capture !== "function") throw new Error("Composer cannot capture owned input")
        return handle.capture()
      },
      adopt: (checkpoint: unknown) => {
        if (!handle || !("adopt" in handle) || typeof handle.adopt !== "function") throw new Error("Composer cannot adopt owned input")
        handle.adopt(checkpoint)
      },
      openSubagent: (sessionId = "child") => setState((current) => ({ ...current, sessionId, children: [fakeSessionSummary({ id: sessionId, kind: "subagent", title: "Working child", parentSessionId: sessionId === "child" ? "chat" : "child", admittedActions: ["session.send"] })] })),
      filePicks: () => filePicks,
      openAttachments() {
        const button = nodes(root).find((node) => node.properties.class === "composer-attach")
        if (!button) throw new Error("Composer has no attachment button")
        dispatch(button, "onClick", {})
      },
      attachmentMenuOpen: () => nodes(root).some((node) => node.properties.role === "menu"),
      openStoppedSubagent: (runOutcome: "stopped" | "failed" | "cancelled" = "stopped") => setState((current) => ({ ...current, sessionId: "child", children: [fakeSessionSummary({ id: "child", kind: "subagent", title: "Stopped child", admittedActions: ["subagent.resume"], runOutcome })] })),
      changesLabel: () => nodes(root).find((node) => node.properties.class === "composer-changes")?.properties["aria-label"],
      changesCount: () => textContent(nodes(root).find((node) => node.properties.class === "composer-changes-count") ?? root),
      publishChanges: (summary: ChangesSummaryState) => setChangesSummary(summary),
      paneHeight: () => pane.properties["style:--fw-composer-height"],
      wrapperHeight: () => slot.properties["style:--fw-composer-height"],
      recalls: () => recalls,
      recalledEntries,
      /** The Edit control under the failed entry `entryId` in the transcript. */
      edit(entryId: string) {
        textarea()
        handle?.recallLocal(entryId)
      },
      hold() { held = [] },
      async answer() { const waiting = held ?? []; held = undefined; for (const resolve of waiting) resolve(); await settle() },
      /** The agent works, so Up on an empty composer recalls the queued message. */
      work: () => setState((current) => ({ ...current, busy: true })),
      publishActivity: setActivity,
      activityText: () => nodes(root).filter(node => node.properties.class === "activity-status").map(textContent).join(""),
      placeholder: () => field().properties.placeholder,
      sendWorking: () => sendButton().properties["aria-busy"] === true,
      /** The send control's accessible name. */
      sendLabel: () => sendButton().properties["aria-label"],
      labels: () => rows().map(label),
      controlTitles: () => nodes(root).filter((node) => node.properties.class === "composer-stop").map((node) => node.properties.title),
      selected: () => rows().filter((node) => node.properties["aria-selected"] === true).map(label),
      sections: () => nodes(root).filter((node) => node.properties.class === "panel-section").map(textContent),
      values: () => nodes(root).filter((node) => node.properties.class === "panel-value").map(textContent),
      refresh: () => setState((current) => ({ ...current, settings: fakePanelSettings({ ...current.settings, compactionThreshold: 300_000 }) })),
      interrupts,
      interruptTargets,
      interruptCommand: () => { if (client.state().interruptible) actions.interrupt() },
      /** Opens the agent view of item `target` in the open workflow. */
      openAgent(target: string | undefined, agentState: WorkflowAgentModel["state"] = "running") {
        setAddress(target === undefined ? undefined : { target, label: `item ${target}`, placeholder: `Message item ${target}` })
        const agentNodeId = target ?? "finished"
        setAgent({ agentNodeId, follow: true, kind: "list", phaseId: "map", position: "1/1", state: agentState, stateText: agentState, emptyText: "", label: agentNodeId, definitionId: "work", name: agentNodeId, running: agentState === "running", current: false, history: [] })
      },
      closeAgent() { setAgent(undefined); setAddress(undefined) },
      /** Opens the workflow child with an agent running or with none. */
      openWorkflow: (running: boolean) => setWorkflow({ running }),
      closeWorkflow: () => setWorkflow(undefined),
      /** The composer's model reading, by its accessible name. */
      model: () => nodes(root).find((node) => node.properties.class === "composer-model")?.properties["aria-label"],
      /** Opens another listed chat in the pane. */
      openChat: (sessionId: string) => setState((current) => ({ ...current, sessionId })),
      /** The runtime answers the new chat's first message with its chat. */
      openCreated: (sessionId: string) => { created = sessionId; setState((current) => ({ ...current, sessionId })) },
      /** Leaves the open session, as before the first chat exists. */
      leaveSession: () => setState((current) => ({ ...current, sessionId: undefined })),
      /** The open session's window holds a question nobody answered, and
       *  the window is current on the lane, or is a kept one not merged yet. */
      publishQuestion(current: boolean) {
        const block: FrontendQuestionBlock = { kind: "question", toolUseId: "ask", timestamp: 1, questions: [{ question: "Which file?", header: "File", multiSelect: false, choices: [{ kind: "option", choiceId: "file", label: "a.ts" }, { kind: "freeform", label: "Other" }] }] }
        projectQuestion(listed().sessionId ?? "", block)
        setState((current_) => ({ ...current_, windowCurrent: current, blocks: [block] }))
      },
      /** The open window is a kept one that has not merged since the lane broke. */
      unmerged: () => setState((current) => ({ ...current, windowCurrent: false })),
      /** The merge after a lane break lands: the window is current again. */
      merged: () => setState((current) => ({ ...current, windowCurrent: true })),
      /** The open session's transcript shows the block, and the question
       *  projection names it while it waits, as the runtime publishes both. */
      publishQuestionBlock(block: FrontendQuestionBlock | undefined) {
        projectQuestion(listed().sessionId ?? "", block)
        setState((current) => ({ ...current, blocks: block === undefined ? [] : [block] }))
      },
      /** The question projection settles the open session's question; the
       *  transcript, which did not receive the settlement, still shows it waiting. */
      settleOutsideTranscript: () => projectQuestion(listed().sessionId ?? "", undefined),
      attend: () => setAttention((current) => ({ sessionId: "chat", sequence: (current?.sequence ?? 0) + 1 })),
      elements: () => nodes(root),
      typeQuestion(fieldLabel: string, text: string) {
        const questionField = nodes(root).find((node) => node.tag === "textarea" && node.properties["aria-label"] === fieldLabel)
        if (!questionField) throw new Error("Question field is not mounted")
        dispatch(questionField, "onInput", { currentTarget: Object.assign(questionField, { value: text }) })
      },
      settle,
      clickQuestion(controlLabel: string) {
        const control = nodes(root).find((node) => node.tag === "button" && (node.properties["aria-label"] === controlLabel || textContent(node) === controlLabel))
        if (!control) throw new Error(`No question control: ${controlLabel}`)
        dispatch(control, "onClick", {})
      },
      resumeOffered: () => nodes(root).some((node) => node.properties["aria-label"] === "Resume"),
      question: () => nodes(root).some((node) => node.properties.class === "command-panel question-panel"),
      publishBackground: (pending: boolean) => setState((current) => ({
        ...current,
        processStatus: {
          activeForegroundBashToolCallIds: [],
          processorHeldToolCallIds: [],
          activeBackgroundCommands: pending ? [{ id: "background", description: "Review", toolUseId: "background", startedAtMs: 1, model: "model" }] : [],
        },
      })),
      text: () => field().properties.value,
      disabled: () => sendButton().properties.disabled,
      editable: () => !field().properties.disabled,
      attachmentCount: () => nodes(root).filter((node) => node.properties.class === "attachment-chip").length,
      type(text: string) {
        dispatch(field(), "onInput", { currentTarget: { value: text, selectionStart: text.length, style: {}, scrollHeight: 20 } })
      },
      send: () => dispatch(sendButton(), "onClick", {}),
      enter: () => key("Enter"),
      remove(name: string) {
        const button = nodes(root).find((node) => node.properties["aria-label"] === `Remove ${name}`)
        if (!button) throw new Error(`No attachment ${name}`)
        dispatch(button, "onClick", {})
      },
      async attach(name: string) {
        const input = nodes(root).find((node) => node.tag === "input" && node.properties.type === "file")
        if (!input) throw new Error("Composer has no file input")
        dispatch(input, "onChange", { currentTarget: { files: [new File(["contents"], name, { type: "text/plain" })], value: name } })
        await settle()
      },
      async accept() { accept(); await settle() },
      /** The runtime's command catalog reaches the session's roster, and the
       *  page's view state is rebuilt from it a moment later, as on a page. */
      async arriveCatalog() {
        roster.accept(published)
        await settle()
        setState((current) => ({ ...current, builtInCommands: roster.builtInCommands, offCommands: roster.offCommands }))
        await settle()
      },
      async refuse(kind?: "handoff") {
        refuse(kind === "handoff" ? new DraftKeptRefusal("This agent has started its handoff and cannot read another message. Your draft was kept.") : new Error("This workflow cannot accept the message"))
        await settle()
      },
      dispose() {
        dispose()
        if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
        else Reflect.deleteProperty(globalThis, "document")
        if (previousResizeObserver) Object.defineProperty(globalThis, "ResizeObserver", previousResizeObserver)
        else Reflect.deleteProperty(globalThis, "ResizeObserver")
        if (previousMutationObserver) Object.defineProperty(globalThis, "MutationObserver", previousMutationObserver)
        else Reflect.deleteProperty(globalThis, "MutationObserver")
        if (previousComputedStyle) Object.defineProperty(globalThis, "getComputedStyle", previousComputedStyle)
        else Reflect.deleteProperty(globalThis, "getComputedStyle")
      },
    }
  })
}
