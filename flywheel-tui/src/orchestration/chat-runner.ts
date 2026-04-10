/**
 * Chat Runner — wraps ChatSession with SessionRunner interface compliance,
 * output persistence, and state machine transitions.
 *
 * Delegates all chat subprocess logic to createChatSession(). Adds:
 * 1. SessionRunner interface (sessionId, abort, dispose, injectMessage)
 * 2. Output persistence via OutputFlusher
 * 3. State transitions (active / paused via updateState)
 * 4. Shared session infra lifecycle (budget, traces, transcripts)
 */

import { createChatSession, type ChatSession, type ChatCallbacks } from "./chat-session"
import { createSessionInfra } from "./session/create-session-infra"
import { createOutputPersistence } from "./session/output-persistence"
import { disposeSessionResources, type SessionResources } from "./session/resources"
import { generateSessionTitle } from "./session-title"
import { prepareWorkflowDeps } from "./engines/workflow-deps"
import type { SessionRunner } from "./session-runner"
import type { SessionState } from "./session/state-machine"
import type { FlywheelConfig } from "./config/schema"
import type { ProcessSpawner } from "./engines/subprocess/spawner"
import { existsSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { AnyBlock } from "../infra/output-blocks"

// ── Font tip ──

function isMonaspaceInstalled(): boolean {
  if (process.platform === "darwin") {
    const userFonts = join(homedir(), "Library", "Fonts")
    const systemFonts = "/Library/Fonts"
    return existsSync(join(userFonts, "MonaspaceArgon-Regular.otf"))
      || existsSync(join(systemFonts, "MonaspaceArgon-Regular.otf"))
  }
  if (process.platform === "linux") {
    const localFonts = join(homedir(), ".local", "share", "fonts")
    return existsSync(join(localFonts, "MonaspaceArgon-Regular.otf"))
  }
  const winFonts = join(process.env.WINDIR ?? "C:\\Windows", "Fonts")
  return existsSync(join(winFonts, "MonaspaceArgon-Regular.otf"))
}

function getFontTipBlock(projectCwd: string, timestamp: number): AnyBlock | null {
  const flagPath = join(projectCwd, ".flywheel", "font-tip-seen")
  if (existsSync(flagPath)) return null

  // Mark as seen so it only shows once
  try {
    mkdirSync(join(projectCwd, ".flywheel"), { recursive: true })
    writeFileSync(flagPath, "")
  } catch { /* best-effort */ }

  if (isMonaspaceInstalled()) {
    return {
      kind: "system",
      message: "Tip: Set Monaspace Argon as your terminal font for the best Flywheel experience.",
      timestamp,
    }
  }

  const installCmd = process.platform === "darwin"
    ? "`brew install --cask font-monaspace`"
    : process.platform === "linux"
      ? "https://github.com/githubnext/monaspace"
      : "`winget install GitHub.Monaspace`"

  return {
    kind: "system",
    message: `Tip: Install Monaspace Argon and set it as your terminal font — ${installCmd}`,
    timestamp,
  }
}

// ── Types ──

/** Function to update fields on the session entry in the reactive store. */
export type ChatUpdateEntryFn = (patch: Partial<import("./session-registry").ChatSessionEntry>) => void

export interface ChatRunnerDeps {
  sessionId: string
  projectCwd: string
  updateState: (id: string, state: SessionState) => void
  /** Write data directly to the reactive session store. */
  updateEntry: ChatUpdateEntryFn
  /** Called on session name change (for manager label persistence). */
  onSessionName?: (name: string) => void
  /** Signal a fatal error — propagated to registry's onError. */
  onError: (message: string) => void
  /** Signal normal completion — propagated to registry's onEnded. */
  onEnded: () => void
  initialMessage?: string
  /** Output blocks from a previous session (for resume — prepended to new output). */
  priorBlocks?: AnyBlock[]
  /** When true, emit a welcome system block before the first chat output. */
  showWelcome?: boolean
  /** Optional overrides for testing. */
  spawner?: ProcessSpawner
  config?: FlywheelConfig
}

export interface ChatRunner extends SessionRunner {
  /** The underlying ChatSession (for direct access when needed). */
  readonly chatSession: ChatSession
  /** Blocks created during init (e.g., welcome message) — before the registry entry exists. */
  readonly initialBlocks: readonly AnyBlock[]
}

// ── Factory ──

export async function createChatRunner(deps: ChatRunnerDeps): Promise<ChatRunner> {
  const { sessionId, projectCwd, updateState, updateEntry, initialMessage, priorBlocks } = deps

  // Prepare workflow deps (config, engine, spawner)
  const workflowDeps = prepareWorkflowDeps()
  const config = deps.config ?? workflowDeps.config

  // Shared session infrastructure (budget, traces, transcripts)
  const infra = createSessionInfra({
    sessionId,
    projectCwd,
    config,
    description: "chat",
  })

  // Output persistence
  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  let currentBlocks: AnyBlock[] = []
  const outputFlusher = outputPersistence.createFlusher(() => currentBlocks)

  let disposed = false
  let firstMessageSent = false
  let lastWaiting: boolean | null = null

  // If resuming, emit prior blocks immediately so the UI shows them
  if (priorBlocks && priorBlocks.length > 0) {
    currentBlocks = [...priorBlocks]
    updateEntry({ outputBlocks: currentBlocks })
  }

  // Emit welcome blocks on first boot (no prior sessions)
  if (deps.showWelcome && !priorBlocks) {
    const now = Date.now()

    const welcomeBlock: AnyBlock = {
      kind: "text",
      content: [
        "**Hey.** Start typing to chat, or try a command:",
        "",
        "  `/work` · `/sprint`",
        "",
        "`Ctrl+B` sessions · `Ctrl+N` new chat",
      ].join("\n"),
      timestamp: now,
    }

    currentBlocks = [welcomeBlock]

    const fontTip = getFontTipBlock(projectCwd, now)
    if (fontTip) currentBlocks.push(fontTip)
  }

  // Wire ChatCallbacks to write directly to the reactive store
  const chatCallbacks: ChatCallbacks = {
    onBlocks: (newBlocks) => {
      currentBlocks = priorBlocks ? [...priorBlocks, ...newBlocks] : newBlocks
      updateEntry({ outputBlocks: currentBlocks })
      outputFlusher.schedule()
    },
    onWaiting: (waiting) => {
      // Only transition when state actually changes to avoid noisy self-transition warnings
      if (waiting && lastWaiting !== true) {
        updateState(sessionId, "active")
      } else if (!waiting && lastWaiting !== false) {
        updateState(sessionId, "paused")
      }
      lastWaiting = waiting
    },
    onTokens: (tokens) => updateEntry({ tokens }),
    onCost: (cost) => updateEntry({ cost }),
    onContextPercent: (percent) => updateEntry({ contextPercent: percent }),
    onModelActivity: (activity) => updateEntry({ modelActivity: activity }),
    onError: (message) => void deps.onError(message),
    onEnded: () => void deps.onEnded(),
  }

  // Create the underlying ChatSession — pass shared infra to avoid duplicate creation
  const chatSession = await createChatSession(chatCallbacks, initialMessage, {
    projectCwd,
    deps: workflowDeps,
    spawner: deps.spawner,
    traceCollector: infra.traceCollector ?? undefined,
    budgetTracker: infra.budgetTracker,
    transcriptWriter: infra.transcriptWriter,
  })

  // ── SessionRunner implementation ──

  function abort(): void {
    chatSession.interrupt()
  }

  function injectMessage(text: string): boolean {
    chatSession.send(text)

    // Auto-name the session from the first user message
    if (!firstMessageSent) {
      firstMessageSent = true
      generateSessionTitle(text, (title) => {
        updateEntry({ description: title })
        deps.onSessionName?.(title)
      })
    }

    return true
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true

    // 1. End the chat session FIRST (signal subprocess to stop).
    //    Must happen before resource disposal — the subprocess may still write
    //    to budgetTracker/transcriptWriter while it's shutting down.
    chatSession.end()

    // 2. Unified resource disposal (finalize → flush → dispose)
    const resources = {
      budgetTracker: infra.budgetTracker,
      traceWriter: infra.traceWriter,
      transcriptWriter: infra.transcriptWriter,
      traceCollector: infra.traceCollector,
      outputFlusher,
    }
    await disposeSessionResources(resources, "ok")
  }

  return {
    sessionId,
    abort,
    dispose,
    injectMessage,
    chatSession,
    initialBlocks: currentBlocks,
  }
}
