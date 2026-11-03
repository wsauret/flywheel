import { errorMessage } from "../../infra/error-message.js"
import type { MutationDiff } from "../../infra/mutation-diff.js"
import type { AttachedRuntimeClient } from "../app-service-types.js"
import { changesCursor, type FileEditToken, type SessionChangeDiffResult, type SessionChangeSummaryResult, type SessionChangesResult, type SessionChangesUndoResult } from "../session-changes-protocol-types.js"
import { cursorKey } from "../runtime-ui-protocol-types.js"
import { lostWithLane } from "./connection-failures.js"
import { createCursorIntake, isLaneBreak } from "./cursor-intake.js"
import { createMutationEvidenceReader, type MutationPatchHandle, type MutationPatchView } from "./mutation-evidence.js"
import { sessionChangeNamesPath } from "./session-changes-copy.js"

const DIFFS_IN_FLIGHT = 2

export type ChangesSummaryState =
  | { readonly status: "idle" }
  | { readonly status: "loading" | "stale"; readonly data?: SessionChangeSummaryResult }
  | { readonly status: "ready" | "incomplete"; readonly data: SessionChangeSummaryResult }
  | { readonly status: "error"; readonly data?: SessionChangeSummaryResult; readonly error: string }

/** `data` during loading or error is the previous list, for display only. */
type ChangesListState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly data?: SessionChangesResult }
  | { readonly status: "ready"; readonly data: SessionChangesResult }
  | { readonly status: "error"; readonly data?: SessionChangesResult; readonly error: string }

export type ChangesDiffState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly diff: MutationDiff; readonly lineCounts: Extract<SessionChangeDiffResult, { status: "ready" }>["lineCounts"]; readonly complete: boolean }
  | { readonly status: "unavailable"; readonly reason: "drifted" | "unretained" | "evidence" }
  | { readonly status: "error"; readonly error: string }

/** `unknown` is client-only: the dispatch failed at the transport after submission. */
export type ChangesUndoState =
  | { readonly fileId: string; readonly status: "confirming"; readonly editToken: FileEditToken }
  | { readonly fileId: string; readonly status: "submitting" }
  | { readonly fileId: string; readonly status: "result"; readonly result: SessionChangesUndoResult }
  | { readonly fileId: string; readonly status: "unknown"; readonly error: string }

type ChangesViewedState =
  | { readonly fileId: string; readonly status: "submitting"; readonly reviewed: boolean }
  | { readonly fileId: string; readonly status: "refused"; readonly reviewed: boolean; readonly error: string }
  | { readonly fileId: string; readonly status: "unknown"; readonly reviewed: boolean; readonly error: string }

export interface SessionChangesSnapshot {
  readonly summary: ChangesSummaryState
  readonly list: ChangesListState
  readonly diffs: ReadonlyMap<string, ChangesDiffState>
  readonly undo: ChangesUndoState | undefined
  readonly viewed: ChangesViewedState | undefined
}

export interface SessionChangesController {
  readonly sessionId: string
  readonly snapshot: SessionChangesSnapshot
  /** Subscribe before acquiring history. Repeated calls do not reacquire. */
  start(): Promise<void>
  /** Starts if necessary, otherwise invalidates and reacquires. Never retries a mutation. */
  refresh(): Promise<void>
  /** The list and its diffs are acquired only while the review is open. */
  openReview(targetPath?: string): Promise<void>
  /** Append one metadata page without acquiring unrelated patches. */
  loadMoreFiles(): Promise<void>
  /** Only selected or visible files acquire net-patch descriptors and byte windows. */
  setVisibleFiles(fileIds: readonly string[]): void
  /** Continue a disclosed patch by displayed rows, through the same two-read lane. */
  continueDiff(fileId: string, displayRows?: number, columns?: number): void
  closeReview(): void
  /** True when the file's net diff is proven, history has no unknown gaps, and no Undo is submitted. */
  canUndo(fileId: string): boolean
  /** True when current Undo proof still names the edit the person chose. */
  canConfirmUndo(): boolean
  /** Short reason beside a held Undo action or confirmation, even when Viewed hides the diff. */
  undoUnavailableReason(fileId: string): string | undefined
  /** True when no Viewed mutation is in flight, this file's review authority is known,
   * and an unviewed file's net diff is proven for its latest edit, which Viewed records. */
  canSetViewed(fileId: string): boolean
  /** Opens the confirmation for one file. False means Undo is not offered for it right now. */
  requestUndo(fileId: string): boolean
  cancelUndo(): void
  /** Dispatches the confirmed file's Undo once. False means nothing was dispatched. */
  confirmUndo(): Promise<boolean>
  /** Records whether the exact latest edit is viewed. No optimistic state is published. */
  setViewed(fileId: string, reviewed: boolean): Promise<boolean>
  onChange(listener: () => void): () => void
  /** Unsubscribes, but neither closes the client nor cancels a submitted Undo. */
  dispose(): void
}

/** One immutable session owner. Construction is passive; read failures are exposed
 * in the snapshot and transport mutation failures remain explicit unknown outcomes. */
export function createSessionChangesController(options: {
  readonly client: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane">
  readonly sessionId: string
}): SessionChangesController {
  const { client, sessionId } = options
  const cursor = changesCursor(sessionId)
  const listeners = new Set<() => void>()
  let state: SessionChangesSnapshot = { summary: { status: "idle" }, list: { status: "idle" }, diffs: new Map(), undo: undefined, viewed: undefined }
  let open = false
  let started = false
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let stopLanes: (() => void) | undefined
  let generation = 0
  let listGeneration = 0
  // A settled Undo survives the refresh it triggers and leaves on the next invalidation.
  let invalidations = 0
  let keepUndoThroughInvalidation = -1
  let startWork = Promise.resolve()
  let queuedRefresh: Promise<void> | undefined
  let activeRefresh: Promise<void> | undefined
  let changesPending = false
  let lastList: SessionChangesResult | undefined
  const diffTokens = new Map<string, FileEditToken>()
  const evidence = createMutationEvidenceReader({ connection: client, sessionId })
  const descriptors = new Map<string, Extract<SessionChangeDiffResult, { status: "ready" }>>()
  const patches = new Map<string, MutationPatchHandle>()
  const publishedPatches = new WeakMap<MutationPatchHandle, MutationPatchView>()
  const diffReads = new Map<string, symbol>()
  const continuations = new Map<string, { rows: number; columns: number }>()
  let visible = new Set<string>()
  let activeDiffs = 0
  let pageWork: Promise<void> | undefined
  let targetPath: string | undefined

  function publishPatch(fileId: string): void {
    const result = descriptors.get(fileId)
    if (!result) return
    const descriptor = result.diff
    const patch = patches.get(fileId)?.view
    if (descriptor.patch.kind === "unavailable" || patch?.status === "unavailable") {
      setDiff(fileId, { status: "unavailable", reason: "evidence" })
    } else if (patch?.status === "error") {
      setDiff(fileId, { status: "error", error: patch.message ?? "Change evidence is unavailable" })
    } else if (patch?.status === "loading" && state.diffs.get(fileId)?.status === "ready") {
      // A loading replacement must not collapse the old body and clamp its viewport.
      return
    } else if (descriptor.patch.kind === "retained" && !patch?.text && !patch?.complete) {
      setDiff(fileId, { status: "loading" })
    } else {
      setDiff(fileId, {
        status: "ready", lineCounts: result.lineCounts, complete: patch?.complete ?? true,
        diff: {
          version: 1,
          files: descriptor.patch.kind === "retained" ? [{
            path: descriptor.path, change: descriptor.change, unifiedDiff: patch?.text ?? "",
            ...(descriptor.omittedLines > 0 ? { omittedLines: descriptor.omittedLines } : {}),
          }] : [],
          omissions: descriptor.patch.kind === "omitted" ? [{ path: descriptor.path, reason: descriptor.patch.reason }] : [],
        },
      })
    }
  }
  const stopEvidence = evidence.onChange(() => {
    for (const [fileId, patch] of patches) {
      if (publishedPatches.get(patch) === patch.view) continue
      publishedPatches.set(patch, patch.view)
      publishPatch(fileId)
    }
    emit()
  })

  const emit = (): void => {
    if (!disposed) for (const listener of listeners) listener()
  }
  const summaryReady = (): boolean => state.summary.status === "ready" || state.summary.status === "incomplete"

  function setDiff(fileId: string, diff: ChangesDiffState): void {
    const diffs = new Map(state.diffs)
    diffs.set(fileId, diff)
    state = { ...state, diffs }
  }
  function retainedUndo(): ChangesUndoState | undefined {
    const undo = state.undo
    if (undo?.status === "confirming" || undo?.status === "submitting" || invalidations <= keepUndoThroughInvalidation) return undo
    return undefined
  }
  function clearReview(): void {
    listGeneration++
    state = { ...state, undo: retainedUndo() }
  }

  function invalidate(): void {
    generation++
    invalidations++
    clearReview()
    pageWork = undefined
    for (const [fileId, diff] of state.diffs) if (diff.status === "error") diffTokens.delete(fileId)
    const summary = "data" in state.summary ? state.summary.data : undefined
    const list = "data" in state.list ? state.list.data : lastList
    state = {
      ...state, summary: { status: "loading", ...(summary ? { data: summary } : {}) },
      list: open ? { status: "loading", ...(list ? { data: list } : {}) } : { status: "idle" },
    }
    emit()
  }

  const intake = createCursorIntake({
    cursor,
    onApply: refreshChanges,
    onRecover: refreshChanges,
  })

  function refreshChanges(): void {
    // Settlements arrive across tasks. Superseding each unfinished read fills
    // the runtime channel before any summary can catch up.
    if (!activeRefresh) { void refresh(); return }
    invalidate()
    changesPending = true
  }

  async function readDiff(data: SessionChangesResult, fileId: string, token: number, readGeneration: number, onStale: () => void): Promise<void> {
    const live = () => !disposed && generation === readGeneration && listGeneration === token
    try {
      const result = await client.query({ type: "sessionChangeDiff", sessionId, fileId, revision: data.revision })
      if (!live()) return
      if (result.status === "stale") { onStale(); return }
      const file = data.files.find(candidate => candidate.fileId === fileId)
      if (result.status === "ready") {
        descriptors.set(fileId, result)
        if (result.diff.patch.kind === "retained") {
          const patch = evidence.openPatch(fileId, result.diff.patch.reference)
          patches.set(fileId, patch)
          await patch.continue()
          if (!live()) return
        }
        publishPatch(fileId)
      } else setDiff(fileId, { status: "unavailable", reason: result.reason })
      if (file) diffTokens.set(fileId, file.editToken)
    } catch (cause) {
      if (!live()) return
      setDiff(fileId, { status: "error", error: errorMessage(cause) })
      const file = data.files.find(candidate => candidate.fileId === fileId)
      if (file) diffTokens.set(fileId, file.editToken)
    }
    emit()
  }

  const sameToken = (left: FileEditToken | undefined, right: FileEditToken): boolean =>
    left?.position === right.position && left.eventId === right.eventId

  function reconcileList(previous: SessionChangesResult | undefined, incoming: SessionChangesResult): SessionChangesResult {
    if (!previous) return incoming
    const prior = new Map(previous.files.map(file => [file.fileId, file]))
    const files = incoming.files.map(file => {
      const old = prior.get(file.fileId)
      return old && old.path === file.path && old.change === file.change && old.review.status === file.review.status
        && sameToken(old.editToken, file.editToken) && old.folder?.path === file.folder?.path && old.folder?.files === file.folder?.files ? old : file
    })
    return { ...incoming, files }
  }

  function needsDiff(file: SessionChangesResult["files"][number]): boolean {
    return visible.has(file.fileId) && !diffReads.has(file.fileId)
      && (!sameToken(diffTokens.get(file.fileId), file.editToken) || continuations.has(file.fileId))
  }

  function finishDiff(fileId: string, request: symbol): void {
    if (diffReads.get(fileId) === request) diffReads.delete(fileId)
    activeDiffs--
    pumpDiffs()
  }

  /** One lane covers descriptor acquisition and window continuation. */
  function pumpDiffs(): void {
    if (disposed || !open || state.list.status !== "ready" || targetPath !== undefined) return
    const data = state.list.data
    while (activeDiffs < DIFFS_IN_FLIGHT) {
      const file = data.files.find(needsDiff)
      if (!file) return
      const { fileId } = file
      const request = Symbol("session change diff")
      diffReads.set(fileId, request)
      activeDiffs++
      const continuation = continuations.get(fileId)
      continuations.delete(fileId)
      const work = sameToken(diffTokens.get(fileId), file.editToken)
        ? patches.get(fileId)?.continue(continuation?.rows, continuation?.columns) ?? Promise.resolve()
        : readDiff(data, fileId, listGeneration, generation, () => { void refresh() })
      void work.finally(finishDiff.bind(undefined, fileId, request))
    }
  }

  /** Keep unchanged-token prefixes, but retire changed and removed file owners. */
  function fanOutDiffs(data: SessionChangesResult): void {
    const currentIds = new Set(data.files.map(file => file.fileId))
    const retained = new Map([...state.diffs].filter(([fileId]) => currentIds.has(fileId)))
    for (const fileId of descriptors.keys()) {
      const file = data.files.find(candidate => candidate.fileId === fileId)
      if (file && sameToken(diffTokens.get(fileId), file.editToken)) continue
      descriptors.delete(fileId)
      patches.delete(fileId)
      continuations.delete(fileId)
      diffTokens.delete(fileId)
      evidence.release(fileId)
    }
    for (const fileId of diffTokens.keys()) if (!currentIds.has(fileId)) diffTokens.delete(fileId)
    for (const file of data.files) if (visible.has(file.fileId) && !retained.has(file.fileId)) retained.set(file.fileId, { status: "loading" })
    state = { ...state, diffs: retained }
    pumpDiffs()
  }

  async function readList(): Promise<void> {
    if (disposed || !started || !open || !summaryReady()) return
    const token = ++listGeneration
    const readGeneration = generation
    const previous = "data" in state.list ? state.list.data : lastList
    state = { ...state, undo: retainedUndo(), list: { status: "loading", ...(previous ? { data: previous } : {}) } }
    emit()
    try {
      let data: SessionChangesResult | undefined
      const extent = previous?.files.length ?? 1
      do {
        const page: SessionChangesResult = await client.query({
          type: "sessionChanges", sessionId, offset: 0, maxFiles: 128, maxBytes: 64 * 1024,
          ...(data && data.nextOffset !== null ? { offset: data.nextOffset, cursor: data.cursor, revision: data.revision } : {}),
        })
        if (disposed || generation !== readGeneration || listGeneration !== token || !open) return
        if (page.status === "stale" || (data && (page.cursor !== data.cursor || page.revision !== data.revision))) { data = undefined; continue }
        data = data ? { ...page, offset: 0, files: [...data.files, ...page.files] } : page
        const path = targetPath
        const executionCwd = data.executionCwd
        const target = path && data.files.find(file => sessionChangeNamesPath(path, executionCwd, file.path))
        if (target) {
          visible = new Set([target.fileId])
          targetPath = undefined
        }
        if (data.nextOffset === null) targetPath = undefined
      } while (!data || (data.nextOffset !== null && (data.files.length < extent || targetPath !== undefined
        || (state.undo?.status === "confirming" && !data.files.some(file => file.fileId === state.undo?.fileId)))))
      const reconciled = reconcileList(previous, data)
      lastList = reconciled
      const viewed = state.viewed
      const viewedFile = viewed && reconciled.files.find(file => file.fileId === viewed.fileId)
      const settled = viewedFile && viewedFile.review.status !== "unknown"
        && (viewedFile.review.status === "viewed") === viewed.reviewed
      const undo = state.undo
      const removed = undo?.status === "confirming" && reconciled.nextOffset === null
        && !reconciled.files.some(file => file.fileId === undo.fileId)
      state = { ...state, undo: removed ? undefined : undo, viewed: settled ? undefined : viewedFile ? viewed : undefined, list: { status: "ready", data: reconciled } }
      fanOutDiffs(reconciled)
      emit()
    } catch (cause) {
      // A read lost with its lane is read again on the next lane.
      if (disposed || generation !== readGeneration || listGeneration !== token || lostWithLane(cause)) return
      state = { ...state, list: { status: "error", ...(previous ? { data: previous } : {}), error: errorMessage(cause) } }
      emit()
    }
  }

  function loadMoreFiles(): Promise<void> {
    if (pageWork) return pageWork
    if (disposed || !open || state.list.status !== "ready") return Promise.resolve()
    const data = state.list.data
    const offset = data.nextOffset
    if (offset === null) return Promise.resolve()
    const token = listGeneration
    const readGeneration = generation
    const work: Promise<void> = Promise.resolve().then(async () => {
      try {
        const page = await client.query({ type: "sessionChanges", sessionId, offset, cursor: data.cursor, revision: data.revision, maxFiles: 128, maxBytes: 64 * 1024 })
        if (disposed || !open || token !== listGeneration || readGeneration !== generation) return
        if (page.status === "stale" || page.cursor !== data.cursor || page.revision !== data.revision) { await refresh(); return }
        const merged = { ...page, offset: 0, files: [...data.files, ...page.files] }
        lastList = merged
        state = { ...state, list: { status: "ready", data: merged } }
        fanOutDiffs(merged)
        emit()
      } catch (cause) {
        if (disposed || token !== listGeneration || readGeneration !== generation || lostWithLane(cause)) return
        state = { ...state, list: { status: "error", data, error: errorMessage(cause) } }
        emit()
      } finally {
        if (pageWork === work) pageWork = undefined
      }
    })
    pageWork = work
    return work
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (!started) return start()
    invalidate()
    // Coalesce one delivery burst, not patches or history. Generation checks
    // let a reconnect replace an outstanding read without waiting for it.
    if (queuedRefresh) return queuedRefresh
    queuedRefresh = Promise.resolve().then(async () => {
      queuedRefresh = undefined
      if (disposed) return
      changesPending = false
      const token = generation
      try {
        const data = await client.query({ type: "sessionChangeSummary", sessionId })
        if (disposed || generation !== token) return
        intake.seed(data.snapshotPosition)
        // Seeding can drain an invalidation that arrived before the summary.
        if (disposed || generation !== token) return
        state = { ...state, summary: { status: intake.pendingCount > 0 ? "stale"
          : data.unknownFileMutationGaps > 0 ? "incomplete" : "ready", data } }
        emit()
        await readList()
      } catch (cause) {
        if (disposed || generation !== token || lostWithLane(cause)) return
        const data = "data" in state.summary ? state.summary.data : undefined
        state = { ...state, summary: { status: "error", ...(data ? { data } : {}), error: errorMessage(cause) } }
        emit()
      }
    })
    const work = queuedRefresh
    activeRefresh = work
    changesPending = false
    void work.finally(() => {
      if (activeRefresh !== work) return
      activeRefresh = undefined
      if (changesPending && !disposed) {
        changesPending = false
        void refresh()
      }
    })
    return queuedRefresh
  }

  function start(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (started) return startWork
    started = true
    unsubscribe = client.subscribe(event => {
      if (disposed) return
      if (event.type === "patch" && event.patch.cursor.scope === "workspace"
        && event.patch.cursor.domain === "runtime" && event.patch.payload.kind === "runtime.invalidate") {
        intake.reset()
        // A lane break voids every read in flight and reads nothing: the
        // next lane reads.
        if (isLaneBreak(event.patch)) invalidate()
        else void refresh()
      } else if (event.type === "patch" && cursorKey(event.patch.cursor) === cursorKey(cursor)) {
        const before = generation
        const classification = intake.accept(event.patch)
        // A held invalidation cannot leave an old confirmation actionable
        // while intake waits for its missing predecessor or first anchor.
        if ((classification === "gap" || classification === "unseeded") && generation === before) refreshChanges()
      }
    })
    // Each lane reads the changes, the first among them.
    let first: Promise<void> | undefined
    stopLanes = client.onLane(() => {
      intake.reset()
      const read = refresh()
      first ??= read
    })
    startWork = first ?? Promise.resolve()
    return startWork
  }

  function canUndo(fileId: string): boolean {
    const file = state.list.status === "ready" ? state.list.data.files.find(candidate => candidate.fileId === fileId) : undefined
    return !disposed && state.list.status === "ready" && state.list.data.unknownFileMutationGaps === 0
      && file !== undefined && sameToken(diffTokens.get(fileId), file.editToken)
      && descriptors.has(fileId) && state.undo?.status !== "submitting"
  }

  function canSetViewed(fileId: string): boolean {
    if (disposed || state.viewed?.status === "submitting" || state.list.status !== "ready") return false
    const file = state.list.data.files.find(candidate => candidate.fileId === fileId)
    return file?.review.status === "viewed"
      || (file?.review.status === "unviewed" && sameToken(diffTokens.get(fileId), file.editToken))
  }

  function canConfirmUndo(): boolean {
    const undo = state.undo
    return undo?.status === "confirming" && canUndo(undo.fileId)
      && sameToken(diffTokens.get(undo.fileId), undo.editToken)
  }

  return {
    sessionId,
    get snapshot() { return state },
    start, refresh, canUndo, canConfirmUndo, canSetViewed, loadMoreFiles,
    undoUnavailableReason(fileId) {
      if (canUndo(fileId)) return state.undo?.status === "confirming" && state.undo.fileId === fileId && !canConfirmUndo()
        ? "File has newer edits; cancel or request Undo again" : undefined
      if (state.undo?.status === "submitting") return "Undo in progress"
      if (state.list.status !== "ready") return "Refreshing changes"
      if (state.list.data.unknownFileMutationGaps > 0) return "Incomplete history"
      const diff = state.diffs.get(fileId)
      if (diff?.status === "unavailable") return diff.reason === "drifted" ? "File changed outside this session" : "Exact evidence is unavailable"
      if (diff?.status === "error") return "Could not load change evidence"
      return "Checking exact evidence"
    },
    setVisibleFiles(fileIds) {
      visible = new Set(fileIds)
      pumpDiffs()
    },
    continueDiff(fileId, rows = 100, columns = 120) {
      const patch = patches.get(fileId)
      if (disposed || !open || !patch || patch.view.complete || patch.view.status !== "ready" || diffReads.has(fileId)) return
      continuations.set(fileId, { rows, columns })
      pumpDiffs()
    },
    async openReview(path) {
      if (disposed) return
      open = true
      targetPath = path
      clearReview()
      state = { ...state, list: { status: "loading", ...(lastList ? { data: lastList } : {}) } }
      emit()
      if (started) await readList()
    },
    closeReview() {
      if (disposed) return
      open = false
      generation++
      clearReview()
      if (state.undo?.status === "confirming") state = { ...state, undo: undefined }
      patches.clear()
      descriptors.clear()
      diffTokens.clear()
      continuations.clear()
      diffReads.clear()
      evidence.release()
      lastList = undefined
      state = { ...state, list: { status: "idle" }, diffs: new Map() }
      emit()
      if (started && state.summary.status === "loading") void refresh()
    },
    requestUndo(fileId) {
      const editToken = diffTokens.get(fileId)
      if (!canUndo(fileId) || !editToken) return false
      state = { ...state, undo: { fileId, status: "confirming", editToken } }
      emit()
      return true
    },
    cancelUndo() {
      if (disposed || state.undo?.status !== "confirming") return
      state = { ...state, undo: undefined }
      emit()
    },
    async confirmUndo() {
      const undo = state.undo
      if (undo?.status !== "confirming" || state.list.status !== "ready" || !canConfirmUndo()) return false
      const { fileId } = undo
      const { revision } = state.list.data
      state = { ...state, undo: { fileId, status: "submitting" } }
      emit()
      try {
        const result = await client.dispatch({ type: "session.changes.undo", sessionId, fileId, revision })
        if (!disposed) state = { ...state, undo: { fileId, status: "result", result } }
      } catch (cause) {
        if (!disposed) state = { ...state, undo: { fileId, status: "unknown", error: errorMessage(cause) } }
      }
      if (!disposed) {
        keepUndoThroughInvalidation = invalidations + 1
        emit()
        void refresh()
      }
      return true
    },
    async setViewed(fileId, reviewed) {
      if (!canSetViewed(fileId) || state.list.status !== "ready") return false
      const file = state.list.data.files.find(candidate => candidate.fileId === fileId)
      if (!file || (file.review.status === "viewed") === reviewed) return false
      state = { ...state, viewed: { fileId, status: "submitting", reviewed } }
      emit()
      try {
        const result = await client.dispatch({
          type: "session.changes.set_viewed",
          sessionId,
          fileId,
          editToken: file.editToken,
          reviewed,
        })
        if (disposed) return true
        if (result.status === "refused") {
          state = { ...state, viewed: { fileId, status: "refused", reviewed, error: result.message } }
          emit()
          return true
        }
        state = { ...state, viewed: undefined }
        emit()
        await refresh()
      } catch (cause) {
        if (!disposed) {
          state = { ...state, viewed: { fileId, status: "unknown", reviewed, error: errorMessage(cause) } }
          emit()
          void refresh()
        }
      }
      return true
    },
    onChange(listener) {
      if (!disposed) listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      disposed = true
      stopLanes?.()
      unsubscribe?.()
      intake.reset()
      stopEvidence()
      evidence.dispose()
      patches.clear()
      descriptors.clear()
      continuations.clear()
      listeners.clear()
    },
  }
}
