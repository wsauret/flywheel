import { describe, expect, test } from "bun:test"
import { firstFrameMs, newChatReadyMs, parseBootTrace, phaseElapsedMs, remoteQuestions, sessionListReadyMs } from "../../release/lib/boot-trace.js"
import { observeReleaseMemoryPhase, startReleaseMemorySampler, type ReleaseMemoryEvidence } from "../../../src/infra/startup-trace.js"
import { writeFileSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { temporaryDirectories } from "../../helpers/directories.js"
import { startRetainedHeapSampler } from "../../release/lib/retained-heap.js"

const temporaryDirectory = temporaryDirectories()

test("release retained heap collects the executor, not its supervisor, before reading memory without a snapshot", async () => {
  const directory = temporaryDirectory("heap-")
  const markerPath = join(directory, "active-process-tree.txt")
  const socketPath = join(directory, "heap.sock")
  const sampler = startRetainedHeapSampler({ socketPath, markerPath })
  const identities = [
    { pid: 17, argv: ["binary", "--internal-role=project-executor"] },
    { pid: 18, argv: ["binary", "--internal-role=command-supervisor", "--", "--internal-role=project-executor"] },
  ]
  const methods: string[][] = identities.map(() => [])
  let identified = 0
  let resolveSample!: () => void
  const sampled = new Promise<void>(resolve => { resolveSample = resolve })
  const peers = await Promise.all(identities.map((identity, index) => Bun.connect<{ buffer: Buffer }>({
    unix: socketPath,
    socket: {
      open(socket) { socket.data = { buffer: Buffer.alloc(0) } },
      data(socket, bytes) {
        socket.data.buffer = Buffer.concat([socket.data.buffer, bytes])
        while (socket.data.buffer.length >= 4) {
          const length = socket.data.buffer.readUInt32BE(0)
          if (socket.data.buffer.length < length + 4) break
          const message: { id: number; method: string; params: { expression?: string } } = JSON.parse(socket.data.buffer.subarray(4, length + 4).toString())
          socket.data.buffer = socket.data.buffer.subarray(length + 4)
          methods[index]!.push(message.method)
          const value: string | undefined = message.params.expression === undefined ? undefined : runInNewContext(message.params.expression, {
            process: { ...identity, memoryUsage: () => ({ heapUsed: 1024, rss: 2048 }) },
          })
          const body = Buffer.from(JSON.stringify({
            id: message.id, result: message.method === "Heap.gc" ? {} : { result: { value } },
          }))
          const header = Buffer.alloc(4)
          header.writeUInt32BE(body.length)
          socket.write(Buffer.concat([header, body]))
          if (methods[index]!.length === 1 && ++identified === identities.length) {
            writeFileSync(markerPath, "")
            const midpoint = new Date(Date.now() - 22_500)
            utimesSync(markerPath, midpoint, midpoint)
          }
          if (methods[index]!.length === 3) resolveSample()
        }
      },
    },
  })))
  try {
    await sampled
    const sample = await sampler.read()
    expect(methods).toEqual([["Runtime.evaluate", "Heap.gc", "Runtime.evaluate"], ["Runtime.evaluate"]])
    expect(sample).toMatchObject({ pid: 17, heapUsed: 1024, rss: 2048 })
    expect(sample.timestampMs).toBeGreaterThanOrEqual(sample.gcStartedAtMs)
  } finally { for (const peer of peers) peer.end(); sampler.dispose() }
})

describe("release memory observations", () => {
  test("ordinary launches install no timer and write no evidence", () => {
    const schedule = () => { throw new Error("unexpected timer") }
    expect(startReleaseMemorySampler({ role: "project-executor", environment: {}, schedule })).toBeUndefined()
  })

  test("retains bounded finite observations and flushes once after disposing the timer", () => {
    let tick: (() => void) | undefined
    let cleared = false
    let now = 100
    const evidence: ReleaseMemoryEvidence[] = []
    const sampler = startReleaseMemorySampler({
      role: "project-executor", pid: 17,
      environment: { FLYWHEEL_RELEASE_MEMORY_DIRECTORY: "/scratch", FLYWHEEL_RELEASE_MEMORY_RUN: "run" },
      capacity: 2, now: () => now++,
      memory: () => ({ heapUsed: 1024, rss: 2048 }),
      schedule: (observe, cadence) => {
        expect(cadence).toBe(100)
        tick = observe
        return () => { cleared = true }
      },
      sink: (_path, value) => { expect(cleared).toBe(true); evidence.push(value) },
    })
    tick!()
    tick!()
    tick!()
    expect(evidence).toEqual([])
    sampler!.dispose()
    sampler!.dispose()
    tick!()
    expect(evidence).toEqual([{
      runId: "run", role: "project-executor", pid: 17, cadenceMs: 100,
      samples: [
        { timestampMs: 102, heapUsed: 1024, rss: 2048 },
        { timestampMs: 103, heapUsed: 1024, rss: 2048 },
      ],
    }])
    expect(evidence[0]!.samples.every((sample) => Object.values(sample).every(Number.isFinite))).toBe(true)
  })

  test("retains synchronous phase peaks even when timed observations wrap", () => {
    let heapUsed = 100
    let evidence: ReleaseMemoryEvidence | undefined
    const sampler = startReleaseMemorySampler({
      role: "project-state", pid: 23, capacity: 1,
      environment: { FLYWHEEL_RELEASE_MEMORY_DIRECTORY: "/scratch", FLYWHEEL_RELEASE_MEMORY_RUN: "upgrade" },
      memory: () => ({ heapUsed, rss: heapUsed * 2 }),
      schedule: () => () => {},
      sink: (_path, value) => { evidence = value },
    })!
    heapUsed = 900
    observeReleaseMemoryPhase("conversion.end")
    heapUsed = 200
    observeReleaseMemoryPhase("workspace.end")
    sampler.dispose()
    expect(evidence!.samples.filter(sample => sample.phase).map(sample => [sample.phase, sample.heapUsed])).toEqual([
      ["conversion.end", 900], ["workspace.end", 200],
    ])
    observeReleaseMemoryPhase("after.dispose")
    expect(evidence!.samples).toHaveLength(3)
  })
})

describe("parseBootTrace", () => {
  test("parses boot lines and ignores everything else", () => {
    const stderr = [
      "[boot +29ms] cli main",
      "some stray warning",
      "[boot +709ms] opentui first frame",
      "[boot +1055ms] chat input mode ready",
      "",
    ].join("\n")
    const phases = parseBootTrace(stderr)
    expect(phases).toEqual([
      { elapsedMs: 29, label: "cli main" },
      { elapsedMs: 709, label: "opentui first frame" },
      { elapsedMs: 1055, label: "chat input mode ready" },
    ])
  })

  test("first occurrence wins when two processes share a label space", () => {
    // The runtime worker interleaves its own [boot ...] lines on the same
    // stderr; a repeated label must resolve to the first (TUI-side) value.
    const phases = parseBootTrace("[boot +100ms] ready\n[boot +5ms] ready")
    expect(phaseElapsedMs(phases, "ready")).toBe(100)
  })

  test("missing phase answers undefined", () => {
    expect(phaseElapsedMs(parseBootTrace(""), "opentui first frame")).toBeUndefined()
  })
})

describe("firstFrameMs", () => {
  test("both roles read the content frame, not an earlier blank renderer frame", () => {
    const phases = parseBootTrace("[boot +150ms] opentui first frame\n[boot +340ms] content frame")
    expect(firstFrameMs(phases, "candidate")).toEqual({ kind: "ready", elapsedMs: 340 })
    expect(firstFrameMs(phases, "baseline")).toEqual({ kind: "ready", elapsedMs: 340 })
  })

  test("the candidate must report the content frame; a baseline that predates it reports the renderer frame", () => {
    const phases = parseBootTrace("[boot +450ms] opentui first frame")
    expect(firstFrameMs(phases, "candidate")).toEqual({ kind: "missing", phase: "content frame" })
    expect(firstFrameMs(phases, "baseline")).toEqual({ kind: "ready", elapsedMs: 450 })
    expect(firstFrameMs([], "baseline")).toEqual({ kind: "missing", phase: "content frame" })
  })
})

describe("newChatReadyMs", () => {
  const inputReady = "[boot +900ms] chat input mode ready"

  test("a welcome card that lags the prompt decides readiness", () => {
    const phases = parseBootTrace(`${inputReady}\n[boot +30000ms] session intro visible`)
    expect(newChatReadyMs(phases, "candidate")).toEqual({ kind: "ready", elapsedMs: 30000 })
    expect(newChatReadyMs(phases, "baseline")).toEqual({ kind: "ready", elapsedMs: 30000 })
  })

  test("a prompt that lags the welcome card decides readiness", () => {
    const phases = parseBootTrace(`[boot +700ms] session intro visible\n${inputReady}`)
    expect(newChatReadyMs(phases, "candidate")).toEqual({ kind: "ready", elapsedMs: 900 })
  })

  test("the candidate must report the welcome card; a baseline that predates the phase reports input readiness", () => {
    const phases = parseBootTrace(inputReady)
    expect(newChatReadyMs(phases, "candidate")).toEqual({ kind: "missing", phase: "session intro visible" })
    expect(newChatReadyMs(phases, "baseline")).toEqual({ kind: "ready", elapsedMs: 900 })
  })

  test("no role reads readiness without chat input mode", () => {
    const phases = parseBootTrace("[boot +700ms] session intro visible")
    expect(newChatReadyMs(phases, "candidate")).toEqual({ kind: "missing", phase: "chat input mode ready" })
    expect(newChatReadyMs(phases, "baseline")).toEqual({ kind: "missing", phase: "chat input mode ready" })
  })
})

describe("sessionListReadyMs", () => {
  test("reads complete catalog hydration for both measurement roles", () => {
    const phases = parseBootTrace("[boot +3100ms] session list ready")
    expect(sessionListReadyMs(phases, "candidate")).toEqual({ kind: "ready", elapsedMs: 3100 })
    expect(sessionListReadyMs(phases, "baseline")).toEqual({ kind: "ready", elapsedMs: 3100 })
  })

  test("requires the candidate phase and marks an older baseline unavailable", () => {
    expect(sessionListReadyMs([], "candidate")).toEqual({ kind: "missing", phase: "session list ready" })
    expect(sessionListReadyMs([], "baseline")).toEqual({ kind: "unavailable" })
  })
})

describe("remoteQuestions", () => {
  test("sums the answer time of every picker question and keeps when the first one showed", () => {
    const phases = parseBootTrace([
      "[boot +400ms] remote project question shown",
      "[boot +2400ms] remote project question answered",
      "[boot +2500ms] remote project question shown",
      "[boot +3000ms] remote project question answered",
      "[boot +3600ms] opentui first frame",
    ].join("\n"))
    expect(remoteQuestions(phases)).toEqual({ kind: "answered", firstShownMs: 400, answerWaitMs: 2500 })
  })

  test("a launch that asked nothing, or left a question open, reads no answer time", () => {
    expect(remoteQuestions(parseBootTrace("[boot +3600ms] opentui first frame"))).toEqual({ kind: "missing", phase: "remote project question shown" })
    expect(remoteQuestions(parseBootTrace("[boot +400ms] remote project question shown"))).toEqual({ kind: "missing", phase: "remote project question answered" })
  })
})
