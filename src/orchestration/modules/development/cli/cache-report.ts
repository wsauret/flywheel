// Prompt caching depends on byte-identical prefixes across turns. Repairs to tool
// adjacency, synthesized continuations, and reasoning-setting changes can mutate
// that prefix and turn a request into a full-cost cache miss. This verb derives
// the provider-measured cache read-back per request from the existing
// model.requested and model.usage.recorded events, pairs consecutive requests of
// the same conversation, and flags requests that failed to read back the previous
// prompt without a cause that explains it: an identity change (system prompt,
// tools, model, reasoning effort), compaction, an advance of stale tool-result
// masking, or an idle gap long enough for the cache to expire.

import * as fs from "node:fs"
import { CliArgsError, type CliArgsResult, parseArgsResult, requiredValue } from "../../../../infra/cli-args.js"
import { createSqliteEventStore } from "../../../../infra/sqlite-event-store.js"
import { errorMessage } from "../../../../infra/error-message.js"
import { formatTokens } from "../../../../protocol/client/format.js"
import { resolveEventStoreDbFile } from "../../../../infra/paths.js"
import { loadProviderRequestAuditFromEvents } from "../../../session/provider-request-audit-projection.js"
import {
  buildTurnReport,
  LOW_HIT_RATIO_THRESHOLD,
  PREFIX_READBACK_THRESHOLD,
  type TurnCacheReport,
} from "../../../session/diagnostics/cache-report-analysis.js"
import type { CliVerb } from "../../../cli-contribution.js"

interface CliOptions {
  sessionId?: string
  json: boolean
  help: boolean
}

export const cacheReportVerb: CliVerb = {
  syntax: "cache-report --session <id>",
  description: "Report prompt-cache read-back per request for one session.",
  run: (args, { directories }) => {
    const parsed = parseArgs(args)
    if (!parsed.ok) {
      console.error(parsed.error.message)
      console.error("")
      console.error(usage())
      process.exitCode = 1
      return
    }
    const options = parsed.options
    if (options.help) {
      console.log(usage())
      return
    }
    try {
      const dbPath = resolveEventStoreDbFile(directories.projectRoot)
      if (!fs.existsSync(dbPath)) {
        console.error(`No Flywheel SQLite event store found at ${dbPath}`)
        process.exitCode = 1
        return
      }

      const store = createSqliteEventStore(dbPath)
      try {
        const events = store.read({ aggregateId: `session:${options.sessionId}` })
        const entries = loadProviderRequestAuditFromEvents(events)
        const turns = buildTurnReport(entries)
        printReport(options, dbPath, turns)
      } finally {
        store.close()
      }
    } catch (err) {
      console.error(errorMessage(err))
      console.error("")
      console.error(usage())
      process.exitCode = 1
    }
  },
}

function printReport(options: CliOptions, dbPath: string, turns: TurnCacheReport[]): void {
  if (options.json) {
    console.log(JSON.stringify({ sessionId: options.sessionId, dbPath, turns }))
    return
  }

  const requestStreamCount = new Set(turns.map((turn) => turn.requestIdentity)).size
  console.log(`${turns.length} request(s) with recorded usage across ${requestStreamCount} request stream(s) in ${dbPath}`)
  let currentRequestStream: string | undefined
  for (const turn of turns) {
    if (turn.requestIdentity !== currentRequestStream) {
      currentRequestStream = turn.requestIdentity
      console.log(`request stream ${turn.requestIdentity} (${turn.promptKind})`)
    }
    console.log(`  ${formatTurn(turn)}`)
  }

  // Follow-up means the request stream has a predecessor. The turn counter can
  // restart when a session resumes.
  const seenRequestStreams = new Set<string>()
  const followUpTurns = turns.filter((turn) => {
    if (seenRequestStreams.has(turn.requestIdentity)) return true
    seenRequestStreams.add(turn.requestIdentity)
    return false
  })
  const reportedRatios = followUpTurns.flatMap((t) => t.hitRatio === null ? [] : [t.hitRatio])
  if (reportedRatios.length > 0) {
    const avgHitRatio = reportedRatios.reduce((sum, ratio) => sum + ratio, 0) / reportedRatios.length
    const unreported = followUpTurns.length - reportedRatios.length
    console.log(`avg hit ratio (follow-up requests): ${percent(avgHitRatio)}${unreported > 0 ? ` (${unreported} with unreported cache reads excluded)` : ""}`)
  }
  const lowHitTurns = followUpTurns.filter((t) => t.hitRatio !== null && t.hitRatio < LOW_HIT_RATIO_THRESHOLD)
  if (lowHitTurns.length > 0) {
    console.log(`low hit ratio (< ${percent(LOW_HIT_RATIO_THRESHOLD)}) on: ${lowHitTurns.map(turnKey).join(", ")}`)
  }
  const explainedBreaks = turns.filter((t) => t.prefixBreak?.kind === "explained")
  if (explainedBreaks.length > 0) {
    console.log(`explained prefix breaks: ${explainedBreaks.map((t) => `${turnKey(t)} (${t.prefixBreak?.kind === "explained" ? describeExplainedBreak(t.prefixBreak) : ""})`).join(", ")}`)
  }
  const unexplainedBreaks = turns.filter((t) => t.prefixBreak?.kind === "unexplained")
  if (unexplainedBreaks.length > 0) {
    console.log(`UNEXPLAINED prefix break (read back < ${percent(PREFIX_READBACK_THRESHOLD)} of the previous prompt with identical request identity, no compaction, no mask advance, and no idle gap) on: ${unexplainedBreaks.map(turnKey).join(", ")} - the message history itself mutated`)
  }
}

type ExplainedBreak = Extract<NonNullable<TurnCacheReport["prefixBreak"]>, { kind: "explained" }>

/** The cause, and for an idle gap the idle time beside the retention that the
 *  previous request asked for, such as `idle-gap (idle 7m, requested 1h)`. */
function describeExplainedBreak(prefixBreak: ExplainedBreak): string {
  if (prefixBreak.cause !== "idle-gap") return prefixBreak.cause
  const idle = `idle ${Math.round(prefixBreak.idleMs / 60_000)}m`
  return `idle-gap (${prefixBreak.requestedRetention === undefined ? idle : `${idle}, requested ${prefixBreak.requestedRetention}`})`
}

function turnKey(turn: TurnCacheReport): string {
  return `${turn.requestIdentity.slice(0, 18)}#${turn.turn}`
}

function formatTurn(turn: TurnCacheReport): string {
  return [
    `turn=${turn.turn}`,
    `model=${turn.model} (${turn.accessProvider})`,
    `msgs=${turn.messageCount}`,
    `prompt=${turn.promptTokens === null ? "unknown" : formatTokens(turn.promptTokens)}`,
    `cache=${turn.cacheReadInputTokens === null ? "unreported " : formatTokens(turn.cacheReadInputTokens)}read/${formatTokens(turn.cacheCreationInputTokens)}create`,
    `hit=${turn.hitRatio === null ? "unknown" : percent(turn.hitRatio)}`,
    `sysHash=${shortHash(turn.systemPromptHash)}`,
    `toolHash=${shortHash(turn.toolSurfaceHash)}`,
  ].join(" | ") + formatBreakFlag(turn)
}

function formatBreakFlag(turn: TurnCacheReport): string {
  const prefixBreak = turn.prefixBreak
  if (!prefixBreak) return ""
  if (prefixBreak.kind === "explained") {
    return ` [prefix break: ${describeExplainedBreak(prefixBreak)}, lost ${formatTokens(prefixBreak.lostTokens)}]`
  }
  return ` ** UNEXPLAINED PREFIX BREAK (lost ${formatTokens(prefixBreak.lostTokens)}) **`
}

function shortHash(hash: string): string {
  return hash.slice(0, 8)
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function parseArgs(args: readonly string[]): CliArgsResult<CliOptions> {
  return parseArgsResult(() => parseArgsOrThrow(args))
}

function parseArgsOrThrow(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    help: false,
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg) continue
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true
        break
      case "--session":
      case "-s":
        options.sessionId = requiredValue(args, ++index, arg)
        break
      case "--json":
        options.json = true
        break
      default:
        throw new CliArgsError(`Unknown option: ${arg}`)
    }
  }
  if (options.help) return options
  if (!options.sessionId) throw new CliArgsError("--session <id> is required")
  return options
}

function usage(): string {
  return [
    "Usage:",
    "  flywheel dev cache-report --session <id> [options]",
    "",
    "Reports the provider-measured prompt-cache read-back per request for a",
    "session, joining model.requested + model.usage.recorded facts by",
    "requestId and pairing consecutive requests of the same conversation.",
    "Flags requests that failed to read back the previous prompt from cache",
    "without a cause that explains the break: an identity change (system",
    "prompt, tools, model, reasoning effort), compaction, a stale-mask",
    "advance, or an idle gap of 5 minutes or more (a possible expiry).",
    "Reads the event store of the project the root selected (--project-root, FLYWHEEL_PROJECT_ROOT, or discovery).",
    "",
    "Options:",
    "  -s, --session <id>    Session id to report.",
    "      --json            Print one JSON report object.",
  ].join("\n")
}
