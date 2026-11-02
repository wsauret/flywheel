import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { join } from "node:path"
import { appendJsonLine, createJsonFile } from "../../../src/orchestration/modules/development/benchmark/json-lines.js"
import { ensuredDirectoryUnder } from "../../../src/orchestration/modules/development/benchmark/paths.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

const spies: Array<{ mockRestore(): void }> = []

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

describe("benchmark JSONL durability", () => {
  test("syncs each new results directory entry in its parent", async () => {
    const parent = temporaryDirectory("flywheel-results-parent-")
    const root = join(parent, "results")
    const campaign = join(root, "campaign")
    const sync = spyOn(fs, "fsyncSync").mockImplementation(() => {})
    spies.push(sync)

    await ensuredDirectoryUnder(root, campaign, "campaign")

    expect(sync).toHaveBeenCalledTimes(process.platform === "win32" ? 0 : 2)
  })

  test("allows concurrent campaigns to create one missing results root", async () => {
    const parent = temporaryDirectory("flywheel-concurrent-results-")
    const root = join(parent, "results")

    const campaigns = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        ensuredDirectoryUnder(root, join(root, `campaign-${index}`), `campaign-${index}`)
      ),
    )

    expect(new Set(campaigns).size).toBe(12)
  })

  test("syncs the parent directory when a config or ledger name is created", async () => {
    const directory = temporaryDirectory("flywheel-json-lines-")
    const sync = spyOn(fs, "fsyncSync").mockImplementation(() => {})
    spies.push(sync)

    await createJsonFile(join(directory, "run-config.json"), "{}\n")
    await appendJsonLine(join(directory, "runs.jsonl"), { run: 1 })

    expect(sync).toHaveBeenCalledTimes(process.platform === "win32" ? 0 : 2)
  })

  test("does not resync the parent directory for an existing ledger name", async () => {
    const directory = temporaryDirectory("flywheel-json-lines-")
    const ledger = join(directory, "runs.jsonl")
    await appendJsonLine(ledger, { run: 1 })
    const sync = spyOn(fs, "fsyncSync").mockImplementation(() => {})
    spies.push(sync)

    await appendJsonLine(ledger, { run: 2 })

    expect(sync).not.toHaveBeenCalled()
  })
})
