import { describe, expect, test } from "bun:test"
import { PassThrough, Writable } from "node:stream"

import { chooseStartupDirectory, PromptCancelled, promptCancelledExitCode, promptFromReadline } from "../../../src/cli/readline-prompt.js"
import { apiKeyHint } from "../../../src/infra/auth/api-key-hint.js"
import type { StartupDirectoryFallbackCandidate } from "../../../src/infra/directory-authorities.js"

const STARTUP_CANDIDATES: readonly StartupDirectoryFallbackCandidate[] = [
  { kind: "git-root", path: "/repo" },
  { kind: "starting-directory", path: "/repo/packages/app" },
]
const QUESTION = "Enter the Exa API key: "
const QUESTION_LINE = `${QUESTION.trimEnd()}\r\n`
// The key uses only characters that no question, label, or escape sequence
// in the output contains, so any key character in the output is a leak.
const KEY_ALPHABET = "BCDFGHJLMNOQSTUVWXYZ"
const KEY = KEY_ALPHABET.repeat(2)
const REDRAW = "\r\u001b[2K"
const ENTER = "\r"
const BACKSPACE = "\u007f"
const CTRL_C = "\u0003"
const CTRL_D = "\u0004"
const CTRL_U = "\u0015"

function fakeTerminal({ columns = 80, inputTTY = true, outputTTY = true } = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: inputTTY, setRawMode: () => input })
  const chunks: string[] = []
  const output = Object.assign(
    new Writable({ write: (chunk, _encoding, done) => { chunks.push(String(chunk)); done() } }),
    { isTTY: outputTTY, columns },
  )
  const written = () => chunks.join("")
  const counterRows = () => written().split(REDRAW).slice(1).map((draw) => draw.split("\r")[0]!)
  return {
    input,
    output,
    written,
    draws: () => counterRows().length,
    /** Every counter row that the prompt drew, without the line end that follows the last one. */
    counterRows,
    /** The text of the most recent counter row. */
    counter: () => counterRows().at(-1),
  }
}

/** Lets the line editor read what the test typed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function keyCharacters(text: string): string {
  return [...text].filter((char) => KEY_ALPHABET.includes(char)).join("")
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1
}

describe("promptFromReadline secret answers on a terminal", () => {
  test("print the question once and redraw only a count that follows the line editor", async () => {
    const terminal = fakeTerminal()
    const answer = promptFromReadline(QUESTION, { secret: true }, terminal)
    expect(terminal.written().startsWith(QUESTION_LINE)).toBe(true)

    terminal.input.write("B")
    await settle()
    expect(terminal.counter()).toBe("1 character")

    const before = terminal.draws()
    terminal.input.write(KEY)
    await settle()
    expect(terminal.draws()).toBe(before + 1)
    expect(terminal.counter()).toBe("41 characters")

    terminal.input.write(`${BACKSPACE}${BACKSPACE}`)
    await settle()
    expect(terminal.counter()).toBe("39 characters")

    terminal.input.write(CTRL_U)
    await settle()
    expect(terminal.counter()).toBe("")

    terminal.input.write(KEY)
    await settle()
    terminal.input.write(ENTER)

    expect(await answer).toBe(KEY)
    expect(occurrences(terminal.written(), QUESTION.trimEnd())).toBe(1)
    const confirmation = `\r\nReceived API key ••••${KEY.slice(-4)}.\n`
    expect(terminal.written().endsWith(confirmation)).toBe(true)
    expect(keyCharacters(terminal.written().slice(0, -confirmation.length))).toBe("")
  })

  test("draw the count again when the terminal resizes, even when the count is unchanged", async () => {
    const terminal = fakeTerminal()
    const answer = promptFromReadline(QUESTION, { secret: true }, terminal)
    terminal.input.write(KEY)
    await settle()
    const before = terminal.draws()

    terminal.output.columns = 8
    terminal.output.emit("resize")
    await settle()
    expect(terminal.draws()).toBe(before + 1)
    expect(terminal.counter()).toBe("40")

    terminal.input.write(ENTER)
    await answer
    const afterAnswer = terminal.draws()
    terminal.output.emit("resize")
    await settle()
    expect(terminal.draws()).toBe(afterAnswer)
  })

  test("keep the question whole and every counter row in one plain-text row of a narrow terminal", async () => {
    for (const columns of [30, 12, 3]) {
      const terminal = fakeTerminal({ columns })
      const answer = promptFromReadline(QUESTION, { secret: true }, terminal)
      terminal.input.write("BC")
      await settle()
      terminal.input.write(KEY)
      await settle()
      terminal.input.write(ENTER)
      await answer

      expect(terminal.written().startsWith(QUESTION_LINE)).toBe(true)
      const rows = terminal.counterRows()
      expect(rows.length).toBeGreaterThan(2)
      for (const row of rows) {
        expect(row).toMatch(/^[\x20-\x7e]*$/)
        expect(row.length).toBeLessThan(columns)
      }
      expect(terminal.counter()).toBe(columns > 14 ? "42 characters" : "42")
    }
  })

  test.each([
    ["a long key shows the stored-key hint", "BCDFGHJLMNOQ", "Received API key ••••MNOQ."],
    ["a short key shows the same hint as when it is stored", "B", `Received API key ${apiKeyHint("B")}.`],
    ["a command reference shows the stored-key hint for a command", "!op read op://vault/exa", "Received API key !command."],
  ])("confirm the answer on Enter: %s", async (_name, key, confirmation) => {
    const terminal = fakeTerminal()
    const answer = promptFromReadline(QUESTION, { secret: true }, terminal)
    terminal.input.write(`${key}${ENTER}`)

    expect(await answer).toBe(key)
    expect(terminal.written()).toEndWith(`\r\n${confirmation}\n`)
    expect(confirmation).toBe(`Received API key ${apiKeyHint(key)}.`)
    expect(terminal.counter()).toBe(`${key.length} ${key.length === 1 ? "character" : "characters"}`)
  })

  test.each([
    ["Ctrl+C", `${KEY}${CTRL_C}`, "interrupt"],
    ["Ctrl+D", `${KEY}${CTRL_U}${CTRL_D}`, "no-answer"],
  ] as const)("cancel with %s and leave no key text", async (_name, keys, reason) => {
    const terminal = fakeTerminal()
    const answer = promptFromReadline(QUESTION, { secret: true }, terminal)
    terminal.input.write(keys)

    await expect(answer).rejects.toBeInstanceOf(PromptCancelled)
    await expect(answer).rejects.toMatchObject({ reason })
    expect(keyCharacters(terminal.written())).toBe("")
    expect(terminal.written()).not.toContain("Received")
    expect(terminal.written()).toEndWith("\r\n")
  })

  test("end with no answer when its signal aborts, as when a browser finished the login first", async () => {
    const terminal = fakeTerminal()
    const settled = new AbortController()
    const answer = promptFromReadline(QUESTION, { signal: settled.signal }, terminal)
    settled.abort()

    await expect(answer).rejects.toMatchObject({ reason: "no-answer" })
    const aborted = fakeTerminal()
    await expect(promptFromReadline(QUESTION, { secret: true, signal: settled.signal }, aborted)).rejects.toMatchObject({ reason: "no-answer" })
    expect(aborted.input.listenerCount("keypress")).toBe(0)
    expect(aborted.output.listenerCount("resize")).toBe(0)
  })

  test.each([
    ["a piped answer", { inputTTY: false, outputTTY: false }],
    ["a terminal answer whose output is captured", { inputTTY: true, outputTTY: false }],
  ])("print only the question and a newline for %s", async (_name, streams) => {
    const terminal = fakeTerminal(streams)
    const answer = promptFromReadline(QUESTION, { secret: true }, terminal)
    terminal.input.write(`${KEY}${streams.inputTTY ? ENTER : "\n"}`)

    expect(await answer).toBe(KEY)
    expect(terminal.written()).toBe(`${QUESTION}\n`)
  })
})

describe("chooseStartupDirectory", () => {
  test("maps terminal project choices, asks again after an invalid answer, and cancels on an empty one", async () => {
    expect(await chooseStartupDirectory(STARTUP_CANDIDATES, async () => "1")).toBe("git-root")
    expect(await chooseStartupDirectory(STARTUP_CANDIDATES, async () => "2")).toBe("starting-directory")
    const answers = ["3", "two", "2"]
    const questions: string[] = []
    expect(await chooseStartupDirectory(STARTUP_CANDIDATES, async (question) => {
      questions.push(question)
      return answers.shift() ?? ""
    })).toBe("starting-directory")
    expect(questions.slice(1)).toEqual(["3 is not a choice. Enter 1 or 2: ", "two is not a choice. Enter 1 or 2: "])
    const cancelled: unknown = await chooseStartupDirectory(STARTUP_CANDIDATES, async () => "").catch((error: unknown) => error)
    if (!(cancelled instanceof PromptCancelled)) throw new Error("an empty answer cancels the choice")
    expect(promptCancelledExitCode(cancelled)).toBe(1)
  })

  test("offers a project on a paired machine as a third choice only when the terminal is paired", async () => {
    const questions: string[] = []
    const paired = ["3"]
    expect(await chooseStartupDirectory(STARTUP_CANDIDATES, async (question) => { questions.push(question); return paired.shift() ?? "" }, { pairedMachines: 1 })).toBe("another-machine")
    expect(questions[0]).toContain("  3. A project on a paired machine")
    expect(questions[0]).toEndWith("Choice [1-3]: ")
    const answers = ["3", "1"]
    expect(await chooseStartupDirectory(STARTUP_CANDIDATES, async () => answers.shift() ?? "")).toBe("git-root")
  })
})
