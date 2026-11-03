import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import { DebugLog, type DebugLogRecordInput } from "../../../../../src/infra/debug-log.js"
import { bugReportsModule } from "../../../../../src/orchestration/modules/bug-reports/module.js"
import { bugReportsService, createBugReportsService } from "../../../../../src/orchestration/modules/bug-reports/service.js"
import { BugReportSchema, type BugReportInput } from "../../../../../src/protocol/modules/bug-reports.js"
import { composeAccountModuleProtocolRuntimes } from "../../../../../src/orchestration/app-service/module-protocol-host.js"
import { createRuntimeFaultReporting } from "../../../../../src/orchestration/app-service/runtime-fault-reporting.js"
import type { RuntimeExecutorState } from "../../../../../src/protocol/app-service-types.js"

const temporary = temporaryDirectories()
const input: BugReportInput = { kind: "crash", error: { name: "TypeError", message: "undefined is not an object", stack: "TypeError\n at render" }, surface: "tui", sessionId: "s1", note: "It stopped while scrolling." }
const fakeFetch = (run: (request: Request) => Promise<Response>): typeof fetch => Object.assign(
  async (url: string | URL | Request, init?: RequestInit) => run(new Request(url, init)),
  { preconnect() {} },
)

// The report endpoint is a compile-time define in a built binary; a source run reads it from the environment.
const ENDPOINT = "https://reports.example/reports"
interface ReportEnvironment { readonly FLYWHEEL_REPORT_ENDPOINT?: string; readonly FLYWHEEL_INTERNAL_RELEASE_HARNESS?: string }
const reportEnvironment: ReportEnvironment = { FLYWHEEL_REPORT_ENDPOINT: process.env.FLYWHEEL_REPORT_ENDPOINT, FLYWHEEL_INTERNAL_RELEASE_HARNESS: process.env.FLYWHEEL_INTERNAL_RELEASE_HARNESS }
const setReportEnvironment = ({ FLYWHEEL_REPORT_ENDPOINT, FLYWHEEL_INTERNAL_RELEASE_HARNESS }: ReportEnvironment) => {
  if (FLYWHEEL_REPORT_ENDPOINT === undefined) delete process.env.FLYWHEEL_REPORT_ENDPOINT
  else process.env.FLYWHEEL_REPORT_ENDPOINT = FLYWHEEL_REPORT_ENDPOINT
  if (FLYWHEEL_INTERNAL_RELEASE_HARNESS === undefined) delete process.env.FLYWHEEL_INTERNAL_RELEASE_HARNESS
  else process.env.FLYWHEEL_INTERNAL_RELEASE_HARNESS = FLYWHEEL_INTERNAL_RELEASE_HARNESS
}
/** Collects the records the bug-reports service logs from now until `DebugLog.close()`. The debug log is process-global, so the
 *  sink also receives a record from any other work that still runs in the test process, such as work an earlier test file left. */
const captureServiceRecords = async (): Promise<DebugLogRecordInput[]> => {
  const records: DebugLogRecordInput[] = []
  await DebugLog.forward((record) => {
    const { payload } = record
    if (typeof payload === "object" && payload !== null && "service" in payload && payload.service === "bug-reports") records.push(record)
  })
  return records
}
beforeEach(() => { setReportEnvironment({ FLYWHEEL_REPORT_ENDPOINT: ENDPOINT }) })
afterEach(() => { setReportEnvironment(reportEnvironment) })

describe("account bug reports", () => {
  test.each(["manual", "crash"] as const)("the %s protocol mutation assembles three bounded metadata streams and sends the relay envelope", async (kind) => {
    const root = temporary("bug-reports-")
    const projectRoot = join(root, "project")
    const userDataRoot = join(root, "account")
    const projectLog = join(projectRoot, ".flywheel", "log")
    const accountLog = join(userDataRoot, "log")
    await Promise.all([mkdir(projectLog, { recursive: true }), mkdir(accountLog, { recursive: true })])
    const makeRecord = (serviceName: string, type: string, ts: number, extra = {}) => JSON.stringify({ ts, type, sessionId: "s1", payload: { service: serviceName, count: 4, message: "private conversation", output: "private file", ...extra } })
    await writeFile(join(projectLog, "01.jsonl"), `${makeRecord("tui-renderer", "log.error", 1)}\n${makeRecord("tui-renderer", "log.debug", 2)}\n{partial`)
    await writeFile(join(projectLog, "02.jsonl"), `${makeRecord("executor", "log.warn", 3)}\n${makeRecord("executor", "log.info", 4, { durationMs: 300, slowMs: 100 })}\n`)
    await writeFile(join(accountLog, "03.jsonl"), `${makeRecord("account", "log.error", 5)}\n`)
    const requests: Request[] = []
    const logs = await captureServiceRecords()
    const service = createBugReportsService({ projectRoot, userDataRoot, enabled: () => true, fetch: fakeFetch(async (request) => { requests.push(request); return Response.json({ reportId: "42" }) }) })
    const protocol = composeAccountModuleProtocolRuntimes([bugReportsModule], {
      modules: composeModuleServices([[bugReportsService.moduleId, service]]),
      publish: () => undefined, snapshotPosition: () => 0,
    }, () => ["bug-reports"])
    try {
      expect(await protocol.mutate({ type: "bugReport.submit", kind, error: input.error, surface: input.surface, sessionId: "s1", note: input.note })).toEqual({ ok: true, reportId: "42" })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe(ENDPOINT)
      const report = Schema.decodeUnknownSync(BugReportSchema)(await requests[0]!.json())
      expect(report.kind).toBe(kind)
      expect(report.error).toEqual(input.error)
      expect(report.note).toBe(input.note)
      expect(report.diagnostics.tui).toEqual([{ ts: 1, type: "log.error", sessionId: "s1", payload: { service: "tui-renderer", count: 4 } }])
      expect(report.diagnostics.executor.map((record) => record.ts)).toEqual([3, 4])
      expect(report.diagnostics.account).toHaveLength(1)
      expect(JSON.stringify(report)).not.toContain("private")
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({ type: "log.info", payload: { service: "bug-reports", message: "bug report sent", reportId: "42" } })
    } finally { protocol.dispose(); await service.dispose(); await DebugLog.close() }
  })

  test("oversized errors and log tails stay within the relay cap and secrets never leave", async () => {
    const userDataRoot = temporary("bug-reports-bound-")
    const logDir = join(userDataRoot, "log")
    await mkdir(logDir)
    await writeFile(join(logDir, "01.jsonl"), `${"old".repeat(40_000)}\n${Array.from({ length: 500 }, (_, ts) => JSON.stringify({
      ts, type: "log.error", sessionId: `Bearer ${"D".repeat(250)}`,
      payload: { service: `Bearer ${"E".repeat(250)}`, generation: `Bearer ${"F".repeat(250)}`, count: ts },
    })).join("\n")}\n`)
    let body = ""
    const service = createBugReportsService({ userDataRoot, enabled: () => true, fetch: fakeFetch(async (request) => { body = await request.text(); return Response.json({ reportId: "43" }) }) })
    try {
      const result = await service.submit({ ...input, error: { name: "Error", message: `Bearer ${"A".repeat(50)}`, stack: "\0".repeat(100_000) } })
      expect(result).toEqual({ ok: true, reportId: "43" })
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(48_000)
      expect(body).not.toContain("A".repeat(50))
      const report = Schema.decodeUnknownSync(BugReportSchema)(JSON.parse(body))
      expect(report.diagnostics.account.length).toBeLessThanOrEqual(40)
      const syntheticKey = `-----BEGIN PRIVATE KEY-----\n${"synthetic-not-key-material\n".repeat(600)}-----END PRIVATE KEY-----`
      expect(await service.submit({
        ...input, note: syntheticKey.slice(0, 2000),
        error: { name: `Bearer ${"B".repeat(220)}`, message: `Bearer ${"C".repeat(4100)}`, stack: syntheticKey.slice(0, 12000) },
      })).toEqual({ ok: true, reportId: "43" })
      const clipped = Schema.decodeUnknownSync(BugReportSchema)(JSON.parse(body))
      expect(clipped.diagnostics.account[0]).toMatchObject({
        sessionId: "[redacted secret]", payload: { service: "[redacted secret]", generation: "[redacted secret]" },
      })
      expect(clipped.note).toBe("[redacted secret]")
      expect(clipped.error).toEqual({ name: "[redacted secret]", message: "[redacted secret]", stack: "[redacted secret]" })
      expect(body).not.toContain("synthetic-not-key-material")
      const homePath = join(homedir(), "work", "client-project", "notes.md")
      expect(await service.submit({ ...input, note: `Opened ${homePath}`, error: { name: "Error", message: `ENOENT: ${homePath}`, stack: `at read (${homePath}:1:1)` } })).toEqual({ ok: true, reportId: "43" })
      expect(body).not.toContain(homedir())
      expect(Schema.decodeUnknownSync(BugReportSchema)(JSON.parse(body)).error.message).toBe(`ENOENT: ${join("~", "work", "client-project", "notes.md")}`)
    } finally { await service.dispose() }
  })

  test("disabled, relay refusal, and network failure return typed failures without retries", async () => {
    const userDataRoot = temporary("bug-reports-refusal-")
    let enabled = false
    let calls = 0
    const logs = await captureServiceRecords()
    const service = createBugReportsService({ userDataRoot, enabled: () => enabled, fetch: fakeFetch(async () => {
      calls += 1
      if (calls === 1) return new Response(null, { status: 429 })
      throw new Error("offline")
    }) })
    try {
      expect(await service.submit(input)).toMatchObject({ ok: false, kind: "disabled" })
      expect(calls).toBe(0)
      enabled = true
      const rejected = await service.submit(input)
      expect(rejected).toMatchObject({ ok: false, kind: "rejected" })
      const unavailable = await service.submit(input)
      expect(unavailable).toMatchObject({ ok: false, kind: "unavailable" })
      if (rejected.ok || unavailable.ok) throw new Error("Expected report failures")
      expect(typeof rejected.reportText).toBe("string")
      expect(typeof unavailable.reportText).toBe("string")
      expect(JSON.parse(rejected.reportText!).error).toEqual(input.error)
      expect(unavailable.reportText).toBe(rejected.reportText)
      expect(calls).toBe(2)
      expect(logs).toHaveLength(2)
      expect(logs).toMatchObject([{ type: "log.info" }, { type: "log.info" }])
      expect(JSON.stringify(logs)).not.toContain("offline")
      await service.dispose()
      expect(await service.submit(input)).toMatchObject({ ok: false, kind: "disabled" })
    } finally { await service.dispose(); await DebugLog.close() }
  })

  test("a build without the official report endpoint sends no report, and the release harness withholds only crash reports", async () => {
    const userDataRoot = temporary("bug-reports-release-")
    let calls = 0
    const logs = await captureServiceRecords()
    const service = createBugReportsService({ userDataRoot, enabled: () => true, fetch: fakeFetch(async () => { calls += 1; return Response.json({ reportId: "44" }) }) })
    const expectWithheld = async (kind: BugReportInput["kind"]) => {
      const withheld = await service.submit({ ...input, kind })
      expect(withheld).toMatchObject({ ok: false, kind: "not-release", error: "No bug report was sent because this build is not an official Flywheel release." })
      if (withheld.ok) throw new Error("Expected a withheld report")
      expect(JSON.parse(withheld.reportText!).error).toEqual(input.error)
    }
    try {
      for (const environment of [{}, { FLYWHEEL_REPORT_ENDPOINT: "" }]) {
        setReportEnvironment(environment)
        await expectWithheld("crash")
        await expectWithheld("manual")
        expect(await service.reportFault(new Error("executor stopped"))).toEqual({ kind: "not-release", reportText: expect.any(String) })
      }
      expect(calls).toBe(0)
      setReportEnvironment({ FLYWHEEL_REPORT_ENDPOINT: ENDPOINT, FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1" })
      await expectWithheld("crash")
      expect(await service.submit({ ...input, kind: "manual" })).toEqual({ ok: true, reportId: "44" })
      expect(calls).toBe(1)
      setReportEnvironment({ FLYWHEEL_REPORT_ENDPOINT: ENDPOINT })
      expect(await service.submit(input)).toEqual({ ok: true, reportId: "44" })
      expect(calls).toBe(2)
      const withheldLogs = logs.filter((record) => JSON.stringify(record).includes("bug report not sent"))
      expect(withheldLogs).toHaveLength(7)
      expect(withheldLogs[0]).toMatchObject({ type: "log.info", payload: { reason: "not-release" } })
      expect(JSON.stringify(withheldLogs)).not.toContain(input.error.message)
    } finally { await service.dispose(); await DebugLog.close() }
  })

  test("an explicit fault read returns the retained account report only for its current episode", async () => {
    const userDataRoot = temporary("bug-reports-episode-")
    const failed = Promise.withResolvers<void>()
    const owner = createRuntimeFaultReporting<RuntimeExecutorState>({
      initial: { kind: "serving" }, report: (error) => service.reportFault(error),
      publish: (state) => { if ("report" in state && state.report?.kind === "failed") failed.resolve() },
    })
    const service = createBugReportsService({
      userDataRoot, enabled: () => true, readFaultReport: () => owner.failedReport(),
      fetch: fakeFetch(async () => new Response(null, { status: 503 })),
    })
    const protocol = composeAccountModuleProtocolRuntimes([bugReportsModule], {
      modules: composeModuleServices([[bugReportsService.moduleId, service]]), publish: () => undefined, snapshotPosition: () => 0,
    }, () => ["bug-reports"])
    try {
      owner.update({ kind: "restarting", cause: "stopped", since: 1 })
      await failed.promise
      const text = await protocol.serve({ type: "bugReport.failed", source: "executor" })
      expect(text).not.toBeNull()
      expect(JSON.parse(text!).error).toMatchObject({ name: "restarting", message: "stopped" })
      expect(JSON.parse(text!).kind).toBe("crash")
      expect(owner.state()).not.toHaveProperty("reportText")
      owner.update({ kind: "recovery_failed", cause: "recovery stopped" })
      expect(await protocol.serve({ type: "bugReport.failed", source: "executor" })).toBe(text)
      owner.update({ kind: "serving" })
      expect(await protocol.serve({ type: "bugReport.failed", source: "executor" })).toBeNull()
    } finally { protocol.dispose(); await owner.dispose(); await service.dispose() }
  })
})
