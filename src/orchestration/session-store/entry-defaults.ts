import type { AnyBlock } from "../../infra/output-blocks.js"
import type { SessionEntry, SessionEntryBase, SessionEntryBasePatch } from "./types.js"

// Monotone per-process stamp: one per entry construction, so a projection can
// tell a re-opened shell (new coordinate baseline) from a mutated entry even
// when removal and re-add coalesce into one observed notification.
let nextEntryEpoch = 0

/** Runtime defaults shared by workflow and chat entries at creation. Callers
 *  spread this first and override the fields they source from options. */
export function entryRuntimeDefaults(
  outputBlocks: () => readonly AnyBlock[],
  startedAt: number,
  accumulatedActiveMs = 0,
): Omit<SessionEntryBase, "kind" | "description"> {
  return {
    entryEpoch: ++nextEntryEpoch,
    outputBlocks,
    outputSequenceStart: 0,
    visibleMessageCountPrefix: 0,
    visibleMessageCountSuffix: 0,
    streamingToolText: {},
    tokens: 0,
    cost: 0,
    billedCost: 0,
    priceUnavailable: false,
    contextPercent: 0,
    streamingOutputChars: 0,
    contextPromptTokens: 0,
    startedAt,
    streamPhase: null,
    runnerState: "absent",
    activityStartedAt: startedAt,
    streamingStartedAt: null,
    accumulatedActiveMs,
    connectionState: "connected",
    notices: [],
    compactionStartedAt: null,
    activeSubagents: new Set<string>(),
    waitingOnBackgroundWork: false,
    activeBackgroundCommands: [],
    activeForegroundBashToolCallIds: [],
  }
}

/** Fold a live streaming episode into accumulatedActiveMs whenever a patch
 *  moves the active-clock anchor (streamingStartedAt) off a running episode:
 *  to null on a park, awaiting_user, queue completion/failure, and chat
 *  detachRunner; to a fresh timestamp on turn resume or logical turn start.
 *  A park that waits on background work (subagents, an explicit wait on a
 *  backgrounded command) leaves the anchor untouched, so that waiting counts
 *  as active in the header timer. */
export function foldStreamingEpisode<T extends Omit<SessionEntryBasePatch, "outputBlocks">>(entry: SessionEntry, patch: T): T {
  if (patch.streamingStartedAt === undefined || entry.streamingStartedAt === null) return patch
  if (patch.streamingStartedAt === entry.streamingStartedAt) return patch
  const episodeEnd = patch.streamingStartedAt ?? Date.now()
  return { ...patch, accumulatedActiveMs: entry.accumulatedActiveMs + Math.max(0, episodeEnd - entry.streamingStartedAt) }
}
