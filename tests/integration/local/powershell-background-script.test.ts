import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { buildBackgroundScript } from "../../../src/orchestration/agent-runtime/tools/bash-script.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporary = temporaryDirectories()
const powershell = ["powershell", "pwsh"].find((shell) => Bun.which(shell) !== null)

describe.skipIf(process.platform !== "win32" || powershell === undefined)("a background PowerShell script", () => {
  // A command that crosses a planned replacement keeps writing after the
  // runtime that holds its inherited streams is gone, so everything the
  // script states goes to its log.
  test.each([
    { ending: "", code: 0, error: "" },
    { ending: "throw 'the build broke'", code: 1, error: "the build broke" },
  ])("merges Console and pipeline output once into its log with exit code $code", async ({ ending, code, error }) => {
    const dir = temporary("powershell-background-")
    const logPath = path.join(dir, "command.log")
    const scriptPath = path.join(dir, "command.ps1")
    fs.writeFileSync(scriptPath, buildBackgroundScript([
      "[Console]::Out.Write('direct-')",
      "[Console]::Out.WriteLine('stdout')",
      "Write-Output 'pipeline'",
      "[Console]::Error.WriteLine('direct-stderr')",
      "$bytes = [Text.Encoding]::UTF8.GetBytes(\"raw-stdout`n\"); [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
      "$bytes = [Text.Encoding]::UTF8.GetBytes(\"raw-stderr`n\"); [Console]::OpenStandardError().Write($bytes, 0, $bytes.Length)",
      "Start-Process -FilePath $env:ComSpec -NoNewWindow -Wait -ArgumentList '/c', '(echo inherited-out)& (echo inherited-err)>&2'",
      "Write-Output 'after-native'",
      ending,
    ].join("\n"), logPath, "win32"))

    const run = Bun.spawn([powershell ?? "pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { stdout: "pipe", stderr: "pipe", windowsHide: true })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

    expect({ stdout, stderr, code: exitCode }).toEqual({ stdout: "", stderr: "", code })
    const log = fs.readFileSync(logPath, "utf8").replaceAll("\r\n", "\n")
    expect(log).toBe(`direct-stdout\npipeline\ndirect-stderr\nraw-stdout\nraw-stderr\ninherited-out\ninherited-err\nafter-native\n${error ? `${error}\n` : ""}`)
  }, 30_000)
})
