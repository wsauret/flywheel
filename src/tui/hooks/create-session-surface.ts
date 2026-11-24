import type { Accessor } from "solid-js"
import { createEffect, createMemo, onCleanup, untrack } from "solid-js"
import type { ToolStreamingText } from "../../infra/output-blocks.js"
import { isInterruptible } from "../../protocol/client/session-controls.js"
import { isActiveActivity, type RuntimeClient, type SessionCatalogRow, type SessionRow } from "../../protocol/app-service-types.js"
import { sessionActiveMs } from "../../protocol/client/session-time.js"
import type { BudgetView } from "../../protocol/budget-protocol-types.js"
import type { OutputView } from "../../protocol/output-protocol-types.js"
import type { PendingQuestionView } from "../../protocol/question-protocol-types.js"
import type { RuntimeSessionDetailView } from "../../protocol/session-detail-protocol-types.js"
import type { ActiveBackgroundCommandView, StatusView } from "../../protocol/status-protocol-types.js"
import type { SessionLifecycleState } from "../../orchestration/session/types.js"
import type { SessionDetailCache } from "../session-detail-cache.js"
import type { OutputTranscriptCache, OutputTranscriptView } from "../transcript-store/output-transcript-cache-types.js"
import type { BudgetCache } from "./create-budget-cache.js"
import { createForegroundOutputPager } from "./create-foreground-output-pager.js"
import type { QuestionCache } from "./create-question-cache.js"
import type { StatusCache } from "./create-status-cache.js"

interface StreamingToolTextById {
  readonly [toolUseId: string]: ToolStreamingText
}

export interface SessionSurface {
  readonly sessionId: Accessor<string | undefined>
  /** The session's row: its catalog row when listed, which carries what a
   *  shown chat admits, else the row its held detail carries, which is how a
   *  child (never listed) is read. */
  readonly summary: Accessor<SessionRow | null>
  readonly detail: Accessor<RuntimeSessionDetailView | null>
  readonly loadResult: Accessor<{ id: string; view: RuntimeSessionDetailView | null; loadError?: string } | undefined>
  readonly transcript: OutputTranscriptView
  readonly outputView: Accessor<OutputView | undefined>
  readonly status: Accessor<StatusView | undefined>
  readonly budget: Accessor<BudgetView | undefined>
  readonly pendingQuestion: Accessor<PendingQuestionView | undefined>
  readonly streamingToolText: Accessor<Readonly<StreamingToolTextById>>
  /** The session's streamed character count, from its transcript;
   *  undefined until the transcript's first read lands. */
  readonly streamingOutputChars: Accessor<number | undefined>
  readonly agentState: Accessor<"idle" | "active">
  /** Whether an Interrupt has something to cut now (`isInterruptible`). */
  readonly interruptible: Accessor<boolean>
  readonly activeSubagentCount: Accessor<number>
  readonly waitingOnBackgroundWork: Accessor<boolean>
  readonly activeBackgroundCommands: Accessor<readonly ActiveBackgroundCommandView[]>
  readonly sessionKind: Accessor<"chat" | "subagent" | "workflow-agent" | null>
  readonly sessionState: Accessor<SessionLifecycleState | null>
  readonly elapsed: Accessor<number>
  readonly pageOutput: (direction: "older" | "newer") => void
}

export interface SessionSurfaceDeps {
  readonly detailCache: SessionDetailCache
  readonly appService: Pick<RuntimeClient, "query">
  readonly transcriptCache: OutputTranscriptCache
  readonly statusCache: StatusCache
  readonly budgetCache: BudgetCache
  readonly questionCache: Pick<QuestionCache, "ensure" | "view">
  readonly row: (sessionId: string) => SessionCatalogRow | undefined
  /** Whether the catalog has answered once, so a session it does not list
   *  is a child or a gone session rather than one not read yet. */
  readonly catalogReady: Accessor<boolean>
  readonly now: Accessor<number>
  readonly hydrateToHead: (sessionId: string, stillMounted: () => boolean) => Promise<void>
  readonly onTranscriptFailure: (sessionId: string, cause: unknown) => void
}

/** What a surface reads beyond its session's detail, status, and budget. A
 *  workflow has no transcript, so its card and its agent views read none:
 *  each agent view reads its own agent's transcript. */
export interface SessionSurfaceOptions {
  readonly transcript?: boolean
}

/** Bind the shared session caches to one mounted transcript surface. The caller
 * owns the Solid lifetime; cleanup releases only this surface's retention. */
export function createSessionSurface(deps: SessionSurfaceDeps, sessionId: Accessor<string | undefined>, options: SessionSurfaceOptions = {}): SessionSurface {
  const readsTranscript = options.transcript !== false
  // Only a session the catalog does not list holds detail: a child, or a
  // session that is gone. A listed chat reads its row from the catalog, so
  // the runtime reads nothing more for the chat a client shows (C5).
  const detailId = createMemo(() => {
    const id = sessionId()
    return id !== undefined && deps.catalogReady() && deps.row(id) === undefined ? id : undefined
  })
  createEffect(() => {
    const id = detailId()
    if (!id) return
    const hold = untrack(() => deps.detailCache.retain(id))
    onCleanup(hold.release)
  })
  // Only a held session has detail, so a surface that holds nothing reads
  // nothing and does not wake when another session becomes held.
  const remoteView = () => {
    const id = detailId()
    if (!id) return undefined
    const state = deps.detailCache.state(id)
    if (!state?.loaded && !state?.error) return undefined
    return { id, view: deps.detailCache.view(id) ?? null, loadError: state.error }
  }
  const detail = () => {
    const loaded = remoteView()
    return loaded && loaded.id === sessionId() ? loaded.view : null
  }
  const summary = () => {
    const id = sessionId()
    return id ? deps.row(id) ?? detail()?.row ?? null : null
  }

  createEffect(() => {
    const id = sessionId()
    if (!id || !readsTranscript) return
    const retention = deps.transcriptCache.retain(id)
    let mounted = true
    onCleanup(() => {
      mounted = false
      retention.release()
    })
    untrack(() => {
      void deps.transcriptCache.open(id)
        .then(() => mounted ? deps.hydrateToHead(id, () => mounted && untrack(sessionId) === id) : undefined)
        .catch((cause: unknown) => { if (mounted) deps.onTranscriptFailure(id, cause) })
    })
  })

  createEffect(() => {
    const id = sessionId()
    if (!id) return
    const active = detail()?.source === "live" || summary()?.lifecycleState === "active"
    untrack(() => {
      deps.budgetCache.ensure(id)
      deps.questionCache.ensure(id)
      deps.statusCache.ensure(id)
      if (active && readsTranscript) deps.transcriptCache.ensure(id)
    })
  })

  let reactivationBaseline: { id: string; wasActive: boolean } | undefined
  createEffect(() => {
    const id = sessionId()
    if (!id) { reactivationBaseline = undefined; return }
    const isActive = summary()?.lifecycleState === "active"
    const wasActive = reactivationBaseline?.id === id ? reactivationBaseline.wasActive : isActive
    reactivationBaseline = { id, wasActive: isActive }
    if (wasActive !== isActive && isActive && readsTranscript) untrack(() => { void deps.transcriptCache.refresh(id) })
  })

  const bound = <T>(read: (id: string) => T | undefined): Accessor<T | undefined> => () => {
    const id = sessionId()
    return id ? read(id) : undefined
  }
  const outputView = bound(deps.transcriptCache.view)
  const cachedStatus = bound(deps.statusCache.view)
  const status = cachedStatus

  const cachedBudget = bound(deps.budgetCache.view)
  const budget = () => cachedBudget() ?? detail()?.budget ?? undefined
  const pendingQuestion = bound(deps.questionCache.view)
  const streamingToolText = () => {
    const current = detail()
    return outputView()?.streamingToolText ?? (current?.source === "live" ? current.streamingToolText : {})
  }
  const agentState = () => isActiveActivity(status()?.activity) ? "active" as const : "idle" as const
  const sessionKind = () => summary()?.kind ?? detail()?.kind ?? null
  const elapsed = () => sessionActiveMs(status() ?? undefined, deps.now())

  const transcript = deps.transcriptCache.bindSession(sessionId)

  const pager = createForegroundOutputPager({ foregroundId: sessionId, transcriptCache: deps.transcriptCache, onFailure: deps.onTranscriptFailure })
  return {
    sessionId,
    summary,
    detail,
    loadResult: remoteView,
    transcript,
    outputView,
    status,
    budget,
    pendingQuestion,
    streamingToolText,
    streamingOutputChars: () => {
      const id = sessionId()
      return id ? deps.transcriptCache.streamingOutputChars(id) : undefined
    },
    agentState,
    interruptible: () => isInterruptible(status()),
    activeSubagentCount: () => status()?.activeSubagentCount ?? 0,
    waitingOnBackgroundWork: () => status()?.waitingOnBackgroundWork ?? false,
    activeBackgroundCommands: () => status()?.activeBackgroundCommands ?? [],
    sessionKind,
    sessionState: () => summary()?.lifecycleState ?? null,
    elapsed,
    pageOutput: pager.pageForegroundOutput,
  }
}
