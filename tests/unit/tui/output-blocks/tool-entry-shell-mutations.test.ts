import { afterAll, describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { AnyBlockSchema, TOOL_PREVIEW_LINE_LIMIT, type ToolEntry } from "../../../../src/infra/output-blocks.js"
import { getToolDisplay, resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry.js"
import flywheelThemeJson from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { highlightShellCommand } from "../../../../src/tui/adapters/shell-command-highlight.js"
import { renderToolEntry as renderEntry, type RenderToolEntryOptions } from "./_tool-entry-render.js"
import type { MutationDiff } from "../../../../src/infra/mutation-diff.js"
import { RGBA } from "@opentui/core"
import { getWriteSyntaxColors } from "../../../../src/protocol/write-syntax-theme.js"
import { SHELL_MUTATION_RUNNING } from "../../../../src/protocol/client/file-change-body.js"
import { mutationEvidenceFixture } from "./_mutation-evidence-fixture.js"

const theme = resolveTheme(flywheelThemeJson, "dark")

const longDiff = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  `@@ -1,${TOOL_PREVIEW_LINE_LIMIT + 1} +1,${TOOL_PREVIEW_LINE_LIMIT + 1} @@`,
  "-const a = 1",
  "+const a = 2",
  ...Array.from({ length: TOOL_PREVIEW_LINE_LIMIT }, (_, index) => ` const line${index} = ${index}`),
].join("\n")

const mutation: MutationDiff = {
  version: 1,
  files: [{ path: "src/a.ts", change: "modified", unifiedDiff: longDiff }],
  omissions: [],
}

const twoFileMutation: MutationDiff = {
  ...mutation,
  files: [...mutation.files, { path: "src/c.ts", change: "added", unifiedDiff: "--- /dev/null\n+++ b/src/c.ts\n@@ -0,0 +1 @@\n+const c = 3\n" }],
}
const single = await mutationEvidenceFixture(mutation)
const multiple = await mutationEvidenceFixture(twoFileMutation)
const addition = await mutationEvidenceFixture({ ...mutation, files: [twoFileMutation.files[1]!] })
afterAll(() => { single.reader.dispose(); multiple.reader.dispose(); addition.reader.dispose() })

async function renderToolEntry(block: ToolEntry, options: RenderToolEntryOptions = {}) {
  const fixture = [single, multiple, addition].find(candidate => candidate.evidence.manifest.root === block.mutationEvidence?.manifest.root)
  const result = await renderEntry(block, { ...options, evidenceReader: options.evidenceReader ?? fixture?.reader })
  if (fixture) for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
  return result
}

const isBlock = Schema.is(AnyBlockSchema)

/** A bash row with `fields` laid over it; an override of `undefined` removes
 *  the field. The overrides can mix status variants, so the row is checked
 *  against the block schema it must satisfy. */
function bash(command: string, fields: Partial<ToolEntry> = {}): ToolEntry {
  const row = {
    kind: "tool",
    id: "reshape",
    name: "bash",
    presentation: resolveToolPresentation("bash", { command }, "/workspace"),
    action: getToolDisplay("bash").action,
    status: "completed",
    timestamp: 1,
    exitCode: 0,
    content: "command output line",
    declaresMutation: true,
    mutationEvidence: single.evidence,
    ...fields,
  }
  const entry = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))
  if (!isBlock(entry) || entry.kind !== "tool") throw new Error(`fixture row for ${command} is not a valid tool entry`)
  return entry
}

type Rendered = Awaited<ReturnType<typeof renderToolEntry>>

async function frameLines(result: Rendered): Promise<string[]> {
  // Rows wrap into their measured width on the second layout pass.
  await result.renderOnce()
  await result.renderOnce()
  return result.captureCharFrame().split("\n")
}

function spanColor(result: Rendered, text: string) {
  return result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.fg
}

/** The lit rail glyph: one per line where the hovered disclosure spans. */
const LIT_RAIL = "┃"

describe("shell mutation card", () => {
  it("reads added-file evidence with the Write syntax palette and suppresses shell output", async () => {
    const fixture = await mutationEvidenceFixture([{ path: "src/new.ts", change: "added", lines: 1,
      patch: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+const generated = 3\n" }])
    const result = await renderToolEntry(bash("generate", { mutationEvidence: fixture.evidence }), {
      height: 32, evidenceReader: fixture.reader,
    })
    try {
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(result.captureCharFrame()).toContain("Write src/new.ts")
      expect(result.captureCharFrame()).not.toContain("+const generated")
      expect(result.captureCharFrame()).not.toContain("command output line")
      const keyword = result.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes("const"))
      expect(keyword?.fg.equals(RGBA.fromHex(getWriteSyntaxColors("nord", "dark").keyword))).toBe(true)
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it("uses the Write row and palette for added files, and keeps modified files as diffs in mixed mutations", async () => {
    const added = twoFileMutation.files[1]!
    for (const fixture of [addition, multiple]) {
      const files = fixture === addition ? [added] : [mutation.files[0]!, added]
      const result = await renderToolEntry(bash("generate", { mutationEvidence: fixture.evidence }), { width: 100, height: 40 })
      try {
        const lines = await frameLines(result)
        expect(lines.some((line) => line.includes(files.length === 1 ? "Write src/c.ts" : "Edit src/a.ts, src/c.ts"))).toBe(true)
        expect(lines.some((line) => line.includes("+const c"))).toBe(false)
        const addedLine = result.captureSpans().lines.find((line) => line.spans.map((span) => span.text).join("").includes("const c = "))
        const keyword = addedLine?.spans.find((span) => span.text.includes("const"))
        expect(keyword?.fg?.equals(RGBA.fromHex(getWriteSyntaxColors("nord", "dark").keyword))).toBe(true)
        if (files.length > 1) expect(lines.some((line) => line.includes("+const a = 2"))).toBe(true)
      } finally {
        result.renderer.destroy()
      }
    }
  })
  it("reads as an edit of its files, never as the command or its output, with its notices in warning color", async () => {
    const result = await renderToolEntry(bash("python3 - <<'EOF' reshape", {
      mutationEvidence: { ...single.evidence, conflictMarkers: 1, notApplied: 1, samples: [
        { kind: "applied", path: "src/a.ts", conflictMarkers: true },
        { kind: "not_applied", path: "src/c.bin", reason: "binary files are not merged" },
      ] },
    }), { width: 100, height: 60 })
    try {
      const folded = await frameLines(result)
      const header = folded.findIndex((line) => line.includes("Edit src/a.ts"))
      expect(header).toBeGreaterThanOrEqual(0)
      expect(folded.some((line) => line.includes("python3") || line.includes("Bash"))).toBe(false)
      // Both notices wrap at the card width, even inside a path, so the lines join without spaces before the match.
      const joined = (from: number) => folded.slice(from, from + 2).join("").replace(/\s+/g, "")
      const conflict = folded.findIndex((line) => line.includes("Flywheel added conflict markers"))
      const refused = folded.findIndex((line) => line.includes("Not applied, because the project also changed these files:"))
      expect(joined(conflict)).toContain("wheretheprojectchangedthesamelinesasthecommand:src/a.ts")
      expect(joined(refused)).toContain("src/c.bin(binaryfilesarenotmerged)")
      expect(spanColor(result, "Flywheel added conflict markers")?.equals(theme.warning)).toBe(true)
      expect(spanColor(result, "Not applied")?.equals(theme.warning)).toBe(true)
      expect(folded.some((line) => line.includes("+const a = 2"))).toBe(true)

      // The header owns the lone file's disclosure, as an edit tool's does.
      await result.mockMouse.click(4, header)
      const open = await frameLines(result)
      expect(open.some((line) => line.includes(`const line${TOOL_PREVIEW_LINE_LIMIT - 1} = `))).toBe(true)
      expect(open.some((line) => line.includes("command output line"))).toBe(false)
    } finally {
      result.renderer.destroy()
    }
  })

  it("shows a removed directory as one collapsed row that discloses the files it held", async () => {
    const deleted = (name: string) => ({ path: `scratch/dl/${name}`, change: "removed" as const, lines: 1,
      patch: `--- a/scratch/dl/${name}\n+++ /dev/null\n@@ -1 +0,0 @@\n-held ${name}\n` })
    const fixture = await mutationEvidenceFixture([deleted("a.txt"), deleted("b.txt"), { path: "src/a.ts", patch: longDiff }],
      { removedDirectories: [{ path: "scratch/dl", files: 2, bytes: 2048 }] })
    const result = await renderToolEntry(bash("rm -rf scratch/dl", { mutationEvidence: fixture.evidence }), { width: 100, height: 60, evidenceReader: fixture.reader })
    try {
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const folded = await frameLines(result)
      expect(folded.some((line) => line.includes("Edit scratch/dl/ (2 files), src/a.ts"))).toBe(true)
      const row = folded.findIndex((line) => line.includes("scratch/dl/ (delete, 2 files, 2 KB)"))
      expect(row).toBeGreaterThanOrEqual(0)
      expect(folded.some((line) => line.includes("held a.txt") || line.includes("scratch/dl/a.txt"))).toBe(false)
      expect(folded.some((line) => line.includes("+const a = 2"))).toBe(true)

      await result.mockMouse.click(folded[row]!.indexOf("scratch"), row)
      for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
      const open = await frameLines(result)
      expect(open.some((line) => line.includes("scratch/dl/a.txt"))).toBe(true)
      expect(open.some((line) => line.includes("scratch/dl/b.txt"))).toBe(true)
    } finally {
      result.renderer.destroy()
      fixture.reader.dispose()
    }
  })

  it("reads as a running edit without its command, then as the plain highlighted command when no change lands", async () => {
    const command = "cd /elsewhere && python3 reshape.py"
    const program = highlightShellCommand(command, theme).find((chunk) => chunk.text === "python3")?.fg
    for (const status of ["pending", "streaming"] as const) {
      const result = await renderToolEntry(bash(command, { status, mutationEvidence: undefined, content: undefined }), { width: 100, height: 24 })
      try {
        const lines = await frameLines(result)
        expect(lines.some((line) => line.includes(`Edit ${SHELL_MUTATION_RUNNING}`))).toBe(true)
        expect(lines.some((line) => line.includes("python3"))).toBe(false)
        expect(spanColor(result, SHELL_MUTATION_RUNNING)?.equals(theme.text)).toBe(true)
      } finally {
        result.renderer.destroy()
      }
    }
    for (const source of ["content", "execution"] as const) for (const status of ["completed", "error", "interrupted", "blocked"] as const) {
      const result = await renderToolEntry(bash(command, {
        id: "shell-output",
        status,
        mutationEvidence: undefined,
        content: source === "content" ? "Git repository writes are not allowed" : undefined,
        errorMessage: "refused",
        statusMessage: "waiting",
      }), {
        width: 100, height: 24,
        ...(source === "execution" ? { streamingToolText: { "shell-output": { content: "Git repository writes are not allowed" } } } : {}),
      })
      try {
        const lines = await frameLines(result)
        expect(lines.some((line) => line.includes(`Bash ${command}`))).toBe(true)
        expect(lines.some((line) => line.includes("Edit"))).toBe(false)
        expect(program !== undefined && spanColor(result, "python3")?.equals(program)).toBe(true)
        expect(lines.some((line) => line.includes("Git repository writes are not allowed"))).toBe(false)
        await result.mockMouse.click(4, lines.findIndex((line) => line.includes(`Bash ${command}`)))
        const opened = await frameLines(result)
        expect(opened.some((line) => line.includes("Git repository writes are not allowed"))).toBe(true)
      } finally {
        result.renderer.destroy()
      }
    }
  })

  it("lights one rail at a time on hover: the card's for a lone file, each file's own beside others", async () => {
    for (const fixture of [single, multiple]) {
      const result = await renderToolEntry(bash("reshape", { mutationEvidence: fixture.evidence }), { width: 100, height: 60 })
      try {
        const lines = await frameLines(result)
        const row = lines.findIndex((line) => line.includes("+const a = 2"))
        await result.mockMouse.moveTo(lines[row]!.indexOf("const"), row)
        const hovered = await frameLines(result)
        expect(hovered.some((line) => line.includes(LIT_RAIL))).toBe(true)
        expect(hovered.every((line) => line.split(LIT_RAIL).length - 1 <= 1)).toBe(true)
      } finally {
        result.renderer.destroy()
      }
    }
  })

  it("fetches omitted settled output only when no mutation evidence landed", async () => {
    for (const landed of [single.evidence, undefined]) {
      const hydrated: string[] = []
      const result = await renderToolEntry(bash("reshape", { mutationEvidence: landed, content: undefined, contentOmittedLines: 3 }), {
        width: 100,
        height: 32,
        onHydrateBody: (id) => hydrated.push(id),
      })
      try {
        const lines = await frameLines(result)
        await result.mockMouse.click(4, lines.findIndex((line) => line.includes(landed ? "Edit src/a.ts" : "Bash reshape")))
        await frameLines(result)
        expect(hydrated).toEqual(landed ? [] : ["tool:reshape"])
      } finally {
        result.renderer.destroy()
      }
    }
  })

  it("keeps a timed-out command's landed edits on its failed card, beside its error", async () => {
    const result = await renderToolEntry(bash("reshape", {
      status: "error",
      errorMessage: "Command timed out after 5s",
      exitCode: 124,
    }), { width: 100, height: 24 })
    try {
      const lines = await frameLines(result)
      expect(lines.some((line) => line.includes("Edit src/a.ts") && line.includes("(exit 124)") && line.includes("Command timed out after 5s"))).toBe(true)
      expect(lines.some((line) => line.includes("+const a = 2"))).toBe(true)
      expect(spanColor(result, "Command timed out")?.equals(theme.error)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps a grouped command row running, as plain text, while its managed process outlives the call", async () => {
    const [{ testRender }, { createComponent }, { createSignal }, { BlockRenderer }, { ThemeProvider }, { TickPoolProvider }, { terminalTranscript }] = await Promise.all([
      import("@opentui/solid"),
      import("solid-js/web"),
      import("solid-js"),
      import("../../../../src/tui/output-blocks/block-renderer.js"),
      import("../../../../src/tui/context/theme.js"),
      import("../../../../src/tui/context/tick-pool-context.js"),
      import("../../../../src/tui/output-blocks/visible-output-blocks.js"),
    ])
    const command = bash("python3 reshape.py", { status: "completed", background: true, mutationEvidence: undefined, timestamp: Date.now() })
    const block = terminalTranscript([command, { kind: "text", id: "after-run", content: "Done", timestamp: command.timestamp + 1200 }], false).timelineBlocks[0]!
    const [active, setActive] = createSignal<ReadonlySet<string>>(new Set([command.id]))
    const result = await testRender(
      () => createComponent(TickPoolProvider, {
        get children() {
          return createComponent(ThemeProvider, {
            mode: "dark",
            get children() {
              return createComponent(BlockRenderer, {
                block,
                processControls: { activeHeldToolCallIds: () => new Set(), processorHeldToolCallIds: () => new Set(), activeManagedProcessToolCallIds: active, onDetach: () => {}, onStop: () => {} },
              })
            },
          })
        },
      }),
      { width: 100, height: 8 },
    )
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain(`Edit ${SHELL_MUTATION_RUNNING}`)
      expect(result.captureCharFrame()).not.toContain("python3")
      const running = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("bash command"))!
      expect(running.fg.equals(theme.text)).toBe(true)
      expect(running.attributes & 1).toBe(0)
      setActive(new Set<string>())
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("python3 reshape.py")
      expect(result.captureCharFrame()).not.toContain(SHELL_MUTATION_RUNNING)
    } finally {
      result.renderer.destroy()
    }
  })
})
