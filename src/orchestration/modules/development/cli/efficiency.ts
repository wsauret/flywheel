import * as fs from "node:fs"
import { CliArgsError, type CliArgsResult, parseArgsResult, parseTimeInput, requiredValue } from "../../../../infra/cli-args.js"
import { createSqliteEventStore } from "../../../../infra/sqlite-event-store.js"
import { errorMessage } from "../../../../infra/error-message.js"
import { formatDuration, formatTokens } from "../../../../protocol/client/format.js"
import { resolveEventStoreDbFile } from "../../../../infra/paths.js"
import {
  hasStepActivity,
  loadStepEfficiencyFromEvents,
  type StepEfficiencyEntry,
  type StepEfficiencyInterval,
  type StepEfficiencySummary,
  summarizeStepEfficiency,
} from "../diagnostics/step-efficiency-projection.js"
import type { CliVerb } from "../../../cli-contribution.js"

type Mode = "steps" | "interval"

interface CliOptions {
  mode: Mode
  sessionId?: string
  interval: StepEfficiencyInterval
  json: boolean
  help: boolean
}

/** Per-agent model, tool, and cost efficiency of one session, read from the
 *  project's event store the root selected. */
export const efficiencyVerb: CliVerb = {
  syntax: "efficiency [steps|interval] --session <id>",
  description: "Report per-agent model, tool, and cost efficiency for one session.",
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
        const events = [
          ...store.read({ aggregateId: `session:${options.sessionId}` }),
          ...store.read({ aggregateId: `workflow:${options.sessionId}` }),
        ].sort((left, right) => left.position - right.position)
        const entries = loadStepEfficiencyFromEvents(events, options.interval).filter((entry) =>
          options.mode === "steps" || hasStepActivity(entry)
        )
        printReport(options, dbPath, entries)
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

function printReport(options: CliOptions, dbPath: string, entries: StepEfficiencyEntry[]): void {
  const summary = summarizeStepEfficiency(entries)
  if (options.json) {
    console.log(JSON.stringify({
      sessionId: options.sessionId,
      mode: options.mode,
      dbPath,
      interval: options.interval,
      summary,
      entries,
    }))
    return
  }

  console.log(`${entries.length} attempt(s) in ${dbPath}`)
  if (options.mode === "interval") console.log(`interval ${formatInterval(options.interval)}`)
  for (const entry of entries) console.log(formatEntry(entry))
  console.log(formatSummary(summary))
}

function formatEntry(entry: StepEfficiencyEntry): string {
  return [
    `${entry.attemptId} ${entry.agentName}`,
    `status=${entry.status}`,
    entry.durationMs !== undefined ? `duration=${formatDuration(entry.durationMs)}` : "duration=?",
    `model=${entry.modelRequests} ok=${entry.successfulModelRequests} failed=${entry.failedModelRequests}`,
    `modelLatency=${formatDuration(entry.modelLatencyMs)}`,
    `tokens=${formatTokens(entry.inputTokens)}in/${formatTokens(entry.outputTokens)}out`,
    `cache=${formatTokens(entry.cacheReadInputTokens)}read/${formatTokens(entry.cacheCreationInputTokens)}create hit=${percent(entry.cacheHitRatio)}`,
    `reasoning=${formatTokens(entry.reasoningTokens)}`,
    `cost=${money(entry.costUsd)} parent=${money(entry.parentWorkerCostUsd)} subagents=${money(entry.subagentCostUsd)}`,
    `tools=${entry.toolCallCount}/${entry.toolCompletedCount} latency=${formatDuration(entry.toolLatencyMs)}`,
    `recoveries=${entry.outputRecoveryCount} semantic=${entry.semanticOutputRecoveryCount} byte=${entry.byteOutputRecoveryCount}`,
    `thinkingStalls=${entry.thinkingStallCount} escapeHatch=${entry.thinkingStallRecoveryCount}`,
    `subagents=${entry.subagentCount} failed=${entry.failedSubagentCount} duration=${formatDuration(entry.subagentDurationMs)}`,
  ].join(" | ")
}

function formatSummary(summary: StepEfficiencySummary): string {
  return [
    "TOTAL",
    `attempts=${summary.stepCount}`,
    `model=${summary.modelRequests} ok=${summary.successfulModelRequests} failed=${summary.failedModelRequests}`,
    `modelLatency=${formatDuration(summary.modelLatencyMs)}`,
    `tokens=${formatTokens(summary.inputTokens)}in/${formatTokens(summary.outputTokens)}out`,
    `cache=${formatTokens(summary.cacheReadInputTokens)}read/${formatTokens(summary.cacheCreationInputTokens)}create`,
    `reasoning=${formatTokens(summary.reasoningTokens)}`,
    `cost=${money(summary.costUsd)} parent=${money(summary.parentWorkerCostUsd)} subagents=${money(summary.subagentCostUsd)}`,
    `tools=${summary.toolCallCount} latency=${formatDuration(summary.toolLatencyMs)}`,
    `recoveries=${summary.outputRecoveryCount} semantic=${summary.semanticOutputRecoveryCount} byte=${summary.byteOutputRecoveryCount}`,
    `thinkingStalls=${summary.thinkingStallCount} escapeHatch=${summary.thinkingStallRecoveryCount}`,
    `subagents=${summary.subagentCount} failed=${summary.failedSubagentCount} duration=${formatDuration(summary.subagentDurationMs)}`,
  ].join(" | ")
}

function parseArgs(args: readonly string[]): CliArgsResult<CliOptions> {
  return parseArgsResult(() => parseArgsOrThrow(args))
}

function parseArgsOrThrow(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    mode: "steps",
    interval: {},
    json: false,
    help: false,
  }
  let index = 0
  if (args[0] === "steps" || args[0] === "interval") {
    options.mode = args[0]
    index = 1
  }
  for (; index < args.length; index++) {
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
      case "--after":
        options.interval.after = parseTimeInput(requiredValue(args, ++index, arg), arg)
        break
      case "--before":
        options.interval.before = parseTimeInput(requiredValue(args, ++index, arg), arg)
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
  if (options.mode === "interval" && options.interval.after === undefined && options.interval.before === undefined) {
    throw new CliArgsError("interval mode requires --after <time>, --before <time>, or both")
  }
  return options
}

function formatInterval(interval: StepEfficiencyInterval): string {
  const after = interval.after === undefined ? "-inf" : new Date(interval.after).toISOString()
  const before = interval.before === undefined ? "+inf" : new Date(interval.before).toISOString()
  return `${after}..${before}`
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function money(value: number): string {
  return `$${value.toFixed(6)}`
}

function usage(): string {
  return [
    "Usage:",
    "  flywheel dev efficiency steps --session <id> [options]",
    "  flywheel dev efficiency interval --session <id> --after <time> --before <time> [options]",
    "",
    "Reads the event store of the project the root selected (--project-root, FLYWHEEL_PROJECT_ROOT, or discovery).",
    "",
    "Options:",
    "  -s, --session <id>    Session id to report.",
    "      --after <time>    Epoch ms or ISO 8601 lower bound for interval mode.",
    "      --before <time>   Epoch ms or ISO 8601 upper bound for interval mode.",
    "      --json            Print one JSON report object.",
  ].join("\n")
}
