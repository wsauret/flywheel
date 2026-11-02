import * as fs from "node:fs"

import { trustedProbeRun } from "./process-container.js"

/** One snapshot of every process on the host, with the command line each one
 *  was started with.
 *
 *  The container module answers questions about one pid or one group it
 *  already knows. This answers the question that comes before it: which pids
 *  are there at all, and what is each one running. Only a decision that has
 *  to find processes nobody recorded needs it, which is why it is a separate
 *  module from the container authority and why nothing on a hot path reads it.
 *
 *  argv is exact where the platform keeps it exact (`/proc/<pid>/cmdline` on
 *  Linux, the process's own command line on Windows) and split on whitespace
 *  where it does not (`ps` on macOS, which joins the arguments with spaces and
 *  keeps no quoting). A reader that matches a path must expect the macOS form
 *  to break a path that contains a space, and fail closed on it. */

export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  /** The process group, on a platform that has one. */
  readonly pgid?: number
  /** The effective user that owns the process, on a platform that states one. */
  readonly uid?: number
  readonly argv: readonly string[]
}

/** `ps -e` on a host with a few thousand processes answers in well under a
 *  second; PowerShell needs most of one just to start. Both are given room,
 *  because a table read under a hard reset is exactly the read that runs on a
 *  host under load. */
const TABLE_PROBE_TIMEOUT_MS = 15_000

/** Every process on the host, or nothing when the table could not be read.
 *  Nothing is not an empty table: a failed read proves no absence. */
export async function listProcesses(): Promise<readonly ProcessRow[] | undefined> {
  if (process.platform === "linux") return listProcTable()
  if (process.platform === "win32") return listWindowsTable()
  return listPsTable()
}

async function listPsTable(): Promise<readonly ProcessRow[] | undefined> {
  const outcome = await trustedProbeRun(["ps", "-e", "-o", "pid=,ppid=,pgid=,uid=,command="], TABLE_PROBE_TIMEOUT_MS)
  return outcome.kind === "output" ? parsePsTable(outcome.text) : undefined
}

/** Rows of `ps -e -o pid=,ppid=,pgid=,uid=,command=`. A line that does not
 *  carry the four numbers is skipped rather than read as a process. */
export function parsePsTable(text: string): readonly ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split("\n")) {
    const [, pid, ppid, pgid, uid, command] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line) ?? []
    if (pid === undefined || ppid === undefined || pgid === undefined || uid === undefined || command === undefined) continue
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid), argv: command.split(/\s+/) })
  }
  return rows
}

interface ProcEntry {
  readonly pid: number
  readonly stat: string
  readonly cmdline: string
  readonly status: string
}

function listProcTable(): readonly ProcessRow[] | undefined {
  let names: string[]
  try {
    names = fs.readdirSync("/proc")
  } catch {
    return undefined
  }
  const entries: ProcEntry[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    // An entry that vanished between the listing and the read exited; an entry
    // this side may not read is another user's, and this side kills nothing it
    // cannot name, so both are left out.
    try {
      entries.push({
        pid: Number(name),
        stat: fs.readFileSync(`/proc/${name}/stat`, "utf8"),
        cmdline: fs.readFileSync(`/proc/${name}/cmdline`, "utf8"),
        status: fs.readFileSync(`/proc/${name}/status`, "utf8"),
      })
    } catch {
      continue
    }
  }
  return parseProcTable(entries)
}

/** Rows from `/proc`: argv is the NUL-separated cmdline, parent and group are
 *  stat fields counted from the last `)` because comm may hold spaces, and
 *  the owner is the effective uid, the second of status's `Uid:` fields, as
 *  `ps` states it elsewhere. A process with an empty cmdline is a kernel
 *  thread or a zombie and runs nothing this side could recognize. */
export function parseProcTable(entries: readonly ProcEntry[]): readonly ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const entry of entries) {
    const argv = entry.cmdline.split("\0").filter((token) => token.length > 0)
    if (argv.length === 0) continue
    const close = entry.stat.lastIndexOf(")")
    if (close < 0) continue
    const fields = entry.stat.slice(close + 1).trim().split(/\s+/)
    const ppid = Number(fields[1])
    const pgid = Number(fields[2])
    if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) continue
    const uid = Number(/^Uid:\s+\d+\s+(\d+)/m.exec(entry.status)?.[1] ?? Number.NaN)
    rows.push({ pid: entry.pid, ppid, pgid, ...(Number.isSafeInteger(uid) ? { uid } : {}), argv })
  }
  return rows
}

/** Windows keeps no process group and `tasklist` prints no command line, so
 *  the table comes from WMI through PowerShell, which the probe authority
 *  already trusts from the system directory. */
const WINDOWS_TABLE_SCRIPT = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"

async function listWindowsTable(): Promise<readonly ProcessRow[] | undefined> {
  const outcome = await trustedProbeRun(["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_SCRIPT], TABLE_PROBE_TIMEOUT_MS)
  return outcome.kind === "output" ? parseWindowsProcessJson(outcome.text) : undefined
}

/** `ConvertTo-Json` emits one object for a single row and an array otherwise.
 *  A row without a command line is a system process this side has no name
 *  for. Text that is not JSON proves nothing. */
export function parseWindowsProcessJson(text: string): readonly ProcessRow[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const rows: ProcessRow[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue
    const record: { readonly ProcessId?: unknown; readonly ParentProcessId?: unknown; readonly CommandLine?: unknown } = item
    if (typeof record.ProcessId !== "number" || typeof record.ParentProcessId !== "number" || typeof record.CommandLine !== "string") continue
    const argv = splitWindowsCommandLine(record.CommandLine)
    if (argv.length === 0) continue
    rows.push({ pid: record.ProcessId, ppid: record.ParentProcessId, argv })
  }
  return rows
}

/** The argument split a Windows program applies to its own command line: a
 *  double-quoted span is one argument, whitespace separates the rest. This is
 *  enough to read a program path and its flags, which is all a reader here
 *  matches; the escaping rules for a quote inside an argument are not
 *  reproduced. */
export function splitWindowsCommandLine(line: string): readonly string[] {
  const argv: string[] = []
  let current = ""
  let quoted = false
  let inToken = false
  for (const char of line) {
    if (char === "\"") {
      quoted = !quoted
      inToken = true
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (inToken) argv.push(current)
      current = ""
      inToken = false
      continue
    }
    current += char
    inToken = true
  }
  if (inToken) argv.push(current)
  return argv
}
