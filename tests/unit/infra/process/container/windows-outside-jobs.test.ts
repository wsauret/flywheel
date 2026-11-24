import { describe, expect, test } from "bun:test"

import type { TrustedCommandResult } from "../../../../../src/infra/process/container/process-container.js"
import type { TrustedProbeLaunch } from "../../../../../src/infra/trusted-probe-launch.js"
import { launchOutsideJobs, OutsideJobsLaunchError, type OutsideJobsLaunchRequest, type OutsideJobsSeams } from "../../../../../src/infra/process/container/windows-outside-jobs.js"
import type { WindowsProcessHold } from "../../../../../src/infra/process/kernel/windows-process-api.js"

const SYSTEM = "C:\\WINDOWS\\system32"
/** One creation time as WMI states it and as the kernel does, observed
 *  together on a Windows 11 host. */
const CREATION_DATE = "20261122081005.187828-480"
const CREATED_FILETIME = 134398374051878287n
const CREATED_REPLY = JSON.stringify({ returnValue: 0, processId: 4242, creationDate: CREATION_DATE })

const request: OutsideJobsLaunchRequest = {
  command: ["C:\\Program Files\\Flywheel\\flywheel.exe", "serve", "C:\\a b\\", "", "100% & ^x"],
  cwd: "C:\\work",
  env: { PATH: "C:\\bin", SECRET: "value=with=equals", UNSET: undefined },
  stdoutPath: "C:\\Temp\\spool %x%\\stdout",
  stderrPath: "C:\\Temp\\spool %x%\\stderr",
}

/** A held process's exit and resume answer, which the test sets, and the
 *  calls made to it. */
interface HeldState {
  exitCode: number | undefined
  resumes: boolean
  resumed: number
  terminated: number
  closed: number
}

function heldProcess(createdFileTime = CREATED_FILETIME) {
  const state: HeldState = { exitCode: undefined, resumes: true, resumed: 0, terminated: 0, closed: 0 }
  const hold: WindowsProcessHold = {
    createdFileTime,
    exitCode: () => state.closed > 0 ? undefined : state.exitCode,
    resume: () => { state.resumed += 1; return state.resumes },
    terminate: () => { state.terminated += 1; return true },
    close: () => { state.closed += 1 },
  }
  return { state, hold }
}

function seams(overrides: Partial<OutsideJobsSeams> & { readonly answer?: TrustedCommandResult } = {}) {
  const runs: { readonly launch: TrustedProbeLaunch; readonly input: string }[] = []
  const held = heldProcess()
  const wmi: OutsideJobsSeams = {
    systemDirectory: () => SYSTEM,
    exists: () => true,
    run: async (launch, input) => {
      runs.push({ launch, input })
      return overrides.answer ?? { exitCode: 0, stdout: CREATED_REPLY, stderr: "" }
    },
    hold: () => held.hold,
    pollMs: 1,
    ...overrides,
  }
  return { wmi, runs, held }
}

function decodedInput(input: string): { readonly commandLine: string; readonly cwd: string; readonly environment: readonly string[] } {
  return JSON.parse(Buffer.from(input, "base64").toString("utf8"))
}

describe("launch outside every job", () => {
  test("runs the system PowerShell with no inherited search path, and asks WMI for the system cmd.exe with each value behind a quoted variable", async () => {
    const { wmi, runs, held } = seams()
    const child = await launchOutsideJobs(request, wmi)

    const [run] = runs
    expect(run?.launch.argv[0]).toBe(`${SYSTEM}\\WindowsPowerShell\\v1.0\\powershell.exe`)
    expect(run?.launch.env.PATH).toBe(SYSTEM)
    expect(run?.launch.env.PSModulePath).toBe(`${SYSTEM}\\WindowsPowerShell\\v1.0\\Modules`)
    expect(run?.launch.windowsHide).toBe(true)
    // The request, with the environment and its secret, reaches the script
    // only on its standard input.
    expect(run?.launch.argv.join(" ")).not.toContain("value=with=equals")

    const sent = decodedInput(run?.input ?? "")
    expect(sent.cwd).toBe("C:\\work")
    expect(sent.commandLine.startsWith(`"${SYSTEM}\\cmd.exe" /d /v:off /s /c "`)).toBe(true)
    const variables = new Map(sent.environment.map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]))
    expect(variables.get("PATH")).toBe("C:\\bin")
    expect(variables.get("SECRET")).toBe("value=with=equals")
    expect(variables.has("UNSET")).toBe(false)
    // No value of the request is written into the line itself.
    for (const value of [...request.command.filter((argument) => argument !== ""), request.stdoutPath]) expect(sent.commandLine).not.toContain(value)
    // Every reference in the line resolves to its value, and the C runtime
    // reads a doubled trailing backslash as one.
    const resolved = sent.commandLine.replace(/%(FLYWHEEL_OUTSIDE_JOBS_[A-Z0-9]+)%/gu, (_, name: string) => variables.get(name) ?? "<missing>")
    expect(resolved).not.toContain("<missing>")
    expect(resolved).toContain(`"C:\\Program Files\\Flywheel\\flywheel.exe" "serve" "C:\\a b\\\\" "" "100% & ^x" <nul 1>>"C:\\Temp\\spool %x%\\stdout" 2>>"C:\\Temp\\spool %x%\\stderr"`)
    // The line clears each variable it reads, before the command runs.
    for (const name of variables.keys()) {
      if (name.startsWith("FLYWHEEL_OUTSIDE_JOBS_")) expect(sent.commandLine).toContain(`set "${name}="`)
    }

    expect(child.pid).toBe(4242)
    expect(held.state.resumed).toBe(1)
    held.state.exitCode = 75
    expect(await child.exited).toBe(75)
    expect(held.state.closed).toBe(1)
    child.kill()
    expect(held.state.terminated).toBe(1)
  })

  test("refuses an argument that cmd.exe cannot pass on, before it runs anything", async () => {
    const { wmi, runs } = seams()
    const launch = launchOutsideJobs({ ...request, command: ["flywheel.exe", 'say "hi"'] }, wmi)
    await expect(launch).rejects.toMatchObject({ stage: "argument" })
    expect(runs).toEqual([])
  })

  test("refuses with a typed reason that quotes no output of PowerShell, for every step that did not start the process", async () => {
    const leak = "SECRET=value"
    const cases: readonly { readonly wmi: OutsideJobsSeams; readonly stage: string }[] = [
      { wmi: seams({ systemDirectory: () => undefined }).wmi, stage: "system-directory" },
      { wmi: seams({ exists: () => false }).wmi, stage: "powershell" },
      { wmi: seams({ run: async () => { throw new Error(leak) } }).wmi, stage: "powershell" },
      { wmi: seams({ answer: { exitCode: null, stdout: "", stderr: "" } }).wmi, stage: "powershell" },
      { wmi: seams({ answer: { exitCode: 2, stdout: leak, stderr: leak } }).wmi, stage: "wmi" },
      { wmi: seams({ answer: { exitCode: 3, stdout: leak, stderr: leak } }).wmi, stage: "wmi" },
      { wmi: seams({ answer: { exitCode: 0, stdout: leak, stderr: "" } }).wmi, stage: "wmi" },
      { wmi: seams({ answer: { exitCode: 0, stdout: '{"returnValue":9}', stderr: "" } }).wmi, stage: "wmi" },
      { wmi: seams({ hold: () => undefined }).wmi, stage: "hold" },
    ]
    for (const { wmi, stage } of cases) {
      const error: unknown = await launchOutsideJobs(request, wmi).then(() => undefined, (failure: unknown) => failure)
      expect(error).toBeInstanceOf(OutsideJobsLaunchError)
      expect(error).toMatchObject({ stage })
      expect(String(error)).not.toContain(leak)
    }
  })

  test("signals nothing at a pid that does not hold the process WMI created", async () => {
    const other = heldProcess(CREATED_FILETIME + 10n)
    const { wmi } = seams({ hold: () => other.hold })
    await expect(launchOutsideJobs(request, wmi)).rejects.toMatchObject({ stage: "identity" })
    expect(other.state).toMatchObject({ resumed: 0, terminated: 0, closed: 1 })
  })

  test("ends a created process that could not be resumed through its proven hold", async () => {
    const { wmi, held } = seams()
    held.state.resumes = false
    await expect(launchOutsideJobs(request, wmi)).rejects.toMatchObject({ stage: "resume" })
    expect(held.state).toMatchObject({ resumed: 1, terminated: 1, closed: 1 })
  })

  test("settles an exit that happened just before the launcher gave the process up, and stops watching a process that still runs", async () => {
    const ended = seams({ pollMs: 60_000 })
    const child = await launchOutsideJobs(request, ended.wmi)
    ended.held.state.exitCode = 1
    child.unref()
    expect(await child.exited).toBe(1)
    expect(ended.held.state.closed).toBe(1)

    const running = seams({ pollMs: 1 })
    const kept = await launchOutsideJobs(request, running.wmi)
    kept.unref()
    expect(running.held.state.closed).toBe(1)
    running.held.state.exitCode = 0
    const settled = await Promise.race([kept.exited.then(() => true), Bun.sleep(5).then(() => false)])
    expect(settled).toBe(false)
  })
})
