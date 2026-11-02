import { describe, expect, test } from "bun:test"
import { createSessionStore } from "../../../../src/orchestration/session-store/store.js"
import { createOutputProjection } from "../../../../src/orchestration/app-service/output-projection.js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import type { StoredFact } from "../../../../src/infra/event-store-types.js"
import { appendChange, batch, deltas, insertChange, outputProjectionRuntime, sink, textBlock, upsertChange } from "./_output-projection-fixtures.js"

const runtime = outputProjectionRuntime()

describe("output projection watches", () => {
  test("an unwatched session projects and publishes no delta, and its rebase still publishes", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    let projected = 0
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped, projectBlock: async (_sessionId, block) => { projected++; return block } })
    try {
      projection.watch(["other"])
      store.openSessionRuntime({ sessionId: "unwatched", conversationId: "conv-unwatched" })
      for (const content of ["a", "b", "c"]) {
        store.updateChatEntry("unwatched", { outputBlocks: [textBlock(content)], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock(content))]) })
        await projection.flush("unwatched")
        store.updateChatEntry("unwatched", { streamingOutputChars: content.charCodeAt(0) })
        await projection.flush("unwatched")
      }
      expect(projected).toBe(0)
      expect(s.patches.map((patch) => patch.payload.kind)).toEqual(["runtime.invalidate"])
    } finally {
      projection.dispose()
    }
  })

  test("a session watched again ships its next change whole over the read its watcher made", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    try {
      projection.watch(["chat"])
      store.openSessionRuntime({ sessionId: "chat", conversationId: "conv-chat" })
      const hello = textBlock("h")
      store.updateChatEntry("chat", { outputBlocks: [hello], visibleMessageCountSuffix: 1, streamingOutputChars: 5, outputChanges: batch([insertChange(0, hello)]) })
      await projection.flush("chat")
      projection.watch([])
      store.updateChatEntry("chat", { outputBlocks: [{ ...hello, content: "hi" }], visibleMessageCountSuffix: 1, outputChanges: batch([appendChange(0, "t-h", 1, "i")]) })
      await projection.flush("chat")
      s.patches.length = 0
      projection.watch(["chat"])
      const edited = { ...hello, content: "hi there" }
      store.updateChatEntry("chat", { outputBlocks: [edited], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, edited)]) })
      await projection.flush("chat")
      expect(deltas(s.patches, "chat").flatMap((delta) => delta.blocks).map((change) => change.kind)).toEqual(["upsert"])
      // The count is unchanged since the session left, but the watcher's read
      // may hold another one, so it ships again.
      expect(deltas(s.patches, "chat").map((delta) => delta.streamingOutputChars)).toEqual([5])
    } finally {
      projection.dispose()
    }
  })

  test("a child's change reaches the card of a parent that was watched after the card arrived", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    let childTools = 0
    let stored: (events: readonly StoredFact[]) => void = () => {}
    const projection = createOutputProjection({
      sessionStore: store, shipped: s.shipped,
      onStored: (listener) => { stored = listener; return () => {} },
      projectBlock: async (sessionId, block) => sessionId !== "parent" || block.kind !== "tool" ? block
        : { kind: "agentGroup", containerKind: "subagent", id: block.id, toolUseId: block.id, label: block.id, description: "", children: [], totalToolCount: childTools, status: "active", timestamp: 1, linkUri: "flywheel://session/child" },
    })
    try {
      projection.watch(["child"])
      store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      store.openSessionRuntime({ sessionId: "child", conversationId: "conv-child" })
      await projection.flush("parent")
      const card: AnyBlock = { kind: "tool", id: "card", name: "subagent", presentation: { name: "Agent", detail: "card" }, status: "pending", timestamp: 1 }
      store.updateChatEntry("parent", { outputBlocks: [card], visibleMessageCountSuffix: 0, outputChanges: batch([upsertChange(0, card)]) })
      await projection.flush("parent")
      expect(deltas(s.patches, "parent")).toEqual([])

      projection.watch(["parent", "child"])
      childTools = 1
      stored([{ id: "event-1", position: 1, seq: 1, aggregateId: "conversation:child", sessionId: "child", actor: "agent", type: "tool-execution-started", version: 1, timestamp: 1, payload: {} }])
      await projection.flush("parent")
      expect(deltas(s.patches, "parent").flatMap((delta) => delta.blocks)).toMatchObject([{ kind: "upsert", blockId: "tool:card", block: { kind: "agentGroup", totalToolCount: 1 } }])
    } finally {
      projection.dispose()
    }
  })
})
