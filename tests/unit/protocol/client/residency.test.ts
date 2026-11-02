import { describe, expect, test } from "bun:test"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { createHeldView, type HeldView } from "../../../../src/protocol/client/held-view.js"
import { createResidency, type ResidentLanes } from "../../../../src/protocol/client/residency.js"
import { createTranscriptStore, type TranscriptStore } from "../../../../src/protocol/client/transcript-store.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import { updatesCursor } from "../../../../src/protocol/update-protocol-types.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { deltaPatch, fakeConnection, SESSION, settle, textBlock } from "./_transcript-store-fixtures.js"

interface Bundle { readonly id: string; readonly lanes: ResidentLanes }

const bundleOf = (id: string) => (lanes: ResidentLanes): Bundle => ({ id, lanes })

function membership(options: { capacity: number; idleMs?: number; pinned?: () => ReadonlySet<string>; now?: () => number }) {
  const evicted: string[] = []
  const residency = createResidency<Bundle>({
    ...options,
    lanes: lanesSource().client,
    dormancy: false,
    onEvict: (bundle, id) => {
      expect(bundle.id).toBe(id)
      evicted.push(id)
    },
  })
  return { residency, evicted }
}

/** A lane source whose breaks and openings a test drives. */
function lanesSource() {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const lanes = fakeLanes()
  const emit = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
  return {
    client: {
      subscribe(listener: (event: FrontendEvent) => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      onLane: lanes.onLane,
    },
    emit,
    lanes,
    breakLane() {
      lanes.end()
      emit(LANE_BREAK)
    },
  }
}

const invalidation = (sessionId: string, position: number, reason: "overflow" | "rebase"): FrontendEvent => ({
  type: "patch",
  patch: { cursor: outputCursor(sessionId), position, prevPosition: position - 1, payload: { kind: "runtime.invalidate", reason } },
})

const outputPatch = (sessionId: string, position: number): FrontendEvent => ({
  type: "patch",
  patch: { cursor: outputCursor(sessionId), position, prevPosition: position - 1, payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [] } } },
})

describe("residency membership", () => {
  test("evicts the least recently used session beyond capacity and hands its bundle to onEvict", () => {
    const { residency, evicted } = membership({ capacity: 2 })
    residency.use("a", bundleOf("a"))
    residency.use("b", bundleOf("b"))
    residency.use("a", bundleOf("a"))
    residency.use("c", bundleOf("c"))
    expect(evicted).toEqual(["b"])
    expect(residency.ids()).toEqual(["a", "c"])
    expect(residency.get("b")).toBeUndefined()
  })

  test("keeps a retained session over capacity and evicts it once its last handle releases", () => {
    const { residency, evicted } = membership({ capacity: 1 })
    const a = residency.use("a", bundleOf("a"))
    const shown = residency.retain("a")
    const shownAgain = residency.retain("a")
    const b = residency.use("b", bundleOf("b"))
    expect(residency.ids()).toEqual(["a", "b"])
    expect(residency.get("a")).toBe(a)
    expect(residency.get("b")).toBe(b)
    residency.retain("b")
    shown.release()
    shown.release()
    expect(evicted).toEqual([])
    shownAgain.release()
    expect(evicted).toEqual(["a"])
    expect(residency.ids()).toEqual(["b"])
  })

  test("evicts sessions idle past the limit, but never a pinned one", () => {
    let now = 0
    const { residency, evicted } = membership({ capacity: 5, idleMs: 1_000, pinned: () => new Set(["a"]), now: () => now })
    residency.use("a", bundleOf("a"))
    residency.use("b", bundleOf("b"))
    now = 2_000
    residency.use("c", bundleOf("c"))
    expect(evicted).toEqual(["b"])
    expect(residency.ids()).toEqual(["a", "c"])
  })

  test("stretches capacity to the pinned count and evicts a pinned session only after every other one", () => {
    const { residency, evicted } = membership({ capacity: 1, pinned: () => new Set(["a", "b"]) })
    residency.use("a", bundleOf("a"))
    residency.use("c", bundleOf("c"))
    residency.use("b", bundleOf("b"))
    expect(evicted).toEqual(["c"])
    expect(residency.ids()).toEqual(["a", "b"])
  })

  test("evicts a session on request whatever retains it, and every session when disposed, after which it takes none", () => {
    const { residency, evicted } = membership({ capacity: 8 })
    residency.use("a", bundleOf("a"))
    residency.use("b", bundleOf("b"))
    residency.retain("a")
    residency.evict("a")
    residency.evict("missing")
    expect(evicted).toEqual(["a"])
    residency.dispose()
    expect(evicted).toEqual(["a", "b"])
    expect(residency.ids()).toEqual([])
    expect(() => residency.use("c", bundleOf("c"))).toThrow("disposed")
  })
})

/** What each resident's readers hear, through the lanes `use` hands them. */
function heardBy(residency: ReturnType<typeof createResidency<Bundle>>, ...ids: string[]) {
  const heard: { [sessionId: string]: string[] } = {}
  for (const id of ids) {
    const log: string[] = []
    heard[id] = log
    const { lanes } = residency.use(id, bundleOf(id))
    lanes.subscribe((event) => { log.push(event.type === "patch" ? event.patch.payload.kind : event.type) })
    lanes.onLane((lane) => { log.push(`lane ${lane}`) })
  }
  return heard
}

describe("residency dormancy", () => {
  test("after a lane break a hidden reader hears the break and nothing else, and showing it wakes it into the open lane once", () => {
    const source = lanesSource()
    const residency = createResidency<Bundle>({ capacity: 8, lanes: source.client, dormancy: true, onEvict: () => {} })
    const heard = heardBy(residency, "hidden", "shown")
    residency.retain("shown")
    expect(heard).toEqual({ hidden: ["lane 1"], shown: ["lane 1"] })

    source.emit(outputPatch("hidden", 1))
    source.breakLane()
    source.emit(outputPatch("hidden", 2))
    source.lanes.open()
    source.emit(outputPatch("hidden", 3))
    expect(heard.hidden).toEqual(["lane 1", "output.delta", "runtime.invalidate"])
    expect(heard.shown).toEqual(["lane 1", "output.delta", "runtime.invalidate", "output.delta", "lane 2", "output.delta"])

    residency.use("hidden", bundleOf("hidden"))
    expect(heard.hidden).toHaveLength(3)
    residency.retain("hidden")
    residency.retain("hidden")
    source.emit(outputPatch("hidden", 4))
    expect(heard.hidden).toEqual(["lane 1", "output.delta", "runtime.invalidate", "lane 2", "output.delta"])
  })

  test("a reader woken while no lane is open reads when the next lane opens", () => {
    const source = lanesSource()
    const residency = createResidency<Bundle>({ capacity: 8, lanes: source.client, dormancy: true, onEvict: () => {} })
    const heard = heardBy(residency, "s")
    source.breakLane()
    residency.retain("s")
    expect(heard.s).toEqual(["lane 1", "runtime.invalidate"])
    source.lanes.open()
    expect(heard.s).toEqual(["lane 1", "runtime.invalidate", "lane 2"])
  })

  test("while no lane is open, a session first made resident is awake and a session its last surface lets go sleeps", () => {
    const source = lanesSource()
    const residency = createResidency<Bundle>({ capacity: 8, lanes: source.client, dormancy: true, onEvict: () => {} })
    const shown = residency.retain("left")
    const heard = heardBy(residency, "left")
    source.breakLane()
    Object.assign(heard, heardBy(residency, "new"))
    shown.release()
    source.lanes.open()
    expect(heard.new).toEqual(["lane 2"])
    expect(heard.left).toEqual(["lane 1", "runtime.invalidate"])
  })

  test("waking hands each reader the latest rebase withheld for each cursor before the open lane", () => {
    const source = lanesSource()
    const residency = createResidency<Bundle>({ capacity: 8, lanes: source.client, dormancy: true, onEvict: () => {} })
    const heard: string[] = []
    const { lanes } = residency.use("s", bundleOf("s"))
    lanes.subscribe((event) => { if (event.type === "patch") heard.push(`${event.patch.payload.kind} ${event.patch.position}`) })
    lanes.onLane((lane) => { heard.push(`lane ${lane}`) })
    source.breakLane()
    source.lanes.open()
    source.emit(invalidation("s", 5, "overflow"))
    source.emit(invalidation("s", 6, "rebase"))
    source.emit(invalidation("s", 7, "rebase"))
    residency.retain("s")
    expect(heard).toEqual(["lane 1", "runtime.invalidate 0", "runtime.invalidate 7", "lane 2"])
  })

  test("awake residents are the shown ones and those that no lane break reached, and each change of that set is told once", () => {
    const source = lanesSource()
    const residency = createResidency<Bundle>({ capacity: 8, lanes: source.client, dormancy: true, onEvict: () => {} })
    let told = 0
    residency.onAwakeChange(() => { told += 1 })
    residency.use("hidden", bundleOf("hidden"))
    residency.use("shown", bundleOf("shown"))
    const shown = residency.retain("shown")
    expect(residency.awake()).toEqual(["hidden", "shown"])
    expect(told).toBe(0)

    source.breakLane()
    expect(residency.awake()).toEqual(["shown"])
    expect(told).toBe(1)
    source.breakLane()
    expect(told).toBe(1)

    const hidden = residency.retain("hidden")
    expect(residency.awake()).toEqual(["hidden", "shown"])
    expect(told).toBe(2)
    shown.release()
    expect(residency.awake()).toEqual(["hidden"])
    expect(told).toBe(3)

    source.lanes.open()
    hidden.release()
    expect(residency.awake()).toEqual(["hidden"])
    expect(told).toBe(3)
  })

  test("a residency without dormancy hands each bundle the connection's own lanes", () => {
    const source = lanesSource()
    const residency = createResidency<Bundle>({ capacity: 8, lanes: source.client, dormancy: false, onEvict: () => {} })
    const heard = heardBy(residency, "s")
    source.breakLane()
    source.lanes.open()
    expect(heard.s).toEqual(["lane 1", "runtime.invalidate", "lane 2"])
    expect(residency.awake()).toEqual(["s"])
  })
})

describe("resident readers", () => {
  test("after a lane break only the shown transcript reads; a hidden one keeps its window and merges the tail when shown", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }] })
    const residency = createResidency<TranscriptStore>({ capacity: 8, lanes: fake.connection, dormancy: true, onEvict: (store) => { store.dispose() } })
    const transcript = (sessionId: string) => (lanes: ResidentLanes) => createTranscriptStore({ connection: { query: fake.connection.query, watchOutput: fake.connection.watchOutput, ...lanes }, sessionId })
    const hidden = residency.use(SESSION, transcript(SESSION))
    residency.use("visible", transcript("visible"))
    residency.retain("visible")
    await settle()
    expect(fake.windowCalls).toBe(2)
    const kept = hidden.view.blocks
    const changes: string[] = []
    hidden.onChange((change) => { changes.push(change.kind === "window" ? `window ${change.reason}` : change.kind) })

    fake.reconnect()
    fake.publish({ type: "patch", patch: deltaPatch(101, 100, 1, textBlock("b")) })
    await settle()
    expect(fake.windowCalls).toBe(3)
    expect(hidden.view.blocks).toBe(kept)
    expect(hidden.status).toBe("ready")

    residency.retain(SESSION)
    await settle()
    expect(fake.windowCalls).toBe(4)
    // The break voids the live coverage the kept window proved; the window
    // itself changes only when the shown session merges the tail.
    expect(changes).toEqual(["status", "window merge"])
    expect(hidden.view.blocks).toEqual([textBlock("a")])
    residency.dispose()
  })

  test("a hidden transcript that is still awake follows its live output", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }] })
    const residency = createResidency<TranscriptStore>({ capacity: 8, lanes: fake.connection, dormancy: true, onEvict: (store) => { store.dispose() } })
    const hidden = residency.use(SESSION, (lanes) => createTranscriptStore({ connection: { query: fake.connection.query, watchOutput: fake.connection.watchOutput, ...lanes }, sessionId: SESSION }))
    residency.use("visible", (lanes) => createTranscriptStore({ connection: { query: fake.connection.query, watchOutput: fake.connection.watchOutput, ...lanes }, sessionId: "visible" }))
    residency.retain("visible")
    await settle()
    fake.publish({ type: "patch", patch: deltaPatch(101, 100, 1, textBlock("b")) })
    expect(hidden.view.blocks).toEqual([textBlock("a"), textBlock("b")])
    residency.dispose()
  })

  test("a hidden transcript whose coordinates were rebased while it slept replaces its window when shown", async () => {
    const kept = { blocks: "abcdefghij".split("").map((id) => textBlock(id)), startBlockIndex: 0, totalBlocks: 10, snapshotPosition: 100 }
    const rebased = { blocks: [textBlock("x"), textBlock("y")], startBlockIndex: 5, totalBlocks: 7, hasBefore: true, snapshotPosition: 300 }
    const fake = fakeConnection({ windows: [kept, rebased] })
    const residency = createResidency<TranscriptStore>({ capacity: 8, lanes: fake.connection, dormancy: true, onEvict: (store) => { store.dispose() } })
    const store = residency.use(SESSION, (lanes) => createTranscriptStore({ connection: { query: fake.connection.query, watchOutput: fake.connection.watchOutput, ...lanes }, sessionId: SESSION }))
    await settle()
    fake.reconnect()
    await settle()
    fake.publish(invalidation(SESSION, 250, "rebase"))
    await settle()
    expect(fake.windowCalls).toBe(1)

    residency.retain(SESSION)
    await settle()
    await settle()
    expect(fake.windowCalls).toBe(2)
    expect(store.view.blocks).toEqual([textBlock("x"), textBlock("y")])
    residency.dispose()
  })

  test("a dormant held view keeps its view and reads nothing on the next lane, then reads once when shown", async () => {
    const source = lanesSource()
    const residency = createResidency<HeldView<number>>({ capacity: 8, lanes: source.client, dormancy: true, onEvict: (held) => { held.dispose() } })
    let reads = 0
    const held = residency.use("s", (lanes) => createHeldView<number>({
      client: lanes,
      cursor: updatesCursor(),
      read: async () => ({ view: ++reads, position: 0 }),
      adopt: () => undefined,
      changed: () => {},
      label: "test view",
    }))
    await held.ready
    source.breakLane()
    source.lanes.open()
    await settle()
    expect(reads).toBe(1)
    expect(held.view).toBe(1)

    residency.retain("s")
    await settle()
    expect(reads).toBe(2)
    expect(held.view).toBe(2)
    residency.dispose()
  })
})
