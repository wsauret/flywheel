import { describe, expect, test } from "bun:test"

import { launchBreakaway, type BreakawayCreation, type BreakawaySeams } from "../../../src/infra/windows-breakaway-launch.js"
import { OutsideJobsLaunchError, type OutsideJobsLaunchRequest } from "../../../src/infra/windows-outside-jobs.js"
import type { WindowsProcessHold } from "../../../src/infra/windows-process-api.js"

const request: OutsideJobsLaunchRequest = {
  command: ["C:\\Program Files\\Flywheel\\flywheel.exe", "serve", "C:\\a b\\", "", 'say "hi"', "plain\\path"],
  cwd: "C:\\work",
  env: { Path: "C:\\bin", SECRET: "value=with=equals", UNSET: undefined, ALLUSERSPROFILE: "C:\\ProgramData" },
  stdoutPath: "C:\\Temp\\spool\\stdout",
  stderrPath: "C:\\Temp\\spool\\stderr",
}

/** A kernel that creates one suspended process, or refuses with `code`, and
 *  records what the launch did to the process. */
function kernel(options: { readonly refusal?: number; readonly inAnyJob?: boolean; readonly resumes?: boolean } = {}) {
  const calls: string[] = []
  const creations: BreakawayCreation[] = []
  const hold: WindowsProcessHold = {
    createdFileTime: 1n,
    exitCode: () => undefined,
    resume: () => { calls.push("resume"); return options.resumes ?? true },
    terminate: () => { calls.push("hold-terminate"); return true },
    close: () => { calls.push("hold-close") },
  }
  const seams: BreakawaySeams = {
    createSuspended: (creation) => {
      creations.push(creation)
      if (options.refusal !== undefined) return { kind: "failed", code: options.refusal }
      return {
        kind: "created",
        process: {
          pid: 4242,
          inAnyJob: () => options.inAnyJob ?? false,
          terminate: () => { calls.push("terminate") },
          close: () => { calls.push("close") },
        },
      }
    },
    hold: (pid) => { calls.push(`hold:${pid}`); return hold },
    pollMs: 60_000,
  }
  return { seams, calls, creations }
}

describe("breakaway launch", () => {
  test("resumes a created process that is in no job, with the command line, environment, and output files of the request", () => {
    const { seams, calls, creations } = kernel()
    const launch = launchBreakaway(request, seams)

    expect(launch.kind).toBe("started")
    if (launch.kind === "started") {
      expect(launch.child.pid).toBe(4242)
      launch.child.unref()
    }
    expect(calls).toEqual(["hold:4242", "resume", "close", "hold-close"])
    expect(creations).toEqual([{
      // The C runtime reads each argument back as it was given.
      commandLine: '"C:\\Program Files\\Flywheel\\flywheel.exe" serve "C:\\a b\\\\" "" "say \\"hi\\"" plain\\path',
      // Exactly the request's variables, sorted by name without regard to case.
      environment: ["ALLUSERSPROFILE=C:\\ProgramData", "Path=C:\\bin", "SECRET=value=with=equals"],
      cwd: "C:\\work",
      stdoutPath: "C:\\Temp\\spool\\stdout",
      stderrPath: "C:\\Temp\\spool\\stderr",
    }])
  })

  test("leaves the process to WMI when a job refuses the breakaway, with nothing created", () => {
    const { seams, calls } = kernel({ refusal: 5 })
    expect(launchBreakaway(request, seams)).toEqual({ kind: "needs-wmi", reason: "refused" })
    expect(calls).toEqual([])
  })

  test("ends a created process that is still in a job before it runs, and leaves the process to WMI", () => {
    const { seams, calls } = kernel({ inAnyJob: true })
    expect(launchBreakaway(request, seams)).toEqual({ kind: "needs-wmi", reason: "in-job" })
    expect(calls).toEqual(["terminate", "close"])
  })

  test("fails with a typed reason, and no process that ran, when the create fails for another reason or the process cannot be resumed", () => {
    const failure = (seams: BreakawaySeams): OutsideJobsLaunchError | undefined => {
      try {
        launchBreakaway(request, seams)
      } catch (error) {
        if (error instanceof OutsideJobsLaunchError) return error
        throw error
      }
      return undefined
    }
    expect(failure(kernel({ refusal: 2 }).seams)?.stage).toBe("create")

    const unresumed = kernel({ resumes: false })
    expect(failure(unresumed.seams)?.stage).toBe("resume")
    expect(unresumed.calls).toEqual(["hold:4242", "resume", "hold-terminate", "hold-close", "close"])
  })
})
