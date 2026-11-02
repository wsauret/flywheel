import { describe, expect, it } from "bun:test"
import { RGBA, type TextChunk } from "@opentui/core"
import { highlightExecuteInputs, highlightToolDetail, linkifyChunks } from "@tui/adapters/tool-detail-highlight.js"
import { resolveTheme, type TuiTheme } from "@tui/context/theme/resolve.js"
import flywheelTheme from "@tui/context/theme/flywheel.json" with { type: "json" }

const theme: TuiTheme = {
  ...resolveTheme(flywheelTheme, "dark"),
  text: RGBA.fromHex("#cccccc"),
  textMuted: RGBA.fromHex("#999999"),
  textSubtle: RGBA.fromHex("#777777"),
  chatCodeString: RGBA.fromHex("#98c379"),
  chatCodeFunction: RGBA.fromHex("#61afef"),
  chatCodeType: RGBA.fromHex("#e5c07b"),
  chatCodeKeyword: RGBA.fromHex("#c678dd"),
  chatCodeVariable: RGBA.fromHex("#e06c75"),
  chatCodeOperator: RGBA.fromHex("#56b6c2"),
}

const reconstruct = (chunks: TextChunk[]): string => chunks.map((c) => c.text).join("")
const colorOf = (chunks: TextChunk[], text: string): RGBA | undefined =>
  chunks.find((c) => c.text === text)?.fg

describe("highlightToolDetail", () => {
  it("shows only the basename (with range suffix) for a linked file read, plain text", () => {
    const chunks = highlightToolDetail("file_read", "src/tui/output-blocks/tool-row.tsx:1-20", theme, "file:///w/src/tui/output-blocks/tool-row.tsx")
    expect(reconstruct(chunks)).toBe("tool-row.tsx:1-20")
    expect(colorOf(chunks, "tool-row.tsx:1-20")?.equals(theme.text)).toBe(true)
  })

  it("keeps a link-less read identifier whole, so a skill resource path survives", () => {
    const chunks = highlightToolDetail("file_read", "implementation/references/guide.md", theme)
    expect(reconstruct(chunks)).toBe("implementation/references/guide.md")
  })

  it("renders a list path as plain text", () => {
    const chunks = highlightToolDetail("list", "src/workflows/queue", theme)
    expect(reconstruct(chunks)).toBe("src/workflows/queue")
    expect(chunks.every((c) => c.fg?.equals(theme.text))).toBe(true)
  })

  it("renders search detail plain with only the scope connective dimmed", () => {
    const chunks = highlightToolDetail("search", '"foo.*bar" in src', theme)
    expect(reconstruct(chunks)).toBe('"foo.*bar" in src')
    expect(colorOf(chunks, '"foo.*bar"')?.equals(theme.text)).toBe(true)
    expect(colorOf(chunks, " in ")?.equals(theme.textMuted)).toBe(true)
    expect(colorOf(chunks, "src")?.equals(theme.text)).toBe(true)
  })

  it("delegates shell_exec to the command tokenizer (program is bright, not subtle)", () => {
    const chunks = highlightToolDetail("shell_exec", "ls -la", theme)
    expect(colorOf(chunks, "ls")?.equals(theme.chatCodeFunction)).toBe(true)
  })

  it("uses normal text (not subtle) for unspecialized actions", () => {
    const chunks = highlightToolDetail("task_subagent", "[explorer] map the codebase", theme)
    expect(chunks.every((c) => c.fg?.equals(theme.text))).toBe(true)
  })

  it("execute rows: keys are accent, spaced values stay one plain chunk", () => {
    const chunks = highlightExecuteInputs("[project=Graph Matching, assignee=me, limit=100]", theme)
    expect(reconstruct(chunks)).toBe("[project=Graph Matching, assignee=me, limit=100]")
    expect(colorOf(chunks, "project")?.equals(theme.chatCodeFunction)).toBe(true)
    expect(colorOf(chunks, "Graph Matching")?.equals(theme.text)).toBe(true)
    expect(colorOf(chunks, "limit")?.equals(theme.chatCodeFunction)).toBe(true)
    expect(colorOf(chunks, "[")?.equals(theme.textMuted)).toBe(true)
    expect(colorOf(chunks, "=")?.equals(theme.textMuted)).toBe(true)
  })

  it("execute rows: a comma inside a value does not split the pair", () => {
    const chunks = highlightExecuteInputs("[q=a, b, limit=5]", theme)
    expect(reconstruct(chunks)).toBe("[q=a, b, limit=5]")
    expect(colorOf(chunks, "a, b")?.equals(theme.text)).toBe(true)
  })

  it("execute rows: a non-bracket detail stays plain", () => {
    const chunks = highlightExecuteInputs("no primitives", theme)
    expect(reconstruct(chunks)).toBe("no primitives")
    expect(chunks.every((c) => c.fg?.equals(theme.text))).toBe(true)
  })

  it("execute rows: text reconstructs exactly even for ambiguous values", () => {
    // A value containing `, key=` mis-accents (documented heuristic limit),
    // but the rendered text must never change.
    const chunks = highlightExecuteInputs("[q=closed], fake=1, limit=5]", theme)
    expect(reconstruct(chunks)).toBe("[q=closed], fake=1, limit=5]")
  })

  it("linkifyChunks attaches the url and underline to every chunk", () => {
    const styled = highlightToolDetail("list", "a/b/c", theme)
    const linked = linkifyChunks(styled, "flywheel://file/a/b/c")
    expect(linked.every((c) => c.link?.url === "flywheel://file/a/b/c")).toBe(true)
    expect(linked.every((c) => (c.attributes ?? 0) !== 0)).toBe(true)
    expect(reconstruct(linked)).toBe("a/b/c")
  })
})
