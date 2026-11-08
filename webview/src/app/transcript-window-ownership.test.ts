import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { mountToolGroup } from "./render-ownership-loader-fixture.js"

const tool = (id: string): FrontendToolEntry => ({
  kind: "tool", id, name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: id },
  timestamp: 3000, status: "completed", content: "", filetype: "ts",
})

describe("a window that opened inside a turn", () => {
  const person: FrontendOutputBlock = { kind: "userMessage", id: "person", content: "Do it", timestamp: 1000, pending: false, injected: false }
  const narration: FrontendOutputBlock = { kind: "text", id: "narration", content: "Working", timestamp: 4000 }
  const answer: FrontendOutputBlock = { kind: "text", id: "answer", content: "Done", timestamp: 9000 }
  const opened = [tool("second"), tool("third"), narration, answer]
  const whole = [person, tool("first"), ...opened]
  const rest = { activity: "idle", interruptible: false } as const
  const groupOf = (mounted: ReturnType<typeof mountToolGroup>) => mounted.rows().find(row => row.id.startsWith("toolGroup:"))

  test("keeps its rows and inherited open fold through overlapping and disjoint coordinate recovery and a session return", () => {
    const mounted = mountToolGroup(opened)
    try {
      mounted.publish({ ...rest, startBlockIndex: 2 })
      const group = groupOf(mounted)
      assert.equal(group?.id, "toolGroup:tool:second")
      mounted.publish({ blocks: whole, startBlockIndex: 0 })
      mounted.frame()
      assert.equal(groupOf(mounted)?.node, group?.node, "the prepend keeps the stretch's row")
      assert.equal(mounted.foldOpen(), true, "the turn the reader was inside arrives open")
      mounted.publish({ windowGeneration: 1 })
      assert.equal(groupOf(mounted)?.node, group?.node, "an overlapping recovery keeps the stretch's row")
      assert.equal(groupOf(mounted)?.id, group?.id)
      assert.equal(mounted.foldOpen(), true)
      mounted.publish({ windowGeneration: 2, blocks: [...whole], startBlockIndex: 100 })
      assert.equal(groupOf(mounted)?.node, group?.node, "disjoint coordinates still name the same stretch")
      assert.equal(mounted.foldOpen(), true)
      mounted.publish({ sessionId: "other", blocks: opened, startBlockIndex: 2 })
      mounted.publish({ blocks: whole, startBlockIndex: 0 })
      mounted.frame()
      assert.equal(mounted.foldOpen(), true, "the other session has its own inherited fold")
      mounted.toggleFold()
      assert.equal(mounted.foldOpen(), false)
      mounted.publish({ sessionId: "render-ownership", blocks: whole, startBlockIndex: 0 })
      assert.equal(mounted.foldOpen(), true, "a session return keeps its inherited openness, not the other session's close")
      assert.equal(groupOf(mounted)?.id, group?.id, "the resident session keeps its group key")
    } finally { mounted.dispose() }
  })

  test("holds the person's close as a choice through a replaced window and a reload", () => {
    const mounted = mountToolGroup(opened)
    try {
      mounted.publish({ ...rest, startBlockIndex: 2 })
      mounted.publish({ blocks: whole, startBlockIndex: 0 })
      mounted.frame()
      assert.equal(mounted.foldOpen(), true)
      mounted.toggleFold()
      assert.equal(mounted.foldOpen(), false)
      mounted.publish({ windowGeneration: 1, blocks: [...whole] })
      assert.equal(mounted.foldOpen(), false, "the replaced window keeps the close")
      mounted.publish({ windowGeneration: 2, blocks: opened, startBlockIndex: 2 })
      mounted.publish({ blocks: whole, startBlockIndex: 0 })
      mounted.frame()
      assert.equal(mounted.foldOpen(), false, "a window that opens inside the turn again keeps the close")
    } finally { mounted.dispose() }
    const reloaded = mountToolGroup(opened, { sessionId: "render-ownership", following: true, open: [], closed: ["turnFold:text:answer"] })
    try {
      reloaded.publish({ ...rest, startBlockIndex: 2 })
      reloaded.publish({ blocks: whole, startBlockIndex: 0 })
      reloaded.frame()
      assert.equal(reloaded.foldOpen(), false, "a reload restores the close")
    } finally { reloaded.dispose() }
  })
})

describe("an opened tool stretch", () => {
  const thought: FrontendOutputBlock = { kind: "thinking", id: "thought", content: "Keep this thought", status: "completed", timestamp: 3500 }
  const stretch = [tool("first"), tool("second"), thought, tool("third"), { kind: "text", id: "after", content: "After", timestamp: 9000 } satisfies FrontendOutputBlock]
  const groupOf = (mounted: ReturnType<typeof mountToolGroup>) => mounted.rows().find(row => row.id.startsWith("toolGroup:"))

  test("keeps its group and nested Thought through anchored recovery, and restores its choice on reload", () => {
    const mounted = mountToolGroup(stretch.slice(1), undefined, true)
    let reading
    try {
      mounted.publish({ startBlockIndex: 1, hasBefore: true })
      assert.equal(groupOf(mounted)?.id, "toolGroup:tool:second")
      mounted.toggle()
      assert.equal(mounted.groupOpen(), true)
      const group = groupOf(mounted)
      const thinking = mounted.elements().find(node => node.properties.class === "block thinking")
      assert.ok(thinking)
      const thoughtControl = thinking.children.find(node => node.tag === "button")
      assert.ok(thoughtControl)
      const toggleThought = thoughtControl.properties.onClick
      assert.equal(typeof toggleThought, "function")
      if (typeof toggleThought !== "function") throw new Error("Missing Thought control")
      toggleThought()
      assert.equal(thoughtControl.properties["aria-expanded"], true)
      mounted.publish({ blocks: stretch, startBlockIndex: 0, hasBefore: false })
      mounted.frame()
      assert.equal(groupOf(mounted)?.id, "toolGroup:tool:second", "the prepend keeps the stretch's key")
      assert.equal(mounted.groupOpen(), true)
      reading = mounted.reading()
      mounted.publish({ windowGeneration: 1, blocks: [...stretch] })
      assert.equal(groupOf(mounted)?.id, group?.id, "overlapping recovery keeps the key")
      assert.equal(groupOf(mounted)?.node, group?.node)
      assert.ok(mounted.elements().includes(thinking), "the nested Thought stays mounted")
      assert.equal(thoughtControl.properties["aria-expanded"], true)
      mounted.publish({ windowGeneration: 2, blocks: [...stretch], startBlockIndex: 100 })
      assert.equal(groupOf(mounted)?.node, group?.node, "disjoint coordinates keep the group node")
      assert.ok(mounted.elements().includes(thinking), "disjoint coordinates keep the nested Thought")
      assert.equal(thoughtControl.properties["aria-expanded"], true)
      assert.equal(mounted.groupOpen(), true)
    } finally { mounted.dispose() }
    const reloaded = mountToolGroup(stretch, reading)
    try {
      assert.equal(groupOf(reloaded)?.id, "toolGroup:tool:first")
      assert.equal(reloaded.groupOpen(), true, "a reload keeps the person's open")
    } finally { reloaded.dispose() }
  })
})

describe("an older page that lands while the transcript scrolls", () => {
  const text = (id: string, content = id): FrontendOutputBlock => ({ kind: "text", id, content, timestamp: 1000 })
  const tail = [text("c"), text("d")]

  test("holds its rows for a still animation frame past the bounce, a finger, and scrolling, while the rows on screen stay live", () => {
    const mounted = mountToolGroup(tail)
    try {
      mounted.publish({ startBlockIndex: 2 })
      const viewport = mounted.viewport()
      assert.ok(viewport)
      const scroll = viewport.properties.onScroll
      if (typeof scroll !== "function") throw new Error("Missing scroll handler")
      const ids = () => mounted.rows().map(row => row.id)
      mounted.frame()
      viewport.scrollTop = -14
      const page = [text("a"), text("b"), ...tail]
      mounted.publish({ blocks: page, startBlockIndex: 1000, windowGeneration: 1 })
      mounted.publish({ blocks: [...page, text("e")], startBlockIndex: 1000 })
      assert.deepEqual(ids(), ["text:c", "text:d", "text:e"], "the tail output shows while the older rows wait")
      mounted.frame()
      assert.deepEqual(ids(), ["text:c", "text:d", "text:e"], "the bounce is not over")
      viewport.scrollTop = 0
      viewport.dispatch("touchstart", { touches: [{}] })
      for (let step = 1; step <= 600; step += 1) {
        viewport.scrollTop = step
        scroll()
        mounted.publish({ blocks: [...page, text("e", `streamed ${step}`)], startBlockIndex: 1000 })
        mounted.frame()
      }
      assert.deepEqual(ids(), ["text:c", "text:d", "text:e"], "a finger and continuous scrolling keep the older rows waiting")
      assert.match(mounted.text(), /streamed 600/, "the streaming row stays live through the scrolling")
      mounted.frame()
      assert.deepEqual(ids(), ["text:c", "text:d", "text:e"], "a resting finger keeps the older rows waiting")
      viewport.dispatch("touchend", { touches: [] })
      mounted.frame()
      assert.deepEqual(ids(), ["text:a", "text:b", "text:c", "text:d", "text:e"])
    } finally { mounted.dispose() }
  })

  test("a restore reads the rows on screen, not a page that waits for a still frame", async () => {
    const settle = async () => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve() }
    const mounted = mountToolGroup(tail, { sessionId: "render-ownership", following: false, top: { index: 0, offset: 0 }, open: [] })
    try {
      mounted.publish({ startBlockIndex: 2, hasBefore: true })
      const viewport = mounted.viewport()
      assert.ok(viewport)
      viewport.scrollHeight = 5000
      await settle()
      assert.equal(mounted.pageRequests(), 1, "the saved place lies before the window")
      viewport.dispatch("touchstart", { touches: [{}] })
      mounted.publish({ blocks: [text("a"), text("b"), ...tail], startBlockIndex: 0, hasBefore: false })
      mounted.settlePage(true)
      await settle()
      mounted.mutate()
      await settle()
      assert.equal(mounted.awayFromTail(), true, "the waiting page does not send the reader to the tail")
      assert.equal(mounted.pageRequests(), 1, "the waiting page is not read again")
      viewport.dispatch("touchend", { touches: [] })
      mounted.frame()
      mounted.mutate()
      await settle()
      assert.equal(mounted.rows()[0]?.id, "text:a")
      assert.equal(mounted.awayFromTail(), true, "the reader lands on the saved row")
      assert.notEqual(viewport.scrollTop, 5000)
    } finally { mounted.dispose() }
  })
})

describe("a restored reading place", () => {
  const text = (id: string): FrontendOutputBlock => ({ kind: "text", id, content: id, timestamp: 1000 })

  test("holds the reader's row through a layout change that lands before the first scroll", async () => {
    const settle = async () => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve() }
    const mounted = mountToolGroup([text("a"), text("b"), text("c")], { sessionId: "render-ownership", following: false, top: { index: 1, offset: 0 }, open: [] })
    try {
      const viewport = mounted.viewport()
      assert.ok(viewport)
      viewport.scrollHeight = 5000
      viewport.scrollTop = 500
      const row = (id: string) => {
        const found = mounted.rows().find(entry => entry.id === id)?.node
        assert.ok(found)
        return found
      }
      row("text:a").properties.rectTop = -500
      row("text:a").properties.rectHeight = 500
      row("text:b").properties.rectHeight = 1000
      await settle()
      assert.equal(viewport.scrollTop, 500, "the saved row lands at its saved offset")
      // Content above the reader changes size, as a turn folding at rest does,
      // before the reader has scrolled at all.
      row("text:a").properties.rectHeight = 800
      row("text:b").properties.rectTop = 300
      mounted.mutate()
      assert.equal(viewport.scrollTop, 800, "the reader's row keeps its place on screen")
    } finally { mounted.dispose() }
  })

  test("keeps the restored row when a scroll near the tail arrives before the older page lands", async () => {
    const settle = async () => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve() }
    const tail = [text("c"), text("d")]
    const mounted = mountToolGroup(tail, { sessionId: "render-ownership", following: false, top: { index: 0, offset: 0 }, open: [] })
    try {
      mounted.publish({ startBlockIndex: 2, hasBefore: true })
      const viewport = mounted.viewport()
      assert.ok(viewport)
      viewport.scrollHeight = 5000
      await settle()
      const scroll = viewport.properties.onScroll
      if (typeof scroll !== "function") throw new Error("Missing scroll handler")
      // A clamp or a stray scroll near the tail while the older page is on its way.
      viewport.scrollTop = 4990
      scroll()
      mounted.publish({ blocks: [text("a"), text("b"), ...tail], startBlockIndex: 0, hasBefore: false })
      mounted.settlePage(true)
      await settle()
      mounted.frame()
      mounted.frame()
      const rowA = mounted.rows().find(row => row.id === "text:a")?.node
      assert.ok(rowA)
      rowA.properties.rectTop = -viewport.scrollTop
      mounted.mutate()
      await settle()
      mounted.publish({ blocks: [text("a"), text("b"), ...tail, text("e")], startBlockIndex: 0, hasBefore: false })
      mounted.mutate()
      await settle()
      assert.equal(mounted.awayFromTail(), true, "the restored reader is not following the tail")
      assert.equal(viewport.scrollTop, 0, "live output leaves the reader on the restored row")
    } finally { mounted.dispose() }
  })
})
