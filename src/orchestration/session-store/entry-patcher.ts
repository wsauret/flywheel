import type { AnyBlock } from "../../infra/output-blocks.js"
import { FULL_RESYNC_OUTPUT_CHANGE_BATCH, type OutputChangeBatch } from "../../infra/output/output-block-delta.js"
import { probe } from "../../infra/render-probe.js"
import { applySessionNoticeOperation } from "../../infra/session-notice.js"
import { foldStreamingEpisode } from "./entry-defaults.js"
import type { ChatEntryPatch, SessionEntry } from "./types.js"
import { entryActivity } from "./activity.js"

interface SessionEntryPatcherDeps {
  entries: Map<string, SessionEntry>
  blockSetters: Map<string, (blocks: readonly AnyBlock[]) => void>
  queueOutputChanges: (sessionId: string, batch: OutputChangeBatch) => void
  recordDuration: (sessionId: string, accumulatedActiveMs: number) => void
  notifyChange: (sessionId: string) => void
}

interface SessionEntryPatcher {
  updateEntry(sessionId: string, patch: ChatEntryPatch): void
  updateChatEntry(sessionId: string, patch: ChatEntryPatch): void
}

export function createSessionEntryPatcher(deps: SessionEntryPatcherDeps): SessionEntryPatcher {
  function applyEntryPatch(sessionId: string, patch: ChatEntryPatch): void {
    const entry = deps.entries.get(sessionId)
    if (!entry) return
    const { outputBlocks, visibleMessageCountSuffix, outputChanges, noticeOperation, ...rest } = patch
    const folded = noticeOperation
      ? { ...foldStreamingEpisode(entry, rest), notices: applySessionNoticeOperation(entry.notices, noticeOperation.operation, noticeOperation.timestamp) }
      : foldStreamingEpisode(entry, rest)
    // Only a key the entry already carries can change it. A patch lands on every
    // output sync, so each folded key is read once instead of rebuilding the
    // entry's entries per key.
    const hasChange = Object.entries(folded).some(([key, value]) => {
      const current = Object.getOwnPropertyDescriptor(entry, key)
      return current !== undefined && current.value !== value
    })
    if (outputBlocks === undefined && outputChanges === undefined && !hasChange) return

    const durationToRecord = folded.accumulatedActiveMs !== undefined && folded.accumulatedActiveMs !== entry.accumulatedActiveMs
      ? folded.accumulatedActiveMs
      : null

    probe("patch")
    if (outputBlocks !== undefined) {
      probe("patch.blocks")
      deps.blockSetters.get(sessionId)?.(outputBlocks)
      entry.visibleMessageCountSuffix = visibleMessageCountSuffix
    }
    if (hasChange) {
      const activity = entryActivity(entry)
      const nextActivity = entryActivity({ runnerState: folded.runnerState ?? entry.runnerState, streamPhase: folded.streamPhase === undefined ? entry.streamPhase : folded.streamPhase })
      if (nextActivity !== activity || (activity === "idle" && folded.waitingOnBackgroundWork !== undefined && folded.waitingOnBackgroundWork !== entry.waitingOnBackgroundWork)) {
        entry.activityStartedAt = Date.now()
      }
      Object.assign(entry, folded)
    }
    // Queued before notifyChange: the app-service output projection's onChange
    // listener drains this queue on the store's next coalesced notify flush.
    // A caller that writes outputBlocks or streamingToolText without minting outputChanges (only
    // OutputSession does both today, but the store has no way to enforce that
    // every future or test writer does) degrades to a full resync instead of
    // silently going undelivered - the same graceful-degradation the write-site
    // model already uses for its own rare structural rewrites.
    if (outputChanges !== undefined) deps.queueOutputChanges(sessionId, outputChanges)
    else if (outputBlocks !== undefined || rest.streamingToolText !== undefined) deps.queueOutputChanges(sessionId, FULL_RESYNC_OUTPUT_CHANGE_BATCH)
    deps.notifyChange(sessionId)
    if (durationToRecord !== null) deps.recordDuration(sessionId, durationToRecord)
  }

  return {
    updateEntry(sessionId, patch) {
      applyEntryPatch(sessionId, patch)
    },
    updateChatEntry(sessionId, patch) {
      applyEntryPatch(sessionId, patch)
    },
  }
}
