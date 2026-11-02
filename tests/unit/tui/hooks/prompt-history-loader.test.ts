import { beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { loadPromptHistorySync } from "../../../../src/tui/hooks/composer-history-loader.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

describe("loadPromptHistorySync", () => {
  const temporaryDirectory = temporaryDirectories()
  let testDir = ""

  beforeEach(() => {
    testDir = temporaryDirectory("composer-history-loader-test-")
  })

  test("returns [] when the file does not exist", () => {
    expect(loadPromptHistorySync(join(testDir, "missing.jsonl"))).toEqual([])
  })

  test("loads one entry per line", async () => {
    const filePath = join(testDir, "history.jsonl")
    await Bun.write(filePath, `${JSON.stringify("first")}\n${JSON.stringify("second")}\n`)

    expect(loadPromptHistorySync(filePath)).toEqual(["first", "second"])
  })

  test("drops a corrupt line but keeps the rest of the file", async () => {
    const filePath = join(testDir, "history.jsonl")
    await Bun.write(filePath, `${JSON.stringify("first")}\nnot valid json\n${JSON.stringify("third")}\n`)

    expect(loadPromptHistorySync(filePath)).toEqual(["first", "third"])
  })

  test("drops a line that parses but isn't a string", async () => {
    const filePath = join(testDir, "history.jsonl")
    await Bun.write(filePath, `${JSON.stringify("first")}\n${JSON.stringify(42)}\n${JSON.stringify(["second"])}\n`)

    expect(loadPromptHistorySync(filePath)).toEqual(["first"])
  })

  test("ignores trailing blank lines", async () => {
    const filePath = join(testDir, "history.jsonl")
    await Bun.write(filePath, `${JSON.stringify("only")}\n\n`)

    expect(loadPromptHistorySync(filePath)).toEqual(["only"])
  })
})
