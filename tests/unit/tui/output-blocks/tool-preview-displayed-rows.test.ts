import { expect, it } from "bun:test"
import type { ToolEntry } from "../../../../src/infra/output-blocks.js"
import { resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry.js"
import { renderToolEntry } from "./_tool-entry-render.js"
import { writeEntry } from "./_write-entry-fixture.js"
import { mutationEvidenceFixture } from "./_mutation-evidence-fixture.js"

it.each(["write", "streaming"] as const)("caps wrapped %s previews and expands wrapping-only overflow", async (kind) => {
  const content = "wrapped ".repeat(180)
  const block: ToolEntry = kind === "streaming" ? { ...writeEntry(""), status: "streaming" } : writeEntry(content)
  const result = await renderToolEntry(block, {
    width: 48,
    height: 96,
    ...(kind === "streaming" ? { streamingToolText: { "write-1": { content, filetype: "typescript" } } } : {}),
  })
  const rows = () => result.captureCharFrame().split("\n").filter((line) => line.includes("wrapped"))
  try {
    await result.renderOnce()
    await result.renderOnce()
    const collapsedRows = rows()
    expect(collapsedRows).toHaveLength(20)
    expect(result.captureCharFrame()).toContain("click to expand")
    await result.mockMouse.click(4, 0)
    await result.mockMouse.moveTo(47, 95)
    await result.renderOnce()
    expect(rows().length).toBeGreaterThan(20)
    expect(rows().slice(0, 20)).toEqual(collapsedRows)
    result.resize(160, 96)
    await result.renderOnce()
    await result.renderOnce()
    expect(result.captureCharFrame()).toContain("click to collapse")
    await result.mockMouse.click(4, 0)
    await result.mockMouse.moveTo(47, 95)
    await result.renderOnce()
    await result.renderOnce()
    expect(rows().length).toBeLessThan(20)
    expect(result.captureCharFrame()).not.toContain("click to expand")
    result.resize(48, 96)
    await result.renderOnce()
    await result.renderOnce()
    expect(rows()).toHaveLength(20)
    expect(result.captureCharFrame()).toContain("click to expand")
  } finally {
    result.renderer.destroy()
  }
})

it("wraps a collapsed legacy diff line, caps it at the preview rows, and expands it to full text", async () => {
  const result = await renderToolEntry({
    kind: "tool", id: "edit-1", name: "edit", status: "completed", timestamp: 0,
    presentation: resolveToolPresentation("edit", { path: "example.ts" }, "/workspace"),
    diff: `--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n+${"wrapped ".repeat(180)}tail-end`,
  }, { width: 48, height: 96 })
  const lines = () => result.captureCharFrame().split("\n")
  try {
    await result.renderOnce()
    await result.renderOnce()
    expect(lines()[0]).toContain("▸")
    expect(lines().filter((line) => line.includes("wrapped"))).toHaveLength(20)
    expect(lines().join("\n")).not.toContain("tail-end")
    expect(lines().join("\n")).toContain("click to expand")
    await result.mockMouse.click(4, 0)
    await result.mockMouse.moveTo(47, 95)
    await result.renderOnce()
    expect(lines().filter((line) => line.includes("wrapped")).length).toBeGreaterThan(20)
    expect(lines().join("\n")).toContain("tail-end")
    await result.mockMouse.click(4, 0)
    await result.mockMouse.moveTo(47, 95)
    await result.renderOnce()
    await result.renderOnce()
    expect(lines()[0]).toContain("▸")
    expect(lines().filter((line) => line.includes("wrapped"))).toHaveLength(20)
  } finally {
    result.renderer.destroy()
  }
})

it("states wrapped rows, not a line count, as the hidden content of a collapsed diff past both budgets", async () => {
  const added = Array.from({ length: 30 }, (_, index) => `+row${index} ${"word ".repeat(10)}`)
  const result = await renderToolEntry({
    kind: "tool", id: "edit-1", name: "edit", status: "completed", timestamp: 0,
    presentation: resolveToolPresentation("edit", { path: "example.ts" }, "/workspace"),
    diff: `--- a/example.ts\n+++ b/example.ts\n@@ -1,0 +1,30 @@\n${added.join("\n")}`,
  }, { width: 48, height: 96 })
  try {
    await result.renderOnce()
    await result.renderOnce()
    const frame = result.captureCharFrame()
    expect(frame).toContain("row9 ")
    expect(frame).not.toContain("row10 ")
    expect(frame).toContain("... more content (click to expand)")
    expect(frame).not.toContain("+10 lines")
  } finally {
    result.renderer.destroy()
  }
})

it("wraps each collapsed file to the preview rows and keeps an expansion control for each file", async () => {
  const files = ["first", "second"].map((name) => ({
    path: `${name}.ts`,
    change: "modified" as const,
    unifiedDiff: `--- a/${name}.ts\n+++ b/${name}.ts\n@@ -1 +1 @@\n+${`${name} `.repeat(240)}${name}-tail`,
  }))
  const fixture = await mutationEvidenceFixture({ version: 1, files, omissions: [] })
  const result = await renderToolEntry({
    kind: "tool", id: "edit-many", name: "edit", status: "completed", timestamp: 0,
    presentation: resolveToolPresentation("edit", {}, "/workspace"),
    fileChangeKind: "patch",
    mutationEvidence: fixture.evidence,
  }, { width: 48, height: 160, evidenceReader: fixture.reader })
  try {
    for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
    const lines = result.captureCharFrame().split("\n")
    for (const name of ["first", "second"]) {
      expect(lines.filter((line) => line.includes(name) && !line.includes(`${name}.ts`))).toHaveLength(20)
      expect(lines.join("\n")).not.toContain(`${name}-tail`)
    }
    // Wrapped rows past the preview are each file's only hidden content.
    expect(lines.filter((line) => line.includes("click to expand"))).toHaveLength(2)
    for (const name of ["first", "second"]) {
      expect(lines.find((line) => line.includes(`${name}.ts`))).toMatch(new RegExp(`${name}\\.ts \\(\\w+\\) ▸`))
    }
    const headingRow = lines.findIndex((line) => line.includes("second.ts"))
    await result.mockMouse.click(8, headingRow)
    for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
    const expanded = result.captureCharFrame().split("\n")
    expect(expanded.filter((line) => line.includes("first") && !line.includes("first.ts"))).toHaveLength(20)
    expect(expanded.filter((line) => line.includes("second") && !line.includes("second.ts")).length).toBeGreaterThan(20)
    expect(expanded.join("\n")).toContain("second-tail")
    expect(expanded.join("\n")).not.toContain("first-tail")
  } finally {
    result.renderer.destroy()
  }
})
