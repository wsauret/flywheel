import { describe, expect, it } from "bun:test"

import { entryRuntimeDefaults, foldStreamingEpisode } from "../../../../src/orchestration/session-store/entry-defaults.js"
import type { ChatSessionEntry, SessionEntryBasePatch } from "../../../../src/orchestration/session-store/types.js"

function entry(overrides: Partial<ChatSessionEntry>): ChatSessionEntry {
  return {
    ...entryRuntimeDefaults(() => [], 0),
    kind: "chat",
    conversationId: "conversation",
    description: "test",
    runner: null,
    ...overrides,
  }
}

describe("foldStreamingEpisode", () => {
  it("folds the live episode into accumulatedActiveMs when the anchor clears to null", () => {
    const startedAt = Date.now() - 5_000
    const folded = foldStreamingEpisode<SessionEntryBasePatch>(
      entry({ streamingStartedAt: startedAt, accumulatedActiveMs: 1_000 }),
      { streamingStartedAt: null },
    )
    expect(folded.accumulatedActiveMs).toBeGreaterThanOrEqual(6_000)
    expect(folded.accumulatedActiveMs).toBeLessThan(7_000)
  })

  it("folds exactly [old anchor, new anchor] when the patch re-anchors a running episode", () => {
    const startedAt = 10_000
    const folded = foldStreamingEpisode<SessionEntryBasePatch>(
      entry({ streamingStartedAt: startedAt, accumulatedActiveMs: 1_000 }),
      { streamingStartedAt: 14_000 },
    )
    expect(folded.accumulatedActiveMs).toBe(5_000)
  })

  it("passes through when the patch does not touch the anchor", () => {
    const folded = foldStreamingEpisode(
      entry({ streamingStartedAt: Date.now(), accumulatedActiveMs: 1_000 }),
      { runnerState: "idle" as const },
    )
    expect(folded).toEqual({ runnerState: "idle" })
  })

  it("passes through when no episode is running", () => {
    const folded = foldStreamingEpisode(
      entry({ streamingStartedAt: null, accumulatedActiveMs: 1_000 }),
      { streamingStartedAt: 42 },
    )
    expect(folded).toEqual({ streamingStartedAt: 42 })
  })
})
