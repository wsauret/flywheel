import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test"
import { POSIX_FILE_MODES } from "../../../helpers/posix-modes.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { DebugLog, listDebugLogFiles, resolveDebugLogDirectory, scanDebugLogFiles } from "../../../../src/infra/diagnostics/debug-log.js"
import { Log } from "../../../../src/infra/diagnostics/log.js"

const TMP_ROOT = path.join(os.tmpdir(), `flywheel-log-session-test-${process.pid}`)
const roots = new Set<string>()

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID())
  roots.add(dir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  await Log.closeGlobal()
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  roots.clear()
})

/** The records the log wrote under `baseDir`, as type and message. */
function written(baseDir: string): { readonly type: string; readonly message: unknown }[] {
  return [...scanDebugLogFiles(listDebugLogFiles(resolveDebugLogDirectory(baseDir)))].map((record) => ({
    type: record.type,
    message: typeof record.payload === "object" && record.payload !== null && "message" in record.payload ? record.payload.message : undefined,
  }))
}

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe("Log global sink", () => {
  it("delivers a record only when it passes the level and the realm has a destination", async () => {
    // The test preload suppresses this realm, so nothing is delivered until init.
    const stderr = spyOn(process.stderr, "write")
    try {
      Log.Default.warn("before init")
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir })
    Log.Default.warn("after init")
    Log.Default.debug("below the level")
    await Log.closeGlobal()

    expect(written(baseDir)).toEqual([{ type: "log.warn", message: "after init" }])
  })

  it("reads FLYWHEEL_LOG_LEVEL in any letter case and warns about a value that names no level", async () => {
    const configured = process.env.FLYWHEEL_LOG_LEVEL
    try {
      process.env.FLYWHEEL_LOG_LEVEL = " debug "
      const debugDir = makeTmpDir()
      await Log.init({ dir: debugDir })
      Log.Default.debug("at the configured level")
      await Log.closeGlobal()
      expect(written(debugDir)).toContainEqual({ type: "log.debug", message: "at the configured level" })

      const baseDir = makeTmpDir()
      process.env.FLYWHEEL_LOG_LEVEL = "verbose"
      await Log.init({ dir: baseDir, level: "INFO" })
      await Log.init({ dir: baseDir })
      Log.Default.debug("below the level that stays")
      await Log.closeGlobal()
      expect(written(baseDir)).toEqual([{ type: "log.warn", message: "FLYWHEEL_LOG_LEVEL is not a log level, so the level stays as it was" }])
      const records = [...scanDebugLogFiles(listDebugLogFiles(resolveDebugLogDirectory(baseDir)))]
      expect(records[0]!.payload).toMatchObject({ value: "verbose" })
    } finally {
      if (configured === undefined) delete process.env.FLYWHEEL_LOG_LEVEL
      else process.env.FLYWHEEL_LOG_LEVEL = configured
      await Log.init({ dir: makeTmpDir(), level: "INFO" })
    }
  })

  it("returns to the default level and writes no verbose family once the global log closes", async () => {
    await Log.init({ dir: makeTmpDir(), level: "DEBUG" })
    await Log.closeGlobal()
    // A sink opened without Log.init keeps the level that the realm has.
    const baseDir = makeTmpDir()
    await DebugLog.init({ dir: baseDir })
    Log.Default.debug("below the default level")
    DebugLog.record({ type: "model.stream.event_observed", payload: { requestId: "r1", sequence: 1 } })
    await DebugLog.close()
    expect(listDebugLogFiles(resolveDebugLogDirectory(baseDir))).toEqual([])
  })

  it("awaits pending global log writes when closing", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir })

    Log.create({ service: "global-log-close" }).error("final headless config error")
    await Log.closeGlobal()

    const logDir = path.join(baseDir, ".flywheel", "log")
    const files = fs.readdirSync(logDir).filter((file) => file.endsWith(".jsonl"))
    expect(files).toHaveLength(1)
    const records = [...scanDebugLogFiles([path.join(logDir, files[0]!)])]
    expect(records).toHaveLength(1)
    expect(records[0]!.type).toBe("log.error")
    expect(records[0]!.payload).toEqual({ service: "global-log-close", message: "final headless config error" })
  })

  it("creates private log directories and files", async () => {
    const baseDir = makeTmpDir()
    const logDir = path.join(baseDir, ".flywheel", "log")
    fs.mkdirSync(logDir, { recursive: true, mode: 0o755 })

    await Log.init({ dir: baseDir })
    Log.Default.info("private log")
    await Log.closeGlobal()

    const [file] = fs.readdirSync(logDir).filter((name) => name.endsWith(".jsonl"))
    if (!file) throw new Error("expected log file")
    if (POSIX_FILE_MODES) expect(fs.statSync(logDir).mode & 0o777).toBe(0o700)
    if (POSIX_FILE_MODES) expect(fs.statSync(path.join(logDir, file)).mode & 0o777).toBe(0o600)
  })

  it("does not create a global log directory in print mode", async () => {
    const baseDir = makeTmpDir()

    await Log.init({ dir: baseDir, print: true })
    Log.create({ service: "global-log-print" }).info("printed only")
    await Log.closeGlobal()

    expect(fs.existsSync(path.join(baseDir, ".flywheel", "log"))).toBe(false)
  })

  it("replaces a destination that opened during a re-init, as the account log opens for a record with no sink", async () => {
    const accountHome = makeTmpDir()
    const projectRoot = makeTmpDir()
    await Log.init({ dir: makeTmpDir() })
    const reinit = Log.init({ dir: projectRoot })
    DebugLog.openDirectory({ dir: accountHome })
    Log.Default.warn("during the re-init")
    await reinit
    Log.Default.warn("after the re-init")
    await Log.closeGlobal()

    const messages = (baseDir: string) => [...scanDebugLogFiles(listDebugLogFiles(resolveDebugLogDirectory(baseDir)))].map((record) => record.payload)
    expect(messages(accountHome)).toEqual([{ service: "default", message: "during the re-init" }])
    expect(messages(projectRoot)).toEqual([{ service: "default", message: "after the re-init" }])
  })
})
