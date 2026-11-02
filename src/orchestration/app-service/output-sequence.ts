import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { ReplayedSession } from "../session/schemas.js"
import { readRecordedExecutionCwd } from "../session/session-execution-directory.js"
import type { SessionStore } from "../session-store/types.js"
import type { CommandKeeper } from "./command-keeper.js"
import type { TranscriptProjectionCache } from "./transcript-projection-cache.js"
import { indexOutputBlocks, type IndexedBlockReader, type IndexedGroupChildren } from "../session/conversation/branch-history-builder.js"
import { isAgentInFlight } from "../../infra/output-blocks.js"

export interface OutputSequence extends IndexedBlockReader {
  readonly consistencyToken: string
  readonly streamingToolText: NonNullable<ReturnType<SessionStore["get"]>>["streamingToolText"]
  /** The live entry's streamed character count; zero without one. */
  readonly streamingOutputChars: number
  groupChildren(blockId: string): Promise<IndexedGroupChildren>
}

export interface OutputSequenceDeps {
  readonly sessionStore: Pick<SessionStore, "get"> & Partial<Pick<SessionStore, "revision">>
  readonly keptOutput?: Pick<CommandKeeper, "liveOutput">
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly projectRoot: string
  readonly transcriptCache: Pick<TranscriptProjectionCache, "read" | "createSessionReader" | "children" | "projectBlock" | "projectGroupChildren">
}

/** Reads one absolute logical transcript. The runtime entry owns paired block
 * and visible-message prefix coordinates for its bounded display tail, then
 * extends both with maintained suffix metadata. The token is the durable
 * snapshot token plus the monotonic runtime revision. The caller reads the
 * session's metadata once and passes it, or `null` for a session with none:
 * such a session has no durable transcript and reads from the project root.
 * An agent of a workflow reads paths in its workflow's recorded directory.
 * A workflow has no transcript, so it reads none. */
export async function readOutputSequence(sessionId: string, session: ReplayedSession | null, deps: OutputSequenceDeps): Promise<OutputSequence | null> {
  if (session?.kind === "workflow") return null
  const executionCwd = await readRecordedExecutionCwd(session, deps.projectRoot, deps.projectionReader)
  const durable = session && await deps.transcriptCache.read(sessionId, session.conversationId, executionCwd)
  const entry = deps.sessionStore.get(sessionId)
  if (!entry) {
    if (!durable) return null
    return {
      ...durable,
      readBlock: async (index) => deps.transcriptCache.projectBlock(sessionId, await durable.readBlock(index)),
      streamingToolText: deps.keptOutput?.liveOutput(sessionId) ?? {},
      streamingOutputChars: 0,
      groupChildren: async (id) => deps.transcriptCache.projectGroupChildren(await durable.groupChildren(id)),
    }
  }

  const start = Math.min(durable?.blockCount ?? 0, entry.outputSequenceStart)
  // Projected together, so the subagent cards of the tail share one snapshot
  // replay and one batched read of their tool sources.
  const runtime = indexOutputBlocks(await Promise.all(entry.outputBlocks().map((block) => deps.transcriptCache.projectBlock(sessionId, block))))
  return {
    blockCount: start + runtime.blockCount,
    visibleMessageCount: entry.visibleMessageCountPrefix + entry.visibleMessageCountSuffix,
    indexOf(id) {
      const liveIndex = runtime.indexOf(id)
      if (liveIndex >= 0) return start + liveIndex
      const index = durable?.indexOf(id) ?? -1
      return index < start ? index : -1
    },
    indexOfEntry(entryId) {
      const index = durable?.indexOfEntry(entryId) ?? -1
      if (index >= 0 && index < start) return index
      const liveIndex = runtime.indexOfEntry(entryId)
      return liveIndex >= 0 ? start + liveIndex : -1
    },
    readBlock: async (index) => index < start && durable
      ? deps.transcriptCache.projectBlock(sessionId, await durable.readBlock(index))
      : runtime.readBlock(index - start),
    async groupChildren(id) {
      return deps.transcriptCache.projectGroupChildren(await readGroupChildren(id))
    },
    consistencyToken: `${durable?.consistencyToken ?? "output-empty:v1"}:runtime:${deps.sessionStore.revision?.(sessionId) ?? 0}`,
    streamingToolText: { ...deps.keptOutput?.liveOutput(sessionId), ...entry.streamingToolText },
    streamingOutputChars: entry.streamingOutputChars,
  }

  async function readGroupChildren(id: string): Promise<IndexedGroupChildren> {
    const durableIndex = durable?.indexOf(id) ?? -1
    if (durable && durableIndex >= 0) return durable.groupChildren(id)
    const liveIndex = runtime.indexOf(id)
    if (liveIndex < 0 && durable) return durable.groupChildren(id)
    const block = runtime.readBlock(liveIndex)
    if (block.kind !== "agentGroup") throw new Error(`Output block ${id} is not an agent group`)
    // Live group ids are UUIDs, not conversation-suffixed tool ids. Their
    // children keep raw tool ids, even before the parent conversation commits.
    return deps.transcriptCache.children(sessionId, block.toolUseId, {
      executionCwd, idSuffix: "", presentation: "container",
      ...(!isAgentInFlight(block.status) ? { settledCount: block.totalToolCount } : {}),
    })
  }
}
