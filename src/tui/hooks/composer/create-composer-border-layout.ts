import type { Accessor } from "solid-js"
import { createMemo, createSignal } from "solid-js"
import type { ModuleComposerStatus } from "../../../protocol/protocol-module.js"
import type { UpdateStatusView } from "../../../protocol/runtime/update-protocol-types.js"
import type { ShellSignals } from "../state/shell-state.js"
import type { ComposerBorderLayout, ComposerBorderUpdate } from "../../components/composer/frame/composer-border-layout.js"
import { computeComposerBorderLayout } from "../../components/composer/frame/composer-border-layout.js"
import type { Keymap } from "../../terminal/keymap/keymap.js"
import { primaryKeyHints, shouldShowGlobalHints } from "../../components/composer/frame/key-hint-row-state.js"
import { sessionChangesLabel } from "../../../protocol/client/session/changes/session-changes-copy.js"
import type { ChangesSummaryState } from "../../../protocol/client/session/changes/session-changes.js"

/** The prompt offers the review only when its last known count is positive. */
export function sessionChangesPromptLabel(summary: ChangesSummaryState | undefined): string | undefined {
  const data = summary && "data" in summary ? summary.data : undefined
  return data && data.fileCount > 0 ? sessionChangesLabel(summary) : undefined
}

export interface ComposerBorderLayoutDeps {
  signals: ShellSignals
  terminalWidth: Accessor<number>
  composerStatus?: Accessor<readonly ModuleComposerStatus[]>
  /** The effective chord for a command. The border reads it inside its memo,
   *  so a [keybindings] change that publishes later reaches every hint. */
  chordFor: Keymap["chordFor"]
  /** True while the foreground session offers Resume. */
  resumeOffered: Accessor<boolean>
  /** How many session tabs are open. */
  activeSessionCount: Accessor<number>
}

export interface UpdateBorderStatus extends ComposerBorderUpdate {
  readonly identity: string
}

export interface DismissibleUpdateStatus {
  readonly current: Accessor<UpdateBorderStatus | undefined>
  readonly dismiss: () => void
}

export interface ComposerBorderLayoutController {
  readonly layout: Accessor<ComposerBorderLayout>
  /** How many listed chats other than the one in front wait on a question.
   *  The border shows it, and so does a docked question, which hides the border. */
  readonly waitingCount: Accessor<number>
  readonly dismissUpdate: () => void
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

export function createComposerBorderLayout(deps: ComposerBorderLayoutDeps): ComposerBorderLayoutController {
  const { signals } = deps
  const updateStatus = createDismissibleUpdateStatus(signals.updateStatus)
  // The listed chats other than the one in front that wait on a question
  // (PI-INTERACTION-184). Joining with the listed rows leaves out deleted
  // sessions, subagents, and workflow agents.
  const waitingCount = createMemo(() => {
    const waiting = signals.waitingSessions()
    const foreground = signals.foregroundId()
    let count = 0
    for (const row of signals.listedSessions()) if (row.id !== foreground && waiting.has(row.id)) count += 1
    return count
  })
  const layout = createMemo(() => computeComposerBorderLayout({
    terminalWidth: deps.terminalWidth(),
    modelLabel: signals.activeModelLabel(),
    update: updateStatus.current(),
    composerStatus: deps.composerStatus?.() ?? [],
    waitingCount: waitingCount(),
    changesLabel: signals.foregroundId() ? sessionChangesPromptLabel(signals.sessionChanges()?.snapshot().summary) : undefined,
    primaryHints: primaryKeyHints({
      hasPendingQuestion: signals.pendingQuestion() !== undefined,
      agentState: signals.agentState(),
      sessionState: signals.sessionState(),
    }),
    showGlobalHints: shouldShowGlobalHints({
      hasPendingQuestion: signals.pendingQuestion() !== undefined,
    }),
    activeSessionCount: deps.activeSessionCount(),
    sessionCount: signals.sessionCount(),
    sessionsHint: { key: deps.chordFor("sessions"), label: "sessions" },
    resumeHint: deps.resumeOffered() ? { key: deps.chordFor("resume"), label: "resume" } : undefined,
    newHint: { key: deps.chordFor("new"), label: "new" },
    closeHint: { key: deps.chordFor("tab.close"), label: "close tab" },
  }))
  return { layout, waitingCount, dismissUpdate: updateStatus.dismiss }
}
