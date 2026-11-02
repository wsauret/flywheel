import { createInterface } from "node:readline"
import { Writable } from "node:stream"

import { apiKeyHint } from "../infra/auth/api-key-hint.js"
import type {
  StartupDirectoryFallback,
  StartupDirectoryFallbackCandidate,
} from "../infra/directory-authorities.js"

/** How a person can end a prompt without an answer: an empty answer or the
 *  end of input (Ctrl+D, or a closed pipe), or an interrupt (Ctrl+C). */
type PromptCancelReason = "no-answer" | "interrupt"

/** A prompt that ended with no answer. The command that asked stops and exits
 *  non-zero, because nothing was chosen or stored. */
export class PromptCancelled extends Error {
  constructor(readonly reason: PromptCancelReason) {
    super(reason === "interrupt" ? "Interrupted" : "No answer was entered")
    this.name = "PromptCancelled"
  }
}

/** The exit status of a command that a prompt cancellation ended. An interrupt
 *  uses the shell convention for Ctrl+C. */
export function promptCancelledExitCode(cancelled: PromptCancelled): number {
  return cancelled.reason === "interrupt" ? 130 : 1
}

interface PromptOptions {
  /** Hides a secret key while it is typed. On a terminal, a row under the
   *  question shows how many characters arrived, and Enter confirms the key
   *  by its stored-key hint. */
  readonly secret?: boolean
  /** Ends the prompt with no answer when another source settled the question
   *  first, such as a browser that finished a login. */
  readonly signal?: AbortSignal
}

/** The streams a prompt reads and writes: the process terminal, or fakes in a test. */
interface PromptTerminal {
  readonly input: NodeJS.ReadableStream & { readonly isTTY?: boolean }
  readonly output: NodeJS.WritableStream & { readonly isTTY?: boolean, readonly columns?: number }
}

export type ReadlinePrompt = (question: string, options?: PromptOptions) => Promise<string>

const CLEAR_ROW = "\r\u001b[2K"

/** Asks one question on the terminal and resolves with the trimmed answer.
 *  Rejects with `PromptCancelled` when input ends or the person presses
 *  Ctrl+C before an answer. A secret answer is never echoed. On a terminal,
 *  the question prints once on its own line, the row under it shows only the
 *  character count, and Enter prints the key's stored-key hint. Piped input
 *  or captured output gets no count and no hint. */
export function promptFromReadline(question: string, options: PromptOptions = {}, terminal: PromptTerminal = { input: process.stdin, output: process.stdout }): Promise<string> {
  const { input, output } = terminal
  const secret = options.secret === true
  const counter = secret && input.isTTY === true && output.isTTY === true
  // For a secret, the line editor writes its echo into a sink, so the typed
  // characters never reach the terminal.
  const echo = secret ? new Writable({ write: (_chunk, _encoding, done) => done() }) : output
  let answered = false
  let drawPending = false
  const drawCounter = (length: number) => {
    drawPending = false
    if (!answered) output.write(`${CLEAR_ROW}${characterCountRow(length, output.columns || 80)}`)
  }
  // The count redraws after every keystroke and every resize. A paste emits
  // one keypress for each character, so one microtask draws once after the
  // whole chunk, from the line that the editor holds after the last key.
  const scheduleDraw = () => {
    if (drawPending) return
    drawPending = true
    queueMicrotask(() => drawCounter(rl.line.length))
  }
  // The question prints before the line editor turns on raw mode, so a line
  // feed in the question also returns the carriage.
  if (counter) output.write(`${question.trimEnd()}\r\n`)
  else if (secret) output.write(question)
  // Each prompt has its own line editor, so a history only keeps the answer,
  // which for a secret is the key, in memory.
  const rl = createInterface({ input, output: echo, terminal: input.isTTY === true, historySize: 0 })
  // Raw mode can turn off the terminal's own carriage return on a line feed.
  const newline = counter ? "\r\n" : "\n"
  if (counter) {
    input.on("keypress", scheduleDraw)
    output.on("resize", scheduleDraw)
    // After Ctrl+Z and `fg`, the shell has written below the prompt, and the
    // line editor stays paused until something resumes it.
    rl.on("SIGCONT", () => {
      output.write(`${CLEAR_ROW}${question.trimEnd()}\r\n`)
      scheduleDraw()
      rl.resume()
    })
  }
  return new Promise((resolve, reject) => {
    const cancel = (reason: PromptCancelReason) => {
      if (answered) return
      answered = true
      output.write(newline)
      rl.close()
      reject(new PromptCancelled(reason))
    }
    const settled = () => cancel("no-answer")
    rl.on("SIGINT", () => cancel("interrupt"))
    rl.on("close", () => {
      input.off("keypress", scheduleDraw)
      output.off("resize", scheduleDraw)
      options.signal?.removeEventListener("abort", settled)
      cancel("no-answer")
    })
    if (options.signal?.aborted) {
      settled()
      return
    }
    options.signal?.addEventListener("abort", settled, { once: true })
    rl.question(secret ? "" : question, (answer) => {
      // Enter in a paste chunk arrives before the chunk's scheduled draw.
      if (counter) drawCounter(answer.length)
      answered = true
      if (secret) output.write(newline)
      rl.close()
      const trimmed = answer.trim()
      if (counter && trimmed !== "") output.write(`Received API key ${apiKeyHint(trimmed)}.\n`)
      resolve(trimmed)
    })
  })
}

/** The count of characters that the line editor holds. The row is plain
 *  ASCII, a number and one word at most, and stays narrower than the
 *  terminal. It never shows a wide character, and only a window narrower
 *  than the row can wrap it, so one row clear replaces it after a resize. */
function characterCountRow(length: number, columns: number): string {
  if (length === 0) return ""
  const room = Math.max(0, columns - 1)
  const count = `${length} ${length === 1 ? "character" : "characters"}`
  return count.length <= room ? count : String(length).slice(0, room)
}

/** Presents the two startup fallback authorities before project services exist,
 * and a project on a paired machine as a third choice when this terminal is
 * paired with one (PI-REMOTE-016). Returns the selected semantic authority,
 * not its display position or path. An answer that names no choice asks
 * again; an empty answer, the end of input, or Ctrl+C rejects with
 * `PromptCancelled`. */
export async function chooseStartupDirectory(
  candidates: readonly StartupDirectoryFallbackCandidate[],
  prompt: ReadlinePrompt = promptFromReadline,
  options: { readonly pairedMachines?: number } = {},
): Promise<StartupDirectoryFallback | "another-machine"> {
  const gitRoot = candidates.find((candidate) => candidate.kind === "git-root")
  const startingDirectory = candidates.find((candidate) => candidate.kind === "starting-directory")
  if (!gitRoot || !startingDirectory) throw new Error("Project selection requires Git-root and starting-directory candidates")

  const elsewhere = (options.pairedMachines ?? 0) > 0
  const last = elsewhere ? 3 : 2
  let question = [
    "Select the Flywheel project root:",
    `  1. Git root: ${gitRoot.path}`,
    `  2. Starting directory: ${startingDirectory.path}`,
    ...(elsewhere ? ["  3. A project on a paired machine"] : []),
    `Choice [1-${last}]: `,
  ].join("\n")
  while (true) {
    const answer = await prompt(question)
    if (answer === "1") return "git-root"
    if (answer === "2") return "starting-directory"
    if (answer === "3" && elsewhere) return "another-machine"
    if (answer === "") throw new PromptCancelled("no-answer")
    question = `${answer} is not a choice. Enter ${elsewhere ? "1, 2, or 3" : "1 or 2"}: `
  }
}
