/** Production launch callers, exercised against real processes on this host.
 *
 *  Every case here proves one caller category no longer starts a subprocess of
 *  its own: either it launches through an owned scope whose container the
 *  guardian holds, or it does not launch at all. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, copyFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { runOwnedCommand } from "../../../src/infra/owned-command.js"
import { launchFailed } from "../../../src/infra/owned-subprocess.js"
import { createLauncherScope, type LauncherScope } from "../../../src/infra/process-supervisor.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { createRealProcessFixture, unguardedSpawnOwned } from "../../helpers/real-process-fixture.js"

const repoRoot = join(import.meta.dir, "..", "..", "..")

const running = new Set<{ kill(signal?: NodeJS.Signals): void }>()

afterEach(() => {
  for (const proc of running) proc.kill("SIGKILL")
  running.clear()
})

describe("the source launch path", () => {
  test("the replacement preserves argv and exit status", async () => {
    const proc = Bun.spawn([join(repoRoot, "bin", "flywheel"), "--version"], { stdout: "pipe", stderr: "pipe", windowsHide: true })
    running.add(proc)

    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(stdout.trim()).toMatch(/^flywheel \d+\.\d+\.\d+/)
  })

  test.skipIf(process.platform !== "linux")("owned launches survive removal of the running Bun path", async () => {
    const scratch = createRealProcessFixture("owned-command-unlinked-bun")
    const copiedBun = scratch.file("bun")
    await copyFile(process.execPath, copiedBun)
    await chmod(copiedBun, 0o700)
    const helper = pathToFileURL(join(repoRoot, "tests", "helpers", "real-process-fixture.ts")).href
    const source = [
      'import { unlink } from "node:fs/promises"',
      `const { unguardedSpawnOwned } = await import(${JSON.stringify(helper)})`,
      "await unlink(process.execPath)",
      'const owned = await unguardedSpawnOwned(1_000)(["sh", "-c", "printf stable"], { stdout: "pipe", stderr: "pipe" })',
      "const stdout = await new Response(owned.stdout).text()",
      "const exit = await owned.exited",
      'if (exit.code !== 0 || stdout !== "stable") throw new Error("owned launch failed: " + JSON.stringify({ exit, stdout }))',
    ].join("\n")
    const proc = Bun.spawn([copiedBun, "-e", source], { stdout: "pipe", stderr: "pipe", windowsHide: true })
    running.add(proc)

    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    scratch.cleanup()
  }, 30_000)
})

describe("one owned command", () => {
  const fixture = createRealProcessFixture("owned-command")
  const temporaryDirectory = temporaryDirectories()
  // A fresh scope per test, so closing one test's containers never refuses the
  // next test's launch.
  let scope: LauncherScope

  beforeEach(() => {
    scope = createLauncherScope({
      spawnOwned: async (command, options) => {
        const owned = await unguardedSpawnOwned()(command, options)
        fixture.guard(owned.pid)
        return owned
      },
      adoptOwned: () => Promise.reject(new Error("no command is adopted here")),
    })
  })

  afterEach(async () => {
    await scope.close()
    fixture.cleanup()
  })

  test("reports the exit code and both streams of a real container", async () => {
    const result = await runOwnedCommand(scope, [
      process.execPath,
      "-e",
      'console.log("out"); console.error("err"); process.exit(3)',
    ])

    expect(result.exitCode).toBe(3)
    expect(result.stdout.trim()).toBe("out")
    expect(result.stderr.trim()).toBe("err")
    expect(result.timedOut).toBe(false)
  })

  test("ends a command that outlives its lease and says so", async () => {
    const result = await runOwnedCommand(scope, [process.execPath, "-e", "setInterval(() => {}, 30_000)"], {
      timeoutMs: 200,
    })

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
  })

  test("a payload that cannot run settles with the status of a failed launch, and a payload that ran does not", async () => {
    const dir = temporaryDirectory("owned-launch-failed-")
    const notExecutable = join(dir, "not-executable")
    await writeFile(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 })
    const settle = async (command: readonly string[]) => (await scope.spawnOwned(command)).exited

    expect(launchFailed(await settle([join(dir, "missing")]))).toBe(true)
    if (process.platform !== "win32") expect(launchFailed(await settle([notExecutable]))).toBe(true)
    expect(launchFailed(await settle([process.execPath, "-e", "process.exit(3)"]))).toBe(false)
  })

  test("a program that is missing names itself on the command's stderr", async () => {
    const missing = join(temporaryDirectory("owned-missing-"), "missing")
    const result = await runOwnedCommand(scope, [missing])

    expect(result.exitCode).toBe(127)
    expect(result.stderr).toContain(`flywheel: `)
    expect(result.stderr).toContain(missing)
  })
})
