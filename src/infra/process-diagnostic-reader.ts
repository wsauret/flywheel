/** The service of the one record a process writes when it cannot open a
 *  kernel process API: libproc on macOS, kernel32 and ntdll on Windows. */
export const KERNEL_API_SERVICE = "process-kernel-api"

/** The services of the records a command supervisor writes on its control
 *  return channel: its own decisions, its termination decisions, and a
 *  kernel API it could not open. They are Flywheel's records, never a
 *  command's output, so every launcher that drains a supervisor relays them
 *  to its own log. This module imports nothing, so the process modules that
 *  write these records can name them without an import cycle. */
export const SUPERVISOR_RECORD_SERVICES: ReadonlySet<string> = new Set(["command-supervisor", "process-termination", KERNEL_API_SERVICE])

/** The payload of one JSONL diagnostic record another process wrote, as it
 *  parsed. Only `service` is known; every other field is the writer's own and
 *  is read at the boundary that needs it. */
export interface ProcessDiagnosticPayload {
  readonly service: string
  readonly [field: string]: unknown
}

/** One JSONL diagnostic record another process wrote: its type, such as
 *  `log.warn`, and its time, when the writer stated them, and its payload. */
export interface ProcessDiagnosticRecord {
  readonly type: string | undefined
  readonly ts: number | undefined
  readonly payload: ProcessDiagnosticPayload
}

/** The longest unfinished line a reader keeps while it waits for the line to
 *  end. A line that grows past it is plain output, never a record. */
const PROCESS_DIAGNOSTIC_LINE_CHARS = 4096

/** Reads one process output stream as JSONL diagnostics, and gives each line
 *  with the record it parsed to, or with none for plain output. Unfinished
 *  records retain at most `PROCESS_DIAGNOSTIC_LINE_CHARS`; oversized records
 *  remain ordinary output. */
export function createProcessDiagnosticReader(emit: (line: string, record: ProcessDiagnosticRecord | undefined) => void): (text: string) => void {
  let pending = ""
  let truncated = false
  return (text) => {
    const lines = text.split("\n")
    for (const [index, part] of lines.entries()) {
      const complete = index < lines.length - 1
      const line = pending + part
      if (complete) {
        emit(line, truncated ? undefined : parseProcessDiagnostic(line))
        pending = ""
        truncated = false
      } else {
        truncated ||= line.length > PROCESS_DIAGNOSTIC_LINE_CHARS
        pending = line.slice(0, PROCESS_DIAGNOSTIC_LINE_CHARS)
      }
    }
  }
}

/** One complete line of process output as the diagnostic record it holds, or
 *  nothing for plain output. */
function parseProcessDiagnostic(line: string): ProcessDiagnosticRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    // Process output can also contain plain text.
    return undefined
  }
  if (typeof value !== "object" || value === null || !("payload" in value)) return undefined
  const payload = value.payload
  if (typeof payload !== "object" || payload === null || !("service" in payload)) return undefined
  const { service } = payload
  if (typeof service !== "string") return undefined
  const type = "type" in value && typeof value.type === "string" ? value.type : undefined
  const ts = "ts" in value && typeof value.ts === "number" ? value.ts : undefined
  return { type, ts, payload: { ...payload, service } }
}

interface RelayFields {
  readonly [field: string]: unknown
}

type RelayLevel = "debug" | "info" | "warn" | "error"

const RELAY_LEVELS: ReadonlyMap<string, RelayLevel> = new Map([
  ["log.debug", "debug"],
  ["log.info", "info"],
  ["log.warn", "warn"],
  ["log.error", "error"],
])

/** Writes a record another process emitted into this process's log with its
 *  own level, service, message, and fields, plus `context` naming where it
 *  came from. A relayed record is a record, not a text field holding one:
 *  search filters and readers see its fields directly, a DEBUG record stays
 *  DEBUG, and `sourceTs` keeps the time the writer recorded it, which a slow
 *  pipe can put well before the relay. A record with no log level relays at
 *  INFO. */
export function relayProcessDiagnostic(
  log: { readonly [level in RelayLevel]: (message: unknown, extra?: RelayFields) => void },
  record: ProcessDiagnosticRecord,
  context: RelayFields,
): void {
  const { message, ...fields } = record.payload
  const level = (record.type === undefined ? undefined : RELAY_LEVELS.get(record.type)) ?? "info"
  log[level](typeof message === "string" ? message : "relayed diagnostic", { ...fields, ...(record.ts === undefined ? {} : { sourceTs: record.ts }), ...context })
}

export interface SupervisorDiagnostics {
  readonly context?: RelayFields
  /** Observes the original record before relay, including records received
   *  before the launch promise returns. The observer must not write it again. */
  readonly observe?: (record: ProcessDiagnosticRecord, supervisorPid: number) => void
}

/** Owns a supervisor's control return reader, independent of payload readers.
 *  `done` settles after EOF and relay, or transport loss. `release` cancels
 *  the reader when ownership is handed over or persistent work is released. */
export function drainSupervisorDiagnostics(
  stream: ReadableStream<Uint8Array> | undefined,
  supervisorPid: number,
  options: SupervisorDiagnostics = {},
) {
  const reader = stream?.getReader()
  const done = (async (): Promise<void> => {
    if (reader === undefined) return
    // Log's private-path setup depends on process launch infrastructure.
    const { Log } = await import("./log.js")
    const log = Log.create({ service: "command-supervisor" })
    const read = createProcessDiagnosticReader((_line, record) => {
      if (record === undefined) return
      options.observe?.(record, supervisorPid)
      relayProcessDiagnostic(log, record, { supervisorPid, ...options.context })
    })
    const decoder = new TextDecoder()
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try {
          chunk = await reader.read()
        } catch {
          // A vanished controller or supervisor can end the return transport.
          break
        }
        if (chunk.done) break
        read(decoder.decode(chunk.value, { stream: true }))
      }
      read(decoder.decode() + "\n")
    } finally {
      reader.releaseLock()
    }
  })()
  return { done, release: async () => { await reader?.cancel().catch(() => {}) } }
}
