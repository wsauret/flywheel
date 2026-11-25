import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { RpcServer } from "effect/rpc"
import { installCrashPolicy, recordFatal } from "../../../infra/process/crash-policy.js"
import { errorMessage } from "../../../infra/diagnostics/error-message.js"
import { Log } from "../../../infra/diagnostics/log.js"
import { openReadonlyEventReader } from "../../../infra/substrate/store/sqlite-event-store.js"
import { readSessionMetadata } from "../../session/metadata/catalog/session-metadata-store.js"
import { getSessionFileChanges, sessionChangeCounts } from "../../session/metadata/catalog/session-file-changes.js"
import type { SessionFileChangeCounts } from "../../../protocol/session/session-changes-protocol-types.js"
import { openWorkspaceState } from "../../workspace-state/workspace-state.js"
import { bunWorkerRunnerLayer, type WorkerSelf } from "../../../infra/process/workers/bun-worker-rpc.js"
import { createSessionDetailReader } from "../projections/session-detail-projection.js"
import { classifyRuntimeProtocolErrorKind, RuntimeBackgroundRpc, RuntimeProtocolError } from "../../../protocol/rpc/runtime-protocol-schemas.js"
import { composeModuleBackgroundReaders } from "../module-protocol-host.js"
import { installedConversationDeletionFacts, installedModules } from "../../module-contract/module-catalog.js"
import { protocolBackgroundSchema } from "../../../protocol/modules.js"
import { createRuntimeBackgroundSnapshotProjector } from "./runtime-background-snapshot.js"
import type { RuntimeSessionDetailResult } from "../../../protocol/session/session-detail-protocol-types.js"
import type { ProtocolBackgroundDomain, ProtocolBackgroundSnapshot } from "../../../protocol/modules.js"
import { acquireConversationSearchIndex, type ConversationSearchIndex } from "../../../infra/substrate/store/conversation-fts.js"
import { asAsyncEventReadSurface, type AsyncEventStateReadSurface } from "../../../infra/substrate/store/event-store-types.js"
import { resolveConversationSearchDbFile, resolveSessionSummaryDbFile } from "../../../infra/platform/files/paths.js"
import { createConversationRecall } from "../../session/conversation-records/conversation-recall.js"
import type { RecallInput, RecallResult } from "../../../protocol/transcript/conversation-recall.js"
import { createTranscriptSearch, searchableSessions } from "../../session/conversation-records/transcript-search.js"
import type { ChatSearchRequest, ChatSearchResult, TranscriptSearchRequest, TranscriptSearchResult } from "../../../protocol/transcript/transcript-protocol-types.js"
import { createSessionMetadataProjection, sessionsFromProjection } from "../../session/metadata/session-metadata-projection.js"
import { acquireSessionSummaryIndex, type SessionSummaryIndex } from "../../session/metadata/catalog/session-summary-index.js"
import { createRuntimeBackgroundProjectMap, createRuntimeBackgroundProjectOperations } from "./runtime-background-projects.js"
import type { RuntimeBackgroundSummaryResult } from "../../../protocol/rpc/runtime-protocol-schemas.js"

export interface RuntimeBackgroundWorkerInit {
  readonly flywheel: "background.init"
  readonly logBase: string
  readonly logLevel: Log.Level
}

const log = Log.create({ service: "runtime-background" })

/** Historical SQLite reads live on a dedicated Worker thread: they retain the
 *  old-session isolation the background lane needs without introducing a
 *  second OS lifetime, TCP transport, PID watchdog, or orphanable process.
 *  The connection is read-only: the runtime's lane-owned connection is the
 *  process's only writer (single-writer funnel), so this thread can never
 *  contend on the SQLite write lock. Hard termination loses nothing; source
 *  facts remain authoritative. Project release awaits in-flight reads and
 *  derived-index replay before it closes the databases. */
interface RuntimeBackgroundProject {
  readonly projectRoot: string
  readonly snapshot: () => Promise<RuntimeBackgroundSummaryResult>
  readonly sessionSummaryImmediate: (sessionIds: readonly string[]) => Promise<RuntimeBackgroundSummaryResult>
  readonly waitForTotals: (sessionIds: readonly string[]) => Promise<RuntimeBackgroundSummaryResult>
  readonly sessionDetail: (sessionId: string) => Promise<RuntimeSessionDetailResult>
  readonly sessionChangeSummary: (sessionId: string) => Promise<SessionFileChangeCounts>
  readonly moduleSnapshot: (domain: ProtocolBackgroundDomain, sessionId: string) => Promise<ProtocolBackgroundSnapshot<ProtocolBackgroundDomain>>
  readonly recall: (conversationId: string, contract: RecallInput) => Promise<RecallResult>
  readonly transcriptSearch: (request: TranscriptSearchRequest) => Promise<TranscriptSearchResult>
  readonly findChats: (request: ChatSearchRequest, signal: AbortSignal) => Promise<ChatSearchResult>
  readonly close: () => Promise<void>
}

function openRuntimeBackgroundProject(projectRoot: string): RuntimeBackgroundProject {
  const reader = openReadonlyEventReader(openWorkspaceState(projectRoot))
  let conversationIndex: ConversationSearchIndex | null = null
  let summaryIndex: SessionSummaryIndex | null = null
  const operations = createRuntimeBackgroundProjectOperations()
  const projectionReader = asAsyncEventReadSurface(reader)
  const summaries = (): SessionSummaryIndex => {
    summaryIndex ??= acquireSessionSummaryIndex(resolveSessionSummaryDbFile(projectRoot), projectionReader)
    return summaryIndex
  }
  const summaryReads = {
    readImmediate: (sessionIds: readonly string[]) => summaries().readImmediate(sessionIds),
    read: (sessionIds: readonly string[]) => summaries().read(sessionIds),
    waitForTotals: (sessionIds: readonly string[]) => summaries().waitForTotals(sessionIds),
  }
  // The history never serves a transcript: the executor answers every
  // transcript read (ARCH-RUNTIME-016). A detail reads no transcript, so this reader
  // holds no conversation state.
  const sessionDetail = createSessionDetailReader({
    manager: { read: (sessionId) => readSessionMetadata(projectionReader, sessionId) },
    reader: projectionReader,
    projectionReader,
    projectRoot,
    source: { kind: "background", summaryIndex: summaryReads },
  })
  const snapshotProjector = createRuntimeBackgroundSnapshotProjector(projectionReader, summaryReads, projectRoot)
  const sessionMetadata = createSessionMetadataProjection(projectionReader)
  const index = (): ConversationSearchIndex => {
    conversationIndex ??= acquireConversationSearchIndex(resolveConversationSearchDbFile(projectRoot), projectionReader, installedConversationDeletionFacts())
    return conversationIndex
  }
  const transcriptSearch = createTranscriptSearch({
    index: { through: (upperPosition) => index().through(upperPosition) },
    source: projectionReader,
    sessions: async () => searchableSessions(sessionsFromProjection(await sessionMetadata.replay())),
  })
  // Each module's durable reader, by registry lookup; a reader holds nothing
  // until the first request names a session.
  // A Worker is its own module realm: nothing installs a catalog here, so the
  // readers come from the shipped catalog. That is complete because no module
  // the source entry adds declares a protocol domain.
  const moduleSnapshotFor = composeModuleBackgroundReaders(installedModules(), reader, { projectRoot })
  return {
    projectRoot,
    snapshot: () => operations.run(() => snapshotProjector.readImmediate()),
    sessionSummaryImmediate: (sessionIds) => operations.run(() => snapshotProjector.readImmediate(sessionIds)),
    waitForTotals: (sessionIds) => operations.run(() => snapshotProjector.waitForTotals(sessionIds)),
    sessionDetail: (sessionId) => operations.run(() => sessionDetail(sessionId)),
    sessionChangeSummary: (sessionId) => operations.run(() => readSessionChangeSummary(projectionReader, sessionId, projectRoot)),
    moduleSnapshot: (domain, sessionId) => operations.run(async () => Schema.encodeUnknownSync(protocolBackgroundSchema(domain))(await moduleSnapshotFor(domain, sessionId))),
    recall: (conversationId, contract) => operations.run(() =>
      createConversationRecall({ store: projectionReader, index: index(), conversationId })(contract)),
    transcriptSearch: (request) => operations.run(() => transcriptSearch.search(request)),
    findChats: (request, signal) => operations.run(() => transcriptSearch.findChats(request, signal)),
    close: () => operations.close(
      () => summaryIndex?.cancel(),
      async () => {
        const indexes = await Promise.allSettled([
          summaryIndex?.dispose(),
          conversationIndex?.dispose(),
        ])
        const failures = indexes.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
        try { reader.close() } catch (error) { failures.push(error) }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, "Runtime background project disposal failed")
      },
    ),
  }
}

export async function runRuntimeBackgroundWorker(worker: WorkerSelf, init: RuntimeBackgroundWorkerInit): Promise<void> {
  await Log.init({ dir: init.logBase, level: init.logLevel })
  const projects = createRuntimeBackgroundProjectMap(openRuntimeBackgroundProject)
  let shutdown: Promise<void> | undefined
  const close = (): Promise<void> => {
    shutdown ??= projects.dispose().then(() => Log.closeGlobal())
    return shutdown
  }
  installCrashPolicy({
    role: "runtime-background-worker", log,
    fatal: (failure, kind) => {
      recordFatal(log, kind, failure)
      return close().finally(() => process.exit(1))
    },
  })
  const rpcRuntime = ManagedRuntime.make(
    RpcServer.layer(RuntimeBackgroundRpc).pipe(
      Layer.provide(RuntimeBackgroundRpc.toLayer(Effect.succeed(RuntimeBackgroundRpc.of({
        RuntimeBackgroundSnapshot: ({ projectRoot }) => fromPromise(projects.get(projectRoot).snapshot),
        RuntimeBackgroundSessionSummaryImmediate: ({ projectRoot, sessionIds }) => fromPromise(() => projects.get(projectRoot).sessionSummaryImmediate(sessionIds)),
        RuntimeBackgroundWaitForTotals: ({ projectRoot, sessionIds }) => fromPromise(() => projects.get(projectRoot).waitForTotals(sessionIds)),
        RuntimeBackgroundSessionDetail: ({ projectRoot, sessionId }) => fromPromise(() => projects.get(projectRoot).sessionDetail(sessionId)),
        RuntimeBackgroundSessionChangeSummary: ({ projectRoot, sessionId }) => fromPromise(() => projects.get(projectRoot).sessionChangeSummary(sessionId)),
        // Encoded with the domain's own background codec, so the wire carries
        // exactly the declared shape.
        RuntimeBackgroundModuleSnapshot: ({ projectRoot, domain, sessionId }) => fromPromise(async () => projects.get(projectRoot).moduleSnapshot(domain, sessionId)),
        RuntimeBackgroundRecall: ({ projectRoot, conversationId, contract }) => fromPromise(() => projects.get(projectRoot).recall(conversationId, contract)),
        RuntimeBackgroundTranscriptSearch: ({ projectRoot, request }) => fromPromise(() => projects.get(projectRoot).transcriptSearch(request)),
        RuntimeBackgroundChatSearch: ({ projectRoot, request }) => fromPromise((signal) => projects.get(projectRoot).findChats(request, signal)),
        RuntimeBackgroundReleaseProject: ({ projectRoot }) => fromPromise(() => projects.release(projectRoot)),
        RuntimeBackgroundShutdown: () => fromPromise(close),
      })))),
      Layer.provide(RpcServer.layerProtocolWorkerRunner),
      Layer.provide(bunWorkerRunnerLayer(worker)),
    ),
  )
  await rpcRuntime.context()
  // The protocol value is the canonical project directory the owner resolved;
  // this thread never re-derives it.
  // A startup step the startup summary covers.
  log.debug("runtime background Worker ready")
}

/** The read-only Worker requires durable session identity before acquiring the
 * file lane. Missing metadata is unavailable, not an empty New Chat. */
async function readSessionChangeSummary(reader: AsyncEventStateReadSurface, sessionId: string, projectRoot: string): Promise<SessionFileChangeCounts> {
  if (!await readSessionMetadata(reader, sessionId)) throw new Error("Session is unavailable")
  return sessionChangeCounts(await getSessionFileChanges(reader, sessionId), projectRoot)
}

/** `signal` aborts when the caller interrupts the call. */
function fromPromise<A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, RuntimeProtocolError> {
  return Effect.tryPromise({
    try: run,
    catch: (err) => new RuntimeProtocolError({ message: errorMessage(err), kind: classifyRuntimeProtocolErrorKind(err) }),
  })
}
