import { isDeepStrictEqual } from "node:util"

import type { AsyncEventAppender, AsyncEventStateReadSurface } from "../../../infra/event-store-types.js"
import { runInTaskSlices } from "../../../infra/task-scheduling.js"
import { validateRawForkBranchWork } from "./conversation-tree-context.js"
import {
  ConversationTreeStorage,
  type CommittedActiveBranchCapture,
} from "./conversation-tree-storage.js"

export interface ForkConversationTreeOptions {
  readonly source: CommittedActiveBranchCapture
  readonly destinationConversationId: string
  readonly destinationSessionId: string
  readonly store: AsyncEventStateReadSurface
  readonly writer?: AsyncEventAppender
  readonly now?: () => string
}

export interface ConversationForkPublication {
  readonly sourcePrefixPosition: number
  readonly entryCount: number
  readonly rootEntryId: string
  readonly leafEntryId: string
}

/** Copy one validated committed branch into a private destination aggregate.
 * This function does not publish session metadata or a fork relationship. */
export async function forkConversationTree(options: ForkConversationTreeOptions): Promise<ConversationForkPublication> {
  const entries = options.source.entries
  if (entries.length === 0) throw new Error("Cannot fork an empty conversation branch")
  if (options.source.degraded) throw new Error("Cannot fork a degraded conversation branch")

  const sourceMessages = await runInTaskSlices("conversation:fork-validate", validateRawForkBranchWork(entries))

  const destinationOptions = {
    conversationId: options.destinationConversationId,
    sessionId: options.destinationSessionId,
    store: options.store,
    ...(options.writer ? { writer: options.writer } : {}),
    ...(options.now ? { now: options.now } : {}),
  }
  const destination = await ConversationTreeStorage.create(destinationOptions)
  try {
    const outcome = await destination.appendEntries(entries)
    if (outcome.kind !== "committed") {
      throw new Error("Destination conversation branch append was not committed", { cause: outcome.cause })
    }
  } finally {
    destination.dispose()
  }

  const reopened = await ConversationTreeStorage.open(destinationOptions)
  try {
    const capture = await reopened.captureInput()
    const matches = await runInTaskSlices("conversation:fork-verify", (function* () {
      const copied = yield* reopened.committedActiveBranchWork(capture)
      const copiedMessages = yield* validateRawForkBranchWork(copied.entries)
      return !copied.degraded
        && copied.rootEntryId === options.source.rootEntryId
        && copied.leafEntryId === options.source.leafEntryId
        && (yield* sameItemsWork(copied.entries, entries))
        && (yield* sameItemsWork(copiedMessages, sourceMessages))
    })())
    if (!matches) throw new Error("Destination conversation branch failed strict copy validation")
  } finally {
    reopened.dispose()
  }

  const rootEntryId = options.source.rootEntryId
  const leafEntryId = options.source.leafEntryId
  if (rootEntryId === null || leafEntryId === null) throw new Error("Forked conversation branch has no publication boundary")
  return {
    sourcePrefixPosition: options.source.foldedPosition,
    entryCount: entries.length,
    rootEntryId,
    leafEntryId,
  }
}

/** Deep-compare two histories one item at a time, so a long branch yields between entries. */
function* sameItemsWork<T>(left: readonly T[], right: readonly T[]): Generator<void, boolean> {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    yield
    if (!isDeepStrictEqual(left[index], right[index])) return false
  }
  return true
}
