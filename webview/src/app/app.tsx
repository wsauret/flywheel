import { createEffect, createSignal, ErrorBoundary, For, on, onCleanup, onMount, Show, type Component } from "solid-js"

import { Dynamic } from "solid-js/web"
import { webModuleEnabled, type WebModule } from "../web-module.js"

import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createSurfaceOpener, type CaptureSurfaceOpener, type SurfaceOpening } from "../../../src/protocol/client/surface-presentation.js"
import type { ClientActions } from "../client/actions.js"
import { actionKey } from "../client/action-key.js"
import type { ReadingPlace } from "../client/reading-place.js"
import type { RuntimeSession } from "../client/session.js"
import { createViewProjection, summaryOf } from "../client/view-state.js"
import { createQuestionPager } from "../client/question-pager.js"
import type { ClientCommand, ClientSheetId, SheetFocus } from "../../../src/protocol/client/host-contract.js"
import { createWebSurfaces } from "./surfaces.js"
import type { ClientHost } from "../host.js"
import type { ModuleId } from "../../../src/protocol/module-ids.js"
import { WEB_MODULES } from "../modules.js"
import { describeFailure } from "../client/failure-message.js"
import { ClientContext, type ClientContextValue, type PromptRequest } from "./client-context.js"
import { createConfirmationQueue } from "./confirmation-queue.js"
import { observeLoginQuestions } from "./login-question.js"
import type { ComposerHandle } from "./composer.js"
import { ConversationBody } from "./conversation-body.js"
import { RuntimeFaultNotice } from "./composer-status.js"
import { FindBar } from "./find-bar.js"
import { ConfirmDialog, PromptDialog, Toasts, type Toast } from "./dialogs.js"
import { PersistentPane } from "./persistent-pane.js"
import { clampRailWidth, readRailLayout, writeRailLayout } from "./rail-layout.js"
import { agentMoveFor, chordFor } from "./shortcuts.js"
import { createModuleHostPresence } from "./module-host-presence.js"
import { SessionRail } from "./session-rail.js"
import { createWorkspaceNavigation } from "./workspace-navigation.js"
import { SessionNotices } from "./session-notices.js"
import { SessionsScreen } from "./sessions-screen.js"
import { BackgroundSheet } from "./sheets/background-sheet.js"
import { CapabilitiesSheet } from "./sheets/capabilities-sheet.js"
import { ChangesSheet } from "./sheets/changes-sheet.js"
import { CommandsSheet } from "./sheets/commands-sheet.js"
import { ModelSheet } from "./sheets/model-sheet.js"
import { ModelsSheet } from "./sheets/models-sheet.js"
import { ProfilesSheet } from "./sheets/profiles-sheet.js"
import { ProviderModelsSheet } from "./sheets/provider-models-sheet.js"
import { ProvidersSheet } from "./sheets/providers-sheet.js"
import { SessionsSheet } from "./sheets/sessions-sheet.js"
import { SettingsSheet } from "./sheets/settings-sheet.js"
import { ShortcutsSheet } from "./sheets/shortcuts-sheet.js"
import { StatusSheet } from "./sheets/status-sheet.js"
import { NeedsProviderStage, StartingStage } from "./stages.js"
import { Toolbar } from "./toolbar.js"
import { ClientExtensionsProvider } from "./client-extensions.js"
import { ModuleStrips } from "./module-strips.js"
import "../styles/tokens.css"
import "../styles/base.css"
import "../styles/app.css"
import type { ComposerCheckpoint } from "../client/input-reload-checkpoint.js"
import { createComposerReturns } from "../../../src/protocol/client/composer-returns.js"

/** The width at which the session list stops being a screen and becomes a
 *  rail. The same threshold the stylesheet's container query uses; the script
 *  needs it too, because which surface opens the list is a decision, not a
 *  style. */
const WIDE_PX = 640

/** How long a transient message stays up. Long enough to read a sentence, short
 *  enough that a burst of them does not wall off the transcript. */
const TOAST_MS = 6_000

/** A tap outside every field and control puts the keyboard away, the way a
 *  native app does. Safari leaves a focused field focused when a tap lands on
 *  plain content, so the keyboard would otherwise stay up until its own
 *  accessory bar is used. Controls keep focus where it is: tapping Answer or a
 *  choice must not first drop the keyboard the field still needs. Only a tap
 *  counts: a touch that becomes a scroll ends in `pointercancel`, never
 *  `pointerup`, so a person can scroll to a field the keyboard covers. */
interface KeyboardDismissal {
  readonly onPointerDown: (event: PointerEvent) => void
  readonly onPointerUp: (event: PointerEvent) => void
  readonly onPointerCancel: () => void
}

function dismissKeyboardOutside(): KeyboardDismissal {
  let pending: number | undefined
  return {
    onPointerDown(event) {
      pending = event.pointerType === "touch" ? event.pointerId : undefined
    },
    onPointerUp(event) {
      if (event.pointerId !== pending) return
      pending = undefined
      const active = document.activeElement
      if (!(active instanceof HTMLElement)) return
      const editable = active.matches("input, textarea, [contenteditable]")
      if (!editable) return
      const target = event.target
      if (target instanceof Element && target.closest("input, textarea, [contenteditable], button, [role='button'], [role='option'], a")) return
      active.blur()
    },
    onPointerCancel() {
      pending = undefined
    },
  }
}

/** Whether keys pressed at `target` type into a text field. */
function typingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable]") !== null
}

export interface AppProps {
  readonly inputCheckpoint?: ComposerCheckpoint
  readonly onComposer?: (handle: ComposerHandle) => void
  readonly host: ClientHost
  readonly session: RuntimeSession
  readonly connection: RuntimeConnection
  readonly actions: ClientActions
  readonly readingPlace: ReadingPlace
  readonly onCommand: (listener: (command: ClientCommand) => void) => () => void
  readonly onReport: (listener: (severity: "info" | "warning", message: string) => void) => () => void
  readonly onCaptureSurfaceOpener: (listener: CaptureSurfaceOpener) => () => void
}

/** The client's root.
 *
 *  It owns the one reactive frame the components read, the overlays (sheets,
 *  dialogs, toasts), the container-width decision, and the host command
 *  routing. It renders what the reconciler settled and nothing it derived on
 *  its own: ordering, recovery, and session state arrive settled. */
export function App(props: AppProps) {
  const lifetime = new AbortController()
  const composerReturns = createComposerReturns({
    client: props.connection,
    ownsSubmission: (id) => props.session.ownsSubmission(id),
    settled: (ids) => props.session.settleReturned(ids),
    append: (sessionId, item) => { composer?.appendInput(sessionId, item.input); report("info", `${item.sourceName} finished. Its unread message is in the parent chat transcript and composer.`) },
    report: (message) => report("warning", message),
  })
  onCleanup(composerReturns.dispose)
  onCleanup(props.session.onTranscriptChange?.(composerReturns.observe) ?? (() => {}))
  onMount(() => {
    createEffect(() => { const id = state().rootSessionId; composerReturns.own(id ? [id] : []) })
  })
  const [attention, setAttention] = createSignal<{ readonly sessionId: string; readonly sequence: number } | undefined>(props.host.initialAttention && props.host.initialSessionId ? { sessionId: props.host.initialSessionId, sequence: 1 } : undefined)
  const keyboardDismissal = dismissKeyboardOutside()
  onCleanup(() => lifetime.abort())
  const projectFrame = createViewProjection()
  const [state, setState] = createSignal(projectFrame(props.session))
  // Coalesces bursts into one paint. A streaming turn publishes a delta per
  // token, and rebuilding the frame for each one spends more time in the
  // projection than in the renderer.
  let pending: ReturnType<typeof setTimeout> | undefined
  let painted = { sessionId: props.session.sessionId, opening: props.session.opening, localSubmissions: props.session.localSubmissions }
  const paint = (): void => {
    if (pending !== undefined) clearTimeout(pending)
    pending = undefined
    painted = { sessionId: props.session.sessionId, opening: props.session.opening, localSubmissions: props.session.localSubmissions }
    setState(projectFrame(props.session))
    publishSummary()
  }
  const stopWatching = props.session.onChange(() => {
    // A move to another destination, and a message sent or taken back, paint
    // in the tap that asked for it, so the pane answers in the frame the
    // finger lifts.
    const moved = props.session.sessionId !== painted.sessionId || props.session.opening !== painted.opening
    if (moved || props.session.localSubmissions !== painted.localSubmissions) { paint(); return }
    if (pending !== undefined) return
    pending = setTimeout(paint, 16)
  })
  onCleanup(() => {
    stopWatching()
    if (pending !== undefined) clearTimeout(pending)
  })

  // The host paints a status bar or a title from this. Published from the same
  // frame the components render, never diffed and never from a separate
  // listener, because the host's own state is a projection of the client's and
  // must never lag it or run ahead of it.
  function publishSummary(): void {
    const frame = state()
    props.host.onSummary?.({
      health: frame.health,
      ready: frame.stage !== "starting",
      sessionId: frame.sessionId,
      rootSessionId: frame.rootSessionId,
      sessionTitle: summaryOf(frame, frame.sessionId)?.title,
      executionCwd: frame.executionCwd,
      activity: frame.activity,
      busy: frame.busy,
      budget: frame.budget,
      hasUsableProvider: frame.stage !== "needs_provider",
      providers: frame.providers,
      changes: frame.changes?.summary,
      ...(frame.settings?.moduleIds === undefined ? {} : { moduleIds: frame.settings.moduleIds }),
    })
  }
  publishSummary()

  // Find is a pane-level surface: one bar, opened by chord or command, and
  // the one block it last landed on for the transcript to light. An opening
  // with a query starts a new search; one without keeps the bar as it is.
  const [finding, setFinding] = createSignal<{ readonly query: string } | undefined>()
  const openFind = (query?: string): void => { setFinding((current) => (query === undefined ? current ?? { query: "" } : { query })) }
  const [markedBlock, setMarkedBlock] = createSignal<string | undefined>()
  const closeFind = (): void => { setFinding(undefined); composer?.focus() }

  const [wide, setWide] = createSignal(false)
  const [workspaceFits, setWorkspaceFits] = createSignal(false)
  let root: HTMLDivElement | undefined
  let pane: HTMLDivElement | undefined
  let workspaceFit: HTMLDivElement | undefined
  onMount(() => {
    if (!root || !pane || !workspaceFit) return
    const observer = new ResizeObserver(() => {
      setWide(root!.clientWidth >= WIDE_PX)
      // Sum both columns so opening the panel cannot change its own admission.
      const available = pane!.getBoundingClientRect().width + (root!.querySelector(".workspace-panel")?.getBoundingClientRect().width ?? 0)
      setWorkspaceFits(available >= workspaceFit!.getBoundingClientRect().width)
    })
    observer.observe(root)
    observer.observe(pane)
    observer.observe(workspaceFit)
    onCleanup(() => observer.disconnect())
  })

  // The rail is furniture the person arranges: dragged to a width, folded
  // away with the toolbar's button or Mod+B, and found the same way next
  // time in this browser. Both choices are one signal and one storage write.
  const [rail, setRail] = createSignal(readRailLayout(localStorage))
  const arrangeRail = (next: Partial<ReturnType<typeof rail>>): void => {
    const layout = { ...rail(), ...next }
    setRail(layout)
    writeRailLayout(localStorage, layout)
  }
  const toggleRail = (): void => { arrangeRail({ collapsed: !rail().collapsed }) }
  // The chords the shell answers from anywhere, read off the one table the
  // shortcuts sheet lists. A chord lands wherever the keyboard is, sheet or
  // composer included, because none of them types a character.
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = chordFor(event)
      if (shortcut === undefined || (shortcut.wide && !wide())) return
      event.preventDefault()
      if (shortcut.chord === "b") toggleRail()
      else if (shortcut.chord === "k") openSheet("sessions")
      else if (shortcut.chord === "/") openSheet("shortcuts")
      else if (shortcut.chord === "f") openFind()
    }
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => document.removeEventListener("keydown", onKeyDown))
  })
  /** Drags the rail's edge. Pointer capture keeps the drag alive when the
   *  pointer outruns the handle, and the width is clamped so the transcript
   *  is never squeezed out. A double click returns to the stylesheet's rung. */
  const resizeRail = (event: PointerEvent & { readonly currentTarget: HTMLElement }): void => {
    if (!root || event.button !== 0) return
    const handle = event.currentTarget
    const left = root.getBoundingClientRect().left
    handle.setPointerCapture(event.pointerId)
    const move = (moving: PointerEvent): void => { arrangeRail({ width: clampRailWidth(moving.clientX - left) }) }
    const stop = (): void => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", stop)
      handle.removeEventListener("pointercancel", stop)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", stop)
    handle.addEventListener("pointercancel", stop)
    event.preventDefault()
  }

  const { stage: hostStage, placement, reach, stack } = createModuleHostPresence(
    WEB_MODULES, props.host, () => state().settings?.moduleIds,
    (module, error) => report("warning", `The ${module.id} module could not show its host: ${describeFailure(error)}`),
    {
      selection: {
        addressed: props.host.initialSessionId,
        selectedSessionId: () => state().sessionId,
        selectSession: props.actions.selectSession,
        // The open chat's parent is known from the tap before its row is.
        parentSessionId: (sessionId) => sessionId === state().sessionId ? state().parentSessionId : summaryOf(state(), sessionId)?.parentSessionId,
      },
      appeared: () => { props.connection.appeared() },
    },
  )
  createEffect(() => {
    const current = stack()
    if (current && root) onCleanup(current.bindSwipe(root))
  })

  const navigation = createWorkspaceNavigation(() => wide() && workspaceFits() && stack() === undefined)
  const sheet = navigation.sheet
  const [sheetFocus, setSheetFocus] = createSignal<SheetFocus | undefined>(undefined)
  let surfaceIntent = 0
  const openSheet = (next: ClientSheetId, focus?: SheetFocus) => {
    surfaceIntent++
    // On the phone the list is a screen, not a sheet.
    if (next === "sessions" && stack()) { stack()?.showSessions(); return }
    setModuleSheet(undefined)
    setSheetFocus(focus)
    navigation.open(next)
  }
  const closeSheet = () => {
    if (!moduleSheet()) navigation.closeSheet()
    setModuleSheet(undefined)
    setSheetFocus(undefined)
  }
  const confirmations = createConfirmationQueue()
  const confirmRequest = confirmations.current
  const [promptRequest, setPromptRequest] = createSignal<{ readonly request: PromptRequest; readonly settle: (value: string | undefined) => void } | undefined>(undefined)
  const [toasts, setToasts] = createSignal<readonly Toast[]>([])
  let nextToast = 1
  const dismissToast = (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id))
  const report = (severity: "info" | "warning", message: string) => {
    const id = nextToast++
    setToasts((current) => [...current, { id, severity, message }])
    setTimeout(() => dismissToast(id), TOAST_MS)
  }
  onCleanup(props.onReport(report))

  let composer: ComposerHandle | undefined
  // The surfaces a runtime command outcome can open, by the id the runtime
  // names: the client's own sheets plus every registered module surface. A
  // module sheet mounts where the kernel sheets do; a module focus is the
  // module's own to open.
  const [moduleSheet, setModuleSheet] = createSignal<{ readonly moduleId: ModuleId; readonly sheet: Component } | undefined>(undefined)
  const moduleSurfaces = new Map<string, () => void>(WEB_MODULES.flatMap((module: WebModule) => (module.surfaces ?? []).map((surface) =>
    [surface.id, () => {
      if (!webModuleEnabled(module.id, state().settings?.moduleIds)) return
      if ("sheet" in surface) { navigation.clearModal(); setModuleSheet({ moduleId: module.id, sheet: surface.sheet }) }
      else surface.open()
    }] as const)))
  createEffect(on(() => state().settings?.moduleIds, (moduleIds) => {
    const current = moduleSheet()
    if (current && !webModuleEnabled(current.moduleId, moduleIds)) setModuleSheet(undefined)
  }))
  // Every surface a command names opens through the one table, whether a
  // menu entry, a typed token, a host palette command, or a runtime outcome
  // asked for it.
  const surfaceFor = createWebSurfaces(() => context, new Map([...moduleSurfaces].map(([id, open]) => [id, () => { surfaceIntent++; open() }])))
  const openSurface = (id: string, opening?: SurfaceOpening) => surfaceFor(id)?.open(opening)
  const captureSurfaceOpener = createSurfaceOpener({
    sessionId: () => props.session.sessionId,
    placement: () => props.session.navigationVersion,
    surfaces: () => [sheet(), moduleSheet(), navigation.panel(), surfaceIntent],
    openSurface: (id, _isCurrent, opening) => openSurface(id, opening),
  })
  onCleanup(props.onCaptureSurfaceOpener(captureSurfaceOpener))

  const clients = WEB_MODULES.flatMap((module: WebModule) => module.createClient ? [module.createClient({
    state, connection: props.connection, actions: props.actions, session: props.session, report,
    selectSession: props.actions.selectSession,
  })] : [])
  const coversConversation = () => clients.some(client => client.coversConversation())
  const conversationInput = () => clients.map(client => client.input()).find(input => input !== undefined)
  const provide = (index: number, children: () => import("solid-js").JSX.Element): import("solid-js").JSX.Element =>
    index === clients.length ? children() : clients[index]!.provide(() => provide(index + 1, children))
  // `[` and `]` move the agent view to the previous or next row while no
  // text field has focus, so they never take a typed bracket.
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const direction = agentMoveFor(event)
      if (direction === undefined || typingTarget(event.target) || !clients.some(client => client.move(direction))) return
      event.preventDefault()
    }
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => document.removeEventListener("keydown", onKeyDown))
  })

  const context: ClientContextValue = {
    signal: lifetime.signal,
    host: props.host,
    connection: props.connection,
    actions: props.actions,
    state,
    submissionHeld: () => takesOver(),
    changes: () => { state(); return props.session.changes },
    report,
    openSheet,
    closeSheet,
    retryLoginQuestion: (questionId) => { loginQuestions.release(questionId) },
    sheetFocus,
    confirm: confirmations.confirm,
    prompt: (request, signal) => new Promise((settle) => {
      if (signal?.aborted) { settle(undefined); return }
      const finish = (value: string | undefined) => {
        signal?.removeEventListener("abort", cancel)
        setPromptRequest((current) => current?.settle === finish ? undefined : current)
        settle(value)
      }
      const cancel = () => finish(undefined)
      signal?.addEventListener("abort", cancel, { once: true })
      setPromptRequest({ request, settle: finish })
    }),
    focusComposer: () => composer?.focus(),
    insertText: (text) => composer?.insertText(text),
    recallLocal: (entryId) => composer?.recallLocal(entryId),
    openFind,
    openMentions: () => composer?.openMentions(),
    pickFiles: () => composer?.pickFiles(),
    openSurface,
    surface: surfaceFor,
    markedBlock,
    markBlock: setMarkedBlock,
    readingPlace: props.readingPlace,
    residents: props.session,
    sessionDetails: { get: props.session.sessionDetail, subscribe: props.session.subscribeSessionDetail },
    attention,
    get stack() { return stack() },
  }

  const loginQuestions = observeLoginQuestions({
    auth: () => state().authStatus?.auth,
    confirm: context.confirm,
    open: (question) => openSheet("providers", { kind: "reconnect-account", question }),
    decline: async (question) => { await props.connection.dispatch({ type: "auth.login.decline", providerId: question.providerId, loginQuestionId: question.questionId }) },
    failed: (cause) => report("warning", `Flywheel could not answer the login question: ${describeFailure(cause)}`),
  })

  /** Shows a session that something outside the page named, such as a host
   *  or a clicked notification: on the phone as the chat screen, elsewhere
   *  in the pane. A workflow shows its full-size card over its chat. */
  const openSession = (sessionId: string) => {
    const current = stack()
    if (current) current.openChat(sessionId)
    else props.actions.selectSession(sessionId)
  }
  /** Opens the session that asks and brings its question into view, over
   *  any module place that covers its conversation. */
  const attendQuestion = (sessionId: string) => {
    closeSheet()
    setFinding(undefined)
    for (const client of clients) client.reveal?.(sessionId)
    openSession(sessionId)
    setAttention((previous) => ({ sessionId, sequence: (previous?.sequence ?? 0) + 1 }))
  }
  createQuestionPager({ state, session: props.session, connection: props.connection, attend: attendQuestion })
  onCleanup(props.onCommand((command) => {
    if (clients.some(client => client.command?.(command))) return
    switch (command.type) {
      case "focusComposer": composer?.focus(); return
      case "insertText": composer?.insertText(command.text); return
      case "openCommands": composer?.openCommands(); return
      case "send": props.actions.send(command.text); return
      case "newSession": props.actions.newSession(); return
      // A host names a session by id, from an address or a palette; one the
      // runtime does not list is nothing to select, not a transcript to open.
      case "selectSession": openSession(command.sessionId); return
      case "attendQuestion": attendQuestion(command.sessionId); return
      case "compact": props.actions.compact(); return
      case "interrupt": props.actions.interrupt(); return
      case "invokeCommand": props.actions.invokeCommand(command.id); return
      case "reconnect": props.actions.reconnect(); return
      case "openSheet": openSheet(command.sheet, command.focus); return
      case "openSurface": openSurface(command.surface); return
    }
  }))

  /** Whether a stage holds the conversation's actions: the page needs a
   *  runtime or a provider before a send can go out. */
  const takesOver = () => hostStage() !== undefined || state().stage === "starting" || state().stage === "needs_provider"
  const hasProject = () => state().projectRoot !== undefined
  /** The host's stage, when the pane shows it. With a known project it is
   *  advice for a runtime that does not answer, so it comes with the
   *  connection's fault notice: a presence report alone, such as during a
   *  short freeze of the machine, leaves the chat as it is. */
  const shownHostStage = () => hasProject() && state().health.kind === "healthy" ? undefined : hostStage()
  /** The cold loading screen, for a page with nothing to show yet. A reload
   *  or a reopened tab that took over waiting messages shows their chat with
   *  them queued instead, however long its project takes to answer. */
  const coldStart = () => state().stage === "starting" && state().localSubmissions.length === 0
  const staged = () => shownHostStage() !== undefined || coldStart() || state().stage === "needs_provider"
  const viewError = () => {
    const module: WebModule | undefined = WEB_MODULES.find((entry: WebModule) => entry.viewError && webModuleEnabled(entry.id, state().settings?.moduleIds))
    return module?.viewError?.component
  }
  const stacked = () => stack() !== undefined && !wide() && hasProject()
  const stackX = () => {
    const current = stack()
    if (!current) return undefined
    const drag = current.dragX()
    if (drag !== undefined) return `${drag}px`
    return current.screen() === "chat" ? "0px" : "100%"
  }

  return (
    <ClientContext.Provider value={context}>
      <ClientExtensionsProvider value={clients}>
      {provide(0, () =>
      <div
        class="client"
        ref={(el) => { root = el }}
        classList={{ wide: wide(), stack: stacked(), dragging: stack()?.dragX() !== undefined, "standard-diffs": state().settings?.diffColors === "standard" }}
        style={{ "--fw-stack-x": stackX(), "--fw-rail-width": rail().width === undefined ? undefined : `${rail().width}px` }}
        onPointerDown={keyboardDismissal.onPointerDown}
        onPointerUp={keyboardDismissal.onPointerUp}
        onPointerCancel={keyboardDismissal.onPointerCancel}
      >
        <For each={WEB_MODULES}>
          {(module: WebModule) => <Show when={webModuleEnabled(module.id, state().settings?.moduleIds) && module.notice}>{(Notice) =>
            <ErrorBoundary fallback={(error: unknown) => { report("warning", `A module could not show its host: ${describeFailure(error)}`); return null }}><Dynamic component={Notice()} visible={(hasProject() || !takesOver()) && !moduleSheet()} /></ErrorBoundary>
          }</Show>}
        </For>
        <div class="client-content">
        <Show when={wide() && hasProject() && !rail().collapsed}>
          <SessionRail />
          <div
            class="rail-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the session list"
            title="Drag to resize. Double-click to reset."
            onPointerDown={resizeRail}
            onDblClick={() => arrangeRail({ width: undefined })}
          />
        </Show>
        <Show when={stacked()}>
          <SessionsScreen />
        </Show>
        <div class="workspace-fit" ref={element => { workspaceFit = element }} aria-hidden="true" />
        <div class="pane" ref={element => { pane = element }} inert={stacked() && stack()?.screen() === "sessions" && stack()?.dragX() === undefined}>
          <PersistentPane
            active={!staged()}
            advisory={hasProject()}
            takeover={
              <>
                <Show when={shownHostStage()}>{(Stage) => <ErrorBoundary fallback={(error: unknown) => {
                  report("warning", `A module could not show its host: ${describeFailure(error)}`)
                  return <Show when={viewError()} fallback={<div class="sheet-problem">This view is unavailable.</div>}>{(Fallback) => <Dynamic component={Fallback()} error={error} />}</Show>
                }}><Dynamic component={Stage()} /></ErrorBoundary>}</Show>
                <Show when={!shownHostStage() && coldStart()}><StartingStage placement={placement()} /></Show>
                <Show when={!shownHostStage() && state().stage === "needs_provider"}><NeedsProviderStage /></Show>
              </>
            }
          >
              <ConversationBody
                register={(handle) => { composer = handle; if (props.inputCheckpoint) handle.adopt(props.inputCheckpoint); props.onComposer?.(handle) }}
                input={conversationInput}
                transcriptHidden={coversConversation()}
                composerHidden={coversConversation() || conversationInput()?.hidden}
                phoneSelection={stack() !== undefined && (!stacked() || stack()?.screen() === "chat")}
                header={<>
                  <Toolbar wide={wide() && !rail().collapsed} rail={wide() ? { collapsed: rail().collapsed, toggle: toggleRail } : undefined} modules={WEB_MODULES}
                    />
                  <RuntimeFaultNotice reach={reach()} modules={WEB_MODULES} />

                  {/* What the runtime wants the user to know about this session.
                      Above the transcript because it is about the session as a whole. */}
                  <SessionNotices
                    notices={state().notices}
                    hasHostCommand={props.actions.hasHostCommand}
                    runHostCommand={props.actions.runHostCommand}
                    dismiss={props.actions.dismissNotice}
                    dismissing={(scope) => props.actions.working(actionKey("dismiss-notice", state().sessionId, scope))}
                  />

                  {/* Module strips belong to the open session and remount with it. */}
                  <Show when={state().sessionId} keyed>
                    {(sessionId) => <ModuleStrips modules={WEB_MODULES} sessionId={sessionId} report={(module, error) => report("warning", `The ${module.id} module could not draw its strip: ${describeFailure(error)}`)} />}
                  </Show>

                  <Show when={finding()} keyed>{(find) => <FindBar query={find.query} onClose={closeFind} />}</Show>
                  <For each={clients}>{client => <>{client.header()}{client.surface()}</>}</For>
                </>}
              />
          </PersistentPane>
        </div>

        {/* Session-scoped reads and subscriptions restart only when selection changes. */}
        <Show when={hasProject() && navigation.panel()} keyed>
          {id => <For each={[state().sessionId]}>
            {() => id === "changes" ? <ChangesSheet docked onClose={navigation.closePanel} /> : id === "background" ? <BackgroundSheet docked onClose={navigation.closePanel} /> : <StatusSheet docked onClose={navigation.closePanel} />}
          </For>}
        </Show>

        </div>
        <Toasts toasts={toasts()} onDismiss={dismissToast} />
        {/* Keyed: a sheet that opens another sheet changes one truthy id to
            another, which a non-keyed Show would never re-render. */}
        <Show when={!moduleSheet() && sheet()} keyed>
          {(id) => {
            switch (id) {
              case "sessions": return <SessionsSheet />
              case "status": return <StatusSheet />
              case "capabilities": return <CapabilitiesSheet />
              case "model": return <ModelSheet />
              case "providers": return <ProvidersSheet />
              case "profiles": return <ProfilesSheet />
              case "models": return <ModelsSheet />
              case "provider-models": return <ProviderModelsSheet />
              case "settings": return <SettingsSheet />
              case "background": return <BackgroundSheet />
              case "changes": return <ChangesSheet />
              case "commands": return <CommandsSheet />
              case "shortcuts": return <ShortcutsSheet />
            }
          }}
        </Show>
        <Show when={moduleSheet()} keyed>{(surface) => <surface.sheet />}</Show>
        <Show when={confirmRequest()} keyed>{(request) => <ConfirmDialog request={request.request} onSettle={request.settle} />}</Show>
        <Show when={promptRequest()}>{(request) => <PromptDialog request={request().request} onSettle={request().settle} />}</Show>
      </div>
      )}
      </ClientExtensionsProvider>
    </ClientContext.Provider>
  )
}
