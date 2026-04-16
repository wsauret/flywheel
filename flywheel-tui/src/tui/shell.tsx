/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, For, Show, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createTextAttributes } from "@opentui/core"
import type { TextareaRenderable, TextareaAction } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { useSession } from "@tui/shared/context/session"
import { Clipboard } from "./utils/clipboard.js"
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
import type { RunnerErrorResult } from "../orchestration/session/types.js"

export function FlywheelShell(props: { factories: WorkflowSessionFactories; projectCwd: string; showThinking?: boolean }) {
  const { theme, syntax } = useTheme()
  const toast = useToast()
  const { manager, refreshList, sessions } = useSession()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  const sessionStore = createSessionStore(props.factories)

  const { signals, services } = createShellState({
    sessionStore,
    manager,
    sessions,
    refreshList,
    setTerminalTitle: (t: string) => renderer.setTerminalTitle(t),
    showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => toast.show(opts),
    showThinking: props.showThinking ?? true,
  })

  renderer.setTerminalTitle(TERMINAL_TITLE_BASE)

  const metrics = services.metrics

  const [promptHeight, setPromptHeight] = createSignal(1)

  let promptRef: TextareaRenderable | null = null
  let pasteCollapse: ReturnType<typeof createPasteCollapse> | null = null

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
      services.refreshList()
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

  const { displayStatus, headerRight, headerRightColor, stepDisplay } = createHeaderDisplay({
    signals,
    metrics,
    dimensions,
    inChat,
    runningCount,
    theme,
  })

  const showPrompt = createMemo(() => !sessionModal.sessionsModalOpen())

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
    return `${activityLabel()!} (${formatElapsed(metrics.elapsed())})`
  })

  return (
    <box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={theme.background} onMouseUp={() => {
        const text = renderer.getSelection()?.getSelectedText()
        if (!text) return
        Clipboard.copy(text)
          .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
          .catch((err) => toast.show({ message: errorMessage(err), variant: "error" }))
        renderer.clearSelection()
      }}>

      <box flexShrink={0} flexDirection="column" backgroundColor={theme.backgroundPanel} {...SplitBorder} border={["left"]} borderColor={theme.border}>
        <box flexDirection="row" justifyContent="space-between" paddingTop={1} paddingBottom={stepDisplay().visible.length > 0 ? 0 : 1} paddingLeft={2} paddingRight={1}>
          <box flexDirection="row" flexShrink={1} overflow="hidden">
            <text fg={theme.primary} attributes={createTextAttributes({ bold: true })}>{"\u2699 flywheel"}</text>
            <Show when={signals.sessionTitle()}>
              <text fg={theme.textMuted}>{" \u00b7 "}</text>
              <text fg={theme.text}>{signals.sessionTitle()}</text>
            </Show>
          </box>
          <Show when={headerRight()}>
            <text fg={headerRightColor()} flexShrink={0}>{" "}{headerRight()}</text>
          </Show>
        </box>
        <Show when={stepDisplay().visible.length > 0}>
          <box paddingLeft={2} paddingRight={1} paddingBottom={1} flexDirection="row" overflow="hidden">
            <Show when={stepDisplay().collapsedCount > 0}>
              <text fg={theme.success} attributes={createTextAttributes({ dim: true })}>{stepDisplay().collapsedCount} done</text>
            </Show>
            <For each={stepDisplay().visible}>
              {(step, i) => {
                const showSep = i() > 0 || stepDisplay().collapsedCount > 0
                const stepColor = step.status === "completed" ? theme.success : step.status === "running" ? theme.primary : step.status === "failed" ? theme.error : theme.textMuted
                const attrs = step.status === "running" ? createTextAttributes({ bold: true }) : (step.status === "completed" || step.status === "failed") ? undefined : createTextAttributes({ dim: true })
                const prefix = step.status === "completed" ? "\u2713 " : step.status === "failed" ? "\u2717 " : ""
                return (
                  <box flexDirection="row">
                    {showSep ? <text fg={theme.textMuted} attributes={createTextAttributes({ dim: true })}>{" \u203a "}</text> : null}
                    <text fg={stepColor} attributes={attrs}>
                      {prefix}{step.title}{step.status === "running" && step.startedAt ? ` ${formatElapsed(now() - step.startedAt)}` : ""}
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </box>

      <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={1} paddingBottom={1} gap={1}>


        <Show when={signals.pendingWorkCommand()}>
          <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
            <text fg={theme.primary} attributes={createTextAttributes({ bold: true })}>
              {signals.pendingWorkCommand() === "sprint" ? "Sprint Mode" : "Work Mode"}
            </text>
            <text fg={theme.textMuted}>Describe what you'd like to work on</text>
          </box>
        </Show>

        <Show when={signals.errorMessage()}>
          <scrollbox flexGrow={1}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.error} attributes={createTextAttributes({ bold: true })}>Error</text>
              <text fg={theme.error}>{signals.errorMessage()}</text>
              <text fg={theme.textMuted}>
                {signals.sessionState() === "paused"
                  ? "Press Enter to retry, or Esc to stop"
                  : "Press Ctrl+N to start fresh"}
              </text>
            </box>
          </scrollbox>
        </Show>

        <Show when={signals.sessionState() !== null && !signals.pendingWorkCommand()}>
          <OutputWindow
            outputBlocks={signals.outputBlocks()}
            workflowStatus={displayStatus()}
          />
        </Show>
      </box>

      <box flexShrink={0}>
        <Show when={showPrompt()}>
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}
            backgroundColor={theme.backgroundElement} border={["left"]} borderColor={theme.primary}
            onMouseDown={() => promptRef?.focus?.()}>
            <textarea
              ref={(r: TextareaRenderable) => {
                promptRef = r
                pasteCollapse = createPasteCollapse(r, syntax)
                r.onPaste = (event) => pasteCollapse!.handlePaste(event)
                r.onContentChange = () => setPromptHeight(Math.min(3, Math.max(1, r.editorView.getTotalVirtualLineCount())))
                queueMicrotask(() => r?.focus?.())
              }}
              width={lineWidth()} height={promptHeight()} wrapMode="word"
              placeholder={
                signals.pendingWorkCommand()
                  ? "What would you like to work on?"
                  : inChat()
                    ? (signals.agentState() === "active" ? "Type to steer the conversation..." : "Send a message (/new for fresh chat)")
                    : signals.agentState() === "active"
                      ? "Send a message to guide the agent (Esc to interrupt)"
                      : signals.sessionState() === "paused"
                        ? "Send a message to resume, or Esc to force stop"
                        : "Send a message..."
              }
              backgroundColor="transparent" focusedBackgroundColor="transparent"
              onSubmit={() => { const v = pasteCollapse?.expandForSubmit() ?? promptRef?.plainText ?? ""; commands.handlePromptSubmit(v); promptRef?.clear(); setPromptHeight(1) }}
              keyBindings={[
                { name: "return", action: "submit" as TextareaAction },
                { name: "z", ctrl: true, action: "undo" as TextareaAction },
                { name: "z", meta: true, action: "undo" as TextareaAction },
                { name: "y", ctrl: true, action: "redo" as TextareaAction },
              ]}
            />
          </box>
        </Show>
      </box>

      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <box flexDirection="row" gap={1} flexShrink={1} overflow="hidden">
          <Show when={promptStatusLabel() && showPrompt()}>
            <Spinner color={theme.primary} />
            <ShimmerText text={promptStatusLabel()!} color={theme.primary} />
          </Show>
        </box>
        <box flexDirection="row" flexShrink={0}>
          <Show when={signals.agentState() === "active"}>
            <text fg={theme.textMuted}>{"Esc interrupt \u00b7 "}</text>
          </Show>
          <Show when={signals.sessionState() === "paused"}>
            <text fg={theme.textMuted}>{"Esc exit \u00b7 Ctrl+R resume \u00b7 "}</text>
          </Show>
          <text fg={theme.textMuted} onMouseDown={() => { chat.backgroundChat(); chat.startChat() }}>
            {"Ctrl+N new"}
          </text>
          <text fg={theme.textMuted}>
            {sessions().filter(s => s.state === "active" || s.state === "paused").length >= 2 ? " \u00b7 Tab" : ""}
            {" \u00b7 "}
          </text>
          <text fg={theme.textMuted} onMouseDown={() => sessionModal.openSessionsModal()}>
            {sessions().length > 0
              ? `Ctrl+B ${sessions().length} session${sessions().length === 1 ? "" : "s"}`
              : "Ctrl+B sessions"}
          </text>
        </box>
      </box>

      <ToastDisplay headerHeight={stepDisplay().visible.length > 0 ? 4 : 3} />

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
