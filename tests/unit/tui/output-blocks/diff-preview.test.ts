import { describe, expect, it } from "bun:test"
import { BoxRenderable, RGBA, ScrollBoxRenderable, StyledText, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createComponent } from "solid-js/web"
import { TOOL_PREVIEW_LINE_LIMIT, type DiffOmission } from "../../../../src/infra/output-blocks.js"
import type { MutationDiff } from "../../../../src/infra/mutation-diff.js"
import type { RuntimeConfigView } from "../../../../src/protocol/runtime-config-protocol-types.js"
import type { SyntaxColors } from "../../../../src/tui/adapters/syntax-highlight.js"
import type { DiffSource } from "../../../../src/tui/output-blocks/diff-preview.js"
import { configView } from "../../../helpers/runtime-views.js"
import { renderToolEntry } from "./_tool-entry-render.js"
import { editDiff } from "./_edit-diff-fixture.js"

interface RenderDiffPreviewOptions {
  expanded?: boolean
  omissions?: MutationDiff["omissions"]
  diffOmission?: DiffOmission
  height?: number
}

async function loadDiffPreview() {
  return import("../../../../src/tui/output-blocks/diff-preview.js")
}

async function renderDiffPreview(sources: readonly DiffSource[], opts?: RenderDiffPreviewOptions): Promise<string[]> {
  const [{ DiffPreview, parseDiffs }, { ThemeProvider }] = await Promise.all([
    loadDiffPreview(),
    import("../../../../src/tui/context/theme.js"),
  ])

  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(DiffPreview, {
          parsed: parseDiffs(sources, opts?.expanded ?? false),
          omissions: opts?.omissions,
          diffOmission: opts?.diffOmission,
        })
      },
    }),
    { width: 80, height: opts?.height ?? 64 },
  )
  try {
    await result.renderOnce()
    return result.captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
  } finally {
    result.renderer.destroy()
  }
}

const writeSyntaxColors = {
  text: RGBA.fromHex("#b7bcc6"),
  keyword: RGBA.fromHex("#81a1c1"),
  type: RGBA.fromHex("#8fbcbb"),
  number: RGBA.fromHex("#b48ead"),
  string: RGBA.fromHex("#a3be8c"),
  comment: RGBA.fromHex("#616e88"),
  function: RGBA.fromHex("#88c0d0"),
  variable: RGBA.fromHex("#d8dee9"),
  operator: RGBA.fromHex("#81a1c1"),
  punctuation: RGBA.fromHex("#7f8a9a"),
} satisfies SyntaxColors

async function renderDiffPreviewArtifacts(sources: readonly DiffSource[], writes = false) {
  const [{ DiffPreview, parseDiffs }, { ThemeProvider }] = await Promise.all([
    loadDiffPreview(),
    import("../../../../src/tui/context/theme.js"),
  ])
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() { return createComponent(DiffPreview, { parsed: parseDiffs(sources, false, writes ? "all" : "none") }) },
    }),
    { width: 80, height: 64 },
  )
  try {
    await result.renderOnce()
    const descendants: unknown[] = [result.renderer.root]
    const texts: TextRenderable[] = []
    const boxes: BoxRenderable[] = []
    for (const node of descendants) {
      if (node instanceof TextRenderable) texts.push(node)
      if (node instanceof BoxRenderable) boxes.push(node)
      if (node && typeof node === "object" && "getChildren" in node && typeof node.getChildren === "function") descendants.push(...node.getChildren())
    }
    return {
      styled: texts.map((text) => text.content).filter((content): content is StyledText => content instanceof StyledText),
      backgrounds: boxes.map((box) => box.backgroundColor),
    }
  } finally {
    result.renderer.destroy()
  }
}

/** The width inside the scroll viewport that holds a row. */
function viewportContentWidth(row: BoxRenderable): number {
  for (let parent = row.parent; parent; parent = parent.parent) {
    if (parent instanceof ScrollBoxRenderable) return parent.content.width
  }
  throw new Error("Expected a scroll viewport")
}

/** Two-hunk unified diff whose hunk content lines exceed the preview budget.
 *  The structural lines (file headers, `@@` hunk headers) are deliberate: the
 *  preview must never count or show them. */
function singleHunkDiff(path: string, hunkLines: number): string {
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${hunkLines} +1,${hunkLines} @@`]
  for (let index = 0; index < hunkLines; index += 1) lines.push(`+${path} line ${index}`)
  return lines.join("\n")
}

describe("diff preview line accounting", () => {
  it("counts only rendered hunk lines, never structural header lines", async () => {
    const { parseDiffs } = await loadDiffPreview()

    expect(parseDiffs([{ unifiedDiff: editDiff() }], false).renderedLines).toBe(TOOL_PREVIEW_LINE_LIMIT + 6)
    expect(parseDiffs([{ unifiedDiff: "--- a/x\n+++ b/x" }], false).renderedLines).toBe(0)
    expect(parseDiffs([
      { path: "a.ts", unifiedDiff: singleHunkDiff("a.ts", 4) },
      { path: "b.ts", unifiedDiff: singleHunkDiff("b.ts", 3) },
    ], false).renderedLines).toBe(7)
  })

  it("materializes up to the preview limit from every file, and every line once expanded", async () => {
    const { parseDiffs } = await loadDiffPreview()
    const sources = [
      { path: "a.ts", unifiedDiff: singleHunkDiff("a.ts", 500) },
      { path: "b.ts", unifiedDiff: singleHunkDiff("b.ts", 500) },
    ]

    const collapsed = parseDiffs(sources, false)
    expect(collapsed.renderedLines).toBe(1_000)
    expect(materializedLines(collapsed)).toBe(TOOL_PREVIEW_LINE_LIMIT * 2)

    const expanded = parseDiffs(sources, true)
    expect(expanded.renderedLines).toBe(1_000)
    expect(materializedLines(expanded)).toBe(1_000)
  })

  it("keeps the provisional head in a compact window with exact coordinates", async () => {
    const { parseDiffs } = await loadDiffPreview()
    const lines = Array.from({ length: 25 }, (_, index) => ({
      id: `line:${index}`,
      kind: index === 24 ? "remove" as const : "add" as const,
      text: index === 24 ? "const oldValue = 1" : `const generated${index} = ${index}`,
      partial: index === 24,
    }))

    const [file] = parseDiffs([{
      id: "file:src/generated.ts",
      path: "src/generated.ts",
      action: "update",
      hunks: [{
        id: "hunk:0",
        oldStart: 40,
        newStart: 10,
        lines,
        omittedBefore: 3,
        omittedAfter: 4,
      }],
    }], false).files

    expect(file?.rows).toHaveLength(TOOL_PREVIEW_LINE_LIMIT)
    expect(file?.rows[0]).toMatchObject({ id: "line:0", newLine: 10 })
    expect(file?.rows.at(-1)).toMatchObject({ id: "line:19", newLine: 29, partial: false })
    expect(file?.renderedLines).toBe(25)
    expect(file?.omittedLines).toBe(7)
  })

  it("reveals every retained provisional row when expanded", async () => {
    const { parseDiffs } = await loadDiffPreview()
    const lines = Array.from({ length: 24 }, (_, index) => ({
      id: `line:${index}`,
      kind: "add" as const,
      text: `generated ${index}`,
      partial: false,
    }))
    const source = {
      id: "file:generated.ts",
      path: "generated.ts",
      action: "add" as const,
      hunks: [{ id: "hunk:0", newStart: 1, lines, omittedBefore: 2, omittedAfter: 3 }],
    }

    const [collapsed] = parseDiffs([source], false).files
    const [expanded] = parseDiffs([source], true).files

    expect(collapsed?.rows).toHaveLength(TOOL_PREVIEW_LINE_LIMIT)
    expect(expanded?.rows).toHaveLength(24)
    expect(expanded?.rows[0]).toMatchObject({ id: "line:0", newLine: 1 })
    expect(expanded?.rows.at(-1)).toMatchObject({ id: "line:23", newLine: 24 })
    expect(expanded?.omittedLines).toBe(5)
  })

  it("keeps the hunk header line numbers of a bounded hunk", async () => {
    const { parseDiffs } = await loadDiffPreview()

    const [file] = parseDiffs([{ path: "a.ts", unifiedDiff: singleHunkDiff("a.ts", 60) }], false).files

    expect(file?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 60, newStart: 1, newLines: 60 })
  })
})

function materializedLines(parsed: { readonly files: readonly { readonly hunks: readonly { readonly lines: readonly string[] }[] }[] }): number {
  return parsed.files.reduce((total, file) => total + file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0), 0)
}

describe("diff preview rendering", () => {
  it("bounds a collapsed preview to the 20 rendered hunk lines and states the omission", async () => {
    const lines = await renderDiffPreview([{ unifiedDiff: editDiff() }])

    expect(lines).toHaveLength(TOOL_PREVIEW_LINE_LIMIT + 1)
    expect(lines[0]?.trimStart()).toBe("1  const first = 1")
    expect(lines.at(-2)?.trimStart()).toBe("26  const filler16 = 16")
    expect(lines.at(-1)?.trimStart()).toBe("... +6 lines (click to expand)")
  })

  it("renders every hunk line and the collapse affordance when expanded", async () => {
    const lines = await renderDiffPreview([{ unifiedDiff: editDiff() }], { expanded: true })

    expect(lines).toHaveLength(TOOL_PREVIEW_LINE_LIMIT + 6 + 1)
    expect(lines.at(-2)?.trimStart()).toBe("32  const filler22 = 22")
    expect(lines.at(-1)?.trimStart()).toBe("(click to collapse)")
  })

  it("states source truncation after rendering every retained line", async () => {
    const sources = [{ unifiedDiff: editDiff(), omittedLines: 900 }]
    const lines = await renderDiffPreview(sources, { expanded: true })

    expect(lines.at(-1)?.trimStart()).toBe("... +900 lines (truncated, click to collapse)")
  })

  it("renders a legacy private-reach omission without a disclosure body", async () => {
    const lines = await renderDiffPreview([], {
      omissions: [{ path: "USER.md", reason: "private_reach" }],
    })

    expect(lines.some((line) => line.includes("USER.md  (diff omitted: private to this reach)"))).toBe(true)
  })

  it("renders one preview and one omission affordance per file", async () => {
    const lines = await renderDiffPreview([
      { path: "src/first.ts", unifiedDiff: singleHunkDiff("src/first.ts", 24) },
      { path: "src/second.ts", unifiedDiff: singleHunkDiff("src/second.ts", 24) },
    ])

    expect(lines.filter((line) => line.trimStart() === "src/first.ts")).toHaveLength(1)
    expect(lines.filter((line) => line.trimStart() === "src/second.ts")).toHaveLength(1)
    expect(lines.some((line) => line.includes("src/first.ts line 19"))).toBe(true)
    expect(lines.some((line) => line.includes("src/second.ts line 19"))).toBe(true)
    expect(lines.some((line) => line.includes("src/first.ts line 20"))).toBe(false)
    expect(lines.some((line) => line.includes("src/second.ts line 20"))).toBe(false)
    expect(lines.filter((line) => line.trimStart() === "... +4 lines (click to expand)")).toHaveLength(2)
  })

  it("renders no heading for an unnamed diff", async () => {
    const lines = await renderDiffPreview([{ unifiedDiff: editDiff(3) }])

    expect(lines).toEqual([
      " 1  const first = 1",
      " 2 -const second = 2",
      " 2 +const second = 3",
    ])
  })

  it("states a source-level omission instead of hiding it, and never counts it as expandable lines", async () => {
    const lines = await renderDiffPreview([], {
      omissions: [{ path: ".flywheel/memory/project.md", reason: "sensitive" }],
    })

    expect(lines).toEqual(["  .flywheel/memory/project.md  (diff omitted: sensitive)"])
  })

  it("folds wire-omitted lines into the expand affordance", async () => {
    const lines = await renderDiffPreview([{ unifiedDiff: editDiff(4) }], { diffOmission: { kind: "aggregate", omittedLines: 9 } })

    expect(lines.at(-1)?.trimStart()).toBe("... +9 lines (click to expand)")
  })

  it("renders active typed rows without invented line-number gutters", async () => {
    const lines = await renderDiffPreview([{
      id: "file:src/a.ts",
      path: "src/a.ts",
      action: "update",
      hunks: [{
        id: "hunk:0",
        lines: [
          { id: "line:0", kind: "context", text: "before", partial: false },
          { id: "line:1", kind: "remove", text: "old value", partial: false },
          { id: "line:2", kind: "add", text: "new", partial: true },
        ],
        omittedBefore: 0,
        omittedAfter: 0,
      }],
    }])

    expect(lines).toEqual([
      "  src/a.ts (update)",
      " before",
      "-old value",
      "+new",
    ])
  })

  it("renders proposed and actual writes with syntax colors but no diff decoration", async () => {
    const proposed = await renderDiffPreviewArtifacts([{
      id: "file:src/value.ts",
      path: "src/value.ts",
      action: "add",
      hunks: [{
        id: "hunk:0",
        newStart: 1,
        lines: [{ id: "line:0", kind: "add", text: "const value: number = answer", partial: true }],
        omittedBefore: 0,
        omittedAfter: 0,
      }],
    }], true)
    const actual = await renderDiffPreviewArtifacts([{
      path: "src/value.ts",
      unifiedDiff: "@@ -0,0 +1 @@\n+const value: number = answer",
    }], true)

    for (const artifact of [proposed, actual]) {
      const codeIndex = artifact.styled.findIndex((styled) => styled.chunks.map((chunk) => chunk.text).join("").includes("const value"))
      const code = artifact.styled[codeIndex]
      expect(code).toBeDefined()
      const codeForegrounds = code?.chunks
        .filter((chunk) => /const|value|number|answer/.test(chunk.text))
        .map((chunk) => chunk.fg)
        .filter((color) => color !== undefined) ?? []
      expect(new Set(codeForegrounds.map((color) => color.toString())).size).toBeGreaterThan(1)
      expect(artifact.backgrounds.every((background) => background.a === 0)).toBe(true)
      expect(code?.chunks.every((chunk) => chunk.bg === undefined)).toBe(true)
      expect(artifact.styled[codeIndex - 1]?.chunks.map((chunk) => chunk.text).join("")).toMatch(/^\s*1\s+$/)
      expect(code?.chunks.map((chunk) => chunk.text).join("")).toBe("const value: number = answer")
      expect(code?.chunks.find((chunk) => chunk.text.includes("answer"))?.fg).toEqual(writeSyntaxColors.text)
    }
  })

  it("does not syntax-color edit diffs by default", async () => {
    const artifact = await renderDiffPreviewArtifacts([{
      path: "src/value.ts",
      unifiedDiff: "@@ -0,0 +1 @@\n+const answer: number = 42",
    }])
    const code = artifact.styled.find((styled) => styled.chunks.map((chunk) => chunk.text).join("").includes("const answer"))
    const colors = code?.chunks.filter((chunk) => /const|answer|number|42/.test(chunk.text)).map((chunk) => chunk.fg?.toString())
    expect(new Set(colors).size).toBe(1)
    expect(artifact.backgrounds.some((background) => background.a > 0)).toBe(true)
  })

  it("updates a mounted Write preview palette without changing an edit preview", async () => {
    const [{ DiffPreview, parseDiffs }, { ThemeProvider }] = await Promise.all([
      loadDiffPreview(),
      import("../../../../src/tui/context/theme.js"),
    ])
    const [writeSyntaxTheme, setWriteSyntaxTheme] = createSignal<"nord" | "vesper">("nord")
    const config = (): RuntimeConfigView => configView({ writeSyntaxTheme: writeSyntaxTheme() })
    const source: DiffSource[] = [{
      path: "src/value.ts",
      unifiedDiff: "@@ -0,0 +1 @@\n+const answer = run()",
    }]
    const render = (syntaxHighlight: boolean) => testRender(
      () => createComponent(ThemeProvider, {
        mode: "dark",
        config,
        get children() {
          return createComponent(DiffPreview, {
            parsed: parseDiffs(source, false, syntaxHighlight ? "all" : "none"),
          })
        },
      }),
      { width: 80, height: 12 },
    )
    const write = await render(true)
    const edit = await render(false)
    const functionColor = (renderer: typeof write.renderer): string | undefined => {
      const descendants: unknown[] = [renderer.root]
      for (const node of descendants) {
        if (node instanceof TextRenderable && node.content instanceof StyledText) {
          const chunk = node.content.chunks.find((candidate) => candidate.text.includes("run"))
          if (chunk?.fg !== undefined) return chunk.fg.toString()
        }
        if (node && typeof node === "object" && "getChildren" in node && typeof node.getChildren === "function") descendants.push(...node.getChildren())
      }
      return undefined
    }
    try {
      await write.renderOnce()
      await edit.renderOnce()
      const nordWrite = functionColor(write.renderer)
      const nordEdit = functionColor(edit.renderer)

      setWriteSyntaxTheme("vesper")
      await write.renderOnce()
      await edit.renderOnce()

      expect(nordWrite).toBe(RGBA.fromHex("#88c0d0").toString())
      expect(functionColor(write.renderer)).toBe(RGBA.fromHex("#cfb08a").toString())
      expect(functionColor(edit.renderer)).toBe(nordEdit)
    } finally {
      write.renderer.destroy()
      edit.renderer.destroy()
    }
  })

  it("updates a mounted Write body palette without changing a chat-colored edit body", async () => {
    const [writeSyntaxTheme, setWriteSyntaxTheme] = createSignal<"nord" | "vesper">("nord")
    const config = (): RuntimeConfigView => configView({ writeSyntaxTheme: writeSyntaxTheme() })
    const block = (name: "write" | "edit", id: string) => ({
      kind: "tool" as const,
      id,
      name,
      presentation: { name: name === "write" ? "Write" : "Edit", detail: "src/value.ts" },
      status: "completed" as const,
      content: "const answer = run()",
      filetype: "typescript",
      timestamp: 1,
    })
    const write = await renderToolEntry(block("write", "write-body"), { config })
    const edit = await renderToolEntry(block("edit", "edit-body"), { config })
    const functionColor = (renderer: typeof write.renderer): string | undefined => {
      const descendants: unknown[] = [renderer.root]
      for (const node of descendants) {
        if (node instanceof TextRenderable && node.content instanceof StyledText) {
          const chunk = node.content.chunks.find((candidate) => candidate.text.includes("run"))
          if (chunk?.fg !== undefined) return chunk.fg.toString()
        }
        if (node && typeof node === "object" && "getChildren" in node && typeof node.getChildren === "function") descendants.push(...node.getChildren())
      }
      return undefined
    }
    try {
      await write.renderOnce()
      await edit.renderOnce()
      const nordEdit = functionColor(edit.renderer)
      expect(functionColor(write.renderer)).toBe(RGBA.fromHex("#88c0d0").toString())

      setWriteSyntaxTheme("vesper")
      await write.renderOnce()
      await edit.renderOnce()

      expect(functionColor(write.renderer)).toBe(RGBA.fromHex("#cfb08a").toString())
      expect(functionColor(edit.renderer)).toBe(nordEdit)
    } finally {
      write.renderer.destroy()
      edit.renderer.destroy()
    }
  })

  it("keeps writes without a known language free of diff decoration", async () => {
    const artifact = await renderDiffPreviewArtifacts([{
      path: "notes.unknown",
      unifiedDiff: "@@ -0,0 +1 @@\n+plain content",
    }], true)
    const codeIndex = artifact.styled.findIndex((styled) => styled.chunks.map((chunk) => chunk.text).join("").includes("plain content"))
    const code = artifact.styled[codeIndex]
    expect(artifact.styled[codeIndex - 1]?.chunks.map((chunk) => chunk.text).join("")).toMatch(/^\s*1\s+$/)
    expect(code?.chunks.map((chunk) => chunk.text).join("")).toBe("plain content")
    expect(code?.chunks.every((chunk) => chunk.bg === undefined)).toBe(true)
    expect(artifact.backgrounds.every((background) => background.a === 0)).toBe(true)
  })

  it("preserves actual word highlights without syntax coloring", async () => {
    const artifact = await renderDiffPreviewArtifacts([{
      path: "src/value.ts",
      unifiedDiff: "@@ -1 +1 @@\n-const answer: number = 41\n+const answer: number = 42",
    }])
    const changed = artifact.styled.filter((styled) => styled.chunks.map((chunk) => chunk.text).join("").includes("const answer"))

    expect(changed).toHaveLength(2)
    expect(changed.every((styled) => styled.chunks.some((chunk) => chunk.bg !== undefined))).toBe(true)
    expect(new Set(artifact.backgrounds.filter((background) => background !== undefined).map((background) => background.toString())).size).toBeGreaterThan(1)
  })

  it("keeps unknown-extension diff text readable without syntax metadata", async () => {
    const artifact = await renderDiffPreviewArtifacts([{
      path: "data/value.unknown-extension",
      unifiedDiff: "@@ -0,0 +1 @@\n+plain value",
    }])
    const lineIndex = artifact.styled.findIndex((styled) => styled.chunks.some((chunk) => chunk.text.includes("plain value")))
    const line = artifact.styled[lineIndex]

    expect(artifact.styled[lineIndex - 1]?.chunks.map((chunk) => chunk.text).join("")).toMatch(/\+$/)
    expect(line?.chunks.map((chunk) => chunk.text).join("")).toBe("plain value")
    expect(line?.chunks.find((chunk) => chunk.text.includes("plain value"))?.fg).toBeDefined()
    expect(artifact.backgrounds.some((background) => background !== undefined)).toBe(true)
  })

  it("wraps each diff line under its code, inside a full-width highlight beside a visible scrollbar", async () => {
    const [{ DiffPreview, parseDiffs }, { ThemeProvider }, { jsx }] = await Promise.all([
      loadDiffPreview(),
      import("../../../../src/tui/context/theme.js"),
      import("@opentui/solid/jsx-runtime"),
    ])
    const paragraph = "The primary store advances a rewrite generation for every fact that any connection updates or deletes."
    const unifiedDiff = ["@@ -1,8 +1,8 @@", ...Array.from({ length: 8 }, () => `-${paragraph}`), ...Array.from({ length: 8 }, () => `+${paragraph} Again.`)].join("\n")
    const result = await testRender(
      () => createComponent(ThemeProvider, {
        mode: "dark",
        get children() {
          return jsx("scrollbox", {
            height: 12,
            get children() { return createComponent(DiffPreview, { parsed: parseDiffs([{ unifiedDiff }], true) }) },
          })
        },
      }),
      { width: 61, height: 12 },
    )
    try {
      await result.renderOnce()
      const descendants: unknown[] = [result.renderer.root]
      const rows: BoxRenderable[] = []
      for (const node of descendants) {
        if (node instanceof BoxRenderable && node.backgroundColor.a > 0) rows.push(node)
        if (node && typeof node === "object" && "getChildren" in node && typeof node.getChildren === "function") descendants.push(...node.getChildren())
      }
      const frame = result.captureCharFrame().split("\n")

      expect(rows).toHaveLength(16)
      expect(viewportContentWidth(rows[0]!)).toBeLessThan(61)
      for (const row of rows) {
        const [gutter, code] = row.getChildren()
        if (!(gutter instanceof TextRenderable) || !(code instanceof TextRenderable)) throw new Error("Expected a gutter and a code text")
        // The highlight spans the content width, and the code ends at its right edge.
        expect(row.width).toBe(viewportContentWidth(row))
        expect(code.x + code.width).toBe(row.x + row.width)
        // A wrapped line continues under its code, never under the gutter.
        expect(code.x).toBe(gutter.x + gutter.width)
        expect(code.height).toBeGreaterThan(1)
        const continuation = frame[code.y + 1]
        if (continuation !== undefined && code.y + 1 < 12) expect(continuation.slice(row.x, code.x).trim()).toBe("")
      }
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders path and action for a proposal before it has rows", async () => {
    const lines = await renderDiffPreview([{
      id: "file:new.ts",
      path: "new.ts",
      action: "add",
      hunks: [],
    }])

    expect(lines).toEqual(["  new.ts (add)"])
  })
  it("renders proposal move destinations and canonical actions", async () => {
    expect(await renderDiffPreview([{ id: "move", path: "old.ts", action: "update", movePath: "new.ts", hunks: [] }]))
      .toEqual(["  old.ts (update) to new.ts"])
    expect(await renderDiffPreview([{ path: "gone.ts", action: "delete", unifiedDiff: "@@ -1 +0,0 @@\n-old" }]))
      .toEqual(["  gone.ts (delete)", " 1 -old"])
  })
})
