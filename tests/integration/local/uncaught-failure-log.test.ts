import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { scanDebugLogFiles, type DebugLogRecord } from "../../../src/infra/debug-log.js"
import { accountServeStartRecordPath } from "../../../src/infra/paths.js"

const LOG_MODULE = new URL("../../../src/infra/log.ts", import.meta.url).href
const POLICY_MODULE = new URL("../../../src/infra/crash-policy.ts", import.meta.url).href
const FATAL_EXIT_MODULE = new URL("../../../src/cli/fatal-exit.ts", import.meta.url).href
const SERVICE_START_MODULE = new URL("../../../src/orchestration/update/service-start.ts", import.meta.url).href
const PLACED_BUILD_MODULE = new URL("../../helpers/placed-build.ts", import.meta.url).href

/** A log record's fields, for reading them in an assertion. */
function fieldsOf(record: DebugLogRecord | undefined): { readonly [key: string]: unknown } {
  const payload = record?.payload
  return typeof payload === "object" && payload !== null ? { ...payload } : {}
}

/** The redacted detail a record carries, for reading its stack. */
function detailOf(record: DebugLogRecord | undefined): { readonly [key: string]: unknown } {
  const detail = fieldsOf(record).errorDetail
  return typeof detail === "object" && detail !== null ? { ...detail } : {}
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Keeps a failing process alive, so that only its crash policy can end it. */
const KEEP_ALIVE = `setTimeout(() => {}, 5_000)`

/** Runs a process that installs a project executor's crash policy over a file
 *  log and then runs `body`, and returns its exit status and its WARN and
 *  ERROR records. */
async function policedProcess(body: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-uncaught-"))
  roots.push(dir)
  const source = [
    `import { Log } from ${JSON.stringify(LOG_MODULE)}`,
    `import { installCrashPolicy, recordFatal } from ${JSON.stringify(POLICY_MODULE)}`,
    `await Log.init({ dir: ${JSON.stringify(dir)}, level: "INFO" })`,
    `const log = Log.create({ service: "failing-process" })`,
    `installCrashPolicy({ role: "project-executor", log, fatal: (error, kind) => { recordFatal(log, kind, error); return Log.closeGlobal().finally(() => process.exit(1)) } })`,
    ...body,
  ].join("\n")
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "ignore", stderr: "ignore", windowsHide: true })
  const code = await child.exited
  const logDir = join(dir, ".flywheel", "log")
  const records = [...scanDebugLogFiles(readdirSync(logDir).map((file) => join(logDir, file)), { types: ["log.warn", "log.error"] })]
  return { code, records }
}

test("a floating abort is contained: the process keeps running and records one WARN", async () => {
  const { code, records } = await policedProcess([
    `const controller = new AbortController()`,
    `controller.abort()`,
    `void Promise.reject(controller.signal.reason)`,
    `setTimeout(() => process.exit(0), 50)`,
  ])
  expect(code).toBe(0)
  expect(records.map((record) => record.type)).toEqual(["log.warn"])
  expect(fieldsOf(records[0])).toMatchObject({ message: "project-executor abort rejection contained" })
})

test("an uncaught exception is written to the file log and still ends the process", async () => {
  const { code, records } = await policedProcess([`setTimeout(() => { throw new Error("executor exploded") }, 1)`, KEEP_ALIVE])
  expect(code).toBe(1)
  expect(records).toHaveLength(1)
  expect(fieldsOf(records[0])).toMatchObject({ message: "uncaught exception", error: "executor exploded" })
  expect(String(detailOf(records[0]).stack)).toContain("executor exploded")
})

test("any other floating rejection ends the process with one ERROR whose stack is redacted", async () => {
  // Built at run time, so that no credential-shaped literal is in the source.
  const secret = `sk-${"a".repeat(48)}`
  const { code, records } = await policedProcess([`void Promise.reject(new Error(${JSON.stringify(`request lost with ${secret}`)}))`, KEEP_ALIVE])
  expect(code).toBe(1)
  expect(records).toHaveLength(1)
  expect(fieldsOf(records[0])).toMatchObject({ message: "unhandled rejection", error: "request lost with [redacted secret]" })
  const stack = String(detailOf(records[0]).stack)
  expect(stack).toContain("request lost with [redacted secret]")
  expect(stack).not.toContain(secret)
})

/** Runs a start of the installed account service before its listen: it opens
 *  the account log in a temporary account home, counts itself as a start of a
 *  build placed in that account, installs the account's crash policy, and then
 *  runs `body`. A case can seed the lane's failing streak before the start.
 *  Returns its exit status, its standard error, its WARN and ERROR records,
 *  and the account's start record. */
async function accountStart(body: readonly string[], failing?: { readonly [key: string]: unknown }) {
  const accountHome = mkdtempSync(join(tmpdir(), "flywheel-uncaught-account-"))
  roots.push(accountHome)
  const userDataRoot = join(accountHome, ".flywheel")
  if (failing !== undefined) {
    const recordPath = accountServeStartRecordPath(userDataRoot)
    mkdirSync(dirname(recordPath), { recursive: true })
    writeFileSync(recordPath, JSON.stringify({ version: 1, failing }))
  }
  const source = [
    `import { Log } from ${JSON.stringify(LOG_MODULE)}`,
    `import { installAccountCrashPolicy } from ${JSON.stringify(FATAL_EXIT_MODULE)}`,
    `import { admitServiceStart } from ${JSON.stringify(SERVICE_START_MODULE)}`,
    `import { placeBuild } from ${JSON.stringify(PLACED_BUILD_MODULE)}`,
    `await Log.init({ dir: ${JSON.stringify(accountHome)}, level: "INFO" })`,
    `const execPath = placeBuild(${JSON.stringify(userDataRoot)}, { version: "1.4.0", buildId: "b".repeat(64) })`,
    `if (await admitServiceStart({ userDataRoot: ${JSON.stringify(userDataRoot)}, execPath, nowMs: Date.now() }) !== "serve") process.exit(9)`,
    `installAccountCrashPolicy()`,
    ...body,
  ].join("\n")
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "ignore", stderr: "pipe", windowsHide: true })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  const logDir = join(userDataRoot, "log")
  const records = [...scanDebugLogFiles(readdirSync(logDir).map((file) => join(logDir, file)), { types: ["log.warn", "log.error"] })]
  const startRecord: { readonly failing?: { readonly [key: string]: unknown } } = JSON.parse(readFileSync(accountServeStartRecordPath(userDataRoot), "utf8"))
  return { code, stderr, records, startRecord }
}

describe("the account service before its listen", () => {
  test("ends at an uncaught exception through the entry's fatal path: one fatal ERROR, one line on stderr, and the lane's failing streak", async () => {
    const { code, stderr, records, startRecord } = await accountStart([`setTimeout(() => { throw new Error("account exploded") }, 1)`, KEEP_ALIVE])
    expect(code).toBe(1)
    expect(stderr).toBe("flywheel: fatal uncaught exception: account exploded\n")
    expect(records).toHaveLength(1)
    expect(fieldsOf(records[0])).toMatchObject({ message: "fatal", kind: "uncaught exception", error: "account exploded" })
    expect(String(detailOf(records[0]).stack)).toContain("account exploded")
    expect(startRecord.failing).toMatchObject({ starts: 1, cause: "account exploded", causeKind: "thrown" })
  })

  // Two floating rejections in one tick: the second arrives while the first
  // one's fatal path waits for the modules that decide its streak.
  const TWO_REJECTIONS = `setTimeout(() => { void Promise.reject(new Error("store lost")); void Promise.reject(new Error("follow-on")) }, 1)`

  test("ends at the first of two floating rejections in one tick: one fatal ERROR, and the lane's failing streak", async () => {
    const { code, stderr, records, startRecord } = await accountStart([TWO_REJECTIONS, KEEP_ALIVE])
    expect(code).toBe(1)
    expect(stderr).toBe("flywheel: fatal unhandled rejection: store lost\n")
    expect(records.map((record) => fieldsOf(record).message)).toEqual(["fatal"])
    expect(fieldsOf(records[0])).toMatchObject({ kind: "unhandled rejection", error: "store lost" })
    expect(startRecord.failing).toMatchObject({ starts: 1, cause: "store lost", causeKind: "thrown" })
  })

  test("parks at the first of two floating rejections in one tick when the lane's streak persists, and exits 0 so its manager stops", async () => {
    const now = Date.now()
    const { code, startRecord } = await accountStart([TWO_REJECTIONS, KEEP_ALIVE], { since: now - 180_000, lastAt: now - 5_000, starts: 5, cause: "an earlier failure", causeKind: "thrown" })
    expect(code).toBe(0)
    expect(startRecord.failing).toMatchObject({ starts: 6, cause: "store lost", causeKind: "thrown", parked: { starts: 1 } })
  })

  test("contains a floating abort: the start keeps running, records one WARN, and adds nothing to the streak", async () => {
    const { code, records, startRecord } = await accountStart([
      `const controller = new AbortController()`,
      `controller.abort()`,
      `void Promise.reject(controller.signal.reason)`,
      `setTimeout(() => process.exit(0), 50)`,
    ])
    expect(code).toBe(0)
    expect(records.map((record) => record.type)).toEqual(["log.warn"])
    expect(fieldsOf(records[0])).toMatchObject({ message: "account-service abort rejection contained" })
    expect(startRecord.failing).toBeUndefined()
  })
})
