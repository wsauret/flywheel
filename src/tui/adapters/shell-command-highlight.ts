import { bold as stBold, fg as stFg, type RGBA, type TextChunk } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/resolve.js"

// A command-line is parsed positionally, not as a full shell grammar: the
// leading word of each command is the program, a following bareword is the
// subcommand for known multi-command drivers, `-`-prefixed words are flags,
// and quotes/operators/variables get their own scope colors. This reproduces
// the grouped "highlight the command" look while staying calm — plain
// args keep normal text color and the program is bold so the hierarchy
// survives without color. Full grammar highlighting (highlight.js bash) is the
// wrong tool here: it leaves program names and flags uncolored and miscolors
// subcommands that collide with shell builtins (e.g. `git log`).

// Operators that start a new command, so the next word is a program again.
const COMMAND_SEPARATORS = new Set(["|", "&", ";", "(", ")"])

// Drivers whose second bareword is a meaningful subcommand worth its own color.
const MULTITOOLS = new Set([
  "git", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "cargo", "go", "deno",
  "docker", "podman", "kubectl", "helm", "terraform", "gh", "brew", "pip",
  "pip3", "apt", "apt-get", "systemctl", "make", "rustup", "dotnet", "composer",
  "gradle", "mvn", "rails", "rake", "poetry", "uv",
])

type Phase = "program" | "after-program" | "rest"

type ShellToken =
  | { kind: "whitespace" | "quoted" | "variable"; text: string }
  | { kind: "operator"; text: string; resetsCommand: boolean }
  | { kind: "word"; text: string }

interface ScanResult {
  token: ShellToken
  nextIndex: number
}

interface HighlightState {
  phase: Phase
  program: string
}

const isWordBoundary = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === '"' || c === "'" || c === "$" ||
  c === "|" || c === "&" || c === ";" || c === "(" || c === ")" ||
  c === ">" || c === "<"

export function highlightShellCommand(command: string, theme: TuiTheme): TextChunk[] {
  const chunks: TextChunk[] = []
  const state: HighlightState = { phase: "program", program: "" }
  let i = 0
  while (i < command.length) {
    const scan = scanShellToken(command, i)
    appendShellToken(chunks, scan.token, state, theme)
    i = scan.nextIndex
  }
  return chunks
}

function appendShellToken(chunks: TextChunk[], token: ShellToken, state: HighlightState, theme: TuiTheme): void {
  switch (token.kind) {
    case "whitespace":
      pushShellChunk(chunks, token.text, theme.text)
      // A newline starts a new command line, so the next word is a program again.
      if (token.text.includes("\n")) state.phase = "program"
      return
    case "quoted":
      pushShellChunk(chunks, token.text, theme.chatCodeString)
      if (state.phase === "program") state.phase = "rest"
      return
    case "variable":
      pushShellChunk(chunks, token.text, theme.chatCodeVariable)
      if (state.phase === "program") state.phase = "rest"
      return
    case "operator":
      pushShellChunk(chunks, token.text, theme.chatCodeOperator)
      if (token.resetsCommand) state.phase = "program"
      return
    case "word":
      appendShellWord(chunks, token.text, state, theme)
      return
  }
}

function appendShellWord(chunks: TextChunk[], word: string, state: HighlightState, theme: TuiTheme): void {
  const isFlag = word.startsWith("-")
  if (state.phase === "program") {
    if (/^[A-Za-z_]\w*=/.test(word)) {
      pushShellChunk(chunks, word, theme.chatCodeVariable)
    } else if (isFlag) {
      pushShellChunk(chunks, word, theme.chatCodeKeyword)
      state.phase = "rest"
    } else {
      state.program = word
      pushShellChunk(chunks, word, theme.chatCodeFunction, true)
      state.phase = "after-program"
    }
    return
  }
  if (state.phase === "after-program") {
    pushShellChunk(chunks, word, isFlag ? theme.chatCodeKeyword : MULTITOOLS.has(state.program) ? theme.chatCodeType : theme.text)
    state.phase = "rest"
    return
  }
  pushShellChunk(chunks, word, isFlag ? theme.chatCodeKeyword : theme.text)
}

function pushShellChunk(chunks: TextChunk[], text: string, color: RGBA, emphasize = false): void {
  if (!text) return
  const chunk = stFg(color)(text)
  chunks.push(emphasize ? stBold(chunk) : chunk)
}

const isSpacing = (c: string): boolean => c === " " || c === "\t" || c === "\n"

function scanShellToken(command: string, index: number): ScanResult {
  const ch = command.charAt(index)
  if (isSpacing(ch)) return scanWhitespace(command, index)
  if (ch === '"' || ch === "'") return scanQuoted(command, index, ch)
  const variable = scanVariable(command, index)
  if (variable) return variable
  const operator = scanOperator(command, index)
  if (operator) return operator
  return scanWord(command, index)
}

function scanWhitespace(command: string, index: number): ScanResult {
  let nextIndex = index + 1
  // SAFETY: charAt returns "" past the end, which isSpacing rejects.
  while (nextIndex < command.length && isSpacing(command.charAt(nextIndex))) nextIndex++
  return { token: { kind: "whitespace", text: command.slice(index, nextIndex) }, nextIndex }
}

function scanQuoted(command: string, index: number, quote: string): ScanResult {
  let nextIndex = index + 1
  while (nextIndex < command.length) {
    if (quote === '"' && command[nextIndex] === "\\") { nextIndex += 2; continue }
    if (command[nextIndex] === quote) { nextIndex++; break }
    nextIndex++
  }
  return { token: { kind: "quoted", text: command.slice(index, nextIndex) }, nextIndex }
}

function scanVariable(command: string, index: number): ScanResult | null {
  if (command.charAt(index) !== "$" || index + 1 >= command.length) return null
  let nextIndex = index + 1
  if (command.charAt(nextIndex) === "{") {
    while (nextIndex < command.length && command.charAt(nextIndex) !== "}") nextIndex++
    if (nextIndex < command.length) nextIndex++
  } else {
    while (nextIndex < command.length && /\w/.test(command.charAt(nextIndex))) nextIndex++
  }
  return nextIndex > index + 1
    ? { token: { kind: "variable", text: command.slice(index, nextIndex) }, nextIndex }
    : null
}

function scanOperator(command: string, index: number): ScanResult | null {
  const two = command.slice(index, index + 2)
  if (two === "||" || two === "&&" || two === ">>" || two === "<<") {
    return { token: { kind: "operator", text: two, resetsCommand: two === "||" || two === "&&" }, nextIndex: index + 2 }
  }
  const ch = command.charAt(index)
  if (!COMMAND_SEPARATORS.has(ch) && ch !== ">" && ch !== "<") return null
  return { token: { kind: "operator", text: ch, resetsCommand: COMMAND_SEPARATORS.has(ch) }, nextIndex: index + 1 }
}

function scanWord(command: string, index: number): ScanResult {
  let nextIndex = index + 1
  while (nextIndex < command.length && !isWordBoundary(command.charAt(nextIndex))) nextIndex++
  return { token: { kind: "word", text: command.slice(index, nextIndex) }, nextIndex }
}
