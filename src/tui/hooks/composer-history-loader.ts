import * as fs from "node:fs"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"

const log = Log.create({ service: "composer-history" })

/** One JSON string per line (append-only history posture): a torn write
 *  or a single corrupt line only loses that one entry, not the whole file --
 *  unlike a single-JSON-array file, where any corruption anywhere loses
 *  everything. A missing file is normal first-run state. */
export function loadPromptHistorySync(filePath: string): string[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf-8")
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : undefined
    if (code !== "ENOENT") {
      log.warn("prompt history unreadable, rebuilding", { filePath, error: errorMessage(err) })
    }
    return []
  }

  const entries: string[] = []
  let droppedLines = 0
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== "string") throw new Error("expected a JSON string")
      entries.push(parsed)
    } catch {
      droppedLines++
    }
  }
  if (droppedLines > 0) {
    log.warn("prompt history had corrupt lines, dropped them", { filePath, droppedLines, kept: entries.length })
  }
  return entries
}
