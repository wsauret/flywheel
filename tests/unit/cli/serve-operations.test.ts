import { describe, expect, spyOn, test } from "bun:test"

import { runServe, runServeOperation } from "../../../src/cli/serve.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import type { AccountServiceInstallation } from "../../../src/orchestration/app-service/account-service-installation.js"
import { AccountServiceInstallationError } from "../../../src/orchestration/app-service/service-manager-command.js"
import { installationOf } from "../orchestration/app-service/_account-service-fixtures.js"
import { unusedLauncher } from "./_serve-fixtures.js"

const NOTICE = "Flywheel stops when you log out, because lingering is off for wes. To keep Flywheel running after you log out, run `sudo loginctl enable-linger wes` on this machine.\n"
const DIRECTORIES = { accountHome: "/scratch/home", userDataRoot: "/scratch/home/.flywheel", projectRoot: "/scratch/home", executionCwd: "/scratch/home" }

/** What `flywheel serve <args>` prints, with its exit code. */
async function printed(
  args: readonly string[],
  installation: Partial<AccountServiceInstallation> = { lingerOffFor: async () => "wes" },
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const out: string[] = []
  const err: string[] = []
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true })
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { err.push(String(chunk)); return true })
  try {
    const code = await runServeOperation(args[0] ?? "", args, DIRECTORIES, unusedLauncher(), false, installationOf(installation))
    return { code, stdout: out.join(""), stderr: err.join("") }
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
}

describe("the logout notice of flywheel serve install", () => {
  test("serve install, which a person runs, prints the notice once the service is registered", async () => {
    expect(await printed(["install"])).toEqual({ code: 0, stdout: NOTICE, stderr: "" })
  })

  test("serve install --update, which an update runs, prints nothing", async () => {
    expect(await printed(["install", "--update"])).toEqual({ code: 0, stdout: "", stderr: "" })
  })
})

describe("what flywheel serve says when it registers nothing or refuses", () => {
  test("serve install in a home that is not the login home says that nothing was registered", async () => {
    const result = await printed(["install"], { installed: async () => null })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Process initiation cannot be registered for /scratch/home, because it is not the home you log in to.")
  })

  test("a registration refusal names its operation, not a failed start", async () => {
    const refuse = async () => { throw new AccountServiceInstallationError("Process initiation requires an installed Flywheel build.") }
    for (const [args, label] of [[["install"], "install"], [["uninstall"], "uninstall"], [["install", "--update"], "install --update"]] as const) {
      const result = await printed(args, { install: refuse, uninstall: refuse, refresh: refuse })
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(`flywheel serve ${label}: Process initiation requires an installed Flywheel build.\n`)
    }
  })

  test("an argument it does not know is named, with the usage", async () => {
    for (const [args, word] of [[["bogus"], "bogus"], [["install", "extra"], "extra"], [["install", "--update", "extra"], "extra"], [["ensure", "x"], "x"]] as const) {
      const result = await printed(args)
      expect(result.code).toBe(1)
      expect(result.stderr).toStartWith(`flywheel serve: unknown argument: ${word}\n\nUsage: flywheel serve`)
    }
  })

  test("a word after the scheduled-task argument is named, not the argument itself", async () => {
    const err: string[] = []
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { err.push(String(chunk)); return true })
    try {
      expect(await runServe(["--scheduled-task", "extra"], DIRECTORIES, unusedLauncher(), createPersistentProcessManager(), false)).toBe(1)
    } finally {
      stderr.mockRestore()
    }
    expect(err.join("")).toStartWith("flywheel serve: unknown argument: extra\n")
  })
})
