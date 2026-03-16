/** @jsxImportSource @opentui/solid */
/**
 * FlywheelShell — Top-level persistent shell component
 *
 * Two views driven by signal-based routing:
 *   HOME: Logo, help rows, command prompt — accepts workflow commands
 *   WORKING: Full WorkflowView (PhaseProgress, OutputWindow, TelemetryBar,
 *     StatusFooter, modals) — the rich work view
 *
 * Workflow lifecycle:
 *   handleCommand(workflow, args) — dispatches to startWorkWorkflow or
 *     startGenericWorkflow, returns to home on completion/stop
 *   stopWorkflow() — shuts down controller/runner, destroys session, returns to home
 */

import fs from "node:fs"
import os from "node:os"
import { createSignal, onCleanup, Show, Switch, Match } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { Toast } from "@tui/shared/ui/toast"
import { WorkflowView } from "@tui/shared/components/workflow-view"
import { HomeView } from "../routes/home/home-view"
import { exitTUI } from "../app"
import { createEscapeHandler } from "../utils/escape-handler"
import {
  createWorkflowSession,
  destroyWorkflowSession,
} from "./workflow-session"
import { WorkController } from "../../controller/work"
import { loadConfig } from "../../config/loader"
import { getEngine } from "../../engines/core/registry"
import { BunProcessSpawner } from "../../worker/bun-spawner"
import { EventBus, createFlywheelEmitter } from "../../events/event-bus"
import {
  workflowRegistry,
  WorkflowRunner,
  StepExecutor,
  buildWorkflowPrompt,
} from "../../workflows/index"
import type { WorkflowSession } from "./workflow-session"
import type { UIActions } from "../routes/work/context/ui-state/types"

/** Expand a leading `~` to the user's home directory. */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return os.homedir() + p.slice(1)
  }
  return p
}

// ── Workflow type → label mapping ──

type WorkflowType = "work" | "plan" | "review" | "ship" | "debug" | "research"

interface WorkflowMeta {
  stepLabel: string
  workflowName: string
}

const WORKFLOW_META: Record<WorkflowType, WorkflowMeta> = {
  work:     { stepLabel: "Phase",  workflowName: "work" },
  plan:     { stepLabel: "Step",   workflowName: "plan" },
  review:   { stepLabel: "Step",   workflowName: "review" },
  ship:     { stepLabel: "Step",   workflowName: "ship" },
  debug:    { stepLabel: "Cycle",  workflowName: "debug" },
  research: { stepLabel: "Step",   workflowName: "research" },
}

function isWorkflowType(s: string): s is WorkflowType {
  return s in WORKFLOW_META
}

// ── View mode ──

type ViewMode = "home" | "working"

export function FlywheelShell() {
  const themeCtx = useTheme()
  const toast = useToast()
  const [view, setView] = createSignal<ViewMode>("home")
  const [escHint, setEscHint] = createSignal("")

  // Active workflow metadata
  const [activeStepLabel, setActiveStepLabel] = createSignal("Phase")
  const [activeWorkflowName, setActiveWorkflowName] = createSignal("work")

  // Active workflow store as signal — drives the home/work view switch
  const [activeStore, setActiveStore] = createSignal<UIActions | null>(null)

  // Non-reactive refs for lifecycle management
  let activeSession: WorkflowSession | null = null
  let activeController: WorkController | null = null
  let activeRunner: WorkflowRunner | null = null

  // Double-Esc handler for stopping workflows
  const escapeHandler = createEscapeHandler({ timeoutMs: 5000 })

  // ── Workflow Lifecycle ──

  const startWorkWorkflow = (planPath: string) => {
    // Clean up any previous session
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
      activeController = null
      setActiveStore(null)
    }

    // Create fresh session: store → adapter → eventBus
    const session = createWorkflowSession(planPath)
    activeSession = session
    setActiveStore(session.store)
    setView("working")

    // Subscribe to store — transition shell back to home when workflow ends
    session.store.subscribe(() => {
      const wfStatus = session.store.getState().workflowStatus
      if (
        wfStatus === "completed" ||
        wfStatus === "failed" ||
        wfStatus === "interrupted"
      ) {
        // Stay on working view so user can see final state;
        // they return home via Esc or a new command
      }
    })

    // Load config fresh per workflow (~1ms, catches edits)
    let config
    try {
      const result = loadConfig()
      config = result.config
    } catch {
      returnToHome()
      return
    }

    // Create engine and spawner
    let engine
    try {
      engine = getEngine(config.engine)
    } catch {
      returnToHome()
      return
    }

    const spawner = new BunProcessSpawner({
      timeoutMinutes: config.timeout_minutes,
    })

    // Create WorkController — constructor calls adapter.connect(eventBus)
    const controller = new WorkController({
      config,
      spawner,
      engine,
      ui: session.adapter,
    })
    activeController = controller

    // queueMicrotask: gives renderer one tick to commit before events start flowing
    queueMicrotask(() => {
      controller.run(planPath).catch(() => {
        // Controller threw before emitting workflow:failed (e.g., plan file not found)
      })
    })
  }

  const startGenericWorkflow = (
    workflowName: string,
    args: Record<string, string>,
  ) => {
    const workflow = workflowRegistry[workflowName]
    if (!workflow) return

    // Clean up any previous session
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
      activeController = null
      activeRunner = null
      setActiveStore(null)
    }

    // Create fresh session (reuses the same store/adapter infrastructure)
    const session = createWorkflowSession(workflowName)
    activeSession = session
    setActiveStore(session.store)
    setView("working")

    // Load config
    let config
    try {
      const result = loadConfig()
      config = result.config
    } catch {
      returnToHome()
      return
    }

    // Create engine and spawner
    let engine
    try {
      engine = getEngine(config.engine)
    } catch {
      returnToHome()
      return
    }

    const spawner = new BunProcessSpawner({
      timeoutMinutes: config.timeout_minutes,
    })

    // Wire event bus from session through adapter
    const eventBus = new EventBus()
    const emitter = createFlywheelEmitter(eventBus)
    session.adapter.connect(eventBus)

    const executor = new StepExecutor({
      spawner,
      emitter,
      engine,
      config,
      workflowId: `${workflowName}-tui`,
    })

    const runner = new WorkflowRunner({
      workflow,
      executor,
      emitter,
      ui: session.adapter,
      config,
      promptBuilder: (stepIndex, wf, prevResult) =>
        buildWorkflowPrompt(stepIndex, wf, args, prevResult, config.project_cwd),
    })
    activeRunner = runner

    // Run the workflow asynchronously
    queueMicrotask(() => {
      runner.run().catch(() => {
        // Runner threw before emitting workflow:failed
      })
    })
  }

  const stopWorkflow = async () => {
    escapeHandler.reset()
    setEscHint("")
    if (activeRunner) {
      activeRunner.requestShutdown()
      activeRunner = null
    }
    if (activeController) {
      await activeController.shutdown()
      activeController = null
    }
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
    }
    setActiveStore(null)
    setView("home")
  }

  const returnToHome = () => {
    if (activeRunner) {
      activeRunner.requestShutdown()
      activeRunner = null
    }
    if (activeController) {
      activeController.shutdown().catch(() => {})
      activeController = null
    }
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
    }
    setActiveStore(null)
    setView("home")
  }

  // Clean up on component unmount
  onCleanup(() => {
    escapeHandler.dispose()
    if (activeRunner) {
      activeRunner.requestShutdown()
      activeRunner = null
    }
    if (activeController) {
      activeController.shutdown().catch(() => {})
      activeController = null
    }
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
    }
  })

  // ── Command Handler ──

  const handleCommand = (workflow: string, args: Record<string, string>) => {
    // Handle special commands first
    if (workflow === "exit") {
      exitTUI()
      return
    }

    if (workflow === "help") {
      toast.show({
        message: "Commands: /work, /plan, /review, /ship, /debug, /research, /config, /exit",
        variant: "info",
        duration: 8000,
      })
      return
    }

    if (workflow === "config") {
      toast.show({
        message: "Not yet implemented: /config",
        variant: "warning",
      })
      return
    }

    // Check if this is a workflow type
    if (!isWorkflowType(workflow)) {
      toast.show({
        message: `Unknown workflow: ${workflow}`,
        variant: "error",
      })
      return
    }

    const meta = WORKFLOW_META[workflow]
    setActiveStepLabel(meta.stepLabel)
    setActiveWorkflowName(meta.workflowName)

    // "work" workflow — resolve plan path
    if (workflow === "work") {
      const planPath = args.planPath
      if (!planPath) {
        toast.show({
          message: "Usage: /work <plan-path>",
          variant: "error",
        })
        return
      }

      const resolved = expandTilde(planPath)
      if (!fs.existsSync(resolved)) {
        toast.show({
          message: `File not found: ${planPath}`,
          variant: "error",
        })
        return
      }

      startWorkWorkflow(resolved)
      return
    }

    // Non-work workflows — validate required args
    if (workflow === "plan" && !args.description) {
      toast.show({
        message: "Usage: /plan <feature description>",
        variant: "error",
      })
      return
    }

    if (workflow === "debug" && !args.description) {
      toast.show({
        message: "Usage: /debug <problem description>",
        variant: "error",
      })
      return
    }

    if (workflow === "research" && !args.topic) {
      toast.show({
        message: "Usage: /research <topic>",
        variant: "error",
      })
      return
    }

    // Start generic workflow
    startGenericWorkflow(workflow, args)
  }

  // ── Escape Handling ──

  const handleEscape = () => {
    const currentView = view()
    if (currentView === "home") {
      exitTUI()
      return
    }
    if (currentView === "working") {
      const result = escapeHandler.handleEscape()
      if (result === "show-hint") {
        setEscHint("Press Esc again to stop")
        setTimeout(() => setEscHint(""), 5000)
      } else {
        setEscHint("")
        stopWorkflow()
      }
    }
  }

  // ── Shell-Level Keyboard Shortcuts ──

  useKeyboard((evt) => {
    // Ctrl+T: toggle theme (always available)
    if (evt.ctrl && evt.name === "t") {
      evt.preventDefault()
      themeCtx.setMode(themeCtx.mode === "dark" ? "light" : "dark")
      return
    }
    // Ctrl+C: exit when home, stop workflow when working
    if (evt.ctrl && evt.name === "c") {
      evt.preventDefault()
      const currentView = view()
      if (currentView === "home") {
        exitTUI()
      } else if (currentView === "working") {
        stopWorkflow()
      }
      return
    }
  })

  // ── Approval decision handler ──

  const handleApprovalDecision = (approved: boolean, skip?: boolean) => {
    if (activeSession) {
      activeSession.adapter.onApprovalDecision?.(approved, skip)
    }
  }

  // ── Render ──

  return (
    <box flexDirection="column" height="100%">
      <Toast />
      <Switch>
        <Match when={view() === "home"}>
          <HomeView
            onCommand={handleCommand}
            onEscape={handleEscape}
          />
        </Match>
        <Match when={view() === "working" && activeStore()}>
          {/* Working view with active store */}
          <WorkflowView
            store={activeStore()!}
            stepLabel={activeStepLabel()}
            workflowName={activeWorkflowName()}
            onStop={() => stopWorkflow()}
            onApprovalDecision={handleApprovalDecision}
            onToggleRawMode={() => {
              if (activeSession) {
                const nowRaw = activeSession.adapter.toggleRawMode()
                toast.show({
                  message: nowRaw ? "Raw output: ON" : "Raw output: OFF",
                  variant: "info",
                  duration: 2000,
                })
              }
            }}
          />

          {/* Escape hint overlay (during double-Esc) */}
          <Show when={escHint()}>
            <box flexShrink={0} paddingLeft={2}>
              <text fg={themeCtx.theme.warning ?? themeCtx.theme.textMuted}>
                {escHint()}
              </text>
            </box>
          </Show>
        </Match>
      </Switch>
    </box>
  )
}
