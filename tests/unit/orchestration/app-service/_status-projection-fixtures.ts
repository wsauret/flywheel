import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import type { ChatSessionEntry, SessionEntry } from "../../../../src/orchestration/session-store/types.js"
import type { ViewedSessionStore } from "../../../../src/orchestration/app-service/session-view-projection.js"

export const flush = () => Bun.sleep(0)

/** Polls `condition` each millisecond, and fails after `limit` polls, so a
 *  wait for concurrent work neither guesses a fixed delay nor hangs. */
export async function until(what: string, condition: () => boolean, limit = 500): Promise<void> {
  for (let polls = 0; polls < limit; polls++) {
    if (condition()) return
    await Bun.sleep(1)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** A runtime whose sessions no successor owes a continuation. */
export const NOTHING_OWED = { awaitsContinuation: async () => false, recordedActiveMs: async () => 0, onStored: () => () => {}, handedOver: { commands: async () => [], onChange: () => () => {} }, replyWaits: { addressees: async () => [], onChange: () => () => {}, onSessionsChanged: () => () => {} }, processorHolds: { heldToolCallIds: () => [], onHoldsChanged: () => () => {} } }

export function entry(overrides: Partial<ChatSessionEntry> = {}): ChatSessionEntry {
  return {
    kind: "chat",
    entryEpoch: 0,
    runner: null,
    conversationId: "conv-1",
    description: "Chat",
    outputBlocks: () => [],
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
    startedAt: 100,
    streamPhase: null,
    runnerState: "idle",
    activityStartedAt: 100,
    streamingStartedAt: null,
    accumulatedActiveMs: 0,
    connectionState: "connected",
    compactionStartedAt: null,
    notices: [],
    activeSubagents: new Set(),
    waitingOnBackgroundWork: false,
    activeBackgroundCommands: [],
    activeForegroundBashToolCallIds: [],
    ...overrides,
  }
}

interface SessionEntries { [sessionId: string]: SessionEntry }
export function store(initial: SessionEntries) {
  const entries = new Map(Object.entries(initial))
  const revisions = new Map(Object.keys(initial).map((id) => [id, 1]))
  const listeners = new Set<(changed: ReadonlySet<string> | undefined) => void>()
  const sessionStore: ViewedSessionStore = {
    allIds: () => [...entries.keys()],
    get: (id: string) => entries.get(id),
    revision: (id: string) => revisions.get(id) ?? 0,
    onChange(listener: (changed: ReadonlySet<string> | undefined) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    store: sessionStore,
    set(id: string, next: SessionEntry) {
      entries.set(id, next)
      revisions.set(id, (revisions.get(id) ?? 0) + 1)
      for (const listener of listeners) listener(undefined)
    },
    delete(id: string) {
      entries.delete(id)
      revisions.delete(id)
      for (const listener of listeners) listener(undefined)
    },
  }
}

export function sink() {
  const sequencer = createRuntimeUiPatchSequencer()
  const patches: RuntimeUiPatch[] = []
  return {
    patches,
    outputPosition: (sessionId: string) => sequencer.snapshotPosition({ kind: "cursor", cursor: outputCursor(sessionId) }),
    publish(input: RuntimeUiPatchInput): RuntimeUiPatch {
      const patch = sequencer.publish(input)
      patches.push(patch)
      return patch
    },
  }
}
