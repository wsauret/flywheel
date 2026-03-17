/** @jsxImportSource @opentui/solid */
/**
 * FlywheelShell — Top-level persistent shell component
 *
 * Four view modes driven by signal-based routing:
 *   LAUNCHER:  Logo, help rows, command prompt — accepts workflow commands
 *   WORKING:   Full WorkflowView (PhaseProgress, OutputWindow, TelemetryBar,
 *              StatusFooter, modals) — the rich work view
 *   COMPLETED: Workflow finished/stopped/failed — prompt for next action
 *   IMPORTING: Plan import flow (placeholder, reuses launcher for now)
 *
 * ViewMode transitions are defined in shell-modes.ts (pure state machine).
 *
 * Command dispatch is handled by ActionDispatcher (action-dispatcher.ts),
 * a pure function with dependency injection. Both slash commands and
 * contextual UI actions route through the same dispatcher.
 *
 * Workflow lifecycle:
 *   handleCommand(workflow, args) — routes through ActionDispatcher
 *   stopWorkflow() — shuts down controller/runner, destroys session,
 *     transitions to completed
 */

import fs from "node:fs"
import { createSignal, onCleanup, Show, Switch, Match } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { useDialog } from "@tui/shared/context/dialog"
import { Toast } from "@tui/shared/ui/toast"
import { WorkflowView } from "@tui/shared/components/workflow-view"
import { LauncherView } from "../routes/home/home-view"
import { exitTUI } from "../app"
import { createEscapeHandler } from "../utils/escape-handler"
import { Selection } from "../utils/selection"
import { Clipboard } from "../utils/clipboard"
import { openStarterChooser } from "./starter-chooser"
import { createActionDispatcher } from "./action-dispatcher"
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

// ── View mode ──

import {
  escapeForMode,
  ctrlCForMode,
  type ViewMode,
} from "./shell-modes"

export function FlywheelShell() {
  const themeCtx = useTheme()
  const toast = useToast()
  const dialog = useDialog()
  const renderer = useRenderer()
  const [view, setView] = createSignal<ViewMode>("launcher")
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

  // Wire console copy-to-clipboard via OpenTUI's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return
    await Clipboard.copy(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch((err) => toast.show({ message: String(err), variant: "error" }))
    renderer.clearSelection()
  }

  // ── Selection: copy on mouse-up (X11 / macOS style) ──
  // When user selects text with mouse drag, copy to clipboard on release.
  // Ctrl+C copies when there's an active selection (handled in keyboard section below).

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

  /**
   * Tear down the active workflow: shut down runner, controller, and session.
   * Returns the controller shutdown promise so callers can await if needed.
   */
  const teardownActiveWorkflow = (): Promise<void> | undefined => {
    if (activeRunner) {
      activeRunner.requestShutdown()
      activeRunner = null
    }
    let shutdownPromise: Promise<void> | undefined
    if (activeController) {
      shutdownPromise = activeController.shutdown().catch(() => {})
      activeController = null
    }
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
    }
    setActiveStore(null)
    return shutdownPromise
  }

  const stopWorkflow = async () => {
    escapeHandler.reset()
    setEscHint("")
    await teardownActiveWorkflow()
    setView("completed")
  }

  const returnToHome = () => {
    teardownActiveWorkflow()
    setView("launcher")
  }

  // Clean up on component unmount
  onCleanup(() => {
    escapeHandler.dispose()
    teardownActiveWorkflow()
  })

  // ── Command Handler (via ActionDispatcher) ──

  const dispatch = createActionDispatcher({
    fileExists: (path) => fs.existsSync(path),
    notify: (message, variant) => {
      toast.show({
        message,
        variant: variant as "info" | "error" | "warning",
        ...(variant === "info" ? { duration: 8000 } : {}),
      })
    },
    launchWorkWorkflow: startWorkWorkflow,
    launchGenericWorkflow: startGenericWorkflow,
    exit: exitTUI,
    returnToLauncher: returnToHome,
  })

  const handleCommand = (workflow: string, args: Record<string, string>) => {
    const meta = dispatch(workflow, args)
    if (meta) {
      setActiveStepLabel(meta.stepLabel)
      setActiveWorkflowName(meta.workflowName)
    }
  }

  // ── Escape Handling ──

  const handleEscape = () => {
    const behavior = escapeForMode(view())
    switch (behavior) {
      case "exit-tui":
        exitTUI()
        return
      case "double-esc-stop": {
        const result = escapeHandler.handleEscape()
        if (result === "show-hint") {
          setEscHint("Press Esc again to stop")
          setTimeout(() => setEscHint(""), 5000)
        } else {
          setEscHint("")
          stopWorkflow()
        }
        return
      }
      case "return-launcher":
        returnToHome()
        return
      case "cancel-import":
        setView("launcher")
        return
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
    // Ctrl+N: open starter chooser dialog
    if (evt.ctrl && evt.name === "n") {
      evt.preventDefault()
      openStarterChooser(dialog, (selection) => {
        if (selection === "import-plan") {
          toast.show({ message: "Type /work <plan-path> to start", variant: "info" })
        } else if (selection === "new-idea") {
          toast.show({ message: "Type /plan <description> to create a plan", variant: "info" })
        }
      })
      return
    }
    // Ctrl+C: copy selection if active, otherwise view-mode behavior
    if (evt.ctrl && evt.name === "c") {
      if (renderer.getSelection()) {
        evt.preventDefault()
        if (!Selection.copy(renderer, toast)) {
          renderer.clearSelection()
        }
        return
      }
      evt.preventDefault()
      const behavior = ctrlCForMode(view())
      switch (behavior) {
        case "exit-tui":
          exitTUI()
          return
        case "stop-workflow":
          stopWorkflow()
          return
        case "return-launcher":
          returnToHome()
          return
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
    <box flexDirection="column" height="100%" onMouseUp={() => Selection.copy(renderer, toast)}>
      <Toast />
      <Switch>
        <Match when={view() === "launcher"}>
          <LauncherView
            onCommand={handleCommand}
            onEscape={handleEscape}
          />
        </Match>
        <Match when={view() === "importing"}>
          {/* Importing view — plan import flow (placeholder, reuses launcher for now) */}
          <LauncherView
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
        <Match when={view() === "completed"}>
          {/* Completed view — show final state, prompt for next action */}
          <LauncherView
            onCommand={handleCommand}
            onEscape={handleEscape}
          />
        </Match>
      </Switch>
    </box>
  )
}
