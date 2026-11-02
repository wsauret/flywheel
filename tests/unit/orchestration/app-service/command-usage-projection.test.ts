import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCommandUsageProjection } from "../../../../src/orchestration/app-service/command-usage-projection.js"

const roots: string[] = []
function usageFile(content?: string): string {
  const root = mkdtempSync(join(tmpdir(), "fw-command-usage-"))
  roots.push(root)
  const file = join(root, "command_usage.jsonl")
  if (content !== undefined) writeFileSync(file, content)
  return file
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("command usage projection", () => {
  test("folds recorded tokens and summaries into one ranked view, dropping corrupt lines", () => {
    const file = usageFile('"ship"\n{"model":3,"ship":1}\nnot json\n"bad token!"\n{"deep":0}\n"workflow:debug"\n')
    const projection = createCommandUsageProjection({ filePath: file, publish: () => {} })
    expect(projection.view()).toEqual({ uses: [{ name: "model", count: 3 }, { name: "ship", count: 2 }, { name: "workflow:debug", count: 1 }] })
  })

  test("records a use, publishes the new view, and appends one line", () => {
    const file = usageFile()
    const patches: unknown[] = []
    const projection = createCommandUsageProjection({ filePath: file, publish: (patch) => patches.push(patch) })
    expect(projection.record("ship")).toBe(true)
    expect(projection.record("ship")).toBe(true)
    expect(projection.record("no spaces here")).toBe(false)
    expect(projection.view()).toEqual({ uses: [{ name: "ship", count: 2 }] })
    expect(patches).toEqual([
      { cursor: { scope: "workspace", domain: "commandUsage" }, payload: { kind: "commandUsage.changed", usage: { uses: [{ name: "ship", count: 1 }] } } },
      { cursor: { scope: "workspace", domain: "commandUsage" }, payload: { kind: "commandUsage.changed", usage: { uses: [{ name: "ship", count: 2 }] } } },
    ])
    expect(readFileSync(file, "utf-8")).toBe('"ship"\n"ship"\n')
  })

})
