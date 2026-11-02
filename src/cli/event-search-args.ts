import { CliArgsError, type CliArgsResult, parseArgsResult, parseTimeInput, requiredValue } from "../infra/cli-args.js"

export interface CliOptions {
  pattern?: string
  sessionId?: string
  requestId?: string
  typePatterns: string[]
  actor?: string
  errorsOnly: boolean
  caseSensitive: boolean
  regex: boolean
  json: boolean
  listTypes: boolean
  gaps: boolean
  count: boolean
  countField?: "type" | "actor"
  help: boolean
  limit: number
  order: "asc" | "desc"
  afterPosition: number
  sinceTimestamp?: number
  untilTimestamp?: number
  showGapColumn: boolean
  includeSnapshots: boolean
  aroundPosition?: number
  aroundRadius: number
  reconstructRequestId?: string
  timeoutSeconds: number
}

/** No search may hold a caller longer than this; agents run it unattended. */
export const MAX_TIMEOUT_SECONDS = 60

export function parseArgs(args: string[]): CliArgsResult<CliOptions> {
  return parseArgsResult(() => parseArgsOrThrow(args))
}

function parseArgsOrThrow(args: string[]): CliOptions {
  const options: CliOptions = {
    typePatterns: [],
    errorsOnly: false,
    caseSensitive: false,
    regex: false,
    json: false,
    listTypes: false,
    gaps: false,
    count: false,
    showGapColumn: false,
    help: false,
    limit: 80,
    order: "asc",
    afterPosition: 0,
    includeSnapshots: false,
    aroundRadius: 20,
    timeoutSeconds: 30,
  }
  const patternParts: string[] = []
  let positional = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg) continue

    if (positional) {
      patternParts.push(arg)
      continue
    }

    switch (arg) {
      case "--":
        positional = true
        break
      case "--help":
      case "-h":
        options.help = true
        break
      case "--session":
      case "-s":
        options.sessionId = requiredValue(args, ++index, arg)
        break
      case "--type":
      case "-t":
        options.typePatterns.push(requiredValue(args, ++index, arg))
        break
      case "--actor":
        options.actor = requiredValue(args, ++index, arg)
        break
      case "--errors":
        options.errorsOnly = true
        break
      case "--regex":
        options.regex = true
        break
      case "--case-sensitive":
        options.caseSensitive = true
        break
      case "--json":
        options.json = true
        break
      case "--list-types":
        options.listTypes = true
        break
      case "--gaps":
        options.gaps = true
        break
      case "--request":
        options.requestId = requiredValue(args, ++index, arg)
        break
      case "--since":
        options.sinceTimestamp = parseTimeInput(requiredValue(args, ++index, arg), arg)
        break
      case "--until":
        options.untilTimestamp = parseTimeInput(requiredValue(args, ++index, arg), arg)
        break
      case "--show-gaps":
        options.showGapColumn = true
        break
      case "--count":
        options.count = true
        options.countField = parseOptionalCountField(args, index + 1)
        if (options.countField) index++
        break
      case "--include-snapshots":
        options.includeSnapshots = true
        break
      case "--latest":
        options.order = "desc"
        break
      case "--limit":
      case "-n":
        options.limit = parseNonNegativeInt(requiredValue(args, ++index, arg), arg)
        break
      case "--after":
        options.afterPosition = parseNonNegativeInt(requiredValue(args, ++index, arg), arg)
        break
      case "--around":
        options.aroundPosition = parseNonNegativeInt(requiredValue(args, ++index, arg), arg)
        break
      case "--context":
      case "-C":
        options.aroundRadius = parseNonNegativeInt(requiredValue(args, ++index, arg), arg)
        break
      case "--reconstruct":
        options.reconstructRequestId = requiredValue(args, ++index, arg)
        break
      case "--timeout":
        options.timeoutSeconds = parseNonNegativeInt(requiredValue(args, ++index, arg), arg)
        if (options.timeoutSeconds < 1 || options.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
          throw new CliArgsError(`--timeout must be between 1 and ${MAX_TIMEOUT_SECONDS} seconds`)
        }
        break
      default:
        if (arg.startsWith("-")) throw new CliArgsError(`Unknown option: ${arg}`)
        patternParts.push(arg)
    }
  }

  if (patternParts.length > 0) options.pattern = patternParts.join(" ")
  return options
}

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new CliArgsError(`${flag} requires a non-negative integer`)
  return parsed
}

function parseOptionalCountField(args: string[], index: number): "type" | "actor" | undefined {
  const value = args[index]
  if (value === "type" || value === "actor") return value
  return undefined
}

export function eventSearchUsage(): string {
  return [
    "Usage:",
    "  flywheel events search [options] [pattern]",
    "",
    "Searches one merged, timestamp-ordered timeline from two sources: durable",
    "facts in .flywheel/flywheel.sqlite (tagged store) and diagnostics records in",
    ".flywheel/log/*.jsonl (tagged log, including Log output as log.<level>).",
    "",
    "Options:",
    "  -s, --session <id>         Restrict to one session id.",
    "  -t, --type <pattern>       Restrict event types in both sources. Repeatable. Supports * glob or substring.",
    "      --actor <actor>        Restrict actor.",
    "      --project-root <dir>   Project root whose .flywheel store and log are searched. Default: the current project.",
    "      --errors              Show failure-shaped events plus log.error/log.warn records.",
    "      --regex               Treat pattern as a JavaScript regular expression.",
    "      --case-sensitive      Disable default case-insensitive matching.",
    "      --latest              Show newest matches first.",
    "      --after <position>    Start after a store position; log records after that row's timestamp.",
    "      --around <position>   Search near a store position; log records inside the window's time span.",
    "  -C, --context <count>     Store-row radius for --around. Default: 20.",
    "  -n, --limit <count>        Maximum matches. Use 0 for no limit. Default: 80.",
    "      --gaps                Analyze stream silences (warmup + inter-delta gaps).",
    "      --request <id>        Restrict to one model request id.",
    "      --since <time>        Only events at/after epoch ms or ISO 8601 timestamp.",
    "      --until <time>        Only events at/before epoch ms or ISO 8601 timestamp.",
    "      --show-gaps           Append +<ms> since the previous match to each line.",
    "      --count [type|actor]  Count matches, optionally grouped by type or actor.",
    "      --list-types          Print event type counts with the source(s) each type appears in.",
    "                            Honors --session, --type, --actor, --since, --until, --after, and --around.",
    "      --include-snapshots   Include derived snapshot facts in broad searches.",
    "      --reconstruct <id>    Rebuild the full prompt for a request id (needs --session).",
    "      --json                Print JSON lines.",
    `      --timeout <seconds>   End the search after this long. Default: 30. Maximum: ${MAX_TIMEOUT_SECONDS}.`,
    "",
    "Recover a missed background result before rerunning work:",
    "  flywheel events search --session <sessionId> --type subagent.completed --latest --json",
    "  flywheel events search --session <workflowSessionId> --type handoff.written --latest --json",
    "  flywheel events search --session <sessionId> --type chat.entries.appended --latest --json",
    "A subagent.completed fact confirms the outcome but can contain only a preview",
    "and hash. handoff.written owns a workflow handoff; chat.entries.appended owns",
    "a notification already delivered into the parent conversation.",
    "",
    "Examples:",
    "  flywheel events search --session <sessionId> --errors",
    "  flywheel events search --session <sessionId> --around <position> -C 20",
    "  flywheel events search --type model.response --latest --limit 20",
    "  flywheel events search --type log.error --latest --limit 20",
    "  flywheel events search --session <sessionId> --reconstruct <requestId>",
    "  flywheel events search --session <sessionId> --gaps",
    "  flywheel events search --request <requestId> --show-gaps",
    "  flywheel events search --since 2026-06-02T18:00:00Z --count type",
    "  flywheel events search --list-types",
  ].join("\n")
}
