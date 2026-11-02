import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { runFont } from "../../../src/cli/font.js"
import type { AccountDirectories } from "../../../src/infra/directory-authorities.js"
import { refusingLauncher } from "../../helpers/launcher-fake.js"

/** An unknown command must answer before it reads a directory or launches. */
const directories: AccountDirectories = { userDataRoot: "/nowhere/.flywheel", accountHome: "/nowhere" }

describe("font cli", () => {
  let lines: string[] = []
  let errorLines: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const originalExit = process.exit

  beforeEach(() => {
    lines = []
    errorLines = []
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
    console.error = (...args: unknown[]) => errorLines.push(args.map(String).join(" "))
    process.exit = mock(() => { throw new Error("process.exit") })
  })

  afterEach(() => {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
  })

  it("prints unknown-command errors and usage together on stderr", async () => {
    await expect(runFont(["wat"], directories, refusingLauncher)).rejects.toThrow("process.exit")
    const output = errorLines.join("\n")
    expect(output).toContain("Unknown font command: wat")
    expect(output.indexOf("Unknown font command: wat")).toBeLessThan(output.indexOf("Usage: flywheel font <command>"))
    expect(lines).toEqual([])
  })
})
