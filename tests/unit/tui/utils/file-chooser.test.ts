import { describe, expect, it } from "bun:test"

import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../src/infra/owned-command.js"
import { chooseFiles, fileChooserCommand } from "../../../../src/tui/utils/file-chooser.js"

const has = (...tools: string[]) => (tool: string) => (tools.includes(tool) ? `/usr/bin/${tool}` : null)

function runner(result: Partial<OwnedCommandResult>): OwnedCommandRunner & { readonly calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  const run: OwnedCommandRunner = async (command) => {
    calls.push(command)
    return { exitCode: 0, stdoutBytes: new Uint8Array(), stdout: "", stderr: "", timedOut: false, ...result }
  }
  return Object.assign(run, { calls })
}

describe("fileChooserCommand", () => {
  it("asks each platform's own chooser and names the prompt", () => {
    expect(fileChooserCommand("darwin", has("osascript"), "Attach \"to\" Flywheel")?.slice(0, 3)).toEqual(["osascript", "-e", "set chosen to choose file with prompt \"Attach \\\"to\\\" Flywheel\" with multiple selections allowed"])
    expect(fileChooserCommand("win32", has(), "It's here")?.[0]).toBe("powershell.exe")
    expect(fileChooserCommand("win32", has(), "It's here")?.at(-1)).toContain("$d.Title = 'It''s here'")
    expect(fileChooserCommand("linux", has("zenity"), "Attach")?.[0]).toBe("zenity")
    expect(fileChooserCommand("linux", has("kdialog"), "Attach")?.[0]).toBe("kdialog")
  })
  it("has nothing to ask where no chooser is installed", () => {
    expect(fileChooserCommand("linux", has(), "Attach")).toBeUndefined()
    expect(fileChooserCommand("darwin", has(), "Attach")).toBeUndefined()
  })
})

describe("chooseFiles", () => {
  it("answers the picked paths one per line", async () => {
    const run = runner({ stdout: "/Users/me/Desktop/shot.png\n/Users/me/notes.md\n" })
    expect(await chooseFiles(run, "Attach", "darwin", has("osascript"))).toEqual({ kind: "chosen", paths: ["/Users/me/Desktop/shot.png", "/Users/me/notes.md"] })
    expect(run.calls[0]?.[0]).toBe("osascript")
  })
  it("reads a cancel as a cancel, whatever the exit code", async () => {
    expect(await chooseFiles(runner({ exitCode: 1, stderr: "User canceled. (-128)" }), "Attach", "darwin", has("osascript"))).toEqual({ kind: "cancelled" })
    expect(await chooseFiles(runner({ exitCode: 0, stdout: "" }), "Attach", "win32", has())).toEqual({ kind: "cancelled" })
  })
  it("says when no chooser exists or the one opened was never used", async () => {
    const missing = await chooseFiles(runner({}), "Attach", "linux", has())
    expect(missing.kind).toBe("unavailable")
    if (missing.kind === "unavailable") expect(missing.reason).toContain("zenity or kdialog")
    const stale = await chooseFiles(runner({ timedOut: true }), "Attach", "darwin", has("osascript"))
    expect(stale.kind).toBe("unavailable")
  })
})
