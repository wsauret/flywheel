import { describe, expect, it } from "bun:test"
import { RGBA, type TextChunk } from "@opentui/core"
import { highlightShellCommand } from "@tui/adapters/shell-command-highlight.js"
import flywheelTheme from "@tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme, type TuiTheme } from "@tui/context/theme/resolve.js"

// Distinct colors per role, so each assertion proves which role a token got.
const theme: TuiTheme = {
  ...resolveTheme(flywheelTheme, "dark"),
  text: RGBA.fromHex("#cccccc"),
  textSubtle: RGBA.fromHex("#777777"),
  chatCodeKeyword: RGBA.fromHex("#c678dd"),
  chatCodeType: RGBA.fromHex("#e5c07b"),
  chatCodeString: RGBA.fromHex("#98c379"),
  chatCodeFunction: RGBA.fromHex("#61afef"),
  chatCodeVariable: RGBA.fromHex("#e06c75"),
  chatCodeOperator: RGBA.fromHex("#56b6c2"),
}

// Bold is encoded as a bit in the attributes field; any nonzero attributes on a
// foreground chunk produced here means bold was applied.
const isBold = (chunk: TextChunk): boolean => (chunk.attributes ?? 0) !== 0

function colorOf(chunks: TextChunk[], text: string): RGBA | undefined {
  return chunks.find((c) => c.text === text)?.fg
}

function reconstruct(chunks: TextChunk[]): string {
  return chunks.map((c) => c.text).join("")
}

describe("highlightShellCommand", () => {
  it("is lossless: chunk texts concatenate back to the original command", () => {
    const cmd = `FOO=bar git log --oneline -6 | grep 'x' && echo "$HOME/done"`
    expect(reconstruct(highlightShellCommand(cmd, theme))).toBe(cmd)
  })

  it("bolds the program and colors the subcommand for known multitools", () => {
    const chunks = highlightShellCommand("git log --oneline -6", theme)
    const git = chunks.find((c) => c.text === "git")
    expect(git?.fg?.equals(theme.chatCodeFunction)).toBe(true)
    expect(git === undefined ? false : isBold(git)).toBe(true)
    expect(colorOf(chunks, "log")?.equals(theme.chatCodeType)).toBe(true)
    expect(colorOf(chunks, "--oneline")?.equals(theme.chatCodeKeyword)).toBe(true)
    expect(colorOf(chunks, "-6")?.equals(theme.chatCodeKeyword)).toBe(true)
  })

  it("does not treat the second word as a subcommand for non-multitools", () => {
    const chunks = highlightShellCommand("echo hello", theme)
    expect(colorOf(chunks, "echo")?.equals(theme.chatCodeFunction)).toBe(true)
    expect(colorOf(chunks, "hello")?.equals(theme.text)).toBe(true)
  })

  it("colors strings, variables, and operators, and restarts the program after a pipe", () => {
    const chunks = highlightShellCommand(`cat 'a b' | wc -l`, theme)
    expect(colorOf(chunks, "'a b'")?.equals(theme.chatCodeString)).toBe(true)
    expect(colorOf(chunks, "|")?.equals(theme.chatCodeOperator)).toBe(true)
    // `wc` is the program of the second command, so it is bold + function-colored.
    const wc = chunks.find((c) => c.text === "wc")
    expect(wc?.fg?.equals(theme.chatCodeFunction)).toBe(true)
    expect(wc === undefined ? false : isBold(wc)).toBe(true)
  })

  it("treats VAR= as an assignment prefix without consuming the program slot", () => {
    const chunks = highlightShellCommand("NODE_ENV=prod npm run build", theme)
    expect(colorOf(chunks, "NODE_ENV=prod")?.equals(theme.chatCodeVariable)).toBe(true)
    const npm = chunks.find((c) => c.text === "npm")
    expect(npm?.fg?.equals(theme.chatCodeFunction)).toBe(true)
    expect(npm === undefined ? false : isBold(npm)).toBe(true)
    expect(colorOf(chunks, "run")?.equals(theme.chatCodeType)).toBe(true)
  })

  it("colors a $VARIABLE token", () => {
    const chunks = highlightShellCommand("echo $HOME", theme)
    expect(colorOf(chunks, "$HOME")?.equals(theme.chatCodeVariable)).toBe(true)
  })

  it("is lossless across embedded newlines and restarts the program per line", () => {
    const cmd = "python3 - <<'EOF'\nimport json\nEOF"
    const chunks = highlightShellCommand(cmd, theme)
    expect(reconstruct(chunks)).toBe(cmd)
    const importChunk = chunks.find((c) => c.text === "import")
    expect(importChunk?.fg?.equals(theme.chatCodeFunction)).toBe(true)
    expect(importChunk === undefined ? false : isBold(importChunk)).toBe(true)
  })
})
