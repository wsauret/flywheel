import type { Accessor } from "solid-js"
import { createMemo, createSignal, mapArray } from "solid-js"
import { effectiveSessionShortTitle, type SessionCatalogRow } from "../../protocol/app-service-types.js"
import { isWorkingStatus } from "../../protocol/status-protocol-types.js"
import { isEmptyNewChat } from "../session-empty-state.js"
import type { ForegroundTarget, ShellSignals } from "./shell-state.js"

interface TabPresentation {
  id: string
  title: string
  isForeground: boolean
  // Runner is currently processing a chat turn.
  isBusy: boolean
  // Agent has emitted an `ask_user` question and is parked waiting on an answer.
  isBlocked: boolean
}

export type TabInfo = TabPresentation & ({ readonly kind: "session" } | { readonly kind: "pending" })

interface TabsDeps {
  sessions: Accessor<readonly SessionCatalogRow[]>
  openSessionIds: Accessor<readonly string[]>
  signals: Pick<ShellSignals, "foregroundId" | "sessionShortTitle" | "statusView" | "questionView">
}

interface TabStateDeps {
  sessions: Accessor<readonly SessionCatalogRow[]>
  signals: TabsDeps["signals"] & Pick<ShellSignals, "outputView" | "foregroundTarget">
}

export interface TabState {
  tabs: Accessor<readonly TabInfo[]>
  openSessionTab(sessionId: string): void
  closeSessionTab(sessionId: string): void
  openPendingTab(key: string): void
  removePendingTab(key: string): void
  hasPendingTab(key: string): boolean
  isTransientSessionTab(sessionId: string): boolean
  reorderTab(tabId: string, beforeTabId: string | null): void
}

interface LiveState { isBusy: boolean; isBlocked: boolean }

function deriveLiveState(deps: TabsDeps, id: string): LiveState {
  const status = deps.signals.statusView(id)
  const isBusy = isWorkingStatus(status)
  // The non-evicting question cache is authoritative, so a background tab's
  // blocked indicator survives transcript eviction.
  const isBlocked = deps.signals.questionView(id) !== undefined
  return { isBusy, isBlocked }
}

/** Tabs are the sessions this shell instance explicitly opened. The catalog still
 *  supplies titles and live lifecycle metadata, but global runtime
 *  `active` state is not tab membership. Busy and blocked state remain
 *  status/output-domain reads. */
export function createTabs(deps: TabsDeps): Accessor<readonly TabInfo[]> {
  const summariesById = createMemo(() => new Map(deps.sessions().map((session) => [session.id, session])))

  const tabIds = createMemo<readonly string[]>(() => {
    const fgId = deps.signals.foregroundId()
    const summaries = summariesById()
    const ids = deps.openSessionIds().filter((id) => summaries.has(id))
    if (!fgId || ids.includes(fgId)) return ids
    return [...ids, fgId]
  })

  const tabRows = mapArray(tabIds, (id) => {
    const liveState = createMemo(() => deriveLiveState(deps, id))
    const row = createMemo<TabInfo | undefined>(() => {
      const fgId = deps.signals.foregroundId()
      const liveShortTitle = deps.signals.sessionShortTitle()
      const isForeground = id === fgId
      const summary = summariesById().get(id)
      if (!summary) {
        if (!isForeground) return undefined
        return { kind: "session", id, title: liveShortTitle || "New Chat", isForeground: true, ...liveState() }
      }
      const title = effectiveSessionShortTitle(summary.title, isForeground ? liveShortTitle || summary.shortTitle : summary.shortTitle)
      return { kind: "session", id, title, isForeground, ...liveState() }
    })
    return row
  })

  const tabs = createMemo<readonly TabInfo[]>(() => {
    const list: TabInfo[] = []
    for (const tab of tabRows()) {
      const value = tab()
      if (value) list.push(value)
    }
    return list
  })
  return tabs
}

export function createTabState(deps: TabStateDeps): TabState {
  const [openTargets, setOpenTargets] = createSignal<readonly ForegroundTarget[]>([])
  const openSessionIds = createMemo(() => openTargets().flatMap((target) => target.kind === "session" ? [target.sessionId] : []))
  const sessionTabs = createTabs({ sessions: deps.sessions, openSessionIds, signals: deps.signals })
  const tabs = createMemo<readonly TabInfo[]>(() => {
    const durable = new Map(sessionTabs().map((tab) => [tab.id, tab]))
    const foreground = deps.signals.foregroundTarget()
    const rows: TabInfo[] = []
    for (const target of openTargets()) {
      if (target.kind === "pending") {
        rows.push({ kind: "pending", id: target.key, title: "Opening", isForeground: foreground?.kind === "pending" && foreground.key === target.key, isBusy: false, isBlocked: false })
      } else {
        const row = durable.get(target.sessionId)
        if (row) rows.push(row)
        durable.delete(target.sessionId)
      }
    }
    return [...rows, ...durable.values()]
  })

  function openSessionTab(sessionId: string): void {
    setOpenTargets((targets) => targets.some((target) => target.kind === "session" && target.sessionId === sessionId) ? targets : [...targets, { kind: "session", sessionId }])
  }

  function closeSessionTab(sessionId: string): void {
    setOpenTargets((targets) => targets.filter((target) => target.kind !== "session" || target.sessionId !== sessionId))
  }

  function openPendingTab(key: string): void {
    setOpenTargets((targets) => [...targets, { kind: "pending", key }])
  }
  function removePendingTab(key: string): void {
    setOpenTargets((targets) => targets.filter((target) => target.kind !== "pending" || target.key !== key))
  }
  function hasPendingTab(key: string): boolean {
    return openTargets().some((target) => target.kind === "pending" && target.key === key)
  }
  function isTransientSessionTab(sessionId: string): boolean {
    const row = deps.sessions().find((session) => session.id === sessionId)
    return isEmptyNewChat(row, deps.signals.outputView(sessionId))
  }

  function reorderTab(tabId: string, beforeTabId: string | null): void {
    setOpenTargets((targets) => {
      const id = (target: ForegroundTarget) => target.kind === "session" ? target.sessionId : target.key
      const moved = targets.find((target) => id(target) === tabId)
      if (!moved) return targets
      const without = targets.filter((target) => target !== moved)
      const targetIndex = beforeTabId === null ? without.length : without.findIndex((target) => id(target) === beforeTabId)
      if (targetIndex === -1) return targets
      const next = [...without.slice(0, targetIndex), moved, ...without.slice(targetIndex)]
      return next.every((target, index) => target === targets[index]) ? targets : next
    })
  }

  return { tabs, openSessionTab, closeSessionTab, openPendingTab, removePendingTab, hasPendingTab, isTransientSessionTab, reorderTab }
}
