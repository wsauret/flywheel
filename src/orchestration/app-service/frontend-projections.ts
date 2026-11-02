import { outputCursor } from "../../protocol/output-protocol-types.js"
import { createBudgetProtocolProjection } from "./budget-protocol-projection.js"
import { createFrontendProjection } from "./frontend-projection.js"
import { createSessionDetailProjection } from "./session-detail-projection.js"
import { createProjectFiles } from "./project-files.js"
import { listFiles } from "../agent-runtime/tools/ripgrep.js"
import { createOutputProjection } from "./output-projection.js"
import { createKeptOutputProjection } from "./kept-output-projection.js"
import { createShippedOutput } from "./shipped-output.js"
import { readOutputSequence } from "./output-sequence.js"
import { createQuestionProtocolProjection } from "./question-protocol-projection.js"
import { onReplyWaitsChanged, readReplyWaitViews } from "../session/reply-waits.js"
import { createStatusProjection } from "./status-projection.js"
import type { RuntimeOwnership } from "./runtime-ownership.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import type { RuntimeUiBus } from "./runtime-ui-bus.js"
import type { RuntimeUiPatch } from "../../protocol/runtime-ui-protocol-types.js"
import type { createSessionManager } from "../session/manager.js"
import type { createSessionStore } from "../session-store/store.js"
import type { TranscriptProjectionCache } from "./transcript-projection-cache.js"
import type { RuntimeBackgroundLane } from "./runtime-background-lane.js"
import type { CommandKeeper } from "./command-keeper.js"
import { createRuntimeSummaryProjection } from "./runtime-summary-projection.js"
import { createSessionPlacements } from "../session/session-metadata-store.js"
import { workflowPlacements } from "../module-catalog.js"
import { awaitsPlannedContinuation } from "../session/planned-session-continuation.js"
import { keptCommandsOf } from "../session/command-handover.js"
import { readSessionDurationFromReader } from "../session/session-duration-projection.js"
import { sharedProcessorClaims } from "../agent-runtime/tools/processor-claims.js"

interface FrontendProjectionDeps {
  readonly sessionStore: ReturnType<typeof createSessionStore>
  readonly manager: ReturnType<typeof createSessionManager>
  readonly projectRoot: string
  readonly eventReader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly bus: Pick<RuntimeUiBus<RuntimeUiPatch>, "publish" | "snapshotPosition">
  readonly transcriptCache: TranscriptProjectionCache
  readonly backgroundLane: RuntimeBackgroundLane
  readonly keeper: CommandKeeper
}

/** The kernel protocol projections the app service reads and publishes
 *  through, each owned by the runtime scope so disposal runs in creation
 *  order. Module domains are served by the module protocol runtimes the
 *  composition root constructs beside these. */
export async function createFrontendProjections(scope: RuntimeOwnership, deps: FrontendProjectionDeps) {
  const { sessionStore, manager, projectRoot, eventReader, projectionReader, bus, transcriptCache } = deps
  const eventStore = { onStored: deps.onStored }
  const summaries = scope.own("runtime-summary-projection", createRuntimeSummaryProjection({
    workflowPlacements: workflowPlacements(projectionReader),
    context: { projectRoot },
    background: deps.backgroundLane,
    sessionPlacements: createSessionPlacements(projectionReader),
    onStored: eventStore.onStored,
  }), (owned) => { owned.dispose() })
  const projection = scope.own("frontend-projection", createFrontendProjection({ sessionStore, manager, projectRoot, summaries }), (owned) => { owned.dispose() })
  // The session store's output and the keeper's live tails publish on one
  // cursor, so they share the one owner of what that cursor's clients hold.
  const shippedOutput = createShippedOutput({ publish: bus.publish })
  const outputProjection = scope.own("output-projection", createOutputProjection({ sessionStore, keptOutput: deps.keeper, shipped: shippedOutput, projectBlock: transcriptCache.projectBlock, onStored: deps.onStored }), (owned) => { owned.dispose() })
  const statusProjection = scope.own("status-projection", createStatusProjection({
    sessionStore,
    publish: bus.publish,
    flushOutput: outputProjection.flush,
    outputPosition: (sessionId) => bus.snapshotPosition({ kind: "cursor", cursor: outputCursor(sessionId) }),
    awaitsContinuation: (sessionId) => awaitsPlannedContinuation({ reader: eventReader, projectionReader, manager }, sessionId),
    recordedActiveMs: async (sessionId) => (await readSessionDurationFromReader(projectionReader, sessionId)).accumulatedActiveMs,
    onStored: eventStore.onStored,
    handedOver: { commands: (sessionId) => keptCommandsOf(eventReader, sessionId), onChange: deps.keeper.onChange },
    replyWaits: {
      addressees: (sessionId) => readReplyWaitViews(projectionReader, manager.read, sessionId),
      onChange: (listener) => onReplyWaitsChanged(projectionReader, listener),
    },
    processorHolds: sharedProcessorClaims(),
  }), (owned) => { owned.dispose() })
  const budgetProjection = scope.own("budget-projection", createBudgetProtocolProjection({
    sessionStore,
    summaries,
    publish: bus.publish,
  }), (owned) => { owned.dispose() })
  const questionProjection = scope.own("question-projection", await createQuestionProtocolProjection({ sessionStore, reader: projectionReader, onStored: eventStore.onStored, publish: bus.publish }), (owned) => { owned.dispose() })
  const historyProjection = scope.own("history-projection", createSessionDetailProjection({ sessionStore, keptOutput: deps.keeper, manager, reader: eventReader, projectionReader, projectRoot, transcriptCache, summaries, shipped: shippedOutput, processorHolds: sharedProcessorClaims() }), (owned) => owned.dispose())
  scope.own("kept-output-projection", createKeptOutputProjection({
    keeper: deps.keeper,
    projectSettled: (sessionId, change) => { sessionStore.get(sessionId)?.runner?.applyProjectionEvent(change.event) },
    readSequence: async (sessionId) => {
      // Kept output belongs to a session with durable metadata, so a session
      // without it fails the read instead of answering an empty transcript.
      const session = await manager.read(sessionId)
      if (!session) throw new Error(`session ${sessionId} has no durable metadata`)
      return readOutputSequence(sessionId, session, { sessionStore, keptOutput: deps.keeper, reader: eventReader, projectionReader, projectRoot, transcriptCache })
    },
    shipped: shippedOutput,
  }), (owned) => { owned.dispose() })
  const projectFiles = createProjectFiles({ projectRoot, listFiles })
  return { summaries, projection, outputProjection, statusProjection, budgetProjection, questionProjection, historyProjection, projectFiles }
}
