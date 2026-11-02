import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  test("names each record's writing process from its file name", () => {
    const workDir = temporaryWorkspace("fw-release-writer-")
    const logDir = join(workDir, ".flywheel", "log")
    mkdirSync(logDir, { recursive: true })
    const line = JSON.stringify({ ts: 100, type: "log.debug", payload: { service: "event-loop-lag" } })
    writeFileSync(join(logDir, "2026-10-02T120000000Z-4242-0-123e4567-e89b-12d3-a456-426614174000.jsonl"), line)
    writeFileSync(join(logDir, "unrecognized-name.jsonl"), line)
    expect(readDebugLogRecords(workDir).map((record) => record.writer)).toEqual([{ pid: "4242", writer: "4242:0" }, undefined])
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
