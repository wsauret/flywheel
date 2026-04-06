/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, For, Show, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createTextAttributes } from "@opentui/core"
import type { TextareaRenderable, TextareaAction } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { useSession } from "@tui/shared/context/session"
import { Selection } from "./utils/selection"
import { exitTUI } from "./app"
import { OutputWindow } from "./routes/work/components/output-window"
import { SplitBorder } from "./shared/ui/border"
import { FULL_LOGO, SIMPLE_LOGO } from "@tui/shared/components/logo"
import { SessionModal } from "./session-modal"
import { createSessionRegistry } from "../orchestration/session-registry"
import { formatElapsed, formatCost, formatTokens, relativeTime } from "./format"
import { useMetrics, SPINNER_FRAMES } from "./hooks/use-metrics.js"
import { useRegistrySync } from "./hooks/use-registry-sync.js"
import { useWorkflowLifecycle } from "./hooks/use-workflow-lifecycle.js"
import { useChatMode } from "./hooks/use-chat-mode.js"
import { useCommandDispatch } from "./hooks/use-command-dispatch.js"
import { useSessionModal } from "./hooks/use-session-modal.js"
import type { AgentState, SessionStatus } from "./hooks/use-workflow-lifecycle.js"
import type { AnyBlock } from "./types"
import type { StepState } from "../orchestration/workflow-runner"

export function FlywheelShell() {
  const { theme } = useTheme()
  const toast = useToast()
  const { manager, refreshList, sessions } = useSession()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  // ── Signals ──
  const [agentState, setAgentState] = createSignal<AgentState>("idle")
  const [sessionStatus, setSessionStatus] = createSignal<SessionStatus>(null)
  const [outputBlocks, setOutputBlocks] = createSignal<AnyBlock[]>([])
  const [steps, setSteps] = createSignal<StepState[]>([])
  const [errorMessage, setErrorMessage] = createSignal("")
  const [sessionTitle, setSessionTitle] = createSignal("")
  const [statusLine, setStatusLine] = createSignal("")
  const [promptHeight, setPromptHeight] = createSignal(1)

  // Active workflow tracking
  const [foregroundId, setForegroundId] = createSignal<string | undefined>()
  const [runningCount, setRunningCount] = createSignal(0)

  // ── Session registry ──
  const registry = createSessionRegistry()

  // ── Prompt ref ──
  let promptRef: TextareaRenderable | null = null

  // ── Hooks ──
  const metrics = useMetrics()

  const workflow = useWorkflowLifecycle({
    registry,
    manager,
    refreshList,
    foregroundId,
    setForegroundId,
    setAgentState,
    setSessionStatus,
    setOutputBlocks,
    setSteps,
    setErrorMessage,
    setStatusLine,
    setSessionTitle,
    setTerminalTitle: (t) => renderer.setTerminalTitle(t),
    resetMetrics: metrics.resetMetrics,
    showToast: (opts) => toast.show(opts),
  })

  const chat = useChatMode({
    setAgentState,
    setSessionStatus,
    setOutputBlocks,
    setSteps: (s) => setSteps(s),
    setErrorMessage,
    setStatusLine,
    setSessionTitle,
    setTerminalTitle: (t) => renderer.setTerminalTitle(t),
    resetMetrics: metrics.resetMetrics,
    workStartTime: metrics.workStartTime,
    setTokens: metrics.setTokens,
    setCost: metrics.setCost,
    setActivity: metrics.setActivity,
  })

  const sessionModal = useSessionModal({
    sessions,
    manager,
    refreshList,
    registry,
    foregroundId,
    setForegroundId,
    sessionStatus,
    setSessionStatus,
    outputBlocks,
    setOutputBlocks,
    sessionTitle,
    setSessionTitle,
    statusLine,
    setStatusLine,
    setTerminalTitle: (t) => renderer.setTerminalTitle(t),
    showToast: (opts) => toast.show(opts),
    handleResume: workflow.handleResume,
    switchForeground,
    actionDeps: workflow.actionDeps,
  })

  const inChat = () => sessionStatus() !== null && foregroundId() === undefined

  const commands = useCommandDispatch({
    agentState,
    sessionStatus,
    setAgentState,
    setSessionStatus,
    foregroundId,
    inChat,
    registry,
    startWorkflow: workflow.startWorkflow,
    startTestStep: workflow.startTestStep,
    startChat: chat.startChat,
    endChat: chat.endChat,
    sendMessage: chat.sendMessage,
    handleResume: workflow.handleResume,
    openSessionsModal: sessionModal.openSessionsModal,
    showToast: (opts) => toast.show(opts),
  })

  // ── Registry subscription — sync foreground entry to display signals ──
  const registryUnsub = useRegistrySync({
    registry,
    foregroundId,
    setForegroundId,
    setAgentState,
    setSessionStatus,
    setOutputBlocks,
    setSteps,
    setRunningCount,
    setStatusLine,
    setSessionTitle,
    setErrorMessage,
    setTerminalTitle: (t) => renderer.setTerminalTitle(t),
    metrics,
    manager,
    refreshList,
    showToast: (opts) => toast.show(opts),
  })

  // ── Timer — reactive: runs only when the agent is actively working ──
  createEffect(() => {
    if (agentState() === "active") metrics.startTimer()
    else metrics.pauseTimer()
  })

  // ── Foreground switching ──
  function switchForeground(sessionId: string): void {
    const entry = registry.get(sessionId)
    if (!entry) return
    metrics.pauseTimer()  // stop old interval before resetting accumulated value
    setForegroundId(sessionId)
    setAgentState(entry.status === "running" ? "active" : "idle")
    setSessionStatus(entry.status === "running" ? "running" : entry.status === "paused" ? "paused" : "completed")
    metrics.resetElapsedTo(Date.now() - entry.startedAt)
    // effect above handles start/pause based on new agentState
    setStatusLine("")
    setErrorMessage("")
    renderer.setTerminalTitle(`flywheel · ${entry.description}`)
  }

  // ── Keyboard ──
  useKeyboard((evt) => {
    if (sessionModal.sessionsModalOpen()) { sessionModal.handleModalKey(evt); return }
    if (evt.name === "escape") {
      if (sessionStatus() === "running" && !inChat()) {
        workflow.pauseForeground()
        const bg = runningCount()
        if (bg > 0) toast.show({ message: `${bg} session${bg > 1 ? "s" : ""} still running in background`, variant: "info" })
        return
      }
      if (sessionStatus() === "paused") { workflow.abortForeground(); return }
      // In chat mode, Esc interrupts the active worker — never ends the session.
      // Use /end to close a chat session.
      if (inChat()) {
        chat.interruptChat()
        return
      }
      if (sessionStatus() === "completed" || sessionStatus() === "error") {
        // If we're viewing a historical session, restore the state from before viewing.
        if (sessionModal.isViewingSession()) {
          sessionModal.dismissViewedSession()
          return
        }
        setAgentState("idle")
        setSessionStatus(null)
        setOutputBlocks([])
        setSteps([])
        setStatusLine("")
        setErrorMessage("")
        setSessionTitle("")
        setForegroundId(undefined)
        renderer.setTerminalTitle("flywheel")
        return
      }
    }
    if (evt.ctrl && evt.name === "b") { sessionModal.openSessionsModal() }
    if (evt.ctrl && evt.name === "r") { workflow.handleResume() }
    if (evt.ctrl && evt.name === "c") {
      if (registry.runningCount() === 0 && !inChat()) { exitTUI() }
    }
  })

  // ── Cleanup ──
  onCleanup(() => {
    registryUnsub()
    for (const id of registry.activeIds()) registry.abort(id)
    chat.endChat()
    metrics.stopTimer()
    renderer.setTerminalTitle("")
  })

  // ── Derived state ──
  const lineWidth = createMemo(() => Math.max(dimensions().width - 4, 40))
  const currentStep = createMemo(() => {
    const running = steps().find((s) => s.status === "running")
    if (!running) return null
    return { index: steps().indexOf(running), name: running.title, status: "running" as const }
  })

  const headerRight = createMemo(() => {
    const status = sessionStatus()
    const bgCount = runningCount()
    const bgSuffix = bgCount > 1 ? ` (+${bgCount - 1} bg)` : bgCount === 1 && agentState() !== "active" ? ` (1 running)` : ""
    if (status === null) return bgCount > 0 ? `${bgCount} running` : "ready"
    if (status === "error") return "error" + bgSuffix
    if (status === "paused") return "paused" + bgSuffix
    const hasMetrics = agentState() === "active" || metrics.liveTokens() > 0 || metrics.liveCost() > 0
    if (hasMetrics) {
      const parts: string[] = [formatElapsed(metrics.elapsed())]
      const t = metrics.liveTokens()
      if (t > 0) parts.push(`${formatTokens(t)} tokens`)
      const c = metrics.liveCost()
      if (c > 0) parts.push(formatCost(c))
      return parts.join(" · ") + bgSuffix
    }
    if (status === "running") return "waiting" + bgSuffix  // in session, agent idle (user's turn)
    return "done" + bgSuffix
  })

  const showLogo = createMemo(() => sessionStatus() === null && dimensions().height >= 20)
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
    if (agentState() !== "active") return null
    const activity = metrics.liveActivity()
    if (activity === "idle") return null

    const spinner = SPINNER_FRAMES[metrics.spinnerTick()]
    let label = activityLabel()!
    if (activity === "thinking" && metrics.thinkingElapsed() > 0) {
      label = `${label} (${metrics.thinkingElapsed()}s)`
    }

    const hint = "(Press ESC to stop)"
    return `${spinner} ${label} ${hint}`
  })

  // ── JSX ──
  return (
    <box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={theme.background} onMouseUp={() => Selection.copy(renderer, toast)}>

      {/* Header */}
      <box flexShrink={0} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={1}
        backgroundColor={theme.backgroundPanel} {...SplitBorder} border={["left"]} borderColor={theme.border}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.primary} attributes={createTextAttributes({ bold: true })}>flywheel</text>
          <Show when={sessionTitle()}><text fg={theme.text} attributes={createTextAttributes({ bold: true })}>{sessionTitle()}</text></Show>
          <text fg={theme.textMuted}>{headerRight()}</text>
        </box>
      </box>

      {/* Content */}
      <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>

        <Show when={steps().length > 0}>
          <box flexShrink={0}>
            <For each={steps()}>
              {(step) => (
                <text fg={step.status === "completed" ? theme.success : step.status === "running" ? theme.primary : step.status === "failed" ? theme.error : theme.textMuted}>
                  {step.status === "completed" ? "✓" : step.status === "running" ? "▸" : step.status === "failed" ? "✗" : "○"} {step.title}
                  {step.durationMs ? ` (${(step.durationMs / 1000).toFixed(1)}s)` : step.completedAt ? ` · ${relativeTime(step.completedAt)}` : step.status === "running" && step.startedAt ? ` · ${relativeTime(step.startedAt)}` : ""}
                </text>
              )}
            </For>
          </box>
        </Show>

        <Show when={sessionStatus() === null && !sessionModal.sessionsModalOpen()}>
          <scrollbox flexGrow={1}>
            <Show when={showLogo()}>
              <box paddingTop={2} paddingBottom={1}>
                <For each={FULL_LOGO}>{(line) => <text fg={theme.primary}>{line}</text>}</For>
              </box>
            </Show>
            <Show when={!showLogo()}>
              <box paddingTop={1} paddingBottom={1}>
                <For each={SIMPLE_LOGO}>{(line) => <text fg={theme.primary} attributes={createTextAttributes({ bold: true })}>{line}</text>}</For>
              </box>
            </Show>
            <text fg={theme.textMuted}>/chat              start an interactive session</text>
            <text fg={theme.textMuted}>/start work "desc"  run a workflow pipeline</text>
            <text fg={theme.textMuted}>/resume            resume an interrupted session</text>
            <text fg={theme.textMuted}>/test {"<step-id>"}    test a single step type in isolation</text>
            <text fg={theme.textMuted}>/sessions          manage sessions (Ctrl+B)</text>
            <text fg={theme.textMuted}>/exit              quit</text>
          </scrollbox>
        </Show>

        <Show when={sessionStatus() === "error"}>
          <scrollbox flexGrow={1}>
            <text fg={theme.error} attributes={createTextAttributes({ bold: true })}>Error</text>
            <text fg={theme.error}>{errorMessage()}</text>
          </scrollbox>
        </Show>

        <Show when={sessionStatus() !== null}>
          <OutputWindow
            outputBlocks={outputBlocks()}
            workflowStatus={agentState() === "active" ? "running" : sessionStatus() === "paused" ? "interrupted" : sessionStatus() === "running" ? (inChat() ? "idle" : "running") : "completed"}
            approvalPending={false}
            isPromptFocused={true}
            currentStep={inChat() ? null : currentStep()}
          />
        </Show>

        <Show when={statusLine()}>
          <box flexShrink={0}><text fg={theme.success}>{statusLine()}</text></box>
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
            backgroundColor={theme.backgroundElement} border={["left"]} borderColor={theme.primary}>
            <textarea
              ref={(r: TextareaRenderable) => {
                promptRef = r
                r.onContentChange = () => setPromptHeight(Math.min(3, Math.max(1, r.editorView.getTotalVirtualLineCount())))
                queueMicrotask(() => r?.focus?.())
              }}
              width={lineWidth()} height={promptHeight()} wrapMode="word"
              placeholder={
                inChat()
                  ? (agentState() === "active" ? "Waiting for response..." : "Send a message (/end to exit chat)")
                  : agentState() === "active"
                    ? "Send a message to steer the worker (Esc to pause)"
                    : sessionStatus() === "paused"
                      ? "Send a message to resume, or Esc to force stop"
                      : sessionStatus() === null
                        ? '/chat or /start work "description"'
                        : "Enter command..."
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
        <text fg={theme.textMuted}>{process.cwd()}</text>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.textMuted}>
            {inChat() ? "/end"
              : sessionStatus() === "paused" ? "Esc (stop) · Ctrl+R (resume)"
              : agentState() === "active" ? `Esc (pause)${runningCount() > 1 ? ` · ${runningCount()} sessions` : ""}`
              : `Esc · Ctrl+B · /chat · /exit${runningCount() > 0 ? ` · ${runningCount()} running` : ""}`}
          </text>
          <text fg={theme.textMuted}>v0.0.1</text>
        </box>
      </box>

      {/* Session modal overlay */}
      <Show when={sessionModal.sessionsModalOpen()}>
        <SessionModal
          activeSessionId={foregroundId()}
          cursor={sessionModal.modalCursor()}
          confirmDeleteId={sessionModal.modalConfirmDelete()}
          onClose={sessionModal.closeSessionsModal}
          onSelect={sessionModal.selectModalItem}
        />
      </Show>
    </box>
  )
}
