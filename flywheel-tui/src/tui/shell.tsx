/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, batch, For, Show, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createTextAttributes } from "@opentui/core"
import type { TextareaRenderable, TextareaAction } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { useSession } from "@tui/shared/context/session"
import { Clipboard } from "./utils/clipboard"
import { exitTUI, registerPreExitCleanup } from "./exit"
import { OutputWindow } from "./routes/work/components/output-window"
import { SplitBorder } from "./shared/ui/border"
import { SIMPLE_LOGO } from "@tui/shared/components/logo"
import { SessionModal } from "./session-modal"
import { createSessionRegistry } from "../orchestration/session-registry"
import type { SessionEntry } from "../orchestration/session-registry"
import type { WorkflowSessionFactories } from "../orchestration/workflow-session"
import { formatElapsed, formatCost, formatTokens, relativeTime } from "../infra/format.js"
import { useMetrics, SPINNER_FRAMES } from "./hooks/use-metrics.js"
import { useWorkflowLifecycle } from "./hooks/use-workflow-lifecycle.js"
import { useChatMode } from "./hooks/use-chat-mode.js"
import { useCommandDispatch } from "./hooks/use-command-dispatch.js"
import { useSessionModal } from "./hooks/use-session-modal.js"
import { createShellState } from "./hooks/shell-state.js"
import { TERMINAL_TITLE_PREFIX } from "../infra/format.js"

export function FlywheelShell(props: { factories: WorkflowSessionFactories }) {
  const { theme } = useTheme()
  const toast = useToast()
  const { manager, refreshList, sessions } = useSession()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  // ── Session registry ──
  const registry = createSessionRegistry(props.factories)

  // ── Metrics (local hook — not part of shell state, but injected as a service) ──
  // Entry accessor is late-bound: signals.registryEntry is available after createShellState.
  // SolidJS memos/effects evaluate lazily — no reads happen during construction.
  let registryEntryAccessor: () => SessionEntry | undefined = () => undefined
  const metrics = useMetrics(() => registryEntryAccessor())

  // ── Shell state: shared signals + services ──
  const { signals, services } = createShellState({
    registry,
    manager,
    refreshList,
    setTerminalTitle: (t: string) => renderer.setTerminalTitle(t),
    metrics,
    showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => toast.show(opts),
  })
  // Wire up the late-bound accessor now that signals exists
  registryEntryAccessor = signals.registryEntry

  // ── Prompt-specific signal (local, not shared) ──
  const [promptHeight, setPromptHeight] = createSignal(1)

  // ── Prompt ref ──
  let promptRef: TextareaRenderable | null = null

  // ── Hooks ──
  const workflow = useWorkflowLifecycle({ signals, services })

  const chat = useChatMode({ signals, services, projectCwd: process.cwd() })

  const sessionModal = useSessionModal({
    signals,
    services,
    sessions,
    handleResume: workflow.handleResume,
    switchForeground,
    actionDeps: workflow.actionDeps,
  })

  const inChat = () => {
    // chatActive covers the async startup window before the registry entry exists
    if (chat.chatActive()) return true
    const fgId = signals.foregroundId()
    if (!fgId) return false
    const entry = registry.get(fgId)
    return entry?.kind === "chat"
  }

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
    sendMessage: chat.sendMessage,
    handleResume: workflow.handleResume,
    steerWorkflow: workflow.steerWorkflow,
    openSessionsModal: sessionModal.openSessionsModal,
  })

  // ── Running count — backed by registry's internal createMemo ──
  const runningCount = createMemo(() => registry.runningCount())

  // ── Timer — reactive: runs only when the agent is actively working ──
  createEffect(() => {
    if (signals.agentState() === "active") metrics.startTimer()
    else metrics.pauseTimer()
  })

  // ── Foreground switching ──
  // After Phase 3, changing foregroundId triggers all derived memos automatically.
  // This helper just sets the ID and resets transient UI state.
  function switchForeground(sessionId: string): void {
    const entry = registry.get(sessionId)
    if (!entry) return
    metrics.pauseTimer()  // stop old interval before resetting accumulated value
    batch(() => {
      signals.setForegroundId(sessionId)
      // Clear overlays so live registry data shows through
      signals.setViewedBlocks(undefined)
      signals.setViewedTitle(undefined)
      // Derived memos (agentState, outputBlocks, steps, sessionTitle) update automatically
      metrics.resetElapsedTo(Date.now() - entry.startedAt)
      // effect above handles start/pause based on new agentState
      signals.setStatusLine("")
      signals.setErrorMessage("")
    })
    renderer.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}${entry.description}`)
  }

  // ── Keyboard ──
  useKeyboard((evt) => {
    if (sessionModal.sessionsModalOpen()) { sessionModal.handleModalKey(evt); return }
    if (evt.name === "escape") {
      const state = signals.sessionState()
      // Active workflow (not chat): first Esc pauses, second Esc aborts
      if (state === "active" && !inChat()) {
        workflow.pauseForeground()
        const bg = runningCount()
        if (bg > 0) toast.show({ message: `${bg} session${bg > 1 ? "s" : ""} still running in background`, variant: "info" })
        return
      }
      // In chat mode, Esc interrupts the active worker — never ends the session.
      // Use /new to start a fresh chat, or Ctrl+B -> d to delete.
      if (inChat()) {
        chat.interruptChat()
        return
      }
      // Paused with runner still alive (winding down): abort it
      if (state === "active") { workflow.abortForeground(); return }
      // Completed or paused (no runner): dismiss and return to welcome
      if (state === "completed" || state === "paused") {
        // If we're viewing a historical session, restore the state from before viewing.
        if (sessionModal.isViewingSession()) {
          sessionModal.dismissViewedSession()
          return
        }
        // Derived memos (agentState, outputBlocks, steps, sessionTitle) reset automatically
        // when foregroundId is cleared — they derive from the registry entry.
        signals.setStatusLine("")
        signals.setErrorMessage("")
        signals.setForegroundId(undefined)
        renderer.setTerminalTitle("flywheel")
        return
      }
      // Error state (errorMessage set, no foreground session): dismiss
      if (signals.errorMessage()) {
        signals.setErrorMessage("")
        return
      }
    }
    if (evt.ctrl && evt.name === "n") { chat.backgroundChat(); chat.startChat(); return }
    if (evt.ctrl && evt.name === "w") {
      if (inChat()) { chat.endChat(); chat.startChat(); return }
      // For workflows: abort the foreground session
      workflow.abortForeground()
      return
    }
    if (evt.ctrl && evt.name === "b") { sessionModal.openSessionsModal() }
    if (evt.ctrl && evt.name === "r") { workflow.handleResume() }
    if (evt.ctrl && evt.name === "c") {
      // Exit if no workflows running (chat sessions don't block exit)
      const hasWorkflows = registry.allIds().some((id) => workflow.isWorkflowSession(id))
      if (!hasWorkflows) { exitTUI() }
    }
  })

  // ── Cleanup ──
  // Async disposal is registered as a pre-exit hook so exitTUI() can await it
  // before destroying the renderer. This prevents data loss (traces, transcripts).
  registerPreExitCleanup(() => registry.disposeAll())
  onCleanup(() => {
    metrics.pauseTimer()
    renderer.setTerminalTitle("")
  })

  // ── Derived state ──
  const lineWidth = createMemo(() => Math.max(dimensions().width - 4, 40))
  const currentStep = createMemo(() => {
    const steps = signals.steps()
    const idx = steps.findIndex((s) => s.status === "running")
    if (idx === -1) return null
    return { index: idx, name: steps[idx].title, status: "running" as const }
  })

  const headerRight = createMemo(() => {
    const state = signals.sessionState()
    const bgCount = runningCount()
    const bgSuffix = bgCount > 1 ? ` (+${bgCount - 1} bg)` : bgCount === 1 && signals.agentState() !== "active" ? ` (1 running)` : ""
    if (state === null) return bgCount > 0 ? `${bgCount} running` : (signals.errorMessage() ? "error" : "ready")
    if (state === "paused") return (signals.errorMessage() ? "error" : "paused") + bgSuffix
    const hasMetrics = signals.agentState() === "active" || metrics.liveTokens() > 0 || metrics.liveCost() > 0
    if (hasMetrics) {
      const parts: string[] = [formatElapsed(metrics.elapsed())]
      parts.push(`${metrics.liveContextPercent()}% used`)
      const c = metrics.liveCost()
      if (c > 0) parts.push(`${formatCost(c)} spent`)
      return parts.join(" \u00b7 ") + bgSuffix
    }
    if (state === "active") return "waiting" + bgSuffix  // in session, agent idle (user's turn)
    return "done" + bgSuffix
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

  const promptStatusLine = createMemo(() => {
    if (signals.agentState() !== "active") return null
    const activity = metrics.liveActivity()
    if (activity === "idle") return null

    const spinner = SPINNER_FRAMES[metrics.spinnerTick()]
    const ms = metrics.elapsed()
    let label = activityLabel()!
    if (ms >= 1000) {
      label = `${label} (${formatElapsed(ms)})`
    }

    return `${spinner} ${label}`
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
      <box flexShrink={0} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={1}
        backgroundColor={theme.backgroundPanel} {...SplitBorder} border={["left"]} borderColor={theme.border}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.primary} attributes={createTextAttributes({ bold: true })}>flywheel</text>
          <Show when={signals.sessionTitle()}><text fg={theme.text} attributes={createTextAttributes({ bold: true })}>{signals.sessionTitle()}</text></Show>
          <text fg={theme.textMuted}>{headerRight()}</text>
        </box>
      </box>

      {/* Content */}
      <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>

        <Show when={signals.steps().length > 0}>
          <box flexShrink={0}>
            <For each={signals.steps()}>
              {(step) => (
                <text fg={step.status === "completed" ? theme.success : step.status === "running" ? theme.primary : step.status === "failed" ? theme.error : theme.textMuted}>
                  {step.status === "completed" ? "\u2713" : step.status === "running" ? "\u25b8" : step.status === "failed" ? "\u2717" : "\u25cb"} {step.title}
                  {step.durationMs ? ` (${(step.durationMs / 1000).toFixed(1)}s)` : step.completedAt ? ` \u00b7 ${relativeTime(step.completedAt)}` : step.status === "running" && step.startedAt ? ` \u00b7 ${relativeTime(step.startedAt)}` : ""}
                </text>
              )}
            </For>
          </box>
        </Show>

        {/* Welcome logo — shown briefly before first chat output arrives */}
        <Show when={signals.sessionState() === null && !signals.errorMessage() && !sessionModal.sessionsModalOpen()}>
          <scrollbox flexGrow={1}>
            <box paddingTop={1} paddingBottom={1}>
              <For each={SIMPLE_LOGO}>{(line) => <text fg={theme.primary} attributes={createTextAttributes({ bold: true })}>{line}</text>}</For>
            </box>
          </scrollbox>
        </Show>

        <Show when={signals.errorMessage()}>
          <scrollbox flexGrow={1}>
            <text fg={theme.error} attributes={createTextAttributes({ bold: true })}>Error</text>
            <text fg={theme.error}>{signals.errorMessage()}</text>
          </scrollbox>
        </Show>

        <Show when={signals.sessionState() !== null}>
          <OutputWindow
            outputBlocks={signals.outputBlocks()}
            workflowStatus={signals.agentState() === "active" ? "running" : signals.sessionState() === "paused" ? "interrupted" : signals.sessionState() === "active" ? (inChat() ? "idle" : "running") : "completed"}
            approvalPending={false}
            isPromptFocused={true}
            currentStep={inChat() ? null : currentStep()}
          />
        </Show>

        <Show when={signals.statusLine()}>
          <box flexShrink={0}><text fg={theme.success}>{signals.statusLine()}</text></box>
        </Show>
      </box>

      {/* Activity status */}
      <Show when={promptStatusLine() && showPrompt()}>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <text fg={theme.primary}>{promptStatusLine()}</text>
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
                inChat()
                  ? (signals.agentState() === "active" ? "Waiting for response..." : "Send a message (/new for fresh chat)")
                  : signals.agentState() === "active"
                    ? "Send a message to steer the worker (Esc to pause)"
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
        <text fg={theme.textMuted} flexShrink={1} overflow="hidden">{process.cwd()}</text>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.textMuted}>
            {signals.agentState() === "active"
              ? `Esc to interrupt \u00b7 Ctrl+N`
              : signals.sessionState() === "paused"
                ? "Esc to stop \u00b7 Ctrl+R to resume"
                : "Ctrl+N \u00b7 /exit"}
            {` \u00b7 Ctrl+B`}{runningCount() > 1 || sessions().length > 1 ? ` (${runningCount()} active \u00b7 ${sessions().length} total)` : ""}
          </text>
          <text fg={theme.textMuted}>v0.0.1</text>
        </box>
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
