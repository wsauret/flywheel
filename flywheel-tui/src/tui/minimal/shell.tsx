/** @jsxImportSource @opentui/solid */
/**
 * MinimalShell — Phase 3 stripped-down TUI shell.
 *
 * Layout: Header → StepProgress → OutputWindow (structured blocks) → Prompt → Footer
 *
 * Does exactly three things:
 * 1. Accept `/start work "description"` (or /start <workflow>)
 * 2. Show live structured output as the worker runs
 * 3. Display completion state
 *
 * No sidebar, no session switching, no resume, no chat, no HITL.
 */

import { createSignal, createMemo, createEffect, For, Show, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { Selection } from "../utils/selection"
import { exitTUI } from "../app"
import { OutputWindow } from "../routes/work/components/output-window"
import { OpenTUIAdapter } from "../adapters/opentui"
import { createStore as createUIStore } from "../routes/work/context/ui-state/store"
import { prepareWorkflowDeps, type WorkflowDeps } from "../../engines/workflow-deps"
import { buildQueueForSlashCommand } from "../shell/shell-queue"
import { resolveTransports, buildExecutorDeps } from "../shell/queue-orchestrator"
import { createStepExecutor, type StepExecutor } from "../../queue/executor"
import { createQueuePersistence } from "../../queue/persistence"
import { createGuardrails } from "../../queue/guardrails"
import { createBudgetTracker, type BudgetTracker } from "../../session/budget-tracker"
import { EventBus, createFlywheelEmitter, type Unsubscribe } from "../../events/event-bus"
import { ContextIndexer } from "../../memory/indexer"
import { ensureSessionDir } from "../../config/paths"
import { randomUUID } from "node:crypto"
import { Log } from "../../utils/log"
import { startChatSession, type ChatSession } from "./chat"
import { FULL_LOGO, SIMPLE_LOGO } from "@tui/shared/components/logo"
import { SplitBorder } from "../shared/ui/border"
import type { StdinHandle } from "../../worker/spawner"
import type { AnyBlock } from "../types"
import "../../queue/steps/register-all"

const log = Log.create({ service: "minimal-shell" })

// ── Formatting helpers ──

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m ${sec}s`
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

function relativeTime(ms: number): string {
  const ago = Date.now() - ms
  if (ago < 5_000) return "just now"
  if (ago < 60_000) return `${Math.floor(ago / 1000)}s ago`
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`
  return `${Math.floor(ago / 3_600_000)}h ago`
}

// ── Types ──

type AppState = "idle" | "working" | "completed" | "error" | "chatting"
type StepState = {
  id: string; type: string; title: string; status: string
  durationMs?: number; startedAt?: number; completedAt?: number
}

export function MinimalShell() {
  const { theme } = useTheme()
  const toast = useToast()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  // ── State ──
  const [appState, setAppState] = createSignal<AppState>("idle")
  const [outputBlocks, setOutputBlocks] = createSignal<AnyBlock[]>([])
  const [steps, setSteps] = createSignal<StepState[]>([])
  const [errorMessage, setErrorMessage] = createSignal("")
  const [sessionTitle, setSessionTitle] = createSignal("")
  const [statusLine, setStatusLine] = createSignal("")

  // Re-focus prompt after chat turn completes
  createEffect(() => {
    if (appState() === "chatting" && !chatWaiting()) {
      queueMicrotask(() => promptRef?.focus?.())
    }
  })

  // Live metrics (updated during execution)
  const [liveTokens, setLiveTokens] = createSignal(0)
  const [liveCost, setLiveCost] = createSignal(0)
  const [workStartTime, setWorkStartTime] = createSignal(0)
  const [elapsed, setElapsed] = createSignal(0)

  // Chat mode state
  const [chatWaiting, setChatWaiting] = createSignal(false)

  // ── Mutable refs ──
  let activeExecutor: StepExecutor | null = null
  let activeBudgetTracker: BudgetTracker | null = null
  let activeAdapter: OpenTUIAdapter | null = null
  let storeUnsub: (() => void) | null = null
  let eventUnsubs: Unsubscribe[] = []
  let promptRef: any = null
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let metricsTimer: ReturnType<typeof setInterval> | null = null
  let activeChatSession: ChatSession | null = null

  // ── Cleanup ──
  onCleanup(() => {
    eventUnsubs.forEach((u) => u())
    storeUnsub?.()
    activeAdapter?.disconnect()
    activeBudgetTracker?.dispose()
    activeChatSession?.end()
    if (elapsedTimer) clearInterval(elapsedTimer)
    if (metricsTimer) clearInterval(metricsTimer)
    renderer.setTerminalTitle("")
  })

  // ── Start workflow ──
  async function startWorkflow(command: string, description: string) {
    setAppState("working")
    setOutputBlocks([])
    setSteps([])
    setErrorMessage("")
    setStatusLine("")
    setSessionTitle(description || command)
    setWorkStartTime(Date.now())
    setElapsed(0)
    setLiveTokens(0)
    setLiveCost(0)

    // Terminal title
    renderer.setTerminalTitle(`flywheel · ${description || command}`)

    // Elapsed timer — ticks every second
    elapsedTimer = setInterval(() => {
      setElapsed(Date.now() - workStartTime())
    }, 1000)

    let deps: WorkflowDeps
    try {
      deps = prepareWorkflowDeps()
    } catch (err) {
      setErrorMessage(`Config error: ${err instanceof Error ? err.message : String(err)}`)
      setAppState("error")
      stopTimers()
      return
    }

    const queue = buildQueueForSlashCommand(command, deps.config)
    const sessionId = randomUUID()
    const projectCwd = process.cwd()
    ensureSessionDir(sessionId, projectCwd)

    // Initialize step display
    setSteps(queue.steps.map((s) => ({ id: s.id, type: s.type, title: s.title, status: s.status })))

    // Event bus + emitter
    const eventBus = new EventBus()
    const emitter = createFlywheelEmitter(eventBus)
    const workflowIdRef = { current: randomUUID() }

    // Budget tracker
    activeBudgetTracker = createBudgetTracker({ sessionId, baseDir: projectCwd })

    // Live metrics poll — update cost/tokens from budget tracker every 500ms
    metricsTimer = setInterval(() => {
      if (activeBudgetTracker) {
        setLiveTokens(activeBudgetTracker.getTokensUsed())
        setLiveCost(activeBudgetTracker.getTotalCost())
      }
    }, 500)

    // ── Structured output pipeline ──
    const uiActions = createUIStore("workflow")
    uiActions.startWorkflow(command)
    activeAdapter = new OpenTUIAdapter({ actions: uiActions })
    activeAdapter.connect(eventBus)

    storeUnsub = uiActions.subscribe(() => {
      const state = uiActions.getState()
      setOutputBlocks(state.outputBlocks ?? [])
    })

    // Subscribe to queue events for step progress
    eventUnsubs.push(
      eventBus.subscribe((event) => {
        if (event.type === "queue:step-started") {
          const e = event as any
          setSteps((prev) =>
            prev.map((s) => (s.id === e.stepId ? { ...s, status: "running", startedAt: Date.now() } : s)),
          )
        }
        if (event.type === "queue:step-completed") {
          const e = event as any
          const now = Date.now()
          setSteps((prev) =>
            prev.map((s) => {
              if (s.id !== e.stepId) return s
              return { ...s, status: "completed", completedAt: now, durationMs: s.startedAt ? now - s.startedAt : undefined }
            }),
          )
        }
        if (event.type === "queue:step-failed") {
          const e = event as any
          setSteps((prev) =>
            prev.map((s) => (s.id === e.stepId ? { ...s, status: "failed", completedAt: Date.now() } : s)),
          )
        }
      }),
    )

    try {
      const { dispatcherTransport, evaluatorTransport } = await resolveTransports(
        deps, eventBus, workflowIdRef, "", sessionId, projectCwd,
      )

      if (!dispatcherTransport) {
        setErrorMessage("Dispatcher transport unavailable. Check your engine configuration.")
        setAppState("error")
        stopTimers()
        return
      }

      const contextIndexer = new ContextIndexer(projectCwd)
      const stdinHandleRef: { current: StdinHandle | null } = { current: null }

      const execDeps = buildExecutorDeps({
        deps, emitter, workflowIdRef, dispatcherTransport, evaluatorTransport,
        contextIndexer, projectCwd, sessionObjective: description, queue, sessionId,
        stdinHandleRef,
        setShellQueueSteps: () => {},
        capturedWorkerSessionId: { current: undefined },
        pendingInjection: { current: null },
        activeSessionRef: { current: null },
        budgetTracker: activeBudgetTracker,
      })

      const guardrails = createGuardrails({
        maxQueueLength: deps.config.queue?.max_steps ?? 50,
        maxMutationsPerStepCompletion: deps.config.dispatcher_intelligence?.max_mutations_per_step ?? 3,
        maxInsertedStepsPerSession: deps.config.dispatcher_intelligence?.max_inserted_steps ?? 20,
      })

      const persistence = createQueuePersistence({ sessionId, baseDir: projectCwd })

      const executor = createStepExecutor({
        queue,
        workflowId: workflowIdRef.current,
        sessionId,
        emitter,
        dispatcher: execDeps.dispatcherFn,
        worker: execDeps.workerFn,
        evaluator: execDeps.evaluator,
        handoffReader: execDeps.handoffReader,
        budgetChecker: { isExhausted: () => false },
        persist: async (q) => { try { await persistence.save(q) } catch { /* best-effort */ } },
        accumulator: execDeps.contextAccumulator,
        maxRevisions: deps.config.max_revisions ?? 1,
        onStepCompleted: execDeps.compositeHook,
        guardrails,
        sessionObjective: description,
        onWorkerDispatched: activeBudgetTracker ? () => activeBudgetTracker!.incrementInvocations() : null,
        onSessionName: (name) => {
          setSessionTitle(name)
          renderer.setTerminalTitle(`flywheel · ${name}`)
        },
      })
      activeExecutor = executor

      const result = await executor.run()

      // Final step states from queue
      setSteps(queue.steps.map((s) => ({ id: s.id, type: s.type, title: s.title, status: s.status })))

      activeBudgetTracker?.flush()
      const cost = activeBudgetTracker?.getTotalCost() ?? 0
      const tokens = activeBudgetTracker?.getTokensUsed() ?? 0
      const totalElapsed = formatElapsed(Date.now() - workStartTime())
      if (result.completed) {
        setStatusLine(`✓ ${result.stepsCompleted}/${result.stepsTotal} steps · ${totalElapsed} · ${formatCost(cost)} · ${formatTokens(tokens)} tokens`)
      } else {
        setStatusLine(`✗ ${result.reason ?? "stopped"} (${result.stepsCompleted}/${result.stepsTotal}) · ${totalElapsed} · ${formatCost(cost)}`)
      }
      setAppState("completed")
      renderer.setTerminalTitle("flywheel · done")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error("workflow execution failed", { error: msg })
      setErrorMessage(msg)
      setAppState("error")
      renderer.setTerminalTitle("flywheel · error")
    } finally {
      stopTimers()
      activeExecutor = null
      activeAdapter?.disconnect()
      activeAdapter = null
      storeUnsub?.()
      storeUnsub = null
      activeBudgetTracker?.dispose()
      activeBudgetTracker = null
    }
  }

  function stopTimers() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null }
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
    setWorkStartTime(Date.now())
    setElapsed(0)
    setLiveTokens(0)
    setLiveCost(0)
    renderer.setTerminalTitle("flywheel · chat")
    elapsedTimer = setInterval(() => setElapsed(Date.now() - workStartTime()), 1000)

    try {
      activeChatSession = await startChatSession({
        onBlocksChanged: setOutputBlocks,
        onWaitingChanged: setChatWaiting,
        onTokensChanged: setLiveTokens,
        onCostChanged: setLiveCost,
        onError: (msg) => { setErrorMessage(msg); setAppState("error") },
        onEnded: () => {
          if (appState() !== "chatting") return
          stopTimers()
          const cost = activeChatSession?.budgetTracker.getTotalCost() ?? 0
          const tokens = activeChatSession?.budgetTracker.getTokensUsed() ?? 0
          setStatusLine(`Chat ended · ${formatElapsed(Date.now() - workStartTime())} · ${formatCost(cost)} · ${formatTokens(tokens)} tokens`)
          activeChatSession = null
          setAppState("completed")
          renderer.setTerminalTitle("flywheel · done")
        },
      }, initialMessage)
    } catch (err) {
      setErrorMessage(`Chat error: ${err instanceof Error ? err.message : String(err)}`)
      setAppState("error")
      stopTimers()
    }
  }

  function endChat() {
    stopTimers()
    activeChatSession?.end()
    activeChatSession = null
  }

  // ── Command dispatch ──
  function handlePromptSubmit(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return

    // Chat mode: send message to worker (unless it's a command)
    if (appState() === "chatting") {
      if (trimmed === "/exit" || trimmed === "/quit") { endChat(); exitTUI(); return }
      if (trimmed === "/end" || trimmed === "/stop") { endChat(); return }
      activeChatSession?.send(trimmed)
      return
    }

    if (trimmed === "/exit" || trimmed === "/quit") { exitTUI(); return }

    // /chat — start interactive chat mode
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

    toast.show({ message: `Unknown command. Try /chat, /start work "desc", or /exit`, variant: "warning" })
  }

  // ── Keyboard ──
  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      if (appState() === "chatting") {
        endChat()
        setStatusLine(`Chat ended · ${formatElapsed(Date.now() - workStartTime())}`)
        setAppState("completed")
        return
      }
      if (activeExecutor && appState() === "working") {
        activeExecutor.requestShutdown()
      } else {
        exitTUI()
      }
    }
  })

  // ── Derived state ──
  const lineWidth = createMemo(() => Math.max(dimensions().width - 4, 40))
  const currentStep = createMemo(() => {
    const running = steps().find((s) => s.status === "running")
    if (!running) return null
    const idx = steps().indexOf(running)
    return { index: idx, name: running.title, status: "running" as const }
  })

  // Header right-side info: live metrics while working, final summary when done
  const headerRight = createMemo(() => {
    const state = appState()
    if (state === "idle") return "ready"
    if (state === "error") return "error"
    if (state === "working" || state === "chatting") {
      const parts: string[] = [formatElapsed(elapsed())]
      const t = liveTokens()
      if (t > 0) parts.push(formatTokens(t))
      const c = liveCost()
      if (c > 0) parts.push(formatCost(c))
      return parts.join(" · ")
    }
    return "done"
  })

  const showLogo = createMemo(() => appState() === "idle" && dimensions().height >= 20)

  return (
    <box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={theme.background} onMouseUp={() => Selection.copy(renderer, toast)}>

      {/* Header — panel background + left border */}
      <box
        flexShrink={0}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        backgroundColor={theme.backgroundPanel}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.primary} style={{ bold: true }}>flywheel</text>
          <Show when={sessionTitle()}><text fg={theme.text} style={{ bold: true }}>{sessionTitle()}</text></Show>
          <text fg={theme.textMuted}>{headerRight()}</text>
        </box>
      </box>

      {/* Main content area */}
      <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>

        {/* Step Progress */}
        <Show when={steps().length > 0}>
          <box flexShrink={0}>
            <For each={steps()}>
              {(step) => {
                const color = () =>
                  step.status === "completed" ? theme.success
                  : step.status === "running" ? theme.primary
                  : step.status === "failed" ? theme.error
                  : theme.textMuted
                const icon = () =>
                  step.status === "completed" ? "✓"
                  : step.status === "running" ? "▸"
                  : step.status === "failed" ? "✗"
                  : "○"
                const detail = () => {
                  if (step.durationMs) return ` (${(step.durationMs / 1000).toFixed(1)}s)`
                  if (step.completedAt) return ` · ${relativeTime(step.completedAt)}`
                  if (step.status === "running" && step.startedAt) return ` · ${relativeTime(step.startedAt)}`
                  return ""
                }
                return (
                  <text fg={color()}>
                    {icon()} {step.title}{detail()}
                  </text>
                )
              }}
            </For>
          </box>
        </Show>

        {/* Idle: logo + help text */}
        <Show when={appState() === "idle"}>
          <scrollbox flexGrow={1}>
            <Show when={showLogo()}>
              <box paddingTop={2} paddingBottom={1}>
                <For each={FULL_LOGO}>
                  {(line) => <text fg={theme.primary}>{line}</text>}
                </For>
              </box>
            </Show>
            <Show when={!showLogo()}>
              <box paddingTop={1} paddingBottom={1}>
                <For each={SIMPLE_LOGO}>
                  {(line) => <text fg={theme.primary} style={{ bold: true }}>{line}</text>}
                </For>
              </box>
            </Show>
            <text fg={theme.textMuted}>/chat              start an interactive session</text>
            <text fg={theme.textMuted}>/start work "desc"  run a workflow pipeline</text>
            <text fg={theme.textMuted}>/exit              quit</text>
          </scrollbox>
        </Show>

        {/* Error */}
        <Show when={appState() === "error"}>
          <scrollbox flexGrow={1}>
            <text fg={theme.error} style={{ bold: true }}>Error</text>
            <text fg={theme.error}>{errorMessage()}</text>
          </scrollbox>
        </Show>

        {/* Active output */}
        <Show when={appState() === "working" || appState() === "completed" || appState() === "chatting"}>
          <OutputWindow
            outputBlocks={outputBlocks()}
            workflowStatus={appState() === "working" ? "running" : appState() === "chatting" ? "running" : "completed"}
            approvalPending={false}
            isPromptFocused={appState() !== "working"}
            currentStep={appState() === "chatting" ? null : currentStep()}
          />
        </Show>

        {/* Status line */}
        <Show when={statusLine()}>
          <box flexShrink={0}>
            <text fg={theme.success}>{statusLine()}</text>
          </box>
        </Show>

      </box>

      {/* Prompt — distinct background, left border */}
      <box flexShrink={0}>
        <Show when={appState() !== "working"}>
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={theme.backgroundElement}
            border={["left"]}
            borderColor={theme.primary}
          >
            <input
              ref={(r: any) => { promptRef = r; queueMicrotask(() => r?.focus?.()) }}
              width={lineWidth()}
              placeholder={
                appState() === "chatting"
                  ? (chatWaiting() ? "Waiting for response..." : "Send a message (/end to exit chat)")
                  : appState() === "idle"
                    ? '/chat or /start work "description"'
                    : "Enter command..."
              }
              onSubmit={() => { const v = promptRef?.value ?? ""; handlePromptSubmit(v); if (promptRef) promptRef.value = "" }}
            />
          </box>
        </Show>
        <Show when={appState() === "working"}>
          <box paddingLeft={2} paddingTop={1} paddingBottom={1} backgroundColor={theme.backgroundElement}>
            <text fg={theme.textMuted}>Running... Press Ctrl+C to stop.</text>
          </box>
        </Show>
      </box>

      {/* Footer */}
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0}>
        <text fg={theme.textMuted}>{process.cwd()}</text>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.textMuted}>
            {appState() === "chatting" ? "/end · Ctrl+C" : "/chat · /exit · Ctrl+C"}
          </text>
          <text fg={theme.textMuted}>v0.0.1</text>
        </box>
      </box>
    </box>
  )
}
