import { batch } from "solid-js"
import type { Accessor } from "solid-js"
import { loadSessionOutput } from "../../orchestration/session-actions.js"
import type { SessionKind } from "../../orchestration/session/types.js"
import type { SessionSummary } from "../../orchestration/session/manager.js"
import { TERMINAL_TITLE_BASE, TERMINAL_TITLE_PREFIX } from "../../infra/format.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"

interface ForegroundSwitcherDeps {
  signals: ShellSignals
  services: ShellServices
  sessions: Accessor<SessionSummary[]>
  projectCwd: string
  setTerminalTitle: (title: string) => void
}

export function createForegroundSwitcher(deps: ForegroundSwitcherDeps): (sessionId: string) => Promise<void> {
  const { signals, services, sessions, projectCwd, setTerminalTitle } = deps
  const { sessionStore, metrics } = services

  let switchGen = 0

  return async function switchForeground(sessionId: string): Promise<void> {
    const gen = ++switchGen
    if (!sessionStore.has(sessionId)) {
      const blocks = await loadSessionOutput(sessionId, projectCwd)
      if (gen !== switchGen) return
      const s = sessions().find(s => s.id === sessionId)
      if (!s) return
      sessionStore.load(sessionId, {
        kind: s.kind as SessionKind,
        description: s.label || s.name || sessionId,
        outputBlocks: blocks,
        tokens: s.totalTokens,
        cost: s.totalCost,
        contextPercent: s.contextPercent,
        startedAt: s.createdAt ? new Date(s.createdAt).getTime() : undefined,
        engineSessionId: s.engineSessionId,
      })
    }
    if (gen !== switchGen) return
    const entry = sessionStore.get(sessionId)
    if (!entry) return
    batch(() => {
      signals.setForegroundId(sessionId)
      metrics.resetElapsedTo(Date.now() - entry.startedAt)
      signals.setErrorMessage("")
    })
    setTerminalTitle(entry.kind === "chat" ? TERMINAL_TITLE_BASE : `${TERMINAL_TITLE_PREFIX}${entry.description}`)
  }
}
