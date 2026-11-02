import { describe, expect, test } from "bun:test"

import { trustedCommandRun, type TrustedProbeLaunch } from "../../../src/infra/process-container.js"
import { lingerAfter, sourceModule } from "../../helpers/process-linger.js"

const IMPORT_RUNS = `import { trustedCommandRun, trustedProbeRun } from ${JSON.stringify(sourceModule("infra/process-container.ts"))}`

/** A budget far longer than the run it bounds, so a timer left armed after the
 *  run answers shows as a process that stays alive for most of it. */
const LONG_BUDGET_MS = 10_000

/** A launch of this test's own Bun, so the program runs the same on every
 *  platform; `trustedProbeLaunch` would bind a system program instead. */
function bunLaunch(script: string): TrustedProbeLaunch {
  return { argv: [process.execPath, "-e", script], env: { PATH: process.env.PATH ?? "" }, timeoutMs: 5_000, windowsHide: true }
}

describe("trustedProbeRun", () => {
  test("holds its process open no longer than the probe once the probe answers", async () => {
    const { answer, lingerMs } = await lingerAfter(IMPORT_RUNS, `trustedProbeRun(["whoami"], ${LONG_BUDGET_MS})`)

    expect(answer).toMatchObject({ kind: "output" })
    expect(lingerMs).toBeLessThan(2_000)
  }, LONG_BUDGET_MS * 2)
})

describe("trustedCommandRun", () => {
  test("answers a non-zero exit with both of its streams", async () => {
    const result = await trustedCommandRun(bunLaunch(`process.stdout.write("partial"); process.stderr.write("Could not find service"); process.exit(113)`), 10_000)

    expect(result).toEqual({ exitCode: 113, stdout: "partial", stderr: "Could not find service" })
  })

  test("answers a command that outlives its budget with no exit code", async () => {
    const started = Date.now()

    const result = await trustedCommandRun(bunLaunch("await Bun.sleep(30_000)"), 300)

    expect(result).toEqual({ exitCode: null, stdout: "", stderr: "" })
    // The command is killed at its budget rather than awaited.
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("holds its process open no longer than the command once the command answers", async () => {
    const launch = JSON.stringify(bunLaunch("process.exit(0)"))

    const { answer, lingerMs } = await lingerAfter(IMPORT_RUNS, `trustedCommandRun(${launch}, ${LONG_BUDGET_MS})`)

    expect(answer).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(lingerMs).toBeLessThan(2_000)
  }, LONG_BUDGET_MS * 2)
})
