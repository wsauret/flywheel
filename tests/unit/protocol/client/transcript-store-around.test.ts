import { describe, expect, test } from "bun:test"

import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import { createTranscriptStore } from "../../../../src/protocol/client/transcript-store.js"
import { deltaPatch, fakeConnection, SESSION, settle, textBlock } from "./_transcript-store-fixtures.js"

describe("transcript store: opening around a chat entry", () => {
  // A message from another session takes its delivery key as its entry id,
  // and that key holds colons of its own.
  test.each([
    ["an entry of the agent", "e3", "text:e3:0"],
    ["a message from another session", "msg:sender:call_1", "userMessage:msg:sender:call_1"],
  ])("installs the window around %s as history and names the block it holds", async (_kind, entryId, blockId) => {
    const message: FrontendOutputBlock = { kind: "userMessage", id: "msg:sender:call_1", content: "Which file?", timestamp: 1, pending: false, injected: false, from: { sessionId: "sender", name: "Sender", relation: "child" } }
    const middle = [textBlock("e3:0", "three"), message, textBlock("e5", "five")]
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("e8"), textBlock("e9")], startBlockIndex: 8, totalBlocks: 10, hasBefore: true },
      { blocks: middle, startBlockIndex: 3, totalBlocks: 10, hasBefore: true, hasAfter: true },
    ] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    try {
      await settle()
      expect(store.view.atTail).toBe(true)
      const found = await store.openAround(entryId)
      expect(found).toBe(blockId)
      expect(store.view.blocks.map((block) => "id" in block ? block.id : "")).toEqual(["e3:0", "msg:sender:call_1", "e5"])
      expect(store.view.startBlockIndex).toBe(3)
      expect(store.view.atTail).toBe(false)
      expect(store.view.hasNewer).toBe(true)
      expect(store.status).toBe("ready")

      // A landing on a block the window already holds answers without a read
      // and keeps the window the view measured.
      const reads = fake.calls.filter((call) => call === "read outputWindow").length
      const window = store.view
      const generation = store.windowGeneration
      expect(await store.openAround("e5")).toBe("text:e5")
      expect(fake.calls.filter((call) => call === "read outputWindow")).toHaveLength(reads)
      expect(store.view).toBe(window)
      expect(store.windowGeneration).toBe(generation)
    } finally {
      store.dispose()
    }
  })

  test("an entry the runtime cannot place lands on the tail and names nothing", async () => {
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("e8"), textBlock("e9")], startBlockIndex: 8, totalBlocks: 10, hasBefore: true },
    ] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    try {
      const found = await store.openAround("gone")
      expect(found).toBeUndefined()
      expect(store.view.atTail).toBe(true)
      expect(store.view.blocks.length).toBe(2)
    } finally {
      store.dispose()
    }
  })
})

describe("transcript store: paging from history back to the live end", () => {
  test("a newer page that reaches the live end reattaches the window to live output", async () => {
    const tail = { blocks: [textBlock("e8"), textBlock("e9")], startBlockIndex: 8, totalBlocks: 10, hasBefore: true, snapshotPosition: 100 }
    const fake = fakeConnection({
      windows: [tail, { blocks: [textBlock("e5"), textBlock("e6")], startBlockIndex: 5, totalBlocks: 10, hasBefore: true, hasAfter: true }, tail],
      ranges: [{ blocks: [textBlock("e6"), textBlock("e7"), textBlock("e8"), textBlock("e9")], startBlockIndex: 6, hasBefore: true, hasAfter: false }],
    })
    const diagnostics: string[] = []
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, onDiagnostic: (message) => diagnostics.push(message) })
    await settle()
    await store.openAround("e5")
    expect(store.view.atTail).toBe(false)

    await store.loadNewer()
    await settle()
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 10, textBlock("e10")) })

    expect(store.view.atTail, "the reader who paged down to the end follows the live end again").toBe(true)
    expect(store.view.hasNewer).toBe(false)
    expect(store.view.blocks.map((block) => "id" in block ? block.id : "")).toEqual(["e5", "e6", "e7", "e8", "e9", "e10"])
    expect(diagnostics.filter((message) => message.includes("live end")), "each crossing is recorded once").toEqual([
      "transcript window detached from the live end",
      "transcript window rejoined the live end",
    ])
    store.dispose()
  })

  for (const { refusal, page } of [
    { refusal: "disagrees with the window", page: { blocks: [textBlock("x6"), textBlock("x7")], startBlockIndex: 6, hasBefore: true } },
    { refusal: "holds no later blocks", page: { blocks: [textBlock("e6")], startBlockIndex: 6, hasBefore: true, hasAfter: false } },
  ]) test(`a newer page that ${refusal} rejoins the live end instead of leaving the window behind it`, async () => {
    const tail = { blocks: [textBlock("e8"), textBlock("e9")], startBlockIndex: 8, totalBlocks: 10, hasBefore: true, snapshotPosition: 100 }
    const fake = fakeConnection({
      windows: [tail, { blocks: [textBlock("e5"), textBlock("e6")], startBlockIndex: 5, totalBlocks: 10, hasBefore: true, hasAfter: true }, tail],
      ranges: [page],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    await store.openAround("e5")

    expect(await store.loadNewer(), "the page itself extends nothing").toBe(false)
    await settle()
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 10, textBlock("e10")) })

    expect(store.view.atTail).toBe(true)
    expect(store.view.blocks.map((block) => "id" in block ? block.id : "")).toEqual(["e8", "e9", "e10"])
    store.dispose()
  })
})
