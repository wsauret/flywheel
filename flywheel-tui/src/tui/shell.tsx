/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, on, Show, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { BOLD } from "@tui/shared/ui/text-attributes"
import { StyledText, fg as stFg, dim as stDim } from "@opentui/core"
import type { TextRenderable, TextareaRenderable, TextareaAction, MouseEvent } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { useSession } from "@tui/shared/context/session"
import { Clipboard } from "./utils/clipboard.js"
import { consumeSelectedText } from "./utils/selection.js"
import { registerPreExitCleanup } from "./exit.js"
import { OutputWindow } from "./routes/work/components/output-window.js"
import { SplitBorder } from "./shared/ui/border.js"
import { Spinner } from "@tui/shared/components/spinner"
import { ShimmerText } from "@tui/shared/components/shimmer-text"
import { SessionModal } from "./session-modal.js"
import { ToastDisplay } from "@tui/shared/components/toast-display"
import { createSessionStore } from "../orchestration/session-store.js"
import type { WorkflowSessionFactories } from "../orchestration/session-store-types.js"
import { formatElapsed, TERMINAL_TITLE_BASE } from "../infra/format.js"
import { errorMessage } from "../infra/error-message.js"
import { useWorkflowLifecycle } from "./hooks/use-workflow-lifecycle.js"
import { useChatMode } from "./hooks/use-chat-mode.js"
import { useCommandDispatch } from "./hooks/use-command-dispatch.js"
import { useSessionModal } from "./hooks/use-session-modal.js"
import { createShellState } from "./hooks/shell-state.js"
import { createKeyboardHandler } from "./hooks/use-keyboard-handler.js"
import { createForegroundSwitcher } from "./hooks/use-foreground-switcher.js"
import { createHeaderDisplay } from "./hooks/use-header-display.js"
import { createPasteCollapse } from "./hooks/paste-collapse.js"
import { QuestionDock } from "./routes/work/components/question-dock.js"
import type { RunnerErrorResult } from "../orchestration/session/types.js"

export function FlywheelShell(props: { factories: WorkflowSessionFactories; projectCwd: string; showThinking?: boolean; engineName?: string }) {
  const { theme, syntax } = useTheme()
  const toast = useToast()
  const { manager, sessions } = useSession()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  const sessionStore = createSessionStore(props.factories)

  const { signals, services } = createShellState({
    sessionStore,
    manager,
    sessions,
    setTerminalTitle: (t: string) => renderer.setTerminalTitle(t),
    showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => toast.show(opts),
  })

  renderer.setTerminalTitle(TERMINAL_TITLE_BASE)

  const metrics = services.metrics
  const [promptHeight, setPromptHeight] = createSignal(1)
  let promptRef: TextareaRenderable | null = null
  let pasteCollapse: ReturnType<typeof createPasteCollapse> | null = null
  const draftBySession = new Map<string, string>()

  function recalcPromptHeight(): void {
    if (!promptRef) { setPromptHeight(1); return }
    setPromptHeight(Math.min(3, Math.max(1, promptRef.editorView.getTotalVirtualLineCount())))
  }

  createEffect(on(() => signals.foregroundId(), (fgId, prevFgId) => {
    if (prevFgId && promptRef) {
      const text = promptRef.plainText ?? ""
      if (text) draftBySession.set(prevFgId, text)
      else draftBySession.delete(prevFgId)
    }
    if (promptRef) {
      promptRef.clear()
      const saved = fgId ? draftBySession.get(fgId) : undefined
      if (saved) promptRef.insertText(saved)
    }
    recalcPromptHeight()
  }))

  const switchForeground = createForegroundSwitcher({
    signals,
    services,
    sessions,
    projectCwd: props.projectCwd,
    setTerminalTitle: (t: string) => renderer.setTerminalTitle(t),
  })

  const lifecycleCallbacks = {
    onRunnerDone: () => {
      services.setTerminalTitle(TERMINAL_TITLE_BASE)
    },
    onRunnerError: (_id: string, result: RunnerErrorResult) => {
      signals.setErrorMessage(result.errorMessage)
      services.setTerminalTitle(TERMINAL_TITLE_BASE)
    },
  }

  const workflow = useWorkflowLifecycle({ signals, services, lifecycleCallbacks })

  const chat = useChatMode({ signals, services, projectCwd: props.projectCwd, lifecycleCallbacks })

  const sessionModal = useSessionModal({
    signals,
    services,
    sessions,
    handleResume: workflow.handleResume,
    switchForeground,
    deleteActiveChat: async (sessionId) => {
      await chat.endChat()
      try { services.manager.delete(sessionId) } catch { /* already cleaned up by endChat */ }
      const nextId = services.sessionStore.allIds().find((id) => services.sessionStore.isRunning(id))
      if (nextId) {
        await switchForeground(nextId)
      } else {
        await chat.startChat()
      }
    },
    actionDeps: workflow.actionDeps,
  })

  const inChat = createMemo(() => {
    // chatActive covers the async startup window before the sessionStore entry exists
    if (chat.chatActive()) return true
    return signals.storeEntry()?.kind === "chat"
  })

  chat.startChat()

  const commands = useCommandDispatch({
    signals,
    services,
    inChat,
    startWorkflow: workflow.startWorkflow,
    startTestStep: workflow.startTestStep,
    startChat: chat.startChat,
    backgroundChat: chat.backgroundChat,
    endChat: chat.endChat,
    sendMessage: (text: string) => {
      // If viewing a historical session, commit to it (clear restore snapshot)
      // so the auto-resumed chat stays in the foreground.
      if (sessionModal.isViewingSession()) sessionModal.commitViewedSession()
      chat.sendMessage(text)
    },
    handleResume: workflow.handleResume,
    steerWorkflow: workflow.steerWorkflow,
    openSessionsModal: sessionModal.openSessionsModal,
  })

  const runningCount = sessionStore.runningCount

  const handleKey = createKeyboardHandler({
    signals,
    sessionStore,
    sessions,
    workflow,
    chat,
    sessionModal,
    inChat,
    runningCount,
    switchForeground,
    setTerminalTitle: (t: string) => renderer.setTerminalTitle(t),
    showToast: (opts) => toast.show(opts),
  })
  useKeyboard(handleKey)

  // Async disposal is registered as a pre-exit hook so exitTUI() can await it
  // before destroying the renderer. This prevents data loss (traces, transcripts).
  registerPreExitCleanup(() => sessionStore.disposeAll())
  onCleanup(() => {
    metrics.pauseTimer()
    renderer.setTerminalTitle("")
  })

  // Ticking clock for live elapsed displays (step indicators, prompt status).
  // Separate from useMetrics' timer: this drives wall-clock display in JSX,
  // while useMetrics accumulates active-only time across pause/resume cycles.
  const [now, setNow] = createSignal(Date.now())
  const nowTimer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(nowTimer))

  const lineWidth = createMemo(() => Math.max(dimensions().width - 4, 40))

  const { displayStatus, headerLeftContent, headerRightContent, stepBarContent } = createHeaderDisplay({
    signals,
    metrics,
    dimensions,
    inChat,
    runningCount,
    now,
    engineName: props.engineName,
    theme,
  })

  const showPrompt = createMemo(() => !sessionModal.sessionsModalOpen())

  const errorHints = createMemo(() => {
    if (signals.sessionState() === "paused") {
      return new StyledText([
        stFg(theme.textSubtle)("Ctrl+R"), stDim(stFg(theme.textMuted)(" resume \u00b7 ")),
        stFg(theme.textSubtle)("Esc"), stDim(stFg(theme.textMuted)(" stop")),
      ])
    }
    return new StyledText([
      stFg(theme.textSubtle)("Ctrl+N"), stDim(stFg(theme.textMuted)(" new session \u00b7 ")),
      stFg(theme.textSubtle)("Ctrl+B"), stDim(stFg(theme.textMuted)(" sessions")),
    ])
  })

  const activityLabel = createMemo(() => {
    switch (metrics.liveActivity()) {
      case "thinking": return "Thinking\u2026"
      case "generating": return "Responding\u2026"
      case "tool_executing": return "Working\u2026"
      default: return null
    }
  })

  const promptStatusLabel = createMemo(() => {
    if (signals.agentState() !== "active") return null
    const activity = metrics.liveActivity()
    if (activity === "idle") return null

    // Track `now` to guarantee re-evaluation every second — elapsed() alone
    // doesn't reliably propagate through ShimmerText's animation timeline.
    void now()
    return `${activityLabel()!} (${formatElapsed(metrics.episodeElapsed())})`
  })

  let mouseDownPrevented = false

  return (
    <box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={theme.background}
      onMouseDown={(e: MouseEvent) => { mouseDownPrevented = e.defaultPrevented }}
      onMouseUp={() => {
        if (mouseDownPrevented) { mouseDownPrevented = false; renderer.clearSelection(); return }
        const text = consumeSelectedText(renderer)
        if (!text) return
        Clipboard.copy(text)
          .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
          .catch((err) => toast.show({ message: errorMessage(err), variant: "error" }))
      }}>

      <box flexShrink={0} flexDirection="column" backgroundColor={theme.backgroundPanel} border={["left"]} customBorderChars={SplitBorder.customBorderChars} borderColor={theme.border}>
        <box flexDirection="row" justifyContent="space-between" paddingTop={1} paddingBottom={stepBarContent() ? 0 : 1} paddingLeft={2} paddingRight={1}>
          <box flexShrink={1} overflow="hidden">
            <text ref={(el: TextRenderable) => { createEffect(() => { el.content = headerLeftContent() }) }} overflow="hidden" wrapMode="none" />
          </box>
          <box flexShrink={0}>
            <text ref={(el: TextRenderable) => { createEffect(() => { el.content = headerRightContent() }) }} />
          </box>
        </box>
        <Show when={stepBarContent()}>
          <box paddingLeft={2} paddingRight={1} paddingBottom={1}>
            <text ref={(el: TextRenderable) => { createEffect(() => { const c = stepBarContent(); if (c) el.content = c }) }} overflow="hidden" wrapMode="none" />
          </box>
        </Show>
      </box>

      <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={1} paddingBottom={1} gap={1}>
        <Show when={signals.pendingWorkCommand()}>
          <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
            <text fg={theme.primary} attributes={BOLD}>
              {signals.pendingWorkCommand() === "sprint" ? "Sprint Mode" : "Work Mode"}
            </text>
            <text fg={theme.textMuted}>Describe what you'd like to work on</text>
          </box>
        </Show>

        <Show when={signals.errorMessage()}>
          <scrollbox flexGrow={1}>
            <box flexDirection="column" paddingTop={1}>
              <box border={["left"]} borderColor={theme.error} customBorderChars={SplitBorder.customBorderChars} paddingLeft={2} flexDirection="column" gap={1}>
                <text fg={theme.error} attributes={BOLD}>{"✗"} Something went wrong</text>
                <text fg={theme.text}>{signals.errorMessage()}</text>
              </box>
              <box paddingTop={1} paddingLeft={2}>
                <text ref={(el: TextRenderable) => { createEffect(() => { el.content = errorHints() }) }} />
              </box>
            </box>
          </scrollbox>
        </Show>

        <Show when={signals.sessionState() !== null && !signals.pendingWorkCommand()}>
          <OutputWindow
            outputBlocks={signals.outputBlocks()}
            workflowStatus={displayStatus()}
            showThinking={props.showThinking ?? true}
          />
        </Show>
      </box>

      <box flexShrink={0}>
        <Show when={showPrompt()}>
          <Show when={signals.pendingQuestion()} fallback={
            <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}
              backgroundColor={theme.backgroundElement} border={["left"]} borderColor={theme.primary}
              onMouseDown={() => promptRef?.focus?.()}>
              <textarea
                ref={(r: TextareaRenderable) => {
                  promptRef = r
                  pasteCollapse = createPasteCollapse(r, syntax)
                  r.onPaste = (event) => pasteCollapse!.handlePaste(event)
                  r.onContentChange = recalcPromptHeight
                  queueMicrotask(() => r?.focus?.())
                }}
                width={lineWidth()} height={promptHeight()} wrapMode="word"
                cursorColor={theme.primary}
                placeholder={
                  signals.pendingWorkCommand()
                    ? "What would you like to work on?"
                    : inChat()
                      ? (signals.agentState() === "active" ? "Type to steer the conversation..." : "Send a message (/new for fresh chat)")
                      : signals.agentState() === "active"
                        ? "Send a message to guide the agent (Esc to interrupt)"
                        : signals.sessionState() === "paused"
                          ? "Send a message to resume, or press Esc to stop"
                          : "Send a message..."
                }
                backgroundColor="transparent" focusedBackgroundColor="transparent"
                onSubmit={() => { const v = pasteCollapse?.expandForSubmit() ?? promptRef?.plainText ?? ""; commands.handlePromptSubmit(v); promptRef?.clear(); setPromptHeight(1); const fgId = signals.foregroundId(); if (fgId) draftBySession.delete(fgId) }}
                keyBindings={[
                  { name: "return", shift: true, action: "newline" as TextareaAction },
                  { name: "return", action: "submit" as TextareaAction },
                  { name: "z", ctrl: true, action: "undo" as TextareaAction },
                  { name: "z", meta: true, action: "undo" as TextareaAction },
                  { name: "y", ctrl: true, action: "redo" as TextareaAction },
                ]}
              />
            </box>
          }>
            {(pq) => (
              <QuestionDock
                question={pq()}
                onAnswer={(answers) => chat.answerQuestion(pq().toolUseId, answers)}
                onCancel={() => chat.cancelQuestion(pq().toolUseId)}
              />
            )}
          </Show>
        </Show>
      </box>

      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <box flexDirection="row" gap={1} flexShrink={1} overflow="hidden">
          <Show when={promptStatusLabel() && showPrompt()}>
            <Spinner color={theme.primary} />
            <ShimmerText text={promptStatusLabel()!} color={theme.primary} />
          </Show>
        </box>
        {/* §8b exemption: key hints are UI controls, not selectable content lines.
            Each hint needs its own <box> for conditional rendering / click handlers,
            and the parent's gap={2} spaces them — StyledText can't express layout gap. */}
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={signals.pendingWorkCommand()}>
            <box flexDirection="row"><text fg={theme.textMuted}>Esc</text><text fg={theme.textSubtle}>{" cancel"}</text></box>
          </Show>
          <Show when={!signals.pendingWorkCommand() && signals.agentState() === "active"}>
            <box flexDirection="row"><text fg={theme.textMuted}>Esc</text><text fg={theme.textSubtle}>{" interrupt"}</text></box>
          </Show>
          <Show when={!signals.pendingWorkCommand() && signals.sessionState() === "paused"}>
            <box flexDirection="row"><text fg={theme.textMuted}>Esc</text><text fg={theme.textSubtle}>{" exit"}</text></box>
            <box flexDirection="row"><text fg={theme.textMuted}>Ctrl+R</text><text fg={theme.textSubtle}>{" resume"}</text></box>
          </Show>
          <Show when={!signals.pendingWorkCommand() && signals.sessionState() === "completed"}>
            <box flexDirection="row"><text fg={theme.textMuted}>Esc</text><text fg={theme.textSubtle}>{" dismiss"}</text></box>
          </Show>
          <box onMouseDown={() => { chat.backgroundChat(); chat.startChat() }} flexDirection="row">
            <text fg={theme.textMuted}>Ctrl+N</text><text fg={theme.textSubtle}>{" new"}</text>
          </box>
          <Show when={sessions().filter(s => s.state === "active" || s.state === "paused").length >= 2}>
            <box flexDirection="row"><text fg={theme.textMuted}>Tab</text><text fg={theme.textSubtle}>{" switch"}</text></box>
          </Show>
          <box onMouseDown={() => sessionModal.openSessionsModal()} flexDirection="row">
            <text fg={theme.textMuted}>Ctrl+B</text>
            <text fg={theme.textSubtle}>
              {sessions().length > 0
                ? ` ${sessions().length} session${sessions().length === 1 ? "" : "s"}`
                : " sessions"}
            </text>
          </box>
        </box>
      </box>

      <ToastDisplay headerHeight={stepBarContent() ? 4 : 3} />

      <Show when={sessionModal.sessionsModalOpen()}>
        <SessionModal
          activeSessionId={signals.foregroundId()}
          cursor={sessionModal.modalCursor()}
          confirmDeleteId={sessionModal.modalConfirmDelete()}
          refreshTrigger={sessionModal.modalRefreshTrigger()}
          onClose={sessionModal.closeSessionsModal}
          onSelect={sessionModal.selectModalItem}
        />
      </Show>
    </box>
  )
}
