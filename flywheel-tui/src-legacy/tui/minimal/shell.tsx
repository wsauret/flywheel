/** @jsxImportSource @opentui/solid */
/**
 * MinimalShell — Thin wiring layer.
 *
 * Declares signals, imports modules, wires callbacks, renders JSX.
 * No business logic lives here — it's all in:
 *   - workflow.ts     (executor lifecycle)
 *   - session-actions.ts (session CRUD)
 *   - session-modal.tsx  (session browser UI)
 *   - format.ts       (display formatting)
 */

import { createSignal, createMemo, For, Show, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createTextAttributes } from "@opentui/core"
import type { TextareaRenderable, TextareaAction } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { useSession } from "@tui/shared/context/session"
import { Selection } from "../utils/selection"
import { exitTUI } from "../app"
import { OutputWindow } from "../routes/work/components/output-window"
import { safeUpdateState } from "../../session/safe-transition"
import { buildQueueForSlashCommand } from "../../orchestration/queue-builder"
import { prepareWorkflowDeps } from "../../engines/workflow-deps"
import { SplitBorder } from "../shared/ui/border"
import { FULL_LOGO, SIMPLE_LOGO } from "@tui/shared/components/logo"
import { startChatSession, type ChatSession } from "./chat"
import { SessionModal, buildSessionList } from "./session-modal"
import { createSessionRegistry } from "../../orchestration/session-registry"
import type { StepState } from "../../orchestration/workflow-runner"
import { loadSessionOutput, loadResumeData, findResumableSession, archiveSession, deleteSession, type SessionActionDeps } from "../../orchestration/session-actions"
import { formatTokens, formatElapsed, formatCost, relativeTime } from "./format"
import type { AnyBlock } from "../types"
import type { StepType } from "../../queue/types"

const SPINNER_FRAMES = ["⠋", "⠙", "⠸", "⠴", "⠦", "⠇"]

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

type AppState = "idle" | "working" | "paused" | "completed" | "error" | "chatting"

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MinimalShell() {
  const { theme } = useTheme()
  const toast = useToast()
  const { manager, refreshList, sessions } = useSession()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  // ── Signals ──
  const [appState, setAppState] = createSignal<AppState>("idle")
  const [outputBlocks, setOutputBlocks] = createSignal<AnyBlock[]>([])
  const [steps, setSteps] = createSignal<StepState[]>([])
  const [errorMessage, setErrorMessage] = createSignal("")
  const [sessionTitle, setSessionTitle] = createSignal("")
  const [statusLine, setStatusLine] = createSignal("")
  const [liveTokens, setLiveTokens] = createSignal(0)
  const [liveCost, setLiveCost] = createSignal(0)
  const [workStartTime, setWorkStartTime] = createSignal(0)
  const [elapsed, setElapsed] = createSignal(0)
  const [chatWaiting, setChatWaiting] = createSignal(false)
  const [promptHeight, setPromptHeight] = createSignal(1)
  const [spinnerTick, setSpinnerTick] = createSignal(0)

  // Session modal
  const [sessionsModalOpen, setSessionsModalOpen] = createSignal(false)
  const [modalCursor, setModalCursor] = createSignal(0)
  const [modalConfirmDelete, setModalConfirmDelete] = createSignal<string | undefined>()

  // Active workflow tracking — foregroundId is the session whose output is displayed
  const [foregroundId, setForegroundId] = createSignal<string | undefined>()

  // ── Session registry ──
  const registry = createSessionRegistry()

  // ── Mutable refs ──
  let chatSession: ChatSession | null = null
  let promptRef: TextareaRenderable | null = null
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let elapsedAccum = 0
  let elapsedRunStart = 0

  // Session action deps (stable reference)
  const actionDeps: SessionActionDeps = { manager, refreshList, activeSessionId: foregroundId }

  // Spinner
  const spinnerTimer = setInterval(() => setSpinnerTick((t) => (t + 1) % SPINNER_FRAMES.length), 150)
  onCleanup(() => clearInterval(spinnerTimer))

  // ── Cleanup ──
  onCleanup(() => {
    registryUnsub()
    for (const id of registry.activeIds()) registry.abort(id)
    chatSession?.end()
    stopElapsedTimer()
    renderer.setTerminalTitle("")
  })

  // ── Elapsed timer ──
  function startElapsedTimer() {
    if (elapsedTimer) return
    elapsedRunStart = Date.now()
    elapsedTimer = setInterval(() => setElapsed(elapsedAccum + (Date.now() - elapsedRunStart)), 1000)
  }
  function pauseElapsedTimer() {
    if (!elapsedTimer) return
    elapsedAccum += Date.now() - elapsedRunStart
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
  function stopElapsedTimer() { pauseElapsedTimer() }
  function resetMetrics() {
    setWorkStartTime(Date.now())
    setElapsed(0)
    elapsedAccum = 0
    setLiveTokens(0)
    setLiveCost(0)
  }

  // ── Workflow lifecycle ──

  async function startWorkflow(command: string, description: string) {
    setOutputBlocks([])
    setSteps([])
    setErrorMessage("")
    setStatusLine("")
    setSessionTitle(description || command)
    resetMetrics()
    startElapsedTimer()
    setAppState("working")
    renderer.setTerminalTitle(`flywheel · ${description || command}`)

    let queue
    try {
      const deps = prepareWorkflowDeps()
      queue = buildQueueForSlashCommand(command, deps.config)
    } catch (err) {
      setErrorMessage(`Config error: ${err instanceof Error ? err.message : String(err)}`)
      setAppState("error")
      return
    }

    // command is validated by handlePromptSubmit's allowlist before reaching here
    const sessionId = manager.create(description, description, command as StepType)
    safeUpdateState((id, s) => manager.updateState(id, s), sessionId, "work:active")

    registry.start({ sessionId, queue, description })
    setForegroundId(sessionId)
  }

  async function resumeWorkflow(sessionId: string) {
    const data = await loadResumeData(sessionId, actionDeps)
    if (!data) {
      toast.show({ message: "Failed to resume — missing data", variant: "error" })
      return
    }

    const description = data.session.name || data.session.label || ""
    setOutputBlocks(data.outputBlocks)
    setSteps([])
    setErrorMessage("")
    setStatusLine("")
    setSessionTitle(description || "Resumed session")
    resetMetrics()
    startElapsedTimer()
    setAppState("working")
    renderer.setTerminalTitle(`flywheel · ${description || "resume"}`)

    safeUpdateState((id, s) => manager.updateState(id, s), sessionId, "work:active")

    registry.start({ sessionId, queue: data.queue, description, priorBlocks: data.outputBlocks })
    setForegroundId(sessionId)
  }

  // ── Registry subscription — sync foreground entry to display signals ──

  const registryUnsub = registry.subscribe(() => {
    setRunningCount(registry.runningCount())

    const fgId = foregroundId()
    if (!fgId) return

    const entry = registry.get(fgId)
    if (!entry) return

    // Sync display signals from the foreground entry
    setOutputBlocks(entry.outputBlocks)
    setSteps(entry.steps)
    setLiveTokens(entry.tokens)
    setLiveCost(entry.cost)
    setSessionTitle(entry.description)
    renderer.setTerminalTitle(`flywheel · ${entry.description}`)

    // Handle terminal states
    if (entry.status === "completed" || entry.status === "error") {
      stopElapsedTimer()
      const totalElapsed = formatElapsed(Date.now() - workStartTime())

      if (entry.status === "completed" && entry.result) {
        const r = entry.result
        if (r.completed) {
          safeUpdateState((id, s) => manager.updateState(id, s), fgId, "completed")
          setStatusLine(`\u2713 ${r.stepsCompleted}/${r.stepsTotal} steps \u00b7 ${totalElapsed} \u00b7 ${formatCost(r.cost)} \u00b7 ${formatTokens(r.tokens)} tokens`)
        } else {
          safeUpdateState((id, s) => manager.updateState(id, s), fgId, "work:paused")
          setStatusLine(`\u2717 ${r.reason ?? "stopped"} (${r.stepsCompleted}/${r.stepsTotal}) \u00b7 ${totalElapsed} \u00b7 ${formatCost(r.cost)}`)
        }
        refreshList()
        setAppState("completed")
        renderer.setTerminalTitle("flywheel \u00b7 done")
      } else if (entry.status === "error") {
        safeUpdateState((id, s) => manager.updateState(id, s), fgId, "work:paused")
        refreshList()
        setErrorMessage(entry.errorMessage ?? "Unknown error")
        setAppState("error")
        renderer.setTerminalTitle("flywheel \u00b7 error")
      }

      // Defer removal to avoid reentrancy (remove() fires notify() which re-enters this subscriber)
      queueMicrotask(() => {
        registry.remove(fgId)
        setForegroundId(undefined)
      })
    }

    // Toast for background session completions
    const toRemove: string[] = []
    for (const id of registry.activeIds()) {
      if (id === fgId) continue
      const bg = registry.get(id)
      if (bg && (bg.status === "completed" || bg.status === "error")) {
        const label = bg.description || id.slice(0, 8)
        toast.show({
          message: bg.status === "completed" ? `Background session "${label}" completed` : `Background session "${label}" errored`,
          variant: bg.status === "completed" ? "info" : "error",
        })
        toRemove.push(id)
      }
    }
    if (toRemove.length > 0) {
      queueMicrotask(() => { for (const id of toRemove) registry.remove(id) })
    }
  })

  // ── Pause / abort ──

  function pauseForeground() {
    const fgId = foregroundId()
    if (!fgId) return
    registry.pause(fgId)
    pauseElapsedTimer()
    setAppState("paused")
    toast.show({ message: "Pausing after current step... (Esc to force stop)", variant: "info" })
  }

  function abortForeground() {
    const fgId = foregroundId()
    if (!fgId) return
    registry.abort(fgId)
    toast.show({ message: "Force-stopping workflow", variant: "warning" })
    // runner.run() will resolve → registry subscription handles state transition
  }

  // ── Chat mode ──

  async function startChat(initialMessage?: string) {
    setAppState("chatting")
    setOutputBlocks([])
    setSteps([])
    setErrorMessage("")
    setStatusLine("")
    setSessionTitle("Chat")
    setChatWaiting(false)
    resetMetrics()
    renderer.setTerminalTitle("flywheel · chat")

    try {
      chatSession = await startChatSession({
        onBlocksChanged: setOutputBlocks,
        onWaitingChanged: setChatWaiting,
        onTokensChanged: setLiveTokens,
        onCostChanged: setLiveCost,
        onError: (msg) => { setErrorMessage(msg); setAppState("error") },
        onEnded: () => {
          if (appState() !== "chatting") return
          stopElapsedTimer()
          const cost = chatSession?.budgetTracker.getTotalCost() ?? 0
          const tokens = chatSession?.budgetTracker.getTokensUsed() ?? 0
          setStatusLine(`Chat ended · ${formatElapsed(Date.now() - workStartTime())} · ${formatCost(cost)} · ${formatTokens(tokens)} tokens`)
          chatSession = null
          setAppState("completed")
          renderer.setTerminalTitle("flywheel · done")
        },
      }, initialMessage)
    } catch (err) {
      setErrorMessage(`Chat error: ${err instanceof Error ? err.message : String(err)}`)
      setAppState("error")
    }
  }

  function endChat() {
    stopElapsedTimer()
    chatSession?.end()
    chatSession = null
  }

  // ── Resume ──

  async function handleResume(sessionIdArg?: string) {
    let targetId = sessionIdArg
    if (!targetId) {
      const session = findResumableSession(actionDeps)
      if (!session) {
        toast.show({ message: "No resumable sessions found", variant: "warning" })
        return
      }
      targetId = session.id
    }
    await resumeWorkflow(targetId)
  }

  // ── Foreground switching ──

  function switchForeground(sessionId: string) {
    const entry = registry.get(sessionId)
    if (!entry) return

    // Stop current timer before switching
    stopElapsedTimer()

    // Switch foreground pointer — registry subscription will sync display signals
    setForegroundId(sessionId)
    setAppState(entry.status === "running" ? "working" : entry.status === "paused" ? "paused" : "completed")

    // Reset elapsed to this session's runtime
    elapsedAccum = Date.now() - entry.startedAt
    setElapsed(elapsedAccum)
    if (entry.status === "running") startElapsedTimer()

    setStatusLine("")
    setErrorMessage("")
    renderer.setTerminalTitle(`flywheel · ${entry.description}`)
  }

  // ── Session modal callbacks ──

  async function handleSessionView(sessionId: string) {
    setSessionsModalOpen(false)

    // If this session is running in the registry, switch foreground to it
    const entry = registry.get(sessionId)
    if (entry) {
      switchForeground(sessionId)
      return
    }

    // Historical session — load from disk
    const blocks = await loadSessionOutput(sessionId)
    setOutputBlocks(blocks)

    const { sessions: list } = manager.list()
    const session = list.find(s => s.id === sessionId)
    if (session) {
      setSessionTitle(session.label || session.name || sessionId.slice(0, 8))
      setStatusLine(`Viewing session · ${formatCost(session.totalCost)}`)
    }
    setForegroundId(undefined)
    setAppState("completed")
  }

  function handleSessionResume(sessionId: string) {
    setSessionsModalOpen(false)
    handleResume(sessionId)
  }

  function handleSessionArchive(sessionId: string) {
    try {
      archiveSession(sessionId, actionDeps)
      toast.show({ message: "Session archived", variant: "info" })
    } catch (err) {
      toast.show({ message: `Cannot archive: ${err instanceof Error ? err.message : String(err)}`, variant: "error" })
    }
  }

  function handleSessionDelete(sessionId: string) {
    try {
      deleteSession(sessionId, actionDeps)
      toast.show({ message: "Session deleted", variant: "info" })
    } catch (err) {
      toast.show({ message: `Delete failed: ${err instanceof Error ? err.message : String(err)}`, variant: "error" })
    }
  }

  // ── Command dispatch ──

  function handlePromptSubmit(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return

    // Chat mode
    if (appState() === "chatting") {
      if (trimmed === "/exit" || trimmed === "/quit") { endChat(); exitTUI(); return }
      if (trimmed === "/end" || trimmed === "/stop") { endChat(); return }
      chatSession?.send(trimmed)
      return
    }

    // Mid-turn message injection: send text to running/paused worker
    if (appState() === "working" || appState() === "paused") {
      const fgId = foregroundId()
      if (fgId && !trimmed.startsWith("/")) {
        // If paused, cancel shutdown and resume
        if (appState() === "paused") {
          registry.cancelShutdown(fgId)
          startElapsedTimer()
          setAppState("working")
        }
        const injected = registry.injectMessage(fgId, trimmed)
        if (injected) {
          toast.show({ message: "Message sent to worker", variant: "info" })
        } else {
          toast.show({ message: "Could not deliver message — worker pipe closed", variant: "warning" })
        }
        return
      }
    }

    if (trimmed === "/exit" || trimmed === "/quit") { exitTUI(); return }
    if (trimmed === "/sessions") { openSessionsModal(); return }
    if (trimmed === "/resume") { handleResume(); return }
    const resumeMatch = trimmed.match(/^\/resume\s+(.+)$/i)
    if (resumeMatch) { handleResume(resumeMatch[1]); return }
    if (trimmed === "/chat") { startChat(); return }
    const chatMatch = trimmed.match(/^\/chat\s+(.+)$/i)
    if (chatMatch) { startChat(chatMatch[1]); return }

    const startMatch = trimmed.match(/^\/start\s+(\w+)\s+"([^"]+)"$/i)
      ?? trimmed.match(/^\/start\s+(\w+)\s+(.+)$/i)
    if (startMatch) { startWorkflow(startMatch[1], startMatch[2]); return }

    const slashMatch = trimmed.match(/^\/(\w+)\s+"([^"]+)"$/i)
      ?? trimmed.match(/^\/(\w+)\s+(.+)$/i)
    if (slashMatch && ["work", "plan", "review", "debug", "research"].includes(slashMatch[1])) {
      startWorkflow(slashMatch[1], slashMatch[2]); return
    }

    if (appState() === "paused") {
      toast.show({ message: "Session paused. Esc to stop, Ctrl+R to resume, or /sessions to switch.", variant: "warning" })
    } else {
      toast.show({ message: `Unknown command. Try /chat, /sessions, /start work "desc", or /exit`, variant: "warning" })
    }
  }

  function openSessionsModal() {
    setSessionsModalOpen(true)
    setModalCursor(0)
    setModalConfirmDelete(undefined)
  }

  // ── Keyboard ──

  useKeyboard((evt) => {
    // Modal mode — drive modal from here (see session-modal.tsx for why)
    if (sessionsModalOpen()) {
      handleModalKey(evt)
      return
    }

    // Esc — context-dependent interrupt
    if (evt.name === "escape") {
      if (appState() === "working") {
        pauseForeground()
        const bg = runningCount()
        if (bg > 0) toast.show({ message: `${bg} session${bg > 1 ? "s" : ""} still running in background`, variant: "info" })
        return
      }
      if (appState() === "paused") { abortForeground(); return }
      if (appState() === "chatting") {
        endChat()
        setStatusLine(`Chat ended · ${formatElapsed(Date.now() - workStartTime())}`)
        setAppState("completed")
        return
      }
      // Esc from completed/error — return to idle without affecting background sessions
      if (appState() === "completed" || appState() === "error") {
        setAppState("idle")
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

    // Ctrl+B — open sessions modal
    if (evt.ctrl && evt.name === "b") { openSessionsModal() }

    // Ctrl+R — resume most recent paused session
    if (evt.ctrl && evt.name === "r") { handleResume() }

    // Ctrl+C — exit only from idle (no running sessions)
    if (evt.ctrl && evt.name === "c") {
      if (registry.runningCount() === 0 && appState() !== "chatting") { exitTUI() }
    }
  })

  function handleModalKey(evt: any) {
    if (evt.name === "escape" || (evt.ctrl && evt.name === "b")) {
      evt.preventDefault()
      setSessionsModalOpen(false)
      setModalConfirmDelete(undefined)
      return
    }
    const items = buildSessionList(sessions())
    const total = items.length
    if (total === 0) return

    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      setModalCursor((c) => (c - 1 + total) % total)
      setModalConfirmDelete(undefined)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      setModalCursor((c) => (c + 1) % total)
      setModalConfirmDelete(undefined)
      return
    }
    const selected = items[modalCursor()]?.session
    if (!selected) return

    if (evt.name === "return") {
      evt.preventDefault()
      if (selected.lifecycleState === "work:active" && registry.get(selected.id)) {
        // Running session — switch foreground to it
        setSessionsModalOpen(false)
        switchForeground(selected.id)
      } else if (selected.lifecycleState === "work:paused" || selected.lifecycleState === "budget_exhausted") {
        handleSessionResume(selected.id)
      } else {
        handleSessionView(selected.id)
      }
      return
    }
    if (evt.name === "r") {
      if (selected.lifecycleState === "work:paused" || selected.lifecycleState === "budget_exhausted") { evt.preventDefault(); handleSessionResume(selected.id) }
      return
    }
    if (evt.name === "a" && selected.lifecycleState === "completed") {
      evt.preventDefault(); handleSessionArchive(selected.id); return
    }
    if (evt.name === "d" && selected.id !== foregroundId()) {
      evt.preventDefault()
      if (modalConfirmDelete() === selected.id) { setModalConfirmDelete(undefined); handleSessionDelete(selected.id) }
      else { setModalConfirmDelete(selected.id) }
    }
  }

  // ── Derived state ──

  const lineWidth = createMemo(() => Math.max(dimensions().width - 4, 40))
  const currentStep = createMemo(() => {
    const running = steps().find((s) => s.status === "running")
    if (!running) return null
    return { index: steps().indexOf(running), name: running.title, status: "running" as const }
  })

  const [runningCount, setRunningCount] = createSignal(0)

  const headerRight = createMemo(() => {
    const state = appState()
    const bgCount = runningCount()
    const bgSuffix = bgCount > 1 ? ` (+${bgCount - 1} bg)` : bgCount === 1 && state !== "working" ? ` (1 running)` : ""
    if (state === "idle") return bgCount > 0 ? `${bgCount} running` : "ready"
    if (state === "error") return "error" + bgSuffix
    if (state === "paused") return "paused" + bgSuffix
    if (state === "working" || state === "chatting") {
      const parts: string[] = [formatElapsed(elapsed())]
      const t = liveTokens()
      if (t > 0) parts.push(formatTokens(t))
      const c = liveCost()
      if (c > 0) parts.push(formatCost(c))
      return parts.join(" · ") + bgSuffix
    }
    return "done" + bgSuffix
  })

  const showLogo = createMemo(() => appState() === "idle" && dimensions().height >= 20)
  const showPrompt = createMemo(() => !sessionsModalOpen())

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

        <Show when={appState() === "idle" && !sessionsModalOpen()}>
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
            <text fg={theme.textMuted}>/sessions          manage sessions (Ctrl+B)</text>
            <text fg={theme.textMuted}>/exit              quit</text>
          </scrollbox>
        </Show>

        <Show when={appState() === "error"}>
          <scrollbox flexGrow={1}>
            <text fg={theme.error} attributes={createTextAttributes({ bold: true })}>Error</text>
            <text fg={theme.error}>{errorMessage()}</text>
          </scrollbox>
        </Show>

        <Show when={appState() === "working" || appState() === "paused" || appState() === "completed" || appState() === "chatting"}>
          <OutputWindow
            outputBlocks={outputBlocks()}
            workflowStatus={appState() === "working" || appState() === "chatting" ? "running" : appState() === "paused" ? "interrupted" : "completed"}
            approvalPending={false}
            isPromptFocused={true}
            currentStep={appState() === "chatting" ? null : currentStep()}
          />
        </Show>

        <Show when={statusLine()}>
          <box flexShrink={0}><text fg={theme.success}>{statusLine()}</text></box>
        </Show>
      </box>

      {/* Prompt */}
      <box flexShrink={0}>
        <Show when={showPrompt()}>
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}
            backgroundColor={theme.backgroundElement} border={["left"]} borderColor={theme.primary}>
            <textarea
              ref={(r: TextareaRenderable) => {
                promptRef = r
                r.onContentChange = () => setPromptHeight(Math.min(3, Math.max(1, r.virtualLineCount)))
                queueMicrotask(() => r?.focus?.())
              }}
              width={lineWidth()} height={promptHeight()} wrapMode="word"
              placeholder={
                appState() === "working"
                  ? "Send a message to steer the worker (Esc to pause)"
                  : appState() === "chatting"
                    ? (chatWaiting() ? "Waiting for response..." : "Send a message (/end to exit chat)")
                    : appState() === "paused"
                      ? "Send a message to resume, or Esc to force stop"
                      : appState() === "idle"
                        ? '/chat or /start work "description"'
                        : "Enter command..."
              }
              backgroundColor="transparent" focusedBackgroundColor="transparent"
              onSubmit={() => { const v = promptRef?.plainText ?? ""; handlePromptSubmit(v); promptRef?.clear(); setPromptHeight(1) }}
              keyBindings={[{ name: "return", action: "submit" as TextareaAction }]}
            />
          </box>
        </Show>
      </box>

      {/* Footer */}
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0}>
        <text fg={theme.textMuted}>{process.cwd()}</text>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.textMuted}>
            {appState() === "chatting" ? "Esc · /end"
              : appState() === "paused" ? "Esc (stop) · Ctrl+R (resume)"
              : appState() === "working" ? `Esc (pause)${runningCount() > 1 ? ` · ${runningCount()} sessions` : ""}`
              : `Esc · Ctrl+B · /chat · /exit${runningCount() > 0 ? ` · ${runningCount()} running` : ""}`}
          </text>
          <text fg={theme.textMuted}>v0.0.1</text>
        </box>
      </box>

      {/* Session modal overlay */}
      <Show when={sessionsModalOpen()}>
        <SessionModal
          activeSessionId={foregroundId()}
          cursor={modalCursor()}
          confirmDeleteId={modalConfirmDelete()}
          onClose={() => setSessionsModalOpen(false)}
          onSelect={(idx) => { setModalCursor(idx); setModalConfirmDelete(undefined) }}
        />
      </Show>
    </box>
  )
}
