/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, batch, For, Show, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createTextAttributes } from "@opentui/core"
import type { TextareaRenderable, TextareaAction } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { useSession } from "@tui/shared/context/session"
import { Clipboard } from "./utils/clipboard"
import { registerPreExitCleanup } from "./exit"
import { OutputWindow } from "./routes/work/components/output-window"
import { SplitBorder } from "./shared/ui/border"
import { Spinner } from "@tui/shared/components/spinner"
import { ShimmerText } from "@tui/shared/components/shimmer-text"
import { SessionModal } from "./session-modal"
import { createSessionStore } from "../orchestration/session-store"
import type { WorkflowSessionFactories } from "../orchestration/workflow-session"
import { loadSessionOutput } from "../orchestration/session-actions.js"
import type { SessionKind } from "../orchestration/session/types.js"
import { formatElapsed, formatCost } from "../infra/format.js"
import { useWorkflowLifecycle } from "./hooks/use-workflow-lifecycle.js"
import { useChatMode } from "./hooks/use-chat-mode.js"
import { useCommandDispatch } from "./hooks/use-command-dispatch.js"
import { useSessionModal } from "./hooks/use-session-modal.js"
import { createShellState } from "./hooks/shell-state.js"
import { createKeyboardHandler } from "./hooks/use-keyboard-handler.js"
import { TERMINAL_TITLE_PREFIX } from "../infra/format.js"

export function FlywheelShell(props: { factories: WorkflowSessionFactories; projectCwd: string }) {
  const { theme } = useTheme()
  const toast = useToast()
  const { manager, refreshList, sessions } = useSession()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  // ── Session store ──
  const sessionStore = createSessionStore(props.factories)

  // ── Shell state: shared signals + services ──
  const { signals, services } = createShellState({
    sessionStore,
    manager,
    refreshList,
    setTerminalTitle: (t: string) => renderer.setTerminalTitle(t),
    showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => toast.show(opts),
  })

  const metrics = services.metrics

  // ── Prompt-specific signal (local, not shared) ──
  const [promptHeight, setPromptHeight] = createSignal(1)

  // ── Prompt ref ──
  let promptRef: TextareaRenderable | null = null

  // ── Hooks ──
  const workflow = useWorkflowLifecycle({ signals, services })

  const chat = useChatMode({ signals, services, projectCwd: props.projectCwd })

  const sessionModal = useSessionModal({
    signals,
    services,
    sessions,
    handleResume: workflow.handleResume,
    switchForeground,
    actionDeps: workflow.actionDeps,
  })

  const inChat = createMemo(() => {
    // chatActive covers the async startup window before the sessionStore entry exists
    if (chat.chatActive()) return true
    const fgId = signals.foregroundId()
    if (!fgId) return false
    const entry = sessionStore.get(fgId)
    return entry?.kind === "chat"
  })

  // Auto-start chat on boot
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

  // ── Running count — backed by sessionStore's internal createMemo ──
  const runningCount = createMemo(() => sessionStore.runningCount())

  // ── Timer — reactive: runs only when the agent is actively working ──
  createEffect(() => {
    if (signals.agentState() === "active") metrics.startTimer()
    else metrics.pauseTimer()
  })

  // ── Foreground switching ──
  // Changing foregroundId triggers all derived memos automatically.
  // Loads the session from disk into the store if not already present.
  let switchGen = 0
  async function switchForeground(sessionId: string): Promise<void> {
    const gen = ++switchGen
    if (!sessionStore.has(sessionId)) {
      const blocks = await loadSessionOutput(sessionId, props.projectCwd)
      if (gen !== switchGen) return
      const s = sessions().find(s => s.id === sessionId)
      if (!s) return
      sessionStore.load(sessionId, {
        kind: s.kind as SessionKind,
        description: s.label || s.name || sessionId.slice(0, 8),
        outputBlocks: blocks,
        tokens: s.totalTokens,
        cost: s.totalCost,
        contextPercent: s.contextPercent,
        startedAt: s.createdAt ? new Date(s.createdAt).getTime() : undefined,
        claudeSessionId: s.claudeSessionId,
      })
    }
    if (gen !== switchGen) return
    const entry = sessionStore.get(sessionId)
    if (!entry) return
    metrics.pauseTimer()
    batch(() => {
      signals.setForegroundId(sessionId)
      metrics.resetElapsedTo(Date.now() - entry.startedAt)
      signals.setStatusLine("")
      signals.setErrorMessage("")
    })
    renderer.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}${entry.description}`)
  }

  // ── Keyboard ──
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

  // ── Cleanup ──
  // Async disposal is registered as a pre-exit hook so exitTUI() can await it
  // before destroying the renderer. This prevents data loss (traces, transcripts).
  registerPreExitCleanup(() => sessionStore.disposeAll())
  onCleanup(() => {
    metrics.pauseTimer()
    renderer.setTerminalTitle("")
  })

  // ── Derived state ──
  // Ticking clock for live elapsed displays (step indicators, etc.)
  const [now, setNow] = createSignal(Date.now())
  const nowTimer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(nowTimer))

  const lineWidth = createMemo(() => Math.max(dimensions().width - 4, 40))

  const displayStatus = createMemo((): "running" | "idle" | "interrupted" | "completed" => {
    if (signals.agentState() === "active") return "running"
    if (signals.sessionState() === "paused") return "interrupted"
    if (signals.sessionState() === "active") return inChat() ? "idle" : "running"
    return "completed"
  })

  const headerRight = createMemo(() => {
    const state = signals.sessionState()
    const bgCount = runningCount()
    const bgSuffix = bgCount > 1 ? ` (+${bgCount - 1} bg)` : ""
    if (state === null) return bgCount > 0 ? `${bgCount} running` : (signals.errorMessage() ? "error" : "")
    if (signals.errorMessage()) return "error" + bgSuffix

    const hasMetrics = signals.agentState() === "active" || metrics.liveTokens() > 0 || metrics.liveCost() > 0 || metrics.liveContextPercent() > 0
    if (hasMetrics) {
      const width = dimensions().width
      const parts: string[] = []
      if (state === "completed") parts.push("done")
      parts.push(formatElapsed(metrics.elapsed()))
      if (width >= 60) parts.push(`${metrics.liveContextPercent()}% ctx`)
      const c = metrics.liveCost()
      if (c > 0 && width >= 80) parts.push(formatCost(c))
      return parts.join(" \u00b7 ") + bgSuffix
    }

    if (state === "completed") return "done" + bgSuffix
    if (state === "active") return bgSuffix.trim() || ""
    return bgSuffix.trim() || ""
  })

  const headerRightColor = createMemo(() => {
    const state = signals.sessionState()
    if (state === null && signals.errorMessage()) return theme.error
    if (state === "paused" && signals.errorMessage()) return theme.error
    if (state === "paused") return theme.warning
    if (state === "completed") return theme.success
    const ctx = metrics.liveContextPercent()
    if (ctx >= 85) return theme.error
    if (ctx >= 70) return theme.warning
    return theme.textMuted
  })

  // Step pipeline: show all steps if they fit, collapse completed steps from the left if they don't
  const stepDisplay = createMemo(() => {
    const steps = signals.steps()
    if (steps.length === 0) return { collapsedCount: 0, visible: steps }

    const available = dimensions().width - 4
    const estimateWidth = (items: typeof steps, prefixLen: number) => {
      let w = prefixLen
      for (let i = 0; i < items.length; i++) {
        if (i > 0 || prefixLen > 0) w += 3  // " > "
        if (items[i].status === "completed" || items[i].status === "failed") w += 2
        w += items[i].title.length
        if (items[i].status === "running") w += 5  // elapsed estimate
      }
      return w
    }

    if (estimateWidth(steps, 0) <= available) return { collapsedCount: 0, visible: steps }

    let count = 0
    for (const step of steps) {
      if (step.status !== "completed") break
      count++
      const remaining = steps.slice(count)
      if (estimateWidth(remaining, `${count} done`.length) <= available) {
        return { collapsedCount: count, visible: remaining }
      }
    }

    const runIdx = steps.findIndex(s => s.status === "running")
    if (runIdx > 0) return { collapsedCount: runIdx, visible: steps.slice(runIdx) }
    return { collapsedCount: 0, visible: steps }
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

  // ── JSX ──
  return (
    <box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={theme.background} onMouseUp={() => {
        const text = renderer.getSelection()?.getSelectedText()
        if (!text) return
        Clipboard.copy(text)
          .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
          .catch((err) => toast.show({ message: String(err), variant: "error" }))
        renderer.clearSelection()
      }}>

      {/* Header */}
      <box flexShrink={0} flexDirection="column" backgroundColor={theme.backgroundPanel} {...SplitBorder} border={["left"]} borderColor={theme.border}>
        <box flexDirection="row" justifyContent="space-between" paddingTop={1} paddingBottom={stepDisplay().visible.length > 0 ? 0 : 1} paddingLeft={2} paddingRight={1}>
          <box flexDirection="row" flexShrink={1} overflow="hidden">
            <text fg={theme.primary} attributes={createTextAttributes({ bold: true })}>flywheel</text>
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

      {/* Content */}
      <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={1} paddingTop={1} paddingBottom={1} gap={1}>


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
            approvalPending={false}
            isPromptFocused={true}
          />
        </Show>

{/* statusLine removed — completion status belongs in the header, not above the prompt */}
      </box>

      {/* Activity status */}
      <Show when={promptStatusLabel() && showPrompt()}>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="row" gap={1}>
          <Spinner color={theme.primary} />
          <ShimmerText text={promptStatusLabel()!} color={theme.primary} />
        </box>
      </Show>

      {/* Prompt */}
      <box flexShrink={0}>
        <Show when={showPrompt()}>
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}
            backgroundColor={theme.backgroundElement} border={["left"]} borderColor={theme.primary}
            onMouseDown={() => promptRef?.focus?.()}>
            <textarea
              ref={(r: TextareaRenderable) => {
                promptRef = r
                r.onContentChange = () => setPromptHeight(Math.min(3, Math.max(1, r.editorView.getTotalVirtualLineCount())))
                queueMicrotask(() => r?.focus?.())
              }}
              width={lineWidth()} height={promptHeight()} wrapMode="word"
              placeholder={
                signals.pendingWorkCommand()
                  ? "What would you like to work on?"
                  : inChat()
                    ? (signals.agentState() === "active" ? "Waiting for response..." : "Send a message (/new for fresh chat)")
                    : signals.agentState() === "active"
                      ? "Send a message to guide the agent (Esc to interrupt)"
                      : signals.sessionState() === "paused"
                        ? "Send a message to resume, or Esc to force stop"
                        : "Send a message..."
              }
              backgroundColor="transparent" focusedBackgroundColor="transparent"
              onSubmit={() => { const v = promptRef?.plainText ?? ""; commands.handlePromptSubmit(v); promptRef?.clear(); setPromptHeight(1) }}
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

      {/* Footer */}
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0}>
        <text fg={theme.textMuted}>
          {signals.agentState() === "active"
            ? "Esc interrupt"
            : signals.sessionState() === "paused"
              ? "Esc stop \u00b7 Ctrl+R resume"
              : "Ctrl+N new"}
          {sessions().filter(s => s.state === "active" || s.state === "paused").length >= 2 ? " \u00b7 Tab switch" : ""}
          {sessions().length > 0
            ? ` \u00b7 Ctrl+B ${sessions().length} session${sessions().length === 1 ? "" : "s"}`
            : " \u00b7 Ctrl+B sessions"}
        </text>
        <text fg={theme.border} flexShrink={0}>v0.0.1</text>
      </box>

      {/* Session modal overlay */}
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
