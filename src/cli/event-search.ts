#!/usr/bin/env bun

import { errorMessage } from "../infra/error-message.js"
import { startHardExitClock } from "../infra/hard-exit-clock.js"
import { listEventTypes, rowActor, rowTimestamp, rowType, searchEvents, type EventSearchQuery } from "../infra/event-search.js"
import { analyzeStreamGaps, formatStreamGapReport } from "../orchestration/session/diagnostics/provider-stream-gaps.js"
import { formatEventSearchMatch, formatEventTypeSummary } from "./event-search-format.js"
import { withEventStore } from "../infra/with-event-store.js"
import { loadProviderRequestAuditFromEvents } from "../orchestration/session/provider-request-audit-projection.js"
import {
  reconstructProviderRequestPrompt,
  type ProviderRequestPromptReconstruction,
} from "../orchestration/session/provider-request-audit-reconstruction.js"
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
  // The fold reads the installed module catalog, and a release entry installs
  // it only when a command loads the registry. The other modes never read it.
  await import("../orchestration/modules.js")
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
export async function reconstructPromptForRequest(
  request: { projectRoot: string; sessionId: string; requestId: string },
): Promise<ProviderRequestPromptReconstruction> {
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

export function formatReconstruction(
  requestId: string,
  result: ProviderRequestPromptReconstruction,
  options: { json: boolean },
): string {
  if (options.json) return JSON.stringify({ requestId, ...result })
  return result.kind === "reconstructed"
    ? formatReconstructed(requestId, result)
    : formatUnavailable(requestId, result)
}

// Reports exactly the evidence the substrate holds. A request without durable
// message history is never dressed up as a reconstruction.
function formatUnavailable(
  requestId: string,
  result: Extract<ProviderRequestPromptReconstruction, { kind: "unavailable" }>,
): string {
  return [
    `request=${requestId} reconstruction=unavailable reason=${result.reason} sha256=${result.promptSha256}`,
    result.detail,
    "",
    "systemPrompt:",
    result.systemPrompt ?? "(not durably recorded)",
    "",
    `tools (${result.tools?.length ?? 0}):`,
    result.tools ? JSON.stringify(result.tools, null, 2) : "(not durably recorded)",
  ].join("\n")
}

function formatReconstructed(
  requestId: string,
  result: Extract<ProviderRequestPromptReconstruction, { kind: "reconstructed" }>,
): string {
  const lines = [
    `request=${requestId} verified=${result.verified} sha256=${result.computedSha256}`,
    "",
    "systemPrompt:",
    result.systemPrompt,
    "",
    `messages (${result.messages.length}):`,
    JSON.stringify(result.messages, null, 2),
    "",
    `tools (${result.tools.length}):`,
    JSON.stringify(result.tools, null, 2),
  ]
  // Mid-turn requests share the pre-turn leaf pointer because the durable leaf
  // only advances at the turn-end save point, so their sha legitimately differs
  // from the first-of-turn assembly. Flag it so a reader does not read drift.
  if (!result.verified) {
    lines.push(
      "",
      "Note: verified=false is expected for mid-turn requests (additional LLM",
      "calls within a tool-using turn). The durable conversation leaf advances",
      "only at the turn-end save point, so mid-turn requests reconstruct from",
      "the pre-turn leaf rather than the exact bytes that were sent.",
    )
  }
  return lines.join("\n")
}
