import * as fs from "node:fs"
import { appendFileEnsuringDir, writeFileAtomic } from "../../infra/atomic-write.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { slashCommandToken } from "../../infra/slash-command.js"
import { commandUsageCursor, type CommandUsageView } from "../../protocol/command-usage-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"

const log = Log.create({ service: "command-usage" })

/** Rewrite the append log as one summary line once it grows past this many lines. */
const COMPACTION_THRESHOLD = 2000

export interface CommandUsageProjection {
  view(): CommandUsageView
  /** Records one dispatch of a slash token a client handled. A token outside
   *  the slash grammar is refused, so the store never names the untypeable. */
  record(name: string): boolean
  dispose(): void
}

interface LoadedUsage {
  counts: Map<string, number>
  lineCount: number
}

/** JSONL, append-only: a JSON string line is one use of that token, a JSON
 *  object line is a token->count summary written by compaction. A torn write
 *  or corrupt line loses only that line, never the file. */
function loadCommandUsageSync(filePath: string): LoadedUsage {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf-8")
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : undefined
    if (code !== "ENOENT") {
      log.warn("command usage unreadable, starting empty", { filePath, error: errorMessage(err) })
    }
    return { counts: new Map(), lineCount: 0 }
  }
  const counts = new Map<string, number>()
  let lineCount = 0
  let droppedLines = 0
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue
    lineCount++
    if (decodeUsageLine(line, counts)) continue
    droppedLines++
  }
  if (droppedLines > 0) {
    log.warn("command usage had corrupt lines, dropped them", { filePath, droppedLines })
  }
  return { counts, lineCount }
}

/** Strict decode of one owned line: a recorded token string, or a summary
 *  record of tokens to positive integer counts. Flywheel is the only writer,
 *  so any other shape is corruption and the whole line is dropped. */
function decodeUsageLine(line: string, counts: Map<string, number>): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return false
  }
  if (typeof parsed === "string") {
    if (!isUsageToken(parsed)) return false
    bump(counts, parsed, 1)
    return true
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false
  const decoded: [string, number][] = []
  for (const [token, count] of Object.entries(parsed)) {
    if (!isUsageToken(token) || typeof count !== "number" || !Number.isInteger(count) || count <= 0) return false
    decoded.push([token, count])
  }
  for (const [token, count] of decoded) bump(counts, token, count)
  return true
}

/** A stored token is valid exactly when dispatch would resolve it from `/token`. */
function isUsageToken(token: string): boolean {
  return slashCommandToken(`/${token}`) === token
}

function toView(counts: ReadonlyMap<string, number>): CommandUsageView {
  const uses = [...counts].map(([name, count]) => ({ name, count }))
  uses.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return { uses }
}

/** Account-global slash-command usage, published on the `commandUsage`
 *  workspace cursor: the single ranking source for every client's command
 *  lists, shared by every project. The runtime owns the file so a phone with
 *  no disk of its own ranks the same way the terminal does. Loads once at
 *  startup; appends from another concurrent runtime become visible on its
 *  next launch. */
export function createCommandUsageProjection(options: { readonly filePath: string; readonly publish: (patch: RuntimeUiPatchInput) => void }): CommandUsageProjection {
  const loaded = loadCommandUsageSync(options.filePath)
  const counts = loaded.counts
  if (loaded.lineCount > COMPACTION_THRESHOLD) persistSummary(options.filePath, counts)
  let view = toView(counts)
  return Object.freeze({
    view: () => view,
    record(name: string) {
      if (!isUsageToken(name)) return false
      bump(counts, name, 1)
      view = toView(counts)
      options.publish({ cursor: commandUsageCursor(), payload: { kind: "commandUsage.changed", usage: view } })
      try {
        appendFileEnsuringDir(options.filePath, `${JSON.stringify(name)}\n`)
      } catch (err) {
        log.warn("command usage append failed", { filePath: options.filePath, error: errorMessage(err) })
      }
      return true
    },
    dispose: () => {},
  })
}

function persistSummary(filePath: string, counts: ReadonlyMap<string, number>): void {
  try {
    writeFileAtomic(filePath, `${JSON.stringify(Object.fromEntries(counts))}\n`)
  } catch (err) {
    log.warn("command usage rewrite failed", { filePath, error: errorMessage(err) })
  }
}

function bump(counts: Map<string, number>, token: string, by: number): void {
  counts.set(token, (counts.get(token) ?? 0) + by)
}
