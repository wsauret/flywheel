#!/usr/bin/env bun

import { errorMessage } from "../../infra/diagnostics/error-message.js"
import { startHardExitClock } from "../../infra/process/workers/hard-exit-clock.js"
import { listEventTypes, rowActor, rowTimestamp, rowType, searchEvents, type EventSearchQuery } from "../../infra/substrate/store/event-search.js"
import { analyzeStreamGaps, formatStreamGapReport } from "../../orchestration/session/diagnostics/provider-stream-gaps.js"
import { formatEventSearchMatch, formatEventTypeSummary, formatReconstruction } from "./event-search-format.js"
import { withEventStore } from "../../infra/substrate/store/with-event-store.js"
import { loadProviderRequestAuditFromEvents } from "../../orchestration/session/diagnostics/provider-request-audit-projection.js"
import type { ProviderRequestPromptReconstruction } from "../../orchestration/agent-runtime/loop/provider-request-audit-reconstruction.js"
import { importComposing } from "../composition/module-registries.js"
import { type CliOptions, MAX_TIMEOUT_SECONDS, parseArgs, eventSearchUsage } from "./event-search-args.js"

type EventSearchOptions = CliOptions & { readonly projectRoot: string }

export async function runEventSearch(args: readonly string[], projectRoot: string): Promise<void> {
  const parsed = parseArgs([...args])
  if (!parsed.ok) {
    console.error(parsed.error.message)
    console.error("")
    console.error(eventSearchUsage())
    process.exitCode = 1
    return
  }
  const options: EventSearchOptions = { ...parsed.options, projectRoot }
  if (options.help) {
    console.log(eventSearchUsage())
    return
  }
  const raise = options.timeoutSeconds < MAX_TIMEOUT_SECONDS ? ", or raise --timeout" : ""
  // The work is synchronous native SQLite and file reads, so only a clock on
  // another thread can bound it.
  const clock = startHardExitClock(
    options.timeoutSeconds * 1_000,
    `events search timed out after ${options.timeoutSeconds}s. Narrow it with --session, --type, --since, or --limit${raise}.\n`,
  )
  try {
    if (options.listTypes) {
      printTypeSummary(options)
      return
    }

    if (options.gaps) {
      printGapAnalysis(options)
      return
    }

    if (options.count) {
      printCount(options)
      return
    }

    if (options.reconstructRequestId) {
      await printReconstruction(options, options.reconstructRequestId)
      return
    }

    printSearchResults(options)
  } catch (err) {
    console.error(errorMessage(err))
    console.error("")
    console.error(eventSearchUsage())
    process.exitCode = 1
  } finally {
    await clock.cancel()
  }
}

function printSearchResults(options: EventSearchOptions): void {
  const result = searchEvents(toSearchQuery(options))
  if (!result.storeFound && !result.logFilesFound) {
    printMissingSources(result.dbPath, result.logDir)
    return
  }

  if (!options.json) {
    console.log(`${result.matches.length} match(es) in ${describeSources(result)}`)
  }

  let previousTimestamp: number | undefined
  for (const row of result.matches) {
    const formatOptions = options.showGapColumn
      ? { json: options.json, previousTimestamp }
      : { json: options.json }
    console.log(formatEventSearchMatch(row, formatOptions))
    previousTimestamp = rowTimestamp(row)
  }
}

function printCount(options: EventSearchOptions): void {
  const result = searchEvents({ ...toSearchQuery(options), limit: 0 })
  if (!result.storeFound && !result.logFilesFound) {
    printMissingSources(result.dbPath, result.logDir)
    return
  }

  const field = options.countField
  if (!field) {
    console.log(`${result.matches.length} match(es) in ${describeSources(result)}`)
    return
  }

  const counts = new Map<string, number>()
  for (const row of result.matches) {
    const key = (field === "type" ? rowType(row) : rowActor(row)) ?? "(none)"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(7)}  ${key}`)
  }
}

function printTypeSummary(options: EventSearchOptions): void {
  if (options.pattern || options.errorsOnly || options.requestId) {
    throw new Error("--list-types does not take a pattern, --errors, or --request")
  }
  const result = listEventTypes(toSearchQuery(options))
  if (!result.storeFound && !result.logFilesFound) {
    printMissingSources(result.dbPath, result.logDir)
    return
  }

  if (options.json) {
    for (const type of result.types) console.log(JSON.stringify(type))
    return
  }

  console.log(`${result.types.length} event type(s) in ${describeSources(result)}`)
  for (const type of result.types) console.log(formatEventTypeSummary(type))
}

function describeSources(result: { dbPath: string; logDir: string; storeFound: boolean; logFilesFound: boolean }): string {
  const sources = [
    ...(result.storeFound ? [result.dbPath] : []),
    ...(result.logFilesFound ? [`${result.logDir}/*.jsonl`] : []),
  ]
  return sources.join(" + ")
}

function printGapAnalysis(options: EventSearchOptions): void {
  const report = analyzeStreamGaps({
    baseDir: options.projectRoot,
    sessionId: options.sessionId,
    requestId: options.requestId,
    sinceTimestamp: options.sinceTimestamp,
    untilTimestamp: options.untilTimestamp,
  })
  if (!report.storeFound) {
    printMissingStore(report.dbPath)
    return
  }
  console.log(formatStreamGapReport(report, { json: options.json }))
}

async function printReconstruction(options: EventSearchOptions, requestId: string): Promise<void> {
  if (!options.sessionId) throw new Error("--reconstruct requires --session <id>")
  const result = await reconstructPromptForRequest({
    projectRoot: options.projectRoot,
    sessionId: options.sessionId,
    requestId,
  })
  console.log(formatReconstruction(requestId, result, { json: options.json }))
}

function printMissingStore(dbPath: string): void {
  console.error(`No Flywheel SQLite event store found at ${dbPath}`)
  process.exitCode = 1
}

function printMissingSources(dbPath: string, logDir: string): void {
  console.error(`No Flywheel SQLite event store found at ${dbPath} and no debug-log files under ${logDir}`)
  process.exitCode = 1
}

function toSearchQuery(options: EventSearchOptions): EventSearchQuery {
  return {
    baseDir: options.projectRoot,
    pattern: options.pattern,
    sessionId: options.sessionId,
    requestId: options.requestId,
    typePatterns: options.typePatterns,
    actor: options.actor,
    errorsOnly: options.errorsOnly,
    caseSensitive: options.caseSensitive,
    regex: options.regex,
    limit: options.limit,
    order: options.order,
    afterPosition: options.afterPosition,
    sinceTimestamp: options.sinceTimestamp,
    untilTimestamp: options.untilTimestamp,
    includeSnapshots: options.includeSnapshots,
    aroundPosition: options.aroundPosition,
    aroundRadius: options.aroundRadius,
  }
}

// Resolves the durable request audit reference, then folds the conversation tree
// back to the recorded leaf to recover the bytes the model saw. A workflow
// member records its audit facts on `workflow:<id>`, so both aggregates feed
// the fold in position order.
async function reconstructPromptForRequest(
  request: { projectRoot: string; sessionId: string; requestId: string },
): Promise<ProviderRequestPromptReconstruction> {
  // Only a reconstruction reads the module catalog, so only it loads the registries (ARCH-STRUCTURE-012).
  const { reconstructProviderRequestPrompt } = await importComposing(() => import("../../orchestration/agent-runtime/loop/provider-request-audit-reconstruction.js"))
  return withEventStore(request.projectRoot, (store) => {
    const sessionEvents = [
      ...store.read({ aggregateId: `session:${request.sessionId}` }),
      ...store.read({ aggregateId: `workflow:${request.sessionId}` }),
    ].sort((left, right) => left.position - right.position)
    const entries = loadProviderRequestAuditFromEvents(sessionEvents)
    const entry = entries.find((candidate) => candidate.requestId === request.requestId)
    if (!entry) {
      throw new Error(`no provider request ${request.requestId} in session ${request.sessionId}`)
    }
    return reconstructProviderRequestPrompt({ entry, store, sessionEvents })
  })
}
