
/** `memory show`: print both bounded memory stores (project MEMORY.json and
 *  global USER.json) with their usage against the hard char limits, so any
 *  prompt snapshot can be traced to the exact file state that produced it. A
 *  store that does not decode is reported with its reason, never shown empty. */

import type { ProjectDirectories } from "../../../../infra/directory-authorities.js"
import { errorMessage } from "../../../../infra/error-message.js"
import type { LearningScope } from "../../../../infra/learning-scope.js"
import { LEARNING_REACHES } from "../../../../infra/learning-scope.js"
import {
  createMemoryStoreConfig,
  MEMORY_CHAR_LIMITS,
  memoryStorePath,
  memoryUsageText,
  readMemoryStore,
} from "../memory-store.js"

interface MemoryShowOptions {
  json: boolean
}

function parseArgs(args: readonly string[]): MemoryShowOptions {
  const options: MemoryShowOptions = { json: false }
  for (const arg of args) {
    if (arg === "--json") options.json = true
    else throw new Error(`Unknown argument ${arg}`)
  }
  return options
}

interface StoreTitles {
  [reach: string]: string
}

const STORE_TITLES: StoreTitles = {
  project: "Project memory (MEMORY.json)",
  global: "Global memory (USER.json)",
}

/** Prints both memory stores of one project. Memory is project-scoped learning,
 *  so it hangs off the directory authorities the caller selected; this command
 *  never resolves a directory of its own. */
export function runMemoryShow(args: readonly string[], directories: ProjectDirectories): void {
  let options: MemoryShowOptions
  try {
    options = parseArgs(args)
  } catch (err) {
    console.error(errorMessage(err))
    console.error("usage: flywheel memory show [--json]")
    process.exitCode = 1
    return
  }
  const config = createMemoryStoreConfig(directories.projectRoot, directories.accountHome)
  const targets: readonly LearningScope[] = LEARNING_REACHES
  if (options.json) {
    const stores = targets.map((target) => {
      const view = readMemoryStore(config, target)
      const entries = view.ok ? view.entries : []
      return {
        target,
        path: memoryStorePath(config, target),
        limit: MEMORY_CHAR_LIMITS[target],
        usage: memoryUsageText(config, target, entries),
        entries,
        ...(view.ok ? {} : { error: view.reason }),
      }
    })
    console.log(JSON.stringify(stores, null, 2))
    return
  }
  for (const target of targets) {
    const view = readMemoryStore(config, target)
    const entries = view.ok ? view.entries : []
    console.log(`${STORE_TITLES[target]} - ${memoryUsageText(config, target, entries)}`)
    console.log(`  ${memoryStorePath(config, target)}`)
    if (!view.ok) console.log(`  (unreadable: ${view.reason})`)
    for (const entry of entries) console.log(`  - [${entry.protected ? "protected" : "editable"}] ${entry.content.replaceAll("\n", "\n    ")}`)
    if (view.ok && entries.length === 0) console.log("  (empty)")
    console.log("")
  }
}
