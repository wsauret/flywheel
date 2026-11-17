import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DebugLog } from "../../../src/infra/debug-log.js"
import { inWindow, readDebugLogRecords } from "../../release/lib/debug-log-reader.js"

// The "filters" block creates its workspace while the file loads, so the
// workspaces are removed after all tests, not after each test.
const workDirs: string[] = []

afterAll(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temporaryWorkspace(prefix: string): string {
  const workDir = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(workDir)
  return workDir
}

function workspaceWithLog(lines: string[]): string {
  const workDir = temporaryWorkspace("fw-release-log-")
  const logDir = join(workDir, ".flywheel", "log")
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, "2026-08-20T00-00-00-1-a.jsonl"), lines.join("\n"))
  return workDir
}

describe("readDebugLogRecords", () => {
  test("reads records sorted by ts and skips malformed lines", () => {
    const workDir = workspaceWithLog([
      JSON.stringify({ ts: 200, type: "log.info", payload: { service: "render-probe", message: "render diagnostics" } }),
      "{truncated final li",
      JSON.stringify({ ts: 100, type: "log.info", payload: { service: "output-window-scroll", message: "scroll position changed", scrollTop: 5 } }),
      JSON.stringify({ type: "no-ts" }),
    ])
    const records = readDebugLogRecords(workDir)
    expect(records.map((record) => record.ts)).toEqual([100, 200])
  })

  test("names each record's writing process from the name the sink gave its file", async () => {
    const workDir = temporaryWorkspace("fw-release-writer-")
    try {
      await DebugLog.init({ dir: workDir })
      DebugLog.record({ type: "startup.finished", payload: {} })
    } finally {
      await DebugLog.close()
    }
    writeFileSync(join(workDir, ".flywheel", "log", "unrecognized-name.jsonl"), JSON.stringify({ ts: 0, type: "log.debug" }))

    expect(readDebugLogRecords(workDir).map((record) => record.pid)).toEqual([undefined, String(process.pid)])
  })

  test("a workspace without a log directory answers no records", () => {
    expect(readDebugLogRecords(temporaryWorkspace("fw-release-nolog-"))).toEqual([])
  })
})

describe("filters", () => {
  const workDir = workspaceWithLog([
    JSON.stringify({ ts: 100, type: "log.info", payload: { service: "output-window-scroll", message: "scroll position changed" } }),
    JSON.stringify({ ts: 200, type: "log.info", payload: { service: "render-probe", message: "render diagnostics" } }),
    JSON.stringify({ ts: 300, type: "log.info", payload: { service: "render-probe", message: "render diagnostics" } }),
  ])
  const records = readDebugLogRecords(workDir)

  test("inWindow bounds are inclusive", () => {
    expect(inWindow(records, 100, 200).map((record) => record.ts)).toEqual([100, 200])
  })
})
