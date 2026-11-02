import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { DebugLog, listDebugLogFiles, scanDebugLogFiles } from "../../../src/infra/debug-log.js"
import { Log } from "../../../src/infra/log.js"

const TMP_ROOT = path.join(os.tmpdir(), `flywheel-debug-log-test-${process.pid}`)
const roots = new Set<string>()

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID())
  roots.add(dir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Starts a sink with its file open. The sink opens its file at the first
 *  record that passes the tier check, and sweeps retention after that. */
async function openSink(options: Parameters<typeof DebugLog.init>[0]): Promise<void> {
  await DebugLog.init(options)
  DebugLog.record({ type: "startup.finished", payload: {} })
}

function jsonlFiles(baseDir: string): string[] {
  const logDir = path.join(baseDir, ".flywheel", "log")
  return fs
    .readdirSync(logDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(logDir, name))
}

afterEach(async () => {
  // Level and verbosity are process-global; restore the default so a DEBUG
  // case cannot leak into a later test. The stream opens only at a record
  // that passes its level, so this init writes nothing.
  await Log.init({ dir: makeTmpDir(), level: "INFO" })
  await DebugLog.close()
  DebugLog.setVerbose(false)
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  roots.clear()
})

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe("DebugLog sink and reader", () => {
  it.each([1, 2, 3, 7])("decodes complete records across %i-byte reads without losing UTF-8 or the final record", (chunkSize) => {
    const file = path.join(makeTmpDir(), "chunks.jsonl")
    const expected = [
      { ts: 1, type: "log.info", payload: { text: "é中\u{1D11E}\ninside" } },
      { ts: 2, type: "log.warn", payload: { text: "final" } },
    ]
    const text = ` \nmalformed\nnull\n{"ts":"wrong","type":42}\n${JSON.stringify(expected[0])}\r\n${JSON.stringify(expected[1])}`
    fs.writeFileSync(file, text)
    const originalRead = fs.readSync
    let acquiredBytes = 0
    let reads = 0
    const read = spyOn(fs, "readSync").mockImplementation((fd, buffer, offsetOrOptions, length?: number, position?: fs.ReadPosition | null) => {
      const options = typeof offsetOrOptions === "number" ? { offset: offsetOrOptions, length, position } : offsetOrOptions
      reads += 1
      const bytes = originalRead(fd, buffer, {
        ...options,
        length: Math.min(options?.length ?? buffer.byteLength - (options?.offset ?? 0), chunkSize),
      })
      acquiredBytes += bytes
      return bytes
    })
    try {
      expect([...scanDebugLogFiles([file])]).toEqual(expected)
      expect(acquiredBytes).toBe(Buffer.byteLength(text))
      expect(reads).toBe(Math.ceil(Buffer.byteLength(text) / chunkSize))
    } finally {
      read.mockRestore()
    }
  })

  it("bounds acquisition to chunks and assembly to one record even across a large UTF-8 boundary", () => {
    const file = path.join(makeTmpDir(), "large.jsonl")
    const prefix = '{"ts":1,"type":"log.info","payload":"'
    const long = `${prefix}${"x".repeat(65535 - prefix.length)}\u{1D11E}"}`
    const short = '{"ts":2,"type":"log.warn"}'
    fs.writeFileSync(file, `${long}\n${`${short}\n`.repeat(5000)}`)
    const originalRead = fs.readSync
    const originalJoin = Array.prototype.join
    let largestRead = 0
    let largestAssembly = 0
    let acquiredBytes = 0
    const read = spyOn(fs, "readSync").mockImplementation((fd, buffer, offsetOrOptions, length?: number, position?: fs.ReadPosition | null) => {
      const options = typeof offsetOrOptions === "number" ? { offset: offsetOrOptions, length, position } : offsetOrOptions
      const bytes = originalRead(fd, buffer, options)
      largestRead = Math.max(largestRead, bytes)
      acquiredBytes += bytes
      return bytes
    })
    const join = spyOn(Array.prototype, "join").mockImplementation(function (this: unknown[], separator) {
      const text = originalJoin.call(this, separator)
      largestAssembly = Math.max(largestAssembly, text.length)
      return text
    })
    try {
      let count = 0
      for (const record of scanDebugLogFiles([file])) {
        if (count === 0) expect(record.payload).toBe(`${"x".repeat(65535 - prefix.length)}\u{1D11E}`)
        count += 1
      }
      expect(count).toBe(5001)
      expect(largestRead).toBe(65536)
      expect(largestAssembly).toBe(long.length)
      expect(acquiredBytes).toBe(fs.statSync(file).size)
    } finally {
      read.mockRestore()
      join.mockRestore()
    }
  })

  it("closes a partially consumed scan and reads only the initial extent of each listed file", () => {
    const root = makeTmpDir()
    const file = path.join(root, "first.jsonl")
    const deleted = path.join(root, "deleted.jsonl")
    fs.writeFileSync(file, '{"ts":1,"type":"log.first"}\n{"ts":2,"type":"log.last"}')
    fs.writeFileSync(deleted, '{"ts":3,"type":"log.deleted"}')
    const scan = scanDebugLogFiles([file, deleted])
    expect(scan.next().value?.type).toBe("log.first")
    fs.appendFileSync(file, '\n{"ts":4,"type":"log.appended"}')
    fs.unlinkSync(deleted)
    expect([...scan].map((record) => record.type)).toEqual(["log.last"])

    const close = spyOn(fs, "closeSync")
    const partial = scanDebugLogFiles([file])
    try {
      expect(partial.next().value?.type).toBe("log.first")
      partial.return(undefined)
      expect(close).toHaveBeenCalledTimes(1)
      fs.renameSync(file, path.join(root, "renamed.jsonl"))
    } finally {
      partial.return(undefined)
      close.mockRestore()
    }
  })

  it("round-trips a record through sink and reader", async () => {
    const baseDir = makeTmpDir()
    await DebugLog.init({ dir: baseDir })

    DebugLog.record({
      sessionId: "session-a",
      type: "startup.finished",
      actor: "runner",
      payload: { model: "test-model", turn: 3 },
    })
    await DebugLog.close()

    const files = jsonlFiles(baseDir)
    expect(files).toHaveLength(1)
    const records = [...scanDebugLogFiles(files)]
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.sessionId).toBe("session-a")
    expect(record.type).toBe("startup.finished")
    expect(record.actor).toBe("runner")
    expect(record.payload).toEqual({ model: "test-model", turn: 3 })
    expect(typeof record.ts).toBe("number")
    expect(record.ts).toBeGreaterThan(0)
  })

  it("a record is in its file when record() returns", async () => {
    // A process kill, a SIGKILL during a synchronous stall among them, must
    // not lose a record the thread already wrote, so the read below awaits
    // nothing between the call and the file.
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir })

    Log.create({ service: "durable" }).warn("before a kill", { turn: 4 })

    const [file] = jsonlFiles(baseDir)
    const lines = fs.readFileSync(file ?? "", "utf8").split("\n").filter((line) => line !== "")
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { type: "log.warn", payload: { service: "durable", message: "before a kill", turn: 4 } },
    ])
  })

  it("drops a record whose file cannot open with one warning, and opens the file at a later record", async () => {
    const baseDir = makeTmpDir()
    await DebugLog.init({ dir: baseDir })
    const logDir = path.join(baseDir, ".flywheel", "log")
    fs.rmSync(logDir, { recursive: true })
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(() => DebugLog.record({ type: "startup.finished", payload: { order: 1 } })).not.toThrow()
      DebugLog.record({ type: "startup.finished", payload: { order: 2 } })
      fs.mkdirSync(logDir)
      DebugLog.record({ type: "startup.finished", payload: { order: 3 } })

      expect([...scanDebugLogFiles(jsonlFiles(baseDir))].map((record) => record.payload)).toEqual([{ order: 3 }])
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.startsWith("debug log write failed"))).toHaveLength(1)
    } finally {
      stderr.mockRestore()
    }
  })

  it("a write that fails after part of a line is written leaves every later record on a line of its own", async () => {
    const baseDir = makeTmpDir()
    await openSink({ dir: baseDir })
    const write = fs.writeSync
    let writes = 0
    // The disk fills after the first few bytes of the line. A record never
    // throws, so the spies are restored right after it.
    const failing = spyOn(fs, "writeSync").mockImplementation((fd: number, data: string | NodeJS.ArrayBufferView, offset?: number | null) => {
      if (++writes > 1 || typeof data === "string") throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })
      return write(fd, data, offset, 5)
    })
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    DebugLog.record({ type: "startup.finished", payload: { order: 1 } })
    failing.mockRestore()
    stderr.mockRestore()
    DebugLog.record({ type: "startup.finished", payload: { order: 2 } })

    expect([...scanDebugLogFiles(jsonlFiles(baseDir))].map((record) => record.payload)).toEqual(expect.arrayContaining([{}, { order: 2 }]))
  })

  it("skips a malformed line and still parses later valid lines", async () => {
    const baseDir = makeTmpDir()
    await DebugLog.init({ dir: baseDir })
    DebugLog.record({ sessionId: "session-a", type: "startup.finished" })
    await DebugLog.close()

    const [file] = jsonlFiles(baseDir)
    if (!file) throw new Error("expected a debug log file")
    fs.appendFileSync(file, 'not json at all\n{"ts":"wrong-shape","type":42}\n')
    fs.appendFileSync(file, `${JSON.stringify({ ts: 5, sessionId: "session-a", type: "later.record" })}\n`)

    const records = [...scanDebugLogFiles([file])]
    expect(records.map((r) => r.type)).toEqual(["startup.finished", "later.record"])
  })

  it("filters by sessionId and type", async () => {
    const baseDir = makeTmpDir()
    await DebugLog.init({ dir: baseDir })
    DebugLog.record({ sessionId: "session-a", type: "startup.finished" })
    DebugLog.record({ sessionId: "session-a", type: "agent.workflow_link.published" })
    DebugLog.record({ sessionId: "session-b", type: "startup.finished" })
    await DebugLog.close()

    const files = jsonlFiles(baseDir)

    const bySession = [...scanDebugLogFiles(files, { sessionId: "session-a" })]
    expect(bySession).toHaveLength(2)
    expect(bySession.every((r) => r.sessionId === "session-a")).toBe(true)

    const byType = [...scanDebugLogFiles(files, { types: ["startup.finished"] })]
    expect(byType).toHaveLength(2)
    expect(byType.every((r) => r.type === "startup.finished")).toBe(true)

    const byBoth = [...scanDebugLogFiles(files, { sessionId: "session-b", types: ["startup.finished"] })]
    expect(byBoth).toHaveLength(1)
    expect(byBoth[0]!.sessionId).toBe("session-b")
  })

  it("filters by time bounds", async () => {
    const baseDir = makeTmpDir()
    const file = path.join(baseDir, "manual.jsonl")
    const lines = [
      { ts: 100, type: "early.record" },
      { ts: 200, type: "middle.record" },
      { ts: 300, type: "late.record" },
    ]
    fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)

    const windowed = [...scanDebugLogFiles([file], { sinceTimestamp: 150, untilTimestamp: 250 })]
    expect(windowed.map((r) => r.type)).toEqual(["middle.record"])
  })

  it("yields nothing for a missing file", () => {
    const baseDir = makeTmpDir()
    const records = [...scanDebugLogFiles([path.join(baseDir, "absent.jsonl")])]
    expect(records).toEqual([])
  })

  it("drops records before init without throwing", () => {
    expect(() => DebugLog.record({ type: "orphan.record" })).not.toThrow()
  })
})

describe("unified Log and DebugLog stream", () => {
  it("lands a Log call and a record() fact in the same file, in write order", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir })

    Log.create({ service: "unified-test" }).info("stream check", { turn: 7 })
    DebugLog.record({ sessionId: "session-a", type: "startup.finished", payload: { model: "test-model" } })
    await Log.closeGlobal()

    const files = jsonlFiles(baseDir)
    expect(files).toHaveLength(1)
    const records = [...scanDebugLogFiles(files)]
    expect(records.map((r) => r.type)).toEqual(["log.info", "startup.finished"])
    expect(records[0]!.payload).toEqual({ service: "unified-test", message: "stream check", turn: 7 })
    expect(records[0]!.ts).toBeLessThanOrEqual(records[1]!.ts)
  })

  it("carries an error field as structured detail", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir })

    Log.create({ service: "unified-error" }).error("turn failed", { error: new Error("boom") })
    await Log.closeGlobal()

    const [record] = [...scanDebugLogFiles(jsonlFiles(baseDir), { types: ["log.error"] })]
    expect(record!.payload).toMatchObject({ message: "turn failed", error: { kind: "error", message: "boom" } })
  })

  it("gives each logger instance of one service its own context", async () => {
    // One service, two executor generations of two projects: the base logger
    // is shared, and each instance still says which generation wrote it.
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir })

    const first = Log.create({ service: "instance-context" }).with({ projectId: "project-a", generation: 1 })
    const second = Log.create({ service: "instance-context" }).with({ projectId: "project-b", generation: 2 })
    first.info("from the first")
    second.info("from the second", { turn: 3 })
    second.with({ channel: "state" }).warn("from a nested context")
    Log.create({ service: "instance-context" }).info("from the base")
    await Log.closeGlobal()

    const records = [...scanDebugLogFiles(jsonlFiles(baseDir))]
    expect(records.map((record) => record.payload)).toEqual([
      { service: "instance-context", message: "from the first", projectId: "project-a", generation: 1 },
      { service: "instance-context", message: "from the second", projectId: "project-b", generation: 2, turn: 3 },
      { service: "instance-context", message: "from a nested context", projectId: "project-b", generation: 2, channel: "state" },
      { service: "instance-context", message: "from the base" },
    ])
  })

  it("stamps the ambient session id on log records", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir })

    Log.runWithSession("session-z", () => {
      Log.create({ service: "unified-session" }).info("inside session")
    })
    await Log.closeGlobal()

    const records = [...scanDebugLogFiles(jsonlFiles(baseDir), { sessionId: "session-z" })]
    expect(records).toHaveLength(1)
    expect(records[0]!.type).toBe("log.info")
  })
})

describe("retention sweep", () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  // A pid above every platform's pid range names no running process. Names
  // carry the launch timestamp exactly as the sink writes it, with the date's
  // own dashes ahead of the pid.
  const deadPid = 4_000_000
  const otherDeadPid = 4_000_001

  function logDirOf(baseDir: string): string {
    const logDir = path.join(baseDir, ".flywheel", "log")
    fs.mkdirSync(logDir, { recursive: true })
    return logDir
  }

  function plant(logDir: string, name: string, ageMs: number, bytes = 0): string {
    fs.writeFileSync(path.join(logDir, name), "x".repeat(bytes))
    const mtime = new Date(Date.now() - ageMs)
    fs.utimesSync(path.join(logDir, name), mtime, mtime)
    return name
  }

  /** A name in the shape written before 2026-09-23, with no thread id. */
  function launchName(pid: number, index: number, tag = "run"): string {
    return `2026-01-01T0000${String(index).padStart(2, "0")}000Z-${pid}-${tag}${index}.jsonl`
  }

  /** A name in the current shape: the writer's thread id follows its pid. */
  function threadName(pid: number, thread: number, index: number): string {
    return `2026-01-01T0000${String(index).padStart(2, "0")}000Z-${pid}-${thread}-${crypto.randomUUID()}.jsonl`
  }

  it("names each file by the process and the thread that write it, after the launch timestamp", async () => {
    const baseDir = makeTmpDir()
    await openSink({ dir: baseDir })
    await DebugLog.close()

    const [name] = fs.readdirSync(logDirOf(baseDir))
    expect(name).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d+Z-${process.pid}-0-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jsonl$`))
  })

  it("never deletes the open file of any thread of a running process", async () => {
    // A Worker writes its own file beside its process's main thread. Sparing
    // only the newest file of the process let the sweep delete the other
    // thread's open file.
    const baseDir = makeTmpDir()
    const logDir = logDirOf(baseDir)
    const rolledAway = plant(logDir, threadName(process.pid, 5, 0), 3 * 60_000, 100)
    const workerOpen = plant(logDir, threadName(process.pid, 5, 1), 2 * 60_000, 100)
    const otherWorkerOpen = plant(logDir, threadName(process.pid, 6, 2), 60_000, 100)

    await openSink({ dir: baseDir, retentionBytes: 100 })
    await DebugLog.close()

    const remaining = fs.readdirSync(logDir)
    expect(remaining).toContain(workerOpen)
    expect(remaining).toContain(otherWorkerOpen)
    expect(remaining).not.toContain(rolledAway)
  })

  it("marks a crashed process's files of every thread", () => {
    const baseDir = makeTmpDir()
    const logDir = logDirOf(baseDir)
    const main = plant(logDir, threadName(deadPid, 0, 0), 0)
    const worker = plant(logDir, threadName(deadPid, 3, 1), 0)

    expect(DebugLog.markUnexpectedExit(logDir, deadPid)).toEqual([main, worker].map((name) => name.replace(/\.jsonl$/, ".unexpected-exit.jsonl")).sort())
  })

  it("runs the sweep after the new file opens, off the path that opens it", async () => {
    const baseDir = makeTmpDir()
    const logDir = logDirOf(baseDir)
    const expired = plant(logDir, launchName(deadPid, 0), 8 * DAY_MS)

    await openSink({ dir: baseDir })
    // Opening the file does not wait on the sweep; closing the sink does.
    expect(fs.readdirSync(logDir)).toContain(expired)
    await DebugLog.close()

    expect(fs.readdirSync(logDir)).not.toContain(expired)
  })

  it("keeps the directory under its file count, deleting the oldest ordinary files first", async () => {
    const baseDir = makeTmpDir()
    const logDir = logDirOf(baseDir)
    const crashed = plant(logDir, launchName(deadPid, 0, "crash"), 10 * 60_000, 10)
    const ordinary = [1, 2, 3, 4].map((index) => plant(logDir, launchName(otherDeadPid, index), (10 - index) * 60_000, 10))
    const marked = DebugLog.markUnexpectedExit(logDir, deadPid)
    expect(marked).toHaveLength(1)

    // Six files with the one this launch opens, and room for four.
    await openSink({ dir: baseDir, retentionFiles: 4 })
    await DebugLog.close()

    const remaining = fs.readdirSync(logDir)
    expect(remaining).toHaveLength(4)
    for (const name of marked) expect(remaining).toContain(name)
    expect(remaining).not.toContain(crashed)
    expect(remaining.filter((name) => ordinary.includes(name)).sort()).toEqual(ordinary.slice(2))
  })

  it("deletes .log files on sight and retired .jsonl files older than the age limit", async () => {
    const baseDir = makeTmpDir()
    const logDir = logDirOf(baseDir)
    plant(logDir, "20260101-stale.log", 0)
    const expired = plant(logDir, launchName(deadPid, 0), 8 * DAY_MS)
    const recent = plant(logDir, launchName(deadPid, 1), 6 * DAY_MS)

    await openSink({ dir: baseDir })
    await DebugLog.close()

    const remaining = fs.readdirSync(logDir)
    expect(remaining.filter((name) => name.endsWith(".log"))).toEqual([])
    expect(remaining).not.toContain(expired)
    expect(remaining).toContain(recent)
  })

  it("keeps any number of small retired files that fit the byte budget", async () => {
    // A crash-looping executor leaves one small file per launch. Counting
    // files lost them within a few restarts; a byte budget keeps them all.
    const baseDir = makeTmpDir()
    const logDir = logDirOf(baseDir)
    const planted = Array.from({ length: 40 }, (_, index) => plant(logDir, launchName(deadPid + index, index), DAY_MS, 100))

    await openSink({ dir: baseDir })
    await DebugLog.close()

    const remaining = fs.readdirSync(logDir)
    for (const name of planted) expect(remaining).toContain(name)
  })

  it("evicts the oldest retired files first once the directory exceeds its byte budget", async () => {
    const baseDir = makeTmpDir()
    const logDir = logDirOf(baseDir)
    const planted = [0, 1, 2, 3, 4].map((index) => plant(logDir, launchName(deadPid, index), (10 - index) * 60_000, 1_000))

    await openSink({ dir: baseDir, retentionBytes: 2_500 })
    await DebugLog.close()

    const remaining = fs.readdirSync(logDir).filter((name) => name.includes(`-${deadPid}-`)).sort()
    expect(remaining).toEqual(planted.slice(3))
  })

  it("spares the files of a process that exited unexpectedly while the budget has room for them", async () => {
    const baseDir = makeTmpDir()
    const logDir = logDirOf(baseDir)
    // The crashed executor's files are the oldest, and the budget holds only
    // two of the five: the ordinary files go first.
    const crashed = [0, 1].map((index) => plant(logDir, launchName(deadPid, index, "crash"), (10 - index) * 60_000, 1_000))
    const ordinary = [2, 3, 4].map((index) => plant(logDir, launchName(otherDeadPid, index), (10 - index) * 60_000, 1_000))

    const marked = DebugLog.markUnexpectedExit(logDir, deadPid)
    expect(marked).toHaveLength(2)
    await openSink({ dir: baseDir, retentionBytes: 2_500 })
    await DebugLog.close()

    const remaining = fs.readdirSync(logDir)
    expect(remaining.filter((name) => name.includes(`-${deadPid}-`)).sort()).toEqual([...marked].sort())
    for (const name of ordinary) expect(remaining).not.toContain(name)
    for (const name of crashed) expect(remaining).not.toContain(name)
  })

  it("lets marked files expire with age and yield to the budget, oldest first", async () => {
    const baseDir = makeTmpDir()
    const logDir = logDirOf(baseDir)
    plant(logDir, launchName(deadPid, 0), 8 * DAY_MS, 10)
    plant(logDir, launchName(deadPid, 1), 3 * 60_000, 1_000)
    plant(logDir, launchName(deadPid, 2), 2 * 60_000, 1_000)
    plant(logDir, launchName(deadPid, 3), 60_000, 1_000)
    const marked = DebugLog.markUnexpectedExit(logDir, deadPid).sort()

    await openSink({ dir: baseDir, retentionBytes: 2_500 })
    await DebugLog.close()

    const remaining = fs.readdirSync(logDir).filter((name) => name.includes(`-${deadPid}-`)).sort()
    expect(remaining).toEqual(marked.slice(2))
  })

  it("marks only the named process's files and keeps them readable by the search side", async () => {
    const baseDir = makeTmpDir()
    const logDir = logDirOf(baseDir)
    const record = `${JSON.stringify({ ts: 1, type: "log.error", payload: { service: "crashed" } })}\n`
    fs.writeFileSync(path.join(logDir, launchName(deadPid, 0)), record)
    const other = plant(logDir, launchName(otherDeadPid, 1), 0)

    const marked = DebugLog.markUnexpectedExit(logDir, deadPid)
    expect(DebugLog.markUnexpectedExit(logDir, deadPid)).toEqual(marked)

    expect(marked).toEqual([launchName(deadPid, 0).replace(/\.jsonl$/, ".unexpected-exit.jsonl")])
    expect(fs.readdirSync(logDir).sort()).toEqual([...marked, other].sort())
    expect([...scanDebugLogFiles(listDebugLogFiles(logDir))].map((entry) => entry.payload)).toEqual([{ service: "crashed" }])
  })
})

describe("retention sweep with a live writer", () => {
  // Feeds the name shape written before 2026-09-23. Remove after 2026-12-23
  // with the old-shape rule in logFileWriter.
  it("never deletes the file of a process that is still running, however old or large it is, in the name shape without a thread", async () => {
    const baseDir = makeTmpDir()
    const logDir = path.join(baseDir, ".flywheel", "log")
    fs.mkdirSync(logDir, { recursive: true })
    const live = `2026-01-01T000000000Z-${process.pid}-live.jsonl`
    fs.writeFileSync(path.join(logDir, live), "x".repeat(500))
    fs.utimesSync(path.join(logDir, live), new Date(2025, 0, 1), new Date(2025, 0, 1))

    await openSink({ dir: baseDir, retentionBytes: 100 })
    await DebugLog.close()

    expect(fs.readdirSync(logDir)).toContain(live)
  })

  it("counts the files a running process rolled away from, sparing only its newest", async () => {
    // A resident service rolls at the byte cap for as long as it lives. Its
    // rolled files are closed; exempting them let one process grow the
    // directory by a whole file per roll with no bound.
    const baseDir = makeTmpDir()
    const logDir = path.join(baseDir, ".flywheel", "log")
    fs.mkdirSync(logDir, { recursive: true })
    const rolled: string[] = []
    for (let i = 0; i < 5; i++) {
      // Successive roll timestamps, so the newest by name is the open file.
      const name = `2026-01-01T0000${String(i).padStart(2, "0")}000Z-${process.pid}-roll.jsonl`
      rolled.push(name)
      fs.writeFileSync(path.join(logDir, name), "x".repeat(1_000))
      const mtime = new Date(Date.now() - (10 - i) * 60_000)
      fs.utimesSync(path.join(logDir, name), mtime, mtime)
    }

    await openSink({ dir: baseDir, retentionBytes: 2_500 })
    await DebugLog.close()

    const kept = fs.readdirSync(logDir).filter((name) => name.endsWith("-roll.jsonl")).sort()
    // The open file counts toward the budget but is never evicted, so one
    // rolled-away file fits beside it.
    expect(kept).toEqual(rolled.slice(3))
  })
})

describe("DebugLog file size cap", () => {
  it("rolls to a new file once the open one reaches the byte cap", async () => {
    const baseDir = makeTmpDir()
    await DebugLog.init({ dir: baseDir, maxFileBytes: 2048 })

    for (let i = 0; i < 40; i += 1) {
      DebugLog.record({ type: "startup.finished", payload: { filler: "x".repeat(100), i } })
    }
    await DebugLog.close()

    const files = jsonlFiles(baseDir)
    expect(files.length).toBeGreaterThan(1)
    for (const file of files) {
      // The cap bounds a file, but the record that crosses it still lands whole,
      // so the last write may carry one line past the cap.
      expect(fs.statSync(file).size).toBeLessThan(2048 + 512)
    }
  })

  it("a roll keeps call order with no await", async () => {
    // One line is under the cap and two lines are over it, so the second
    // record rolls the file and the third opens the next one.
    const baseDir = makeTmpDir()
    await DebugLog.init({ dir: baseDir, maxFileBytes: 200 })

    for (const order of [1, 2, 3]) {
      DebugLog.record({ type: "startup.finished", payload: { order, filler: "y".repeat(50) } })
    }

    // Two files can share a launch millisecond in their names, so each file
    // is placed by what it holds: the rolled file holds two records.
    const held = jsonlFiles(baseDir)
      .map((file) => [...scanDebugLogFiles([file])].map((record) => record.payload))
      .sort((a, b) => b.length - a.length)
    expect(held).toEqual([
      [{ order: 1, filler: "y".repeat(50) }, { order: 2, filler: "y".repeat(50) }],
      [{ order: 3, filler: "y".repeat(50) }],
    ])
  })
})

describe("registry-driven verbosity", () => {
  it("drops a debug-tier family at the default level and keeps an info-tier one", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir, level: "INFO" })

    DebugLog.record({ type: "startup.finished", payload: { owner: "o1" } })
    DebugLog.record({ type: "model.stream.event_observed", payload: { requestId: "r1", sequence: 1 } })
    await DebugLog.close()

    const types = [...scanDebugLogFiles(jsonlFiles(baseDir))].map((r) => r.type)
    expect(types).toContain("startup.finished")
    expect(types).not.toContain("model.stream.event_observed")
  })

  it("writes a notable-tier record at the default level only when its producer marks it notable", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir, level: "INFO" })

    DebugLog.record({ type: "model.stream.completed", payload: { requestId: "fast", outcome: "ok" } })
    DebugLog.record({ type: "model.stream.completed", payload: { requestId: "failed", outcome: "error" }, notable: true })
    await DebugLog.close()

    const records = [...scanDebugLogFiles(jsonlFiles(baseDir))]
    expect(records.map((record) => record.payload)).toEqual([{ requestId: "failed", outcome: "error" }])
    // The mark routes the record; it is not part of what the file holds.
    expect(fs.readFileSync(jsonlFiles(baseDir)[0] ?? "", "utf8")).not.toContain("notable")
  })

  it("writes every notable-tier record once DEBUG turns the family on", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir, level: "DEBUG" })

    DebugLog.record({ type: "model.stream.completed", payload: { requestId: "fast", outcome: "ok" } })
    await DebugLog.close()

    expect([...scanDebugLogFiles(jsonlFiles(baseDir))].map((record) => record.type)).toEqual(["model.stream.completed"])
  })

  it("detaches its file before a new init closes it, so a record during the re-init never writes to a closed descriptor", async () => {
    const first = makeTmpDir()
    await Log.init({ dir: first, level: "INFO" })
    DebugLog.record({ type: "log.warn", payload: { message: "before the re-init" } })
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const reinit = DebugLog.init({ dir: makeTmpDir() })
      DebugLog.record({ type: "log.warn", payload: { message: "during the re-init" } })
      await reinit
      await DebugLog.close()
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes("debug log write failed"))).toEqual([])
    } finally {
      stderr.mockRestore()
    }
    const written = jsonlFiles(first).map((file) => fs.readFileSync(file, "utf8")).join("")
    expect(written).toContain("before the re-init")
    expect(written).not.toContain("during the re-init")
  })

  it("opens no file for a launch that records nothing at its level", async () => {
    // A short-lived process that writes nothing used to leave an empty file,
    // which counts toward the file ceiling and which every sweep and every
    // search reads.
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir, level: "INFO" })

    Log.create({ service: "quiet" }).debug("routine step")
    DebugLog.record({ type: "model.stream.event_observed", payload: { requestId: "r1", sequence: 1 } })
    await DebugLog.close()

    expect(jsonlFiles(baseDir)).toEqual([])
  })

  it("writes the debug-tier family once DEBUG turns it on", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir, level: "DEBUG" })

    DebugLog.record({ type: "model.stream.event_observed", payload: { requestId: "r1", sequence: 1 } })
    await DebugLog.close()

    const types = [...scanDebugLogFiles(jsonlFiles(baseDir))].map((r) => r.type)
    expect(types).toContain("model.stream.event_observed")
  })

  it("treats an undeclared family as debug so nothing is born loud", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir, level: "INFO" })

    DebugLog.record({ type: "some.family.nobody.declared", payload: { n: 1 } })
    await DebugLog.close()

    expect([...scanDebugLogFiles(jsonlFiles(baseDir))]).toHaveLength(0)
  })
})

describe("high volume reporting", () => {
  it("names an info-tier family that floods, once", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir, level: "INFO" })
    await DebugLog.init({ dir: baseDir, highVolumeRecords: 5 })

    for (let i = 0; i < 12; i += 1) {
      DebugLog.record({ type: "startup.finished", payload: { i } })
    }
    await DebugLog.close()

    const warnings = [...scanDebugLogFiles(jsonlFiles(baseDir))].filter((r) => r.type === "log.warn")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.payload).toMatchObject({
      message: "high volume diagnostic type at info tier",
      diagnosticType: "startup.finished",
      records: 5,
    })
  })

  it("stays quiet for a debug-tier family, which is voluminous by design", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir, level: "DEBUG" })
    await DebugLog.init({ dir: baseDir, highVolumeRecords: 5 })
    DebugLog.setVerbose(true)

    for (let i = 0; i < 12; i += 1) {
      DebugLog.record({ type: "model.stream.event_observed", payload: { i } })
    }
    await DebugLog.close()
    DebugLog.setVerbose(false)

    const warnings = [...scanDebugLogFiles(jsonlFiles(baseDir))].filter((r) => r.type === "log.warn")
    expect(warnings).toHaveLength(0)
  })
})
