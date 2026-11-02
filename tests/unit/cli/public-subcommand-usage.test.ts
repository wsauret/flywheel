import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { runMaintain } from "../../../src/cli/event-maintain.js"

const originalLog = console.log
let lines: string[] = []

beforeEach(() => {
  lines = []
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
})

afterEach(() => {
  console.log = originalLog
})

describe("installed subcommand usage", () => {
  it("advertises the public maintenance command", async () => {
    // Help answers before the command opens any project.
    await runMaintain(["--help"], "/nowhere")

    expect(lines.join("\n")).toContain("flywheel events maintain")
    expect(lines.join("\n")).not.toContain("flywheel maintain")
    expect(lines.join("\n")).not.toContain("bun run")
  })
})
