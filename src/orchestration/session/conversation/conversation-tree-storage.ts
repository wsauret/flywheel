import { requireGuardedEventAppender, type AsyncEventAppender, type AsyncEventStateReadSurface, type GuardedAppendResult, type GuardedEventStoreAppend, type InFlightWrite, type StoredFact } from "../../../infra/event-store-types.js"
import { runInTaskSlices, runToCompletion, type TaskSliceScheduling } from "../../../infra/task-scheduling.js"
import { chatEntriesFacts, parseConversationTreeFact, type ConversationTreeFact } from "./conversation-facts.js"
import { extractTreeFactContent } from "./conversation-tree-content-extraction.js"
import { branchVisibleTranscriptWork, createConversationTreeProjection, type ConversationTreeProjectionState, type ConversationTreeTranscriptEntry, type DegradedTranscriptSequence } from "./conversation-projection.js"
import type { LeafEntry, ConversationEntry } from "./conversation-entry-types.js"
import { walkBranchWork, type BranchWalkGap } from "./conversation-tree-context.js"
import { Log } from "../../../infra/log.js"

const log = Log.create({ service: "conversation-tree" })

export interface ConversationInputCapture {
  readonly leafId: string | null
  readonly entriesById: ConversationTreeProjectionState["entriesById"]
  readonly degraded: DegradedTranscriptSequence
  readonly degradedLength: number
  readonly foldedPosition: number
  readonly pending: readonly ConversationEntry[]
}

export interface CommittedActiveBranchCapture {
  readonly entries: readonly ConversationEntry[]
  readonly foldedPosition: number
  readonly degraded: boolean
  readonly rootEntryId: string | null
  readonly leafEntryId: string | null
}

type ConversationTreeErrorCode =
  | "tree_missing"
  | "already_exists"
  | "duplicate_id"
  | "missing_parent"
  | "self_parent"
  | "unknown_target"
  | "invalid_follow_up"
export class ConversationTreeError extends Error {
  override readonly name = "ConversationTreeError"
  constructor(
    readonly code: ConversationTreeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

type AppendOutcome =
  | { kind: "committed" }
  | { kind: "notCommitted"; cause: unknown }

type AppendRefusal = Extract<AppendOutcome, { kind: "notCommitted" }>

/** Builds the entries of one append from the state the append is guarded
 *  on, or refuses the append. A commit that lands after the guard read fails
 *  the guarded append, and the next attempt builds the entries again from
 *  the newer state, so entries chained off `state.leafId` always extend the
 *  leaf that ends the branch. Entries chained off a leaf read before the
 *  guard would pass it, and drop that other commit off the active branch. */
export type BranchExtension = (state: ConversationTreeProjectionState) => Promise<readonly ConversationEntry[] | AppendRefusal>

interface StorageOptions {
  conversationId: string
  /** Owning session id. Stored on the denormalized `session_id` event column so
   *  `events:search --session <sessionId>` surfaces every conversation tree a
   *  session owns (chat's one tree, a workflow's per-agent trees). Distinct from
   *  the aggregate key, which is `conversation:<conversationId>`. */
  sessionId: string
  /** The workflow whose agent this conversation is. The workflow holds the
   *  messages for its next agent in cells of its own, and the commit that
   *  makes such a message durable here retires that cell. */
  workflowId?: string
  now?: () => string
  /** Borrowed owner-supplied store; the handle never closes it. */
  store: AsyncEventStateReadSurface
  /** Must execute appends immediately, in dispatch order. `appendEntries`
   *  derives its `expectedSeq` guard from the store BEFORE the append, so a
   *  deferring writer (queue/lane) would false-conflict against this
   *  process's own not-yet-flushed events. The chat tree is append-only by
   *  design (ARCH-SESSIONS-047: entries are never deleted or superseded, so abandoned
   *  branches stay forkable); the append surface makes delete and prune
   *  unrepresentable here. */
  writer?: AsyncEventAppender
}

export class ConversationTreeStorage {
  private disposed = false
  /** The uncommitted turn this process is writing, root-to-tip.
   *
   *  In memory only. Continuing an interrupted turn inside a live process needs
   *  no durability, and a crash is answered by reporting the turn's actions,
   *  which their own facts already record. Recording each fragment instead
   *  wrote 92,340 rows for chains discarded the moment their turn committed,
   *  and needed an adoption protocol to promote the survivors. */
  private pending: readonly ConversationEntry[] = []
  /** The ids this handle issued since its last commit. A batch takes all of
   *  its ids before it commits, so the store cannot yet show the ids that
   *  the batch took earlier. A commit folds them into the state, so it
   *  clears this set. */
  private readonly issued = new Set<string>()

  private constructor(
    private readonly store: AsyncEventStateReadSurface,
    private readonly projection: ReturnType<typeof createConversationTreeProjection>,
    private readonly writer: AsyncEventAppender,
    private readonly conversationId: string,
    private readonly sessionId: string,
    private readonly workflowId: string | undefined,
    private readonly now: () => string,
    private state: ConversationTreeProjectionState,
  ) {}

  static async create(options: StorageOptions): Promise<ConversationTreeStorage> {
    const storage = await ConversationTreeStorage.openHandle(options)
    if (storage.state.created) {
      storage.dispose()
      throw new ConversationTreeError("already_exists", `Chat tree ${options.conversationId} already exists`)
    }
    // expectedSeq 0: creation must write the aggregate's FIRST event. Two
    // processes racing to create the same conversation would otherwise both
    // commit and brick every later replay on the duplicate-creation gate.
    const created = await storage.appendGuardedFacts([{
      type: "chat.tree.created",
      version: 1,
      actor: "flywheel",
      payload: {
        conversationId: options.conversationId,
        createdAt: storage.now(),
      },
    }], 0)
    if (created.kind === "conflict") {
      await storage.refresh()
      storage.dispose()
      throw new ConversationTreeError("already_exists", `Chat tree ${options.conversationId} already exists`, { cause: created.conflict })
    }
    const event = onlyStoredEvent(created)
    storage.state = await storage.projection.apply(event)
    return storage
  }

  /** Build guarded tree creation for a larger owner-managed atomic batch. */
  static prepareCreate(input: {
    readonly conversationId: string
    readonly sessionId: string
    readonly createdAt: string
  }): readonly [GuardedEventStoreAppend] {
    const fact = parseConversationTreeFact({
      type: "chat.tree.created",
      version: 1,
      actor: "flywheel",
      payload: { conversationId: input.conversationId, createdAt: input.createdAt },
    })
    return [{
      aggregateId: `conversation:${input.conversationId}`,
      sessionId: input.sessionId,
      timestamp: Date.parse(input.createdAt),
      expectedSeq: 0,
      type: fact.type,
      version: fact.version,
      actor: fact.actor,
      payload: fact.payload,
    }]
  }

  /** Build guarded creation and initial-entry appends for an owner-managed atomic batch. */
  static prepareCreateWithEntries(input: {
    readonly conversationId: string
    readonly sessionId: string
    readonly createdAt: string
    readonly entries: readonly ConversationEntry[]
  }): readonly GuardedEventStoreAppend[] {
    validateEntries(input.conversationId, input.entries, {})
    const append = (fact: ConversationTreeFact, expectedSeq: number): GuardedEventStoreAppend => {
      const { fact: stored, contentRows } = extractTreeFactContent(parseConversationTreeFact(fact))
      return {
        aggregateId: `conversation:${input.conversationId}`,
        sessionId: input.sessionId,
        timestamp: Date.now(),
        expectedSeq,
        type: stored.type,
        version: stored.version,
        actor: stored.actor,
        payload: stored.payload,
        ...(contentRows.length > 0 ? { contentRows } : {}),
      }
    }
    return [
      ...ConversationTreeStorage.prepareCreate(input),
      ...chatEntriesFacts(input.conversationId, input.entries).map((fact, index) => append(fact, 1 + index)),
    ]
  }

  static async open(options: StorageOptions): Promise<ConversationTreeStorage> {
    const storage = await ConversationTreeStorage.openHandle(options)
    if (!storage.state.created) {
      storage.dispose()
      throw new ConversationTreeError("tree_missing", `Chat tree ${options.conversationId} does not exist`)
    }
    return storage
  }

  // Like `open`, but returns null instead of throwing tree_missing. Genuine
  // corruption surfaces during `openHandle` (event-store projection failure).
  static async tryOpen(options: StorageOptions): Promise<ConversationTreeStorage | null> {
    const storage = await ConversationTreeStorage.openHandle(options)
    if (!storage.state.created) {
      storage.dispose()
      return null
    }
    return storage
  }

  async getLeafId(): Promise<string | null> {
    await this.refresh()
    return this.state.leafId
  }

  async getEntry(id: string): Promise<ConversationEntry | undefined> {
    await this.refresh()
    return this.state.entriesById[id]
  }

  /** One refresh, then the whole cached projection slice. A read-only consumer
   *  walks this in memory instead of paying a `currentPosition()` round-trip per
   *  `getEntry` hop. Each change publishes a new state wrapper; its append-only
   *  entry index is shared. Capture a branch for an immutable historical view. */
  async getState(): Promise<ConversationTreeProjectionState> {
    await this.refresh()
    return this.state
  }

  /** The projection slice as of open or the last refresh, with no new read.
   *  For a handle opened moments ago this is the durable answer; a long-held
   *  handle must use `getState()` to see another process's commits. */
  openedState(): ConversationTreeProjectionState {
    if (this.disposed) throw new Error("Session tree storage is disposed")
    return this.state
  }

  /** Refresh once, then select all history boundaries without another await.
   * The entry index and the degraded sequence are append-only, and every
   * pending write replaces the readonly pending array, so the capture stays
   * fixed while cooperative work over it yields. */
  async captureInput(): Promise<ConversationInputCapture> {
    await this.refresh()
    return {
      leafId: this.state.leafId,
      entriesById: this.state.entriesById,
      degraded: this.state.degraded,
      degradedLength: this.state.degraded.length,
      foldedPosition: this.projection.getPosition(),
      pending: this.pending,
    }
  }

  async captureCommittedActiveBranch(scheduling?: TaskSliceScheduling): Promise<CommittedActiveBranchCapture> {
    const input = await this.captureInput()
    return runInTaskSlices("conversation:active-branch", this.committedActiveBranchWork(input), scheduling)
  }

  /** Copy one capture's committed active branch. Pending entries and
   * projection indexes do not cross this boundary.
   * @yields {void} A boundary between two entries, where the runner can give the task queue a turn. */
  *committedActiveBranchWork(input: ConversationInputCapture): Generator<void, CommittedActiveBranchCapture> {
    const branch = yield* this.branchWork(input, false)
    const entries: ConversationEntry[] = []
    for (const entry of branch) {
      yield
      entries.push(structuredClone(entry))
    }
    const transcript = yield* branchVisibleTranscriptWork(branch, input.degraded, input.degradedLength)
    return {
      entries,
      foldedPosition: input.foldedPosition,
      degraded: transcript.some((entry) => entry.kind === "degraded"),
      rootEntryId: entries.at(0)?.id ?? null,
      leafEntryId: entries.at(-1)?.id ?? null,
    }
  }

  /** The active branch, read through one refresh, so its leaf and its
   *  entries come from the same state. */
  async getActiveBranch(): Promise<ConversationEntry[]> {
    const input = await this.captureInput()
    return runInTaskSlices("conversation:branch", this.branchWork(input, false))
  }

  async getPathToRoot(leafId: string | null): Promise<ConversationEntry[]> {
    const input = await this.captureInput()
    return runInTaskSlices("conversation:branch", this.branchWork({ ...input, leafId }, false))
  }

  /** Display-only branch projection. Degraded records never enter tree topology or model context. */
  async getTranscriptToRoot(leafId: string | null): Promise<ConversationTreeTranscriptEntry[]> {
    const input = await this.captureInput()
    return runInTaskSlices("conversation:transcript", this.transcriptWork({ ...input, leafId }, false))
  }

  /** Recovered branch used by provider context. It includes typed gaps in transcript order. */
  async getRecoveredContextPathToRoot(leafId: string | null): Promise<ConversationTreeTranscriptEntry[]> {
    const input = await this.captureInput()
    return runInTaskSlices("conversation:recovered-context", this.transcriptWork({ ...input, leafId }, true))
  }

  async getContextPathToRoot(leafId: string | null): Promise<ConversationEntry[]> {
    const input = await this.captureInput()
    return runInTaskSlices("conversation:context-branch", this.branchWork({ ...input, leafId }, true))
  }

  /** The captured branch with its visible degraded records in transcript order.
   * @yields {void} A boundary between two entries, where the runner can give the task queue a turn. */
  *transcriptWork(input: ConversationInputCapture, contextOnly: boolean): Generator<void, ConversationTreeTranscriptEntry[]> {
    const branch = yield* this.branchWork(input, contextOnly)
    return yield* branchVisibleTranscriptWork(branch, input.degraded, input.degradedLength)
  }

  *branchWork(input: ConversationInputCapture, contextOnly: boolean): Generator<void, ConversationEntry[]> {
    return yield* walkBranchWork(input.entriesById, input.leafId, (gap: BranchWalkGap) => {
      if (gap.kind === "leaf") throw new ConversationTreeError("unknown_target", `Chat tree ${this.conversationId} has no entry ${gap.leafEntryId}`)
      throw new ConversationTreeError("missing_parent", `Chat tree ${this.conversationId} entry ${gap.childId} references missing parent ${gap.parentId}`)
    }, contextOnly)
  }

  /** The reader this handle folds from, for a caller that needs facts this
   *  conversation's aggregate does not carry. */
  getStore(): AsyncEventStateReadSurface {
    return this.store
  }

  /** Session this conversation belongs to. Its facts carry the turn's actions,
   *  which the conversation aggregate does not. */
  getSessionId(): string {
    return this.sessionId
  }

  /** The workflow whose agent this conversation is, if any. */
  getWorkflowId(): string | undefined {
    return this.workflowId
  }

  /** The conversation whose provider requests own its turns' actions among
   *  the session's facts. */
  getConversationId(): string {
    return this.conversationId
  }

  /** Store position of the newest fact this conversation folded. */
  async getFoldedPosition(): Promise<number> {
    await this.refresh()
    return this.projection.getPosition()
  }

  /** Store position of the newest commit that carried an assistant entry. The
   *  boundary between work this conversation accounts for and work an
   *  interrupted turn left behind. */
  async getAssistantWatermark(): Promise<number> {
    await this.refresh()
    return this.state.assistantWatermark
  }

  /** The position an interruption sweep starts after: the assistant
   *  watermark, floored at this conversation's creation commit. The floor is
   *  what keeps one session's conversations apart - session facts written
   *  before this tree existed belong to earlier conversations (a workflow's
   *  prior steps), and a fresh tree whose watermark is still -1 must not
   *  sweep the whole store and claim them. */
  async getInterruptionBoundary(): Promise<number> {
    await this.refresh()
    return Math.max(this.state.assistantWatermark, this.state.createdPosition)
  }

  /** The turn this process is writing, ordered root-to-tip. Empty between
   *  turns, and empty in any process that is not the one writing. */
  getPendingEntries(): ConversationEntry[] {
    return [...this.pending]
  }

  /** Hold one entry of the turn this process is writing. */
  appendPending(entry: ConversationEntry): void {
    this.pending = [...this.pending, entry]
  }

  /** Drop the held turn without committing it. */
  clearPending(): void {
    this.pending = []
  }


  async appendEntry(entry: ConversationEntry, inFlight?: readonly InFlightWrite[]): Promise<AppendOutcome> {
    return this.appendEntries([entry], inFlight)
  }

  /** Append a deterministic entry once, converging concurrent writers: the
   *  append commits nothing when the tree already holds `entryId`. */
  async appendEntryIfAbsent(entryId: string, extend: BranchExtension, inFlight?: readonly InFlightWrite[]): Promise<AppendOutcome> {
    try {
      const outcome = await this.extendBranch(async (state) => state.entriesById[entryId] ? [] : await extend(state), inFlight)
      if (outcome.kind === "committed") return outcome
      await this.refresh()
      return this.state.entriesById[entryId] ? { kind: "committed" } : outcome
    } catch (cause) {
      await this.refresh()
      return this.state.entriesById[entryId] ? { kind: "committed" } : { kind: "notCommitted", cause }
    }
  }

  /** Builds one guarded conversation append for an owner-composed atomic
   *  batch, which the caller publishes through the shared writer. `extend`
   *  builds the entries from the one state this method reads under its guard,
   *  as `extendBranch` does; a commit that lands after the guard read fails
   *  the batch, and the owner prepares it again. Null when `extend` has
   *  nothing to append; a refusal throws its cause. */
  /** The guarded appends of the entries `extend` builds, for a caller that
   *  commits them in one transaction with its own facts. Empty when there is
   *  nothing to append. */
  async prepareEntriesAppend(extend: BranchExtension): Promise<readonly GuardedEventStoreAppend[]> {
    const expectedSeq = await this.store.aggregateSeq(this.aggregateId) + 1
    await this.refresh()
    const state = this.state
    const entries = await extend(state)
    if (isRefusal(entries)) throw entries.cause
    if (entries.length === 0) return []
    return ConversationTreeStorage.prepareAppend({ conversationId: this.conversationId, sessionId: this.sessionId, entries, committed: state.entriesById, expectedSeq })
  }

  /** Shared guarded append builder for live writers and synchronous startup
   *  migration: the entries fact, then any reasoning counts beside it. */
  static prepareAppend(input: {
    readonly conversationId: string
    readonly sessionId: string
    readonly entries: readonly ConversationEntry[]
    readonly committed: { readonly [entryId: string]: ConversationEntry }
    readonly expectedSeq: number
  }): readonly GuardedEventStoreAppend[] {
    validateEntries(input.conversationId, input.entries, input.committed)
    return chatEntriesFacts(input.conversationId, input.entries).map((entriesFact, index) => {
      const { fact, contentRows } = extractTreeFactContent(parseConversationTreeFact(entriesFact))
      return {
        aggregateId: `conversation:${input.conversationId}`, sessionId: input.sessionId,
        timestamp: Date.now(), expectedSeq: input.expectedSeq + index,
        type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload,
        ...(contentRows.length ? { contentRows } : {}),
      }
    })
  }

  /** Appends entries whose parents their caller fixed, such as a fork's
   *  copy into a new tree. An append that extends the leaf builds its
   *  entries in `extendBranch` instead. */
  async appendEntries(entries: readonly ConversationEntry[], inFlight?: readonly InFlightWrite[]): Promise<AppendOutcome> {
    return this.extendBranch(async () => entries, inFlight)
  }

  /** Appends the entries `extend` builds from the state this append is
   *  guarded on (`BranchExtension`), retrying on a guard conflict until they
   *  commit, `extend` refuses, or the store refuses. Nothing to append
   *  commits nothing. A signal withdraws before writer admission only; an
   *  accepted append must finish and advance the projection. */
  async extendBranch(extend: BranchExtension, inFlight?: readonly InFlightWrite[], signal?: AbortSignal): Promise<AppendOutcome> {
    for (;;) {
      // Guard token BEFORE refresh: the batch must extend exactly the state
      // `extend` and the validation below see. Captured after refresh, a
      // foreign commit landing between the two reads would pass the guard
      // against unvalidated state.
      const expectedSeq = await this.store.aggregateSeq(this.aggregateId) + 1
      await this.refresh()
      const state = this.state
      const entries = await extend(state)
      if (isRefusal(entries)) return entries
      if (entries.length === 0) return { kind: "committed" }
      await runInTaskSlices("conversation:validate-append", validateEntriesWork(this.conversationId, entries, state.entriesById))
      let result: GuardedAppendResult
      try {
        if (signal?.aborted) {
          log.info("context reset withdrawn before writer admission", { conversationId: this.conversationId, sessionId: this.sessionId })
          return { kind: "notCommitted", cause: signal.reason }
        }
        result = await this.appendGuardedFacts(chatEntriesFacts(this.conversationId, entries), expectedSeq, inFlight)
      } catch (cause) {
        return { kind: "notCommitted", cause }
      }
      if (result.kind === "conflict") continue
      this.pending = []
      for (const event of result.events) this.state = await this.projection.apply(event)
      for (const entry of entries) this.issued.delete(entry.id)
      return { kind: "committed" }
    }
  }

  async setLeafId(targetId: string | null): Promise<AppendOutcome> {
    return this.extendBranch(async (state) => {
      if (targetId !== null && !state.entriesById[targetId]) {
        throw new ConversationTreeError(
          "unknown_target",
          `Chat tree ${this.conversationId} cannot move leaf to unknown entry ${targetId}`,
        )
      }
      const entry: LeafEntry = {
        kind: "leaf",
        id: await this.allocateId(),
        parentId: state.leafId,
        timestamp: this.now(),
        targetId,
      }
      return [entry]
    })
  }

  /** A fresh entry id that differs from every committed id and from every
   *  id this handle issued since its last commit, so the entries of one
   *  batch never share an id. */
  async allocateId(): Promise<string> {
    await this.refresh()
    const id = this.shortFreeId() ?? crypto.randomUUID().replace(/-/g, "")
    this.issued.add(id)
    return id
  }

  /** Releases a reservation that will not be appended by this handle. */
  releaseId(id: string): void { this.issued.delete(id) }

  private shortFreeId(): string | undefined {
    for (let i = 0; i < 100; i += 1) {
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      if (!this.state.entriesById[id] && !this.issued.has(id)) return id
    }
    return undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
  }

  private static async openHandle(options: StorageOptions): Promise<ConversationTreeStorage> {
    const store = options.store
    const projection = createConversationTreeProjection(store, options.conversationId)
    return new ConversationTreeStorage(
      store,
      projection,
      options.writer ?? READ_ONLY_TREE_WRITER,
      options.conversationId,
      options.sessionId,
      options.workflowId,
      options.now ?? (() => new Date().toISOString()),
      await projection.replay(),
    )
  }

  private get aggregateId(): string {
    return `conversation:${this.conversationId}`
  }

  /** Appends `facts` in one transaction, each guarded on the sequence after
   *  the one before it. `inFlight` rides on the first. */
  private async appendGuardedFacts(facts: readonly ConversationTreeFact[], expectedSeq: number, inFlight?: readonly InFlightWrite[]): Promise<GuardedAppendResult> {
    if (this.disposed) throw new Error("Session tree storage is disposed")
    return requireGuardedEventAppender(this.writer, "Conversation tree guarded writes require guarded append authority")
      .appendBatchGuarded(facts.map((fact, index) => this.toAppend(fact, expectedSeq + index, index === 0 ? inFlight : undefined)))
  }

  // Extraction happens here, the last point before the payload turns durable
  // (tool output dedup): every entry-carrying path funnels through this
  // method, so two entries carrying one text share one content row by
  // construction. Everything upstream keeps inline entries.
  private toAppend(fact: ConversationTreeFact, expectedSeq?: number, inFlight?: readonly InFlightWrite[]): GuardedEventStoreAppend {
    const { fact: stored, contentRows } = extractTreeFactContent(parseConversationTreeFact(fact))
    return {
      aggregateId: this.aggregateId,
      type: stored.type,
      version: stored.version,
      timestamp: Date.now(),
      actor: stored.actor,
      sessionId: this.sessionId,
      payload: stored.payload,
      ...(contentRows.length > 0 ? { contentRows } : {}),
      ...(expectedSeq !== undefined ? { expectedSeq } : {}),
      ...(inFlight !== undefined && inFlight.length > 0 ? { inFlight } : {}),
    }
  }

  private async refresh(): Promise<void> {
    if (this.disposed) throw new Error("Session tree storage is disposed")
    this.state = await this.projection.replay()
  }
}

const READ_ONLY_TREE_WRITER: AsyncEventAppender = {
  append: async () => {
    throw new Error("ConversationTreeStorage requires writer for appends")
  },
  appendBatch: async () => {
    throw new Error("ConversationTreeStorage requires writer for appends")
  },
}

function isRefusal(built: readonly ConversationEntry[] | AppendRefusal): built is AppendRefusal {
  return !Array.isArray(built)
}

function onlyStoredEvent(result: Extract<GuardedAppendResult, { kind: "stored" }>): StoredFact {
  const event = result.events[0]
  if (!event || result.events.length !== 1) throw new Error("Conversation tree append returned an invalid event count")
  return event
}

function validateEntries(
  conversationId: string,
  entries: readonly ConversationEntry[],
  committed: Readonly<StringMap<ConversationEntry>>,
): StringMap<ConversationEntry> {
  return runToCompletion(validateEntriesWork(conversationId, entries, committed))
}

function* validateEntriesWork(
  conversationId: string,
  entries: readonly ConversationEntry[],
  committed: Readonly<StringMap<ConversationEntry>>,
): Generator<void, StringMap<ConversationEntry>> {
  // Read committed parents through the prototype; failed batches own no state.
  const working: StringMap<ConversationEntry> = Object.create(committed)
  for (const entry of entries) {
    yield
    yield* validateEntry(conversationId, entry, working)
    working[entry.id] = entry
  }
  return working
}

function* validateEntry(
  conversationId: string,
  entry: ConversationEntry,
  entriesById: StringMap<ConversationEntry>,
): Generator<void, void> {
  if (entriesById[entry.id]) throw new ConversationTreeError("duplicate_id", `Chat tree ${conversationId} has duplicate entry id ${entry.id}`)
  if (entry.parentId === entry.id) {
    throw new ConversationTreeError("self_parent", `Chat tree ${conversationId} entry ${entry.id} cannot be its own parent`)
  }
  if (entry.parentId !== null && !entriesById[entry.parentId]) {
    throw new ConversationTreeError("missing_parent", `Chat tree ${conversationId} entry ${entry.id} references missing parent ${entry.parentId}`)
  }
  if (entry.kind === "leaf" && entry.targetId !== null && !entriesById[entry.targetId]) {
    throw new ConversationTreeError("unknown_target", `Chat tree ${conversationId} leaf entry ${entry.id} targets unknown entry ${entry.targetId}`)
  }
  if (entry.kind === "message" && entry.followUpRequestSequence !== undefined) {
    if (entry.message.kind !== "user") {
      throw new ConversationTreeError("invalid_follow_up", `Chat tree ${conversationId} follow-up request ${entry.followUpRequestSequence} is not a user turn`)
    }
    // oxlint-disable-next-line eslint/guard-for-in -- batch overlays must include committed entries for cross-batch identity validation.
    for (const id in entriesById) {
      yield
      const existing = entriesById[id]
      if (existing?.kind === "message" && existing.followUpRequestSequence === entry.followUpRequestSequence) {
        throw new ConversationTreeError("invalid_follow_up", `Chat tree ${conversationId} has duplicate follow-up request ${entry.followUpRequestSequence}`)
      }
    }
    const branch = yield* walkBranchWork(entriesById, entry.parentId, () => {
      throw new ConversationTreeError("invalid_follow_up", `Chat tree ${conversationId} follow-up request ${entry.followUpRequestSequence} has an incomplete parent branch`)
    })
    let priorRequests = 0
    for (const existing of branch) { yield; if (existing.kind === "message" && existing.followUpRequestSequence !== undefined) priorRequests += 1 }
    if (entry.followUpRequestSequence !== priorRequests + 1) {
      throw new ConversationTreeError("invalid_follow_up", `Chat tree ${conversationId} follow-up request ${entry.followUpRequestSequence} is not contiguous`)
    }
  }
}
interface StringMap<T> { [key: string]: T }
