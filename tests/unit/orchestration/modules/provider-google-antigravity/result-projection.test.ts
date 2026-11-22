import { describe, expect, spyOn, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { canonicalDirectory } from "../../../../../src/infra/directory-authorities.js"
import { createBudgetNudge } from "../../../../../src/orchestration/agent-runtime/budget-nudge.js"
import { limitOutput } from "../../../../../src/orchestration/agent-runtime/compaction/truncation.js"
import type { LlmToolOutputPart } from "../../../../../src/orchestration/agent-runtime/llm/messages.js"
import * as breadcrumb from "../../../../../src/orchestration/agent-runtime/tools/output-breadcrumb.js"
import { readDefinition } from "../../../../../src/orchestration/agent-runtime/tools/read.js"
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js"
import { projectToolResult, TOOL_RESULT_WIRE_BYTES } from "../../../../../src/orchestration/modules/provider-google-antigravity/result-projection.js"
import { admitEveryTool } from "../../../../helpers/request-tool-surface.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { makeContext } from "../../agent-runtime/tools/_fixtures.js"

const SCOPE = "session-1"
const temporaryDirectory = temporaryDirectories()

function project() {
  const root = canonicalDirectory(temporaryDirectory("fw-agy-results-"), "test project root")
  const outputs = join(root, ".flywheel", "agent-outputs", SCOPE)
  return {
    root,
    context: { executionCwd: root, projectRoot: root, artifactScopeId: SCOPE, toolName: "bash", capabilities: () => true },
    saved: () => { try { return readdirSync(outputs) } catch { return [] } },
  }
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8")
const textOf = (parts: readonly LlmToolOutputPart[]) => parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")

/** Reads `path` as an agent that the route serves: through dispatch, with the route's tool result size less what the
 *  turn reserves. */
async function readPage(root: string, path: string, offset?: number, reserved = 0): Promise<string> {
  const input = { path, ...offset === undefined ? {} : { offset } }
  const result = await executePreparedTool(
    prepareToolCall({ id: "read", name: "read", input }, new Map([["read", readDefinition]]), admitEveryTool),
    makeContext({ executionCwd: root, projectRoot: root, toolResultWireBytes: TOOL_RESULT_WIRE_BYTES - reserved }),
  )
  return String(result.content)
}

describe("the Antigravity tool result projection", () => {
  test("returns a result that fits the route unchanged", async () => {
    const { context, saved } = project()
    const content: LlmToolOutputPart[] = [{ type: "text", text: "a".repeat(TOOL_RESULT_WIRE_BYTES - 2) }, { type: "text", text: "b" }]
    expect(await projectToolResult(content, context)).toBe(content)
    expect(saved()).toEqual([])
  })

  test("cuts a long result that Flywheel kept whole to a preview naming a new saved file, which read pages through in full within the route's size", async () => {
    const { root, context, saved } = project()
    const lines = Array.from({ length: 1_000 }, (_, index) => `output line ${String(index + 1).padStart(4, "0")} ${"x".repeat(8)}`)
    const original = lines.join("\n")
    expect(bytes(original)).toBeGreaterThan(25_000)
    expect(bytes(original)).toBeLessThan(30_000)

    const wire = textOf(await projectToolResult([{ type: "text", text: original }], context))
    expect(bytes(wire)).toBeLessThanOrEqual(TOOL_RESULT_WIRE_BYTES)
    expect(wire).toStartWith("output line 0001")
    const files = saved()
    expect(files).toHaveLength(1)
    const path = `.flywheel/agent-outputs/${SCOPE}/${files[0] ?? ""}`
    expect(wire).toEndWith(`\n[Full output saved to ${path}; grep it with the search tool if you need the removed content]`)
    expect(readFileSync(join(root, path), "utf8")).toBe(original)

    const shown = new Map<number, string>()
    let offset: number | undefined
    for (let page = 0; page < 10; page += 1) {
      const text = await readPage(root, path, offset)
      expect(bytes(text)).toBeLessThanOrEqual(TOOL_RESULT_WIRE_BYTES)
      // A page fits the route, so its own delivery is never cut again.
      const pageContent: LlmToolOutputPart[] = [{ type: "text", text }]
      expect(await projectToolResult(pageContent, context)).toBe(pageContent)
      for (const match of text.matchAll(/^(\d+)\|(.*)$/gmu)) shown.set(Number(match[1]), match[2] ?? "")
      const next = /Use offset=(\d+) to continue reading/u.exec(text)?.[1]
      if (next === undefined) break
      offset = Number(next)
    }
    expect([...shown.keys()].sort((left, right) => left - right)).toEqual(lines.map((_, index) => index + 1))
    expect([...shown.values()].sort()).toEqual([...lines].sort())
    expect(saved()).toEqual(files)
  })

  for (const [name, capabilities, notice] of [
    ["with tools that read it", () => true, (path: string) => `[Full output saved to ${path}; grep it with the search tool if you need the removed content]`],
    ["with no tool that reads it", () => false, () => "[Output was truncated. The rest of the output is not available with your tools.]"],
  ] as const) {
    test(`names the file that Flywheel's own cut saved once, keeps the text after its notice, and writes no second file, ${name}`, async () => {
      const { context: base, saved } = project()
      const context = { ...base, capabilities }
      const limited = await limitOutput({ ...context, content: `head ${"y".repeat(60_000)} tail` })
      const files = saved()
      expect(files).toHaveLength(1)
      expect(bytes(limited.text)).toBeGreaterThan(TOOL_RESULT_WIRE_BYTES)
      const trailer = "[budget: 2 of 10 turns remain.]"

      const wire = textOf(await projectToolResult([{ type: "text", text: limited.text }, { type: "text", text: trailer }], { ...context, savedOutputPath: limited.fullContentPath }))
      expect(bytes(wire)).toBeLessThanOrEqual(TOOL_RESULT_WIRE_BYTES)
      expect(wire).toStartWith("head yyyy")
      expect(wire).toEndWith(`yyyy tail\n${trailer}\n${notice(`.flywheel/agent-outputs/${SCOPE}/${files[0] ?? ""}`)}`)
      expect(wire.split(notice(`.flywheel/agent-outputs/${SCOPE}/${files[0] ?? ""}`))).toHaveLength(2)
      expect(saved()).toEqual(files)
    })
  }

  test("saves a long result that only ends like a recovery notice, and names its own file", async () => {
    const { root, context, saved } = project()
    const original = `${"w".repeat(20_000)}\n[Full output saved to missing.txt]`

    const wire = textOf(await projectToolResult([{ type: "text", text: original }], context))
    expect(bytes(wire)).toBeLessThanOrEqual(TOOL_RESULT_WIRE_BYTES)
    const files = saved()
    expect(files).toHaveLength(1)
    expect(wire).toEndWith(`\n[Full output saved to .flywheel/agent-outputs/${SCOPE}/${files[0] ?? ""}; grep it with the search tool if you need the removed content]`)
    expect(readFileSync(join(root, ".flywheel", "agent-outputs", SCOPE, files[0] ?? ""), "utf8")).toBe(original)
  })

  test("delivers a read page whole when the turn's budget trailer joins it", async () => {
    const { root, context, saved } = project()
    const path = "lines.txt"
    await Bun.write(join(root, path), Array.from({ length: 2_000 }, (_, index) => `line ${String(index)} ${"x".repeat(20)}`).join("\n"))
    const nudge = createBudgetNudge(10, true)

    const page = await readPage(root, path, undefined, nudge.trailerBytes(9))
    const [delivered] = nudge.applyTrailer([{ toolUseId: "read", content: [{ type: "text", text: page }], outcome: "ok" }], 9)
    const content = delivered?.content ?? []
    expect(bytes(textOf(content))).toBeGreaterThan(TOOL_RESULT_WIRE_BYTES - 200)
    expect(await projectToolResult(content, context)).toBe(content)
    expect(saved()).toEqual([])
  })

  test("keeps a valid UTF-8 preview of one long multibyte line, and read shows a valid prefix of its saved file with the long-line notice", async () => {
    const { root, context, saved } = project()
    const line = "é漢".repeat(6_000)
    expect(bytes(line)).toBe(30_000)
    const image: LlmToolOutputPart = { type: "image", data: "aGVsbG8=", mediaType: "image/png" }

    const projected = await projectToolResult([{ type: "text", text: line }, image], context)
    expect(projected.at(-1)).toBe(image)
    const wire = textOf(projected)
    expect(bytes(wire)).toBeLessThanOrEqual(TOOL_RESULT_WIRE_BYTES)
    expect(wire).not.toContain("�")
    const text = await readPage(root, `.flywheel/agent-outputs/${SCOPE}/${saved()[0] ?? ""}`)
    expect(bytes(text)).toBeLessThanOrEqual(TOOL_RESULT_WIRE_BYTES)
    expect(text).not.toContain("�")
    expect(text).toStartWith("1|é漢")
    expect(text).toMatch(/\n\[Line 1 is longer than the output limit: showed \d+ of its 30000 bytes\. Use the bash tool to see the rest of the line\.\]\n/u)
  })

  test("states that the full output was not saved when the save fails", async () => {
    const { context } = project()
    // The disk refused the write, such as when it is full, which the save reports as no file.
    const save = spyOn(breadcrumb, "saveFullOutput").mockResolvedValue(null)
    try {
      const wire = textOf(await projectToolResult([{ type: "text", text: "z".repeat(20_000) }], context))
      expect(bytes(wire)).toBeLessThanOrEqual(TOOL_RESULT_WIRE_BYTES)
      expect(wire).toStartWith("zzzz")
      expect(wire).toEndWith("\n[Output was truncated and the full output could not be saved to disk]")
      expect(save).toHaveBeenCalledTimes(1)
    } finally {
      save.mockRestore()
    }
  })
})
