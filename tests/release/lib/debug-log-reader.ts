/**
 * Reader for the JSONL diagnostics stream a scenario run leaves behind in
 * <workDir>/.flywheel/log/*.jsonl (written by src/infra/debug-log.ts). This is
 * forensic tooling over an already-finished run, so a malformed line is
 * skipped rather than fatal: the metrics that matter assert on the presence
 * of well-formed records, and a truncated final line is normal when the
 * process was killed mid-write.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { logFileWriter, type LogFileWriter } from "../../../src/infra/debug-log.js"

export interface UnknownFieldsRecord {
  [key: string]: unknown
}

export interface DebugLogRecord {
  ts: number
  type: string
  sessionId?: string
  payload?: UnknownFieldsRecord
  /** The process and thread that wrote the record, from its file name. One
   *  log directory holds every process of a project, so this is how a
   *  scenario tells the executor's records from the account service's. */
  writer?: LogFileWriter
}

function asUnknownFields(value: unknown): UnknownFieldsRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const fields: UnknownFieldsRecord = {}
  for (const [key, fieldValue] of Object.entries(value)) fields[key] = fieldValue
  return fields
}

export function readDebugLogRecords(workDir: string): DebugLogRecord[] {
  const logDir = join(workDir, ".flywheel", "log")
  let files: string[]
  try {
    files = readdirSync(logDir).filter((name) => name.endsWith(".jsonl"))
  } catch {
    return []
  }
  const records: DebugLogRecord[] = []
  for (const file of files.sort()) {
    const writer = logFileWriter(file)
    for (const line of readFileSync(join(logDir, file), "utf8").split("\n")) {
      if (line === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const record = asUnknownFields(parsed)
      if (!record || typeof record.ts !== "number" || typeof record.type !== "string") continue
      const payload = asUnknownFields(record.payload)
      records.push({
        ts: record.ts,
        type: record.type,
        ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
        ...(payload ? { payload } : {}),
        ...(writer ? { writer } : {}),
      })
    }
  }
  return records.sort((a, b) => a.ts - b.ts)
}

/** Records a Log.create({ service }) logger wrote: payload.service carries the tag. */
export function serviceRecords(records: readonly DebugLogRecord[], service: string): DebugLogRecord[] {
  return records.filter((record) => record.payload?.service === service)
}

export function inWindow(records: readonly DebugLogRecord[], startTs: number, endTs: number): DebugLogRecord[] {
  return records.filter((record) => record.ts >= startTs && record.ts <= endTs)
}
