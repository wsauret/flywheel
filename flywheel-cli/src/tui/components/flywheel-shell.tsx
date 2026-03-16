/** @jsxImportSource @opentui/solid */
/**
 * FlywheelShell — Top-level persistent shell component
 *
 * Two modes:
 *   IDLE/COMPLETED (no active store): Branding header + centered logo + always-on prompt
 *   WORKING (active store): Full WorkShell (PhaseProgress, OutputWindow, TelemetryBar,
 *     StatusFooter, modals) — the rich CodeMachine-forked work view
 *
 * Workflow lifecycle:
 *   startWorkflow(planPath) — creates session, loads config, creates controller, runs
 *   stopWorkflow() — shuts down controller, destroys session, returns to prompt
 */

import fs from "node:fs"
import os from "node:os"
import { createSignal, onCleanup, Show, For } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { Toast } from "@tui/shared/ui/toast"
import { BrandingHeader } from "@tui/shared/components/layout/branding-header"
import { FULL_LOGO } from "@tui/shared/components/logo"
import { Prompt } from "./prompt/index"
import { HelpOverlay } from "./help-overlay"
import { WorkShell } from "../routes/work/components/work-shell"
import { parseSlashCommand } from "../utils/slash-commands"
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
import type { ShellState } from "./flywheel-shell-types"
import type { WorkflowSession } from "./workflow-session"
import type { UIActions } from "../routes/work/context/ui-state/types"

/** Expand a leading `~` to the user's home directory. */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return os.homedir() + p.slice(1)
  }
  return p
}

export function FlywheelShell() {
  const themeCtx = useTheme()
  const toast = useToast()
  const [shellState, setShellState] = createSignal<ShellState>("idle")
  const [escHint, setEscHint] = createSignal("")
  const [showHelp, setShowHelp] = createSignal(false)

  // Active workflow store as signal — drives the idle/work view switch
  const [activeStore, setActiveStore] = createSignal<UIActions | null>(null)

  // Non-reactive refs for lifecycle management
  let activeSession: WorkflowSession | null = null
  let activeController: WorkController | null = null

  // Double-Esc handler for stopping workflows
  const escapeHandler = createEscapeHandler({ timeoutMs: 5000 })

  // ── Workflow Lifecycle ──

  const startWorkflow = (planPath: string) => {
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
    setShellState("working")

    // Subscribe to store — transition shell to completed when workflow ends
    session.store.subscribe(() => {
      const wfStatus = session.store.getState().workflowStatus
      if (
        wfStatus === "completed" ||
        wfStatus === "failed" ||
        wfStatus === "interrupted"
      ) {
        setShellState("completed")
      }
    })

    // Load config fresh per workflow (~1ms, catches edits)
    let config
    try {
      const result = loadConfig()
      config = result.config
    } catch {
      setShellState("completed")
      destroyWorkflowSession(session)
      activeSession = null
      setActiveStore(null)
      return
    }

    // Create engine and spawner
    let engine
    try {
      engine = getEngine(config.engine)
    } catch {
      setShellState("completed")
      destroyWorkflowSession(session)
      activeSession = null
      setActiveStore(null)
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
        if (shellState() === "working") {
          setShellState("completed")
        }
      })
    })
  }

  const stopWorkflow = async () => {
    escapeHandler.reset()
    setEscHint("")
    if (activeController) {
      await activeController.shutdown()
      activeController = null
    }
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
    }
    setActiveStore(null)
    setShellState("completed")
  }

  const returnToIdle = () => {
    stopWorkflow()
    setShellState("idle")
  }

  // Clean up on component unmount
  onCleanup(() => {
    escapeHandler.dispose()
    if (activeController) {
      activeController.shutdown().catch(() => {})
      activeController = null
    }
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
    }
  })

  // ── Escape Handling ──

  const handleEscape = () => {
    const state = shellState()
    if (state === "idle" || state === "completed") {
      exitTUI()
      return
    }
    if (state === "working") {
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
    // Ctrl+C: exit when idle/completed, stop workflow when working
    if (evt.ctrl && evt.name === "c") {
      evt.preventDefault()
      const state = shellState()
      if (state === "idle" || state === "completed") {
        exitTUI()
      } else if (state === "working") {
        stopWorkflow()
      }
      return
    }
  })

  // ── Prompt Submit Handler (idle/completed mode) ──

  const handleSubmit = (input: string) => {
    const trimmed = input.trim()
    if (!trimmed) return

    const cmd = parseSlashCommand(trimmed)
    if (cmd) {
      switch (cmd.command) {
        case "exit": exitTUI(); return
        case "new": returnToIdle(); return
        case "stop":
          if (shellState() === "working") stopWorkflow()
          return
        case "help": setShowHelp(true); return
      }
      return
    }

    // Unrecognized slash command — show error, stay in current view
    if (trimmed.startsWith("/")) {
      toast.show({
        message: `Unknown command: ${trimmed}. Try /help, /new, /stop, /exit`,
        variant: "error",
      })
      return
    }

    // Treat as plan path
    const state = shellState()
    if (state === "idle" || state === "completed") {
      const resolved = expandTilde(trimmed)
      if (!fs.existsSync(resolved)) {
        toast.show({
          message: `File not found: ${trimmed}`,
          variant: "error",
        })
        return
      }
      startWorkflow(resolved)
    }
  }

  // ── Approval decision handler ──

  const handleApprovalDecision = (approved: boolean, skip?: boolean) => {
    if (activeSession) {
      activeSession.adapter.onApprovalDecision?.(approved, skip)
    }
  }

  // ── Render ──

  const store = () => activeStore()

  return (
    <box flexDirection="column" height="100%">
      <Toast />
      <Show
        when={store()}
        fallback={
          /* ── IDLE VIEW: branding + logo + prompt ── */
          <IdleView
            shellState={shellState()}
            escHint={escHint()}
            showHelp={showHelp()}
            onCloseHelp={() => setShowHelp(false)}
            onSubmit={handleSubmit}
            onEscape={handleEscape}
          />
        }
      >
        {(currentStore) => (
          <>
            {/* ── WORK VIEW: full rich CodeMachine-forked UI ── */}
            <WorkShell
              actions={currentStore()}
              onApprovalDecision={handleApprovalDecision}
              onStop={() => stopWorkflow()}
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
          </>
        )}
      </Show>
    </box>
  )
}

// ── Idle View ──

interface IdleViewProps {
  shellState: ShellState
  escHint: string
  showHelp: boolean
  onCloseHelp: () => void
  onSubmit: (input: string) => void
  onEscape: () => void
}

function IdleView(props: IdleViewProps) {
  const themeCtx = useTheme()

  const promptPlaceholder = () => {
    switch (props.shellState) {
      case "idle":
        return "Enter a plan path, or /help"
      case "completed":
        return "Enter to run again, /new to start fresh, or paste new path"
      default:
        return "Enter a plan path, or /help"
    }
  }

  return (
    <>
      {/* Branding header */}
      <box flexShrink={0}>
        <BrandingHeader version="0.0.1" currentDir={process.cwd()} />
      </box>

      {/* Content area — centered logo */}
      <box
        flexGrow={1}
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
      >
        <box flexDirection="column" alignItems="center">
          <For each={FULL_LOGO}>
            {(line) => (
              <text fg={themeCtx.theme.primary}>{line}</text>
            )}
          </For>
        </box>
      </box>

      {/* Escape hint */}
      <Show when={props.escHint}>
        <box flexShrink={0} paddingLeft={2}>
          <text fg={themeCtx.theme.warning ?? themeCtx.theme.textMuted}>
            {props.escHint}
          </text>
        </box>
      </Show>

      {/* Prompt — pinned at bottom */}
      <box flexShrink={0}>
        <Prompt
          placeholder={promptPlaceholder()}
          onSubmit={props.onSubmit}
          onEscape={props.onEscape}
        />
      </box>

      {/* Help overlay */}
      <Show when={props.showHelp}>
        <HelpOverlay onClose={props.onCloseHelp} />
      </Show>
    </>
  )
}
