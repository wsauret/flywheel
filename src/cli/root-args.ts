import { isSubcommand } from "./subcommands.js"

export type RootCliAction =
  | {
    readonly kind: "run"
    readonly args: readonly string[]
    readonly projectRootOption?: string
    readonly allowPersistentProcesses?: true
    /** The terminal opens a project on a paired machine through the relay
     *  (PI-REMOTE-016) instead of a project on this machine. */
    readonly remote?: true
  }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string }

const PROJECT_ROOT_FLAG = "--project-root"
const ALLOW_PERSISTENT_PROCESSES_FLAG = "--allow-persistent-processes"
const REMOTE_FLAG = "--remote"
const BOOLEAN_LAUNCH_FLAGS = new Set(["--print-logs", "--headless", "--jsonl", "--one-shot", "--acp"])
const VALUE_LAUNCH_FLAGS = new Set(["--task", "--system-prompt", "--model", "--effort", "--deadline-seconds", "--disable-tool", "--auth-profile", "--auth-snapshot", "--session"])
const HELP_FLAGS = new Set(["--help", "-h"])
const VERSION_FLAGS = new Set(["--version", "-v"])

/** Classify the root argument vector. Invocation-only root options are startup
 * input rather than subcommand arguments, so they are extracted here and the
 * surviving arguments are what the subcommand router and launch modes see.
 * A literal `--` ends option parsing: everything after it belongs to the
 * subcommand. Only a bare first word asks the subcommand table, so a launch
 * with no subcommand never loads the module catalog here. */
export async function rootCliAction(args: readonly string[]): Promise<RootCliAction> {
  const extracted = extractRootLaunchOptions(args)
  if (!extracted.ok) return { kind: "error", message: extracted.message }
  const rest = extracted.rest
  const run: RootCliAction = {
    kind: "run",
    args: rest,
    ...(extracted.value === undefined ? {} : { projectRootOption: extracted.value }),
    ...(extracted.allowPersistentProcesses ? { allowPersistentProcesses: true as const } : {}),
    ...(extracted.remote ? { remote: true as const } : {}),
  }

  const first = rest[0]
  if (extracted.remote) {
    if (extracted.value !== undefined) return { kind: "error", message: `${REMOTE_FLAG} opens a project on another machine; it is not valid with ${PROJECT_ROOT_FLAG}` }
    if (first !== undefined && !first.startsWith("-")) return { kind: "error", message: `${REMOTE_FLAG} opens the terminal; it is not valid with a subcommand` }
    if (rest.includes("--headless")) return { kind: "error", message: `${REMOTE_FLAG} opens the terminal; it is not valid with --headless` }
  }
  if (rest.length === 0) return run
  if (first && await isSubcommand(first)) return run
  if (first && !first.startsWith("-")) return { kind: "error", message: `Unknown subcommand or argument: ${first}` }
  if (rest.some((arg) => VERSION_FLAGS.has(arg))) return { kind: "version" }
  if (rest.some((arg) => HELP_FLAGS.has(arg))) return { kind: "help" }
  const isHeadlessLaunch = rest.includes("--headless")
  // Remove this refusal after 2027-04-30.
  if (isHeadlessLaunch && rest.some((arg) => ["--description", "--workflow"].some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) {
    return { kind: "error", message: 'Headless workflow mode is retired: --description and --workflow no longer start a workflow. Run "flywheel --headless" for a headless chat, whose agent writes and launches workflows, or "flywheel --headless --task <text>" for one direct task.' }
  }
  const hasDeadline = rest.some((arg) => arg === "--deadline-seconds" || arg.startsWith("--deadline-seconds="))
  if (hasDeadline && !isHeadlessLaunch) return { kind: "error", message: "Unknown option: --deadline-seconds" }
  if (rest.includes("--jsonl") && !isHeadlessLaunch) return { kind: "error", message: "--jsonl is only valid with --headless" }
  const hasSystemPrompt = rest.some((arg) => arg === "--system-prompt" || arg.startsWith("--system-prompt="))
  const hasDirectTask = rest.some((arg) => arg === "--task" || arg.startsWith("--task="))
  const hasSession = rest.some((arg) => arg === "--session" || arg.startsWith("--session="))
  if (hasSession && (!isHeadlessLaunch || hasDirectTask)) return { kind: "error", message: "--session is only valid with headless chat" }
  if (rest.includes("--one-shot") && (!isHeadlessLaunch || hasDirectTask)) return { kind: "error", message: "--one-shot is only valid with headless chat" }
  if (rest.includes("--acp") && (!isHeadlessLaunch || hasDirectTask || hasSession || rest.includes("--one-shot"))) return { kind: "error", message: "--acp is only valid with headless chat, without --session or --one-shot" }
  if (isHeadlessLaunch && !hasDirectTask && hasDeadline) return { kind: "error", message: "--deadline-seconds is only valid with --task; chat settings use protocol mutations" }
  if (hasSystemPrompt && (!isHeadlessLaunch || !hasDirectTask)) return { kind: "error", message: "--system-prompt is only valid with --headless --task" }
  const hasModel = rest.some((arg) => arg === "--model" || arg.startsWith("--model="))
  if (hasModel && (!isHeadlessLaunch || !hasDirectTask)) return { kind: "error", message: "--model is only valid with --headless --task" }
  const hasEffort = rest.some((arg) => arg === "--effort" || arg.startsWith("--effort="))
  if (hasEffort && !hasModel) return { kind: "error", message: "--effort is only valid with --model" }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg) continue
    if (BOOLEAN_LAUNCH_FLAGS.has(arg)) continue
    if (isValueFlagWithEquals(arg)) {
      const flag = arg.slice(0, arg.indexOf("="))
      if (!isHeadlessLaunch) return { kind: "error", message: `Unknown option: ${flag}` }
      if (arg.length === flag.length + 1) return { kind: "error", message: `${flag} requires a value` }
      continue
    }
    if (VALUE_LAUNCH_FLAGS.has(arg)) {
      const result = validateLaunchValueFlag(rest, index, isHeadlessLaunch)
      if (result.action) return result.action
      index = result.nextIndex
      continue
    }
    if (arg.startsWith("-")) return { kind: "error", message: `Unknown option: ${arg}` }
    return { kind: "error", message: `Unknown subcommand or argument: ${arg}` }
  }

  return run
}

type RootLaunchOptionsExtraction =
  | {
    readonly ok: true
    readonly value?: string
    readonly allowPersistentProcesses: boolean
    readonly remote: boolean
    readonly rest: readonly string[]
  }
  | { readonly ok: false; readonly message: string }

/** Splits the invocation-only root options from the arguments the command
 *  reads. It reads no subcommand table. */
function extractRootLaunchOptions(args: readonly string[]): RootLaunchOptionsExtraction {
  const rest: string[] = []
  let value: string | undefined
  let allowPersistentProcesses = false
  let remote = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === "--") {
      rest.push(...args.slice(index))
      break
    }
    if (arg === ALLOW_PERSISTENT_PROCESSES_FLAG) {
      allowPersistentProcesses = true
      continue
    }
    if (arg === REMOTE_FLAG) {
      remote = true
      continue
    }
    const separated = arg === PROJECT_ROOT_FLAG
    const joined = arg.startsWith(`${PROJECT_ROOT_FLAG}=`)
    if (!separated && !joined) {
      rest.push(arg)
      continue
    }
    if (value !== undefined) return { ok: false, message: `${PROJECT_ROOT_FLAG} may be given once` }
    const given = separated ? args[++index] : arg.slice(PROJECT_ROOT_FLAG.length + 1)
    if (!given || given.startsWith("--")) return { ok: false, message: `${PROJECT_ROOT_FLAG} requires a value` }
    value = given
  }
  return value === undefined
    ? { ok: true, allowPersistentProcesses, remote, rest }
    : { ok: true, value, allowPersistentProcesses, remote, rest }
}

interface LaunchValueValidation {
  readonly nextIndex: number
  readonly action?: RootCliAction
}

function validateLaunchValueFlag(
  args: readonly string[],
  index: number,
  isHeadlessLaunch: boolean,
): LaunchValueValidation {
  const arg = args[index]
  if (!arg) return { nextIndex: index }
  if (!isHeadlessLaunch) return { nextIndex: index, action: { kind: "error", message: `Unknown option: ${arg}` } }
  const nextIndex = index + 1
  const value = args[nextIndex]
  if (!value || value.startsWith("--")) {
    return { nextIndex, action: { kind: "error", message: `${arg} requires a value` } }
  }
  return { nextIndex }
}

function isValueFlagWithEquals(arg: string): boolean {
  const equals = arg.indexOf("=")
  return equals > 0 && VALUE_LAUNCH_FLAGS.has(arg.slice(0, equals))
}
