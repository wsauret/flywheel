#!/usr/bin/env bun

import { invalidateSupersededModuleFacts } from "../orchestration/modules.js"
import type { SupersededFactInvalidationResult } from "../orchestration/module-seams.js"
import { errorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import { resolveEventStoreDbFile } from "../infra/paths.js"
import {
  pruneRetiredFactFamilies,
  pruneSupersededFacts,
  readEventStoreMaintenanceStats,
  shouldVacuum,
  vacuumEventStore,
  type EventStoreMaintenanceStats,
  type RetiredFamilyPruneResult,
  type SupersededFactPruneResult,
  type VacuumResult,
} from "../orchestration/session/event-store-maintenance.js"
import { dedupToolContent, type ToolContentDedupResult } from "../orchestration/migrations/tool-content-dedup.js"
import { CliArgsError, type CliArgsResult, parseArgsResult } from "../infra/cli-args.js"
import { ContainedDirectory } from "../infra/descriptor-directory.js"
import { FLYWHEEL_DIR_NAME } from "../infra/directory-authorities.js"
import { acquireProjectStateGeneration, type ProjectStateLease } from "../orchestration/project-state-lease.js"

interface MaintainOptions {
  stats: boolean
  dryRun: boolean
  prune: boolean
  pruneSuperseded: boolean
  invalidateQueues: boolean
  dedupToolContent: boolean
  vacuum: boolean
  full: boolean
  force: boolean
  json: boolean
  help: boolean
}

interface MaintenanceOutput {
  [key: string]: unknown
}

interface DryRunReport {
  readonly retiredRows: number
  readonly retiredPayloadBytes: number
  readonly vacuumThresholdWouldBeMet: boolean
}

/** Maintains one project's event store. `projectRoot` is selected by the caller
 *  at its composition boundary; this command never resolves a project
 *  directory, so the log it opens and the SQLite store it maintains are always
 *  the same project. */
export async function runMaintain(argv: readonly string[], projectRoot: string): Promise<void> {
  const parsed = parseArgs([...argv])
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
  await Log.init({ dir: projectRoot })
  try {
    const dbPath = resolveEventStoreDbFile(projectRoot)
    const stats = readEventStoreMaintenanceStats(dbPath)
    if (!stats.storeFound) {
      console.error(`No Flywheel SQLite event store found at ${dbPath}`)
      process.exitCode = 1
      return
    }

    const output: MaintenanceOutput = { dbPath }
    const writes = options.invalidateQueues || options.prune || options.pruneSuperseded || options.dedupToolContent || options.vacuum || options.full
    // A write holds the project's state generation exclusively for the whole
    // run, the same window a runtime start takes, so no runtime can have the
    // store open while rows are deleted or rewritten under it. A live runtime
    // would keep its search and summary indexes past rows that no longer
    // exist, and their watermarks only move forward.
    const generation = writes ? exclusiveGeneration(projectRoot) : undefined
    if (generation === "held") {
      console.error("A Flywheel process has this project open. Close its sessions, or run `flywheel kill`, then run this command again.")
      process.exitCode = 1
      return
    }
    try {
      await maintain(dbPath, stats, options, output)
    } finally {
      generation?.release()
    }
  } catch (err) {
    console.error(errorMessage(err))
    console.error("")
    console.error(usage())
    process.exitCode = 1
  }
}

/** The exclusive window over this project's state generation, or `held` when
 *  another process owns it. The window is released on refusal, so the refusal
 *  never keeps a runtime from starting. */
function exclusiveGeneration(projectRoot: string): ProjectStateLease | "held" {
  const flywheel = ContainedDirectory.openExisting(projectRoot, [FLYWHEEL_DIR_NAME])
  if (!flywheel) throw new Error(`this project holds no Flywheel state: ${projectRoot}`)
  const generation = acquireProjectStateGeneration(flywheel)
  if (!generation.otherOwnersLive) return generation
  generation.release()
  return "held"
}

async function maintain(dbPath: string, stats: EventStoreMaintenanceStats, options: MaintainOptions, output: MaintenanceOutput): Promise<void> {
  if (options.stats || options.full) {
    output.stats = stats
    if (!options.json) console.log(formatStats(stats))
  }
  if (options.dryRun) {
    const dryRun = dryRunReport(stats)
    output.dryRun = dryRun
    if (!options.json) console.log(formatDryRun(dryRun))
  }
  if (options.invalidateQueues || options.full) {
    const result = invalidateSupersededModuleFacts(dbPath)
    output.invalidateSupersededQueues = result
    if (!options.json) console.log(formatQueueInvalidation(result))
  }
  if (options.prune || options.full) {
    const result = await pruneRetiredFactFamilies(dbPath)
    output.prune = result
    if (!options.json) console.log(formatPrune(result))
  }
  if (options.pruneSuperseded || options.full) {
    const result = pruneSupersededFacts(dbPath)
    output.pruneSuperseded = result
    if (!options.json) console.log(formatSupersededPrune(result))
  }
  let dedupRewroteFacts = false
  if (options.dedupToolContent) {
    const result = dedupToolContent(dbPath)
    dedupRewroteFacts = result.factsRewritten > 0
    output.dedupToolContent = result
    if (!options.json) console.log(formatDedup(result))
  }
  // The vacuum is the CLI's to run and no other caller's: this command is the
  // one entry point that can be invoked with no session open, which a
  // whole-file rebuild requires. Pruning always offers it, so freed pages are
  // reclaimed in the same run instead of needing a second command. A dedup
  // run that rewrote facts forces it: in-place payload rewrites leave
  // interior page slack the freelist threshold cannot see, so the threshold
  // under-reports exactly when this action reclaims the most.
  if (options.vacuum || options.full || options.prune || options.pruneSuperseded || options.dedupToolContent) {
    const result = vacuumEventStore(dbPath, { force: options.force || dedupRewroteFacts })
    output.vacuum = result
    if (!options.json) console.log(formatVacuum(result))
  }
  if (options.json) console.log(JSON.stringify(output))
}

function parseArgs(args: string[]): CliArgsResult<MaintainOptions> {
  return parseArgsResult(() => parseArgsOrThrow(args))
}

function parseArgsOrThrow(args: string[]): MaintainOptions {
  const options: MaintainOptions = {
    stats: false,
    dryRun: false,
    prune: false,
    pruneSuperseded: false,
    invalidateQueues: false,
    dedupToolContent: false,
    vacuum: false,
    full: false,
    force: false,
    json: false,
    help: false,
  }

  for (const arg of args) {
    if (!arg) continue
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true
        break
      case "--stats":
        options.stats = true
        break
      case "--dry-run":
        options.dryRun = true
        break
      case "--prune-retired":
        options.prune = true
        break
      case "--prune-superseded":
        options.pruneSuperseded = true
        break
      case "--invalidate-superseded-queues":
        options.invalidateQueues = true
        break
      case "--dedup-tool-content":
        options.dedupToolContent = true
        break
      case "--vacuum":
        options.vacuum = true
        break
      case "--full":
        options.full = true
        break
      case "--force":
        options.force = true
        break
      case "--json":
        options.json = true
        break
      default:
        throw new CliArgsError(`Unknown option: ${arg}`)
    }
  }

  if (!options.stats && !options.dryRun && !options.prune && !options.pruneSuperseded && !options.invalidateQueues && !options.dedupToolContent && !options.vacuum && !options.full) options.stats = true
  return options
}

function dryRunReport(stats: EventStoreMaintenanceStats): DryRunReport {
  const reclaimableAfterPrune = stats.reclaimableBytes + stats.retiredPayloadBytes
  return {
    retiredRows: stats.retiredRowCount,
    retiredPayloadBytes: stats.retiredPayloadBytes,
    vacuumThresholdWouldBeMet: shouldVacuum({ dbFileSize: stats.dbFileSize, reclaimableBytes: reclaimableAfterPrune }),
  }
}

function formatStats(stats: EventStoreMaintenanceStats): string {
  const lines = [
    `Event store: ${stats.dbPath}`,
    `DB size: ${formatBytes(stats.dbFileSize)}; WAL: ${formatBytes(stats.walFileSize)}`,
    `SQLite pages: ${stats.pageCount} x ${formatBytes(stats.pageSize)}; free ${stats.freelistCount} (${formatBytes(stats.reclaimableBytes)} reclaimable)`,
    `Retired-family rows: ${stats.retiredRowCount} (${formatBytes(stats.retiredPayloadBytes)} payload)`,
    "",
    "Top event types by row count:",
    ...stats.topByRowCount.map((row) => `  ${String(row.count).padStart(8)}  ${row.type} (${formatBytes(row.payloadBytes)})`),
    "",
    "Top event types by payload bytes:",
    ...stats.topByPayloadBytes.map((row) => `  ${formatBytes(row.payloadBytes).padStart(10)}  ${row.type} (${row.count} row(s))`),
  ]
  return lines.join("\n")
}

function formatDryRun(report: DryRunReport): string {
  return [
    "Dry run:",
    `  retired-family rows eligible for deletion: ${report.retiredRows}`,
    `  retired-family payload bytes: ${formatBytes(report.retiredPayloadBytes)}`,
    `  vacuum threshold would be met after prune: ${report.vacuumThresholdWouldBeMet}`,
  ].join("\n")
}

function formatPrune(result: RetiredFamilyPruneResult): string {
  return [
    "Prune retired fact families:",
    ...result.deletedByType.map((family) => `  ${String(family.count).padStart(8)}  ${family.type} (${formatBytes(family.payloadBytes)})`),
    `  total rows deleted: ${result.rowsDeleted} (${formatBytes(result.payloadBytesDeleted)} payload)`,
  ].join("\n")
}

function formatSupersededPrune(result: SupersededFactPruneResult): string {
  return [
    "Prune superseded facts:",
    ...result.deletedByType.map((family) => `  ${String(family.count).padStart(8)}  ${family.type} (${formatBytes(family.payloadBytes)})`),
    `  total rows deleted: ${result.rowsDeleted} (${formatBytes(result.payloadBytesDeleted)} payload)`,
    `  unreferenced tool content deleted: ${result.contentRowsDeleted} row(s) (${formatBytes(result.contentBytesDeleted)})`,
  ].join("\n")
}

function formatQueueInvalidation(result: SupersededFactInvalidationResult): string {
  if (result.invalidated.length === 0) return "Invalidate superseded queues:\n  no superseded queue facts found"
  return [
    "Invalidate superseded queues:",
    ...result.invalidated.map((entry) => `  ${entry.aggregateId}: deleted ${entry.rowsDeleted} row(s) (${entry.supersededFacts.join(", ")})`),
    `  total rows deleted: ${result.rowsDeleted}`,
  ].join("\n")
}

function formatDedup(result: ToolContentDedupResult): string {
  const lines = ["Dedup tool content:"]
  if (result.sessions.length === 0 && result.skipped.length === 0) {
    lines.push("  no sessions hold inline tool text over the threshold")
  }
  for (const session of result.sessions) {
    lines.push(`  ${session.sessionId}: rewrote ${session.factsRewritten} fact(s), wrote ${session.contentRowsWritten} content row(s), moved ${formatBytes(session.payloadBytesMoved)} out of payloads`)
  }
  for (const session of result.skipped) {
    lines.push(`  ${session.sessionId}: skipped, left inline (${session.reason})`)
  }
  lines.push(`  total: ${result.sessions.length} session(s) converted, ${result.factsRewritten} fact(s) rewritten, ${result.contentRowsWritten} content row(s), ${formatBytes(result.payloadBytesMoved)} moved out of payloads`)
  return lines.join("\n")
}

function formatVacuum(result: VacuumResult): string {
  if (!result.storeFound) return `No Flywheel SQLite event store found at ${result.dbPath}`
  if (result.skippedReason) return `Vacuum skipped: ${result.skippedReason}; reclaimable ${formatBytes(result.before.reclaimableBytes)}`
  const beforeBytes = result.before.dbFileSize + result.before.walFileSize
  const afterBytes = result.after ? result.after.dbFileSize + result.after.walFileSize : beforeBytes
  return [
    "Vacuum:",
    `  before: ${formatBytes(beforeBytes)} (${formatBytes(result.before.reclaimableBytes)} reclaimable)`,
    `  after: ${formatBytes(afterBytes)}`,
    `  reclaimed: ${formatBytes(Math.max(0, beforeBytes - afterBytes))}`,
  ].join("\n")
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let value = bytes / 1024
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]
    if (value < 1024 || index === units.length - 1) return `${value.toFixed(1)} ${unit}`
    value /= 1024
  }
  return `${bytes} B`
}

function usage(): string {
  return [
    "Usage:",
    "  flywheel events maintain [options]",
    "",
    "Options:",
    "      --stats                       Report store size, free pages, top event types, and retired-family rows.",
    "      --dry-run                     Report what pruning would change without writing.",
    "      --prune-retired               Delete all rows of retired fact families, then run thresholded vacuum.",
    "      --prune-superseded            Delete rows a newer row of the same live value replaced, as the retention registry declares, and the tool content no remaining fact references, then run thresholded vacuum.",
    "      --invalidate-superseded-queues  Delete workflow-queue facts whose schema versions are no longer registered.",
    "      --dedup-tool-content          One-time conversion of existing sessions' inline tool text to shared content rows, then a vacuum (forced when facts were rewritten). Safe to re-run (a converted session is a no-op).",
    "      --vacuum                      Run thresholded WAL checkpoint + VACUUM + checkpoint.",
    "      --full                        Run stats, queue invalidation, both prunes, then thresholded vacuum.",
    "      --force                       Bypass vacuum thresholds when used with --vacuum or --full.",
    "      --json                        Print one JSON object.",
    "  -h, --help                        Show this help.",
    "",
    "Every option that writes refuses while a Flywheel process has the project open,",
    "and keeps the project from opening until it finishes.",
  ].join("\n")
}
