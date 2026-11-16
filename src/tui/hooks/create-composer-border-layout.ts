import type { Accessor } from "solid-js"
import { createMemo, createSignal } from "solid-js"
import type { ModuleComposerStatus } from "../../protocol/protocol-module.js"
import type { UpdateStatusView } from "../../protocol/update-protocol-types.js"
import type { SessionLifecycleState } from "../../orchestration/session/types.js"
import type { AgentState } from "./shell-state.js"
import type { ComposerBorderLayout, ComposerBorderUpdate } from "../components/composer-border-layout.js"
import { computeComposerBorderLayout } from "../components/composer-border-layout.js"
import type { Keymap } from "../keymap/keymap.js"
import { primaryKeyHints, shouldShowGlobalHints } from "../components/key-hint-row-state.js"

/** The border of one chat pane's composer: the session the pane shows, and the
 *  window's own labels and counts. */
export interface ComposerBorderLayoutDeps {
  terminalWidth: Accessor<number>
  modelLabel: Accessor<string | undefined>
  /** The workspace update alert, one for every composer, so a dismissal holds in each. */
  update: DismissibleUpdateStatus
  composerStatus?: Accessor<readonly ModuleComposerStatus[]>
  changesLabel?: Accessor<string | undefined>
  pendingQuestion: Accessor<boolean>
  agentState: Accessor<AgentState>
  sessionState: Accessor<SessionLifecycleState | null>
  /** The effective chord for a command. The border reads it inside its memo,
   *  so a [keybindings] change that publishes later reaches every hint. */
  chordFor: Keymap["chordFor"]
  /** True while the session offers Resume. */
  resumeOffered: Accessor<boolean>
  activeSessionCount: Accessor<number>
  sessionCount: Accessor<number>
  /** False where the tab keys do not act or do not teach: the border then names no new, close, or switch key. */
  tabHints: Accessor<boolean>
  /** False where Escape does none of the border's Escape actions: while a
   *  module strip holds key focus, Escape returns to the prompt, and in a
   *  view over the tab in front, Escape goes back. */
  escapeHints: Accessor<boolean>
}

export interface UpdateBorderStatus extends ComposerBorderUpdate {
  readonly identity: string
}

export interface DismissibleUpdateStatus {
  readonly current: Accessor<UpdateBorderStatus | undefined>
  readonly dismiss: () => void
}

export function updateBorderStatus(view: UpdateStatusView | undefined): UpdateBorderStatus | undefined {
  const status = view?.status
  if (status?.kind === "installed") {
    return {
      identity: `installed:${status.version}`,
      label: "✓ Update installed · Restart to update ×",
      tone: "success",
    }
  }
  if (status?.kind !== "available") return undefined

  const label = status.blocking === "auto-install-off"
    ? "updates disabled ×"
    : status.blocking === "platform"
      ? "reinstall to update ×"
      : "run flywheel update ×"
  return { identity: `available:${status.version}:${status.blocking}`, label, tone: "error" }
}

export function createDismissibleUpdateStatus(update: Accessor<UpdateStatusView | undefined>): DismissibleUpdateStatus {
  const [dismissedIdentity, setDismissedIdentity] = createSignal<string>()
  const status = createMemo(() => updateBorderStatus(update()))
  const current = createMemo(() => {
    const candidate = status()
    return candidate?.identity === dismissedIdentity() ? undefined : candidate
  })
  return {
    current,
    dismiss: () => {
      const candidate = status()
      if (candidate) setDismissedIdentity(candidate.identity)
    },
  }
}

export function createComposerBorderLayout(deps: ComposerBorderLayoutDeps): Accessor<ComposerBorderLayout> {
  return createMemo(() => computeComposerBorderLayout({
    terminalWidth: deps.terminalWidth(),
    modelLabel: deps.modelLabel(),
    update: deps.update.current(),
    composerStatus: deps.composerStatus?.() ?? [],
    changesLabel: deps.changesLabel?.(),
    primaryHints: deps.escapeHints() ? primaryKeyHints({
      hasPendingQuestion: deps.pendingQuestion(),
      agentState: deps.agentState(),
      sessionState: deps.sessionState(),
    }) : [],
    showGlobalHints: shouldShowGlobalHints({ hasPendingQuestion: deps.pendingQuestion() }),
    tabHints: deps.tabHints(),
    activeSessionCount: deps.activeSessionCount(),
    sessionCount: deps.sessionCount(),
    sessionsHint: { key: deps.chordFor("sessions"), label: "sessions" },
    resumeHint: deps.resumeOffered() ? { key: deps.chordFor("resume"), label: "resume" } : undefined,
    newHint: { key: deps.chordFor("new"), label: "new" },
    closeHint: { key: deps.chordFor("tab.close"), label: "close tab" },
  }))
}
