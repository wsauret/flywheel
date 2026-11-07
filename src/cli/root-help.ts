// The root help as data. `flywheel --help` and the generated CLI reference
// (`bun run docs:generate`) both read it, so the two cannot disagree. It
// stays plain data on the startup path; only the module catalog loads lazily.

import type { CliVerbSummary } from "../orchestration/cli-contribution.js"
import type { FirstPartyModule } from "../orchestration/modules.js"
import { HEADLESS_FORMS } from "./headless-args.js"
import { SUBCOMMANDS } from "./subcommands.js"

const ROOT_SYNOPSIS = [
  "flywheel [options]",
  "flywheel <subcommand> [args]",
] as const

/** The summary paragraphs. The help wraps each one on lines of its own; the
 *  reference joins them. */
const ROOT_SUMMARY = [
  "Running flywheel with no arguments starts the interactive TUI. An explicit --project-root or FLYWHEEL_PROJECT_ROOT wins, then an established ancestor .flywheel directory. Otherwise, an interactive terminal chooses between the nearest Git root and starting directory before project services start. Once .flywheel is created, later launches discover and reuse that project root. Silent and headless invocations use the same explicit and established precedence, then silently use the nearest Git root or current directory.",
  "The account home is a project only when --project-root names it. A terminal paired with another machine also offers that machine's projects when it asks.",
  "Account-global settings live in ~/.flywheel/flywheel.toml.",
] as const

interface RootOptionForm {
  readonly syntax: string
  readonly note?: string
}

interface RootOption {
  readonly flags: string
  readonly description: string
  /** The invocations the option starts, which the help lists under it. */
  readonly forms?: readonly RootOptionForm[]
}

const ROOT_OPTIONS: readonly RootOption[] = [
  { flags: "-h, --help", description: "Show this help and exit." },
  { flags: "-v, --version", description: "Print the Flywheel version and exit." },
  { flags: "--project-root <dir>", description: "Directory that owns durable project state. Overrides FLYWHEEL_PROJECT_ROOT, established .flywheel discovery, and interactive or silent fallback selection." },
  { flags: "--remote", description: "Choose a project on a machine this terminal is paired with, and open it through the relay. Pair a machine with 'flywheel remote machines add <link>'." },
  { flags: "--print-logs", description: "Mirror structured logs to stderr. While the TUI draws on the terminal, only a redirected stderr gets them." },
  {
    flags: "--headless",
    description: "Run without the TUI for CI/automation:",
    forms: HEADLESS_FORMS,
  },
  { flags: "--task <text>", description: "Run one direct headless task through the shared production runner." },
  { flags: "--deadline-seconds <n>", description: "Positive finite deadline in seconds for --task." },
  { flags: "--system-prompt <text>", description: "Replace the full direct-task system prompt. The override is recorded in session request-audit history and is not secret input." },
  { flags: "--model <id>", description: "Run a direct headless task on this model instead of the configured chat role." },
  { flags: "--effort <level>", description: "Reasoning effort for --model." },
  { flags: "--disable-tool <name>", description: "Disable one active first-party tool for a headless chat or direct task." },
  { flags: "--auth-profile <profile>", description: "Select the auth profile for a headless chat or direct task." },
  { flags: "--session <id>", description: "Attach an existing headless chat without automatic Resume." },
  { flags: "--one-shot", description: "Return after durable handoff and owned work settle; plain parking is incomplete." },
  { flags: "--acp", description: "Speak Agent Client Protocol version 1 on standard input and output instead of the JSONL channel." },
  { flags: "--unattended", description: "With --acp, run one unattended prompt. Omit built-in chat review, publication, and communication guidance. Omit the skill tool, its catalog, and ask_user." },
  { flags: "--auth-snapshot <path>", description: "Consume a matching one-use auth snapshot from a trusted source." },
  { flags: "--jsonl", description: "Write versioned JSONL progress and terminal records." },
  { flags: "--allow-persistent-processes", description: "Allow tools to start processes that survive this invocation." },
]

const ROOT_EXAMPLES = [
  "flywheel events search --errors --latest",
  "flywheel auth login --copilot",
] as const

interface CliNounSummary {
  readonly noun: string
  readonly verbs: readonly CliVerbSummary[]
}

interface RootHelp {
  readonly synopsis: readonly string[]
  readonly summary: readonly string[]
  /** The nouns the kernel table owns, in its order. */
  readonly kernel: readonly CliNounSummary[]
  /** The nouns the module catalog contributes. */
  readonly contributed: readonly CliNounSummary[]
  readonly options: readonly RootOption[]
  readonly examples: readonly string[]
}

/** The root help of a module catalog. A catalog other than the installed one
 *  is the reference generator's or a test's. */
export async function rootHelp(modules?: readonly FirstPartyModule[]): Promise<RootHelp> {
  const { installedCliNouns } = await import("../orchestration/modules.js")
  return {
    synopsis: ROOT_SYNOPSIS,
    summary: ROOT_SUMMARY,
    kernel: Object.entries(SUBCOMMANDS).map(([noun, { verbs }]) => ({ noun, verbs })),
    contributed: [...installedCliNouns(modules)].map(([noun, { verbs }]) => ({ noun, verbs: Object.values(verbs) })),
    options: ROOT_OPTIONS,
    examples: ROOT_EXAMPLES,
  }
}

/** `flywheel <noun> <verb syntax>`, without the program name. */
export function commandSyntax(noun: string, verb: CliVerbSummary): string {
  return verb.syntax === "" ? noun : `${noun} ${verb.syntax}`
}

const HELP_WIDTH = 80
const COMMAND_COLUMN = 28
const OPTION_COLUMN = 19

/** Greedy word wrap of `text` that starts at column `indent` and ends by the
 *  help width. The caller places the first line; every later line carries the
 *  indent. A bracketed group, such as an optional flag with its value, wraps
 *  as one word, and a word longer than the width keeps a line of its own. */
function wrap(text: string, indent: number): string {
  const lines = [""]
  for (const word of text.match(/\[[^\]]*\]\S*|\S+/g) ?? []) {
    const line = lines.at(-1) ?? ""
    if (line === "") lines[lines.length - 1] = word
    else if (indent + line.length + 1 + word.length > HELP_WIDTH) lines.push(word)
    else lines[lines.length - 1] = `${line} ${word}`
  }
  return lines.join(`\n${" ".repeat(indent)}`)
}

/** A help row: the description at `column`, wrapped to the help width. A
 *  label that reaches the column keeps the description on its line when the
 *  whole row fits, and otherwise the description takes a line of its own. */
function row(label: string, description: string, column: number): string {
  if (label.length < column) return `${label.padEnd(column)}${wrap(description, column)}`
  if (label.length + 2 + description.length <= HELP_WIDTH) return `${label}  ${description}`
  return `${label}\n${" ".repeat(column)}${wrap(description, column)}`
}

/** An option row, then each invocation it starts on lines of its own; an
 *  invocation that does not fit continues further indented. */
function optionRow({ flags, description, forms = [] }: RootOption): string[] {
  return [
    row(`  ${flags}`, description, OPTION_COLUMN),
    ...forms.map(({ syntax, note }) => `${" ".repeat(OPTION_COLUMN)}${wrap(note === undefined ? syntax : `${syntax} (${note})`, OPTION_COLUMN + 2)}`),
  ]
}

/** The root help. Kernel and module subcommands share one row layout. */
export async function rootUsage(modules?: readonly FirstPartyModule[]): Promise<string> {
  const { synopsis: [first, ...more], summary, kernel, contributed, options, examples } = await rootHelp(modules)
  return [
    `Usage: ${first}`,
    ...more.map((line) => `       ${line}`),
    "",
    ...summary.map((paragraph) => wrap(paragraph, 0)),
    "",
    "Subcommands:",
    ...[...kernel, ...contributed].flatMap(({ noun, verbs }) => verbs.map((verb) => row(`  ${commandSyntax(noun, verb)}`, verb.description, COMMAND_COLUMN))),
    "",
    "Options:",
    ...options.flatMap(optionRow),
    "",
    "Examples:",
    ...examples.map((example) => `  ${example}`),
    "",
    "Run 'flywheel <subcommand> --help' for subcommand details.",
  ].join("\n")
}
