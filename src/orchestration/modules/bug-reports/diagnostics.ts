import { open, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { redactSecrets } from "../../../infra/redact-secrets.js"
import type { BugReport, BugReportDiagnostic } from "../../../protocol/modules/bug-reports.js"

const LogRecord = z.object({ ts: z.number(), type: z.string(), sessionId: z.string().optional(), payload: z.record(z.string(), z.unknown()).optional() })
const STRING_FIELDS = new Set(["kind", "code", "signal", "sessionId", "projectId", "generation", "reportId", "operationId", "toolUseId"])
const METRIC_FIELD = /(?:Ms|Bytes|Count|Pid|Size|Length|Position|Seq)$|^(?:count|bytes|pid|generation|failed|slow|success|ok)$/
const TAIL_BYTES = 64 * 1024
const SOURCE_BYTES = 6000
interface DiagnosticMetadata { [key: string]: string | number | boolean | null }
interface DiagnosticStreams { tui: BugReportDiagnostic[]; executor: BugReportDiagnostic[]; account: BugReportDiagnostic[] }

/** Read bounded tails asynchronously. Rotation, missing logs, and partial JSONL writes omit only the unavailable records. */
export async function collectReportDiagnostics(input: { readonly userDataRoot: string; readonly projectRoot?: string }): Promise<BugReport["diagnostics"]> {
  const diagnostics: DiagnosticStreams = { tui: [], executor: [], account: [] }
  const roots = [
    ...(input.projectRoot === undefined ? [] : [{ directory: join(input.projectRoot, ".flywheel", "log"), account: false }]),
    { directory: join(input.userDataRoot, "log"), account: true },
  ]
  const bytes = { tui: 0, executor: 0, account: 0 }
  for (const root of roots) {
    const names = await readdir(root.directory).catch(() => [])
    const files = await Promise.all(names.filter((name) => name.endsWith(".jsonl")).map(async (name) => ({ name, modified: (await stat(join(root.directory, name)).catch(() => undefined))?.mtimeMs ?? 0 })))
    for (const { name } of files.sort((a, b) => b.modified - a.modified).slice(0, 8)) {
      const file = await open(join(root.directory, name), "r").catch(() => undefined)
      if (!file) continue
      try {
        const size = (await file.stat()).size
        const start = Math.max(0, size - TAIL_BYTES)
        const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
        const read = await file.read(buffer, 0, buffer.length, start)
        const lines = buffer.subarray(0, read.bytesRead).toString("utf8").split("\n")
        if (start > 0) lines.shift()
        const header = start === 0 ? [] : await file.read(Buffer.alloc(Math.min(size, TAIL_BYTES)), 0, Math.min(size, TAIL_BYTES), 0)
          .then(({ buffer: head, bytesRead }) => head.subarray(0, bytesRead).toString("utf8").split("\n"))
        const identifiesClient = [...header, ...lines].some((line) => {
          try {
            const record = LogRecord.safeParse(JSON.parse(line))
            return record.success && (record.data.payload?.owner === "client" || record.data.payload?.service === "tui-renderer")
          } catch { return false }
        })
        const decodedLines = lines.flatMap((line) => {
          let raw: unknown
          try { raw = JSON.parse(line) } catch { return [] }
          const decoded = LogRecord.safeParse(raw)
          return decoded.success ? [decoded.data] : []
        })
        const source = root.account ? "account" : identifiesClient ? "tui" : "executor"
        for (const record of decodedLines.toReversed()) {
          const payload = record.payload ?? {}
          const slow = typeof payload.durationMs === "number" && typeof payload.slowMs === "number" && payload.durationMs >= payload.slowMs
          if (record.type !== "log.warn" && record.type !== "log.error" && payload.failed !== true && payload.slow !== true && payload.outcome !== "failed" && payload.outcome !== "slow" && !slow) continue
          const service = typeof payload.service === "string" ? payload.service : undefined
          if (diagnostics[source].length >= 40) continue
          // Executor exit diagnostics can carry raw subprocess output. Select metadata, not arbitrary payload keys.
          const fields: DiagnosticMetadata = {}
          for (const [key, value] of Object.entries(payload)) {
            if (typeof value === "string" && STRING_FIELDS.has(key)) fields[key] = redactSecrets(value).slice(0, 200)
            else if (METRIC_FIELD.test(key) && (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || value === null)) fields[key] = value
          }
          const selected: BugReportDiagnostic = {
            ts: record.ts, type: redactSecrets(record.type).slice(0, 200), payload: { ...fields, ...(service === undefined ? {} : { service: redactSecrets(service).slice(0, 200) }) },
            ...(record.sessionId === undefined ? {} : { sessionId: redactSecrets(record.sessionId).slice(0, 200) }),
          }
          const length = Buffer.byteLength(JSON.stringify(selected))
          if (bytes[source] + length > SOURCE_BYTES) continue
          bytes[source] += length
          diagnostics[source].push(selected)
        }
      } catch {
        // A process can rotate or remove its log while this report reads it.
      } finally { await file.close() }
    }
  }
  for (const source of ["tui", "executor", "account"] as const) diagnostics[source].sort((a, b) => a.ts - b.ts)
  return diagnostics
}
