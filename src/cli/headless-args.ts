import { canonicalModelId } from "../infra/llm/model-id.js"

export const HEADLESS_USAGE =
  "Usage: flywheel --headless [--session <id>] [--one-shot] [--disable-tool <name>]... [--jsonl]\n" +
  "       flywheel --headless --acp [--disable-tool <name>]... [--auth-profile <profile>] [--auth-snapshot <absolute-path>]\n" +
  "       flywheel --headless --task <text> [--system-prompt <text>] [--model <id|tier>] [--effort <level>] [--disable-tool <name>]... [--auth-profile <profile>] [--auth-snapshot <absolute-path>] [--deadline-seconds <seconds>] [--jsonl]\n\n" +
  "  --headless       Run without TUI (CI/automation)\n" +
  "  --session        Attach an existing chat without resuming its interrupted turn.\n" +
  "  --one-shot       Return after durable handoff and owned work settle; plain parking is incomplete.\n" +
  "  --acp            Speak Agent Client Protocol version 1 on stdin and stdout instead of the JSONL channel.\n" +
  "  --task           Run one direct task through the shared production runner.\n" +
  "  --system-prompt  Replace the complete system prompt for a direct headless task; recorded in request-audit history, not secret input.\n" +
  "  --model          Use a model ID or an enabled-model tier (cheap, mid, powerful) instead of the configured chat role.\n" +
  "  --effort         Reasoning effort for --model (defaults to the chat role's effort).\n" +
  "  --auth-profile   Profile ID or unique display name.\n" +
  "  --auth-snapshot  Absolute path to a matching one-use snapshot from a trusted source.\n" +
  "  --disable-tool   Disable one active first-party tool for this invocation. Repeatable.\n" +
  "  --deadline-seconds\n" +
  "                   Positive finite deadline for --task.\n" +
  "  --jsonl         Write the versioned JSONL contract to stdout.\n" +
  "  --allow-persistent-processes\n" +
  "                   Allow tools to start processes that survive this invocation.\n"

export function hasHeadlessFlag(argv: readonly string[]): boolean {
  return argv.includes("--headless")
}

export function headlessTask(argv: readonly string[]): string | undefined {
  const task = readFlagArg(argv, "--task")
  return task && task.length > 0 ? task : undefined
}

export function headlessSystemPrompt(argv: readonly string[]): string | undefined {
  const values = readFlagArgs(argv, "--system-prompt")
  if (values.length === 0) return undefined
  if (!hasHeadlessFlag(argv) || !headlessTask(argv)) throw new Error("--system-prompt is only valid with --headless --task")
  if (values.some((value) => value.length === 0)) throw new Error("--system-prompt requires a non-empty value")
  if (values.length > 1) throw new Error("--system-prompt must not be repeated")
  return values[0]
}

/** Model override for a direct headless task. A tier resolves against the
 *  captured profile's enabled catalog; a concrete ID remains fixed. */
export function headlessModel(argv: readonly string[]): string | undefined {
  const value = readFlagArg(argv, "--model")
  if (value === undefined) return undefined
  if (!hasHeadlessFlag(argv) || !headlessTask(argv)) throw new Error("--model is only valid with --headless --task")
  if (value.length === 0) throw new Error("--model requires a non-empty value")
  return canonicalModelId(value)
}

export function headlessEffort(argv: readonly string[]): string | undefined {
  const value = readFlagArg(argv, "--effort")
  if (value === undefined) return undefined
  if (headlessModel(argv) === undefined) throw new Error("--effort is only valid with --model")
  if (value.length === 0) throw new Error("--effort requires a non-empty value")
  return value
}


export function headlessAuthProfile(argv: readonly string[]): string | undefined {
  const value = readFlagArg(argv, "--auth-profile")
  return value && value.length > 0 ? value : undefined
}

export function headlessAuthSnapshot(argv: readonly string[]): string | undefined {
  const value = readFlagArg(argv, "--auth-snapshot")
  return value && value.length > 0 ? value : undefined
}

export function headlessDeadlineSeconds(argv: readonly string[]): number | undefined {
  const value = readFlagArg(argv, "--deadline-seconds")
  if (value === undefined) return undefined
  if (!hasHeadlessFlag(argv)) throw new Error("--deadline-seconds is only valid with --headless")
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--deadline-seconds requires a positive finite number")
  return seconds
}

export function headlessDisabledTools(argv: readonly string[]): readonly string[] {
  const values: string[] = []
  const flag = "--disable-tool"
  const prefix = `${flag}=`
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === flag) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--") || value.length === 0) throw new Error("--disable-tool requires a non-empty canonical tool name")
      values.push(value)
      index += 1
    } else if (arg?.startsWith(prefix)) {
      const value = arg.slice(prefix.length)
      if (value.length === 0) throw new Error("--disable-tool requires a non-empty canonical tool name")
      values.push(value)
    }
  }
  if (values.length > 0 && !hasHeadlessFlag(argv)) throw new Error("--disable-tool is only valid with --headless")
  if (new Set(values).size !== values.length) throw new Error("--disable-tool names must not contain duplicates")
  return values
}

/** Headless chat framed as Agent Client Protocol version 1. An ACP client
 *  opens its own session and ends it by closing input, so root argument
 *  classification refuses the flag with a direct task, an attached session,
 *  or one-shot return. */
export function hasHeadlessAcpFlag(argv: readonly string[]): boolean {
  return argv.includes("--acp")
}

export function hasHeadlessJsonlFlag(argv: readonly string[]): boolean {
  if (!argv.includes("--jsonl")) return false
  if (!hasHeadlessFlag(argv)) throw new Error("--jsonl is only valid with --headless")
  return true
}

export function needsHeadlessUsage(argv: readonly string[]): boolean {
  return hasHeadlessFlag(argv) && !isHeadlessChat(argv) && !headlessTask(argv)
}

/** Headless runs a chat unless it selects a direct task. */
export function isHeadlessChat(argv: readonly string[]): boolean {
  return hasHeadlessFlag(argv) && !argv.some((arg) => arg === "--task" || arg.startsWith("--task="))
}

export function headlessSession(argv: readonly string[]): string | undefined {
  return readFlagArg(argv, "--session")
}

function readFlagArg(argv: readonly string[], flag: string) {
  const prefix = `${flag}=`
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === flag) {
      const value = argv[index + 1]
      return value?.startsWith("--") ? undefined : value
    }
    if (arg?.startsWith(prefix)) return arg.slice(prefix.length)
  }
}

function readFlagArgs(argv: readonly string[], flag: string): string[] {
  const values: string[] = []
  const prefix = `${flag}=`
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === flag) {
      const value = argv[index + 1]
      values.push(value === undefined || value.startsWith("--") ? "" : value)
      index += 1
    } else if (arg?.startsWith(prefix)) {
      values.push(arg.slice(prefix.length))
    }
  }
  return values
}
