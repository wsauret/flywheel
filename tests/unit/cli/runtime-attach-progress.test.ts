import { expect, test } from "bun:test"
import { join } from "node:path"
import { createAccountRuntimeAttach } from "../../../src/cli/runtime-attach.js"
import type { RuntimeStartupStatus } from "../../../src/protocol/app-service-types.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

test("shares startup phases with callers joining an early launch without replaying a completed attempt", async () => {
  const root = temporaryDirectory("flywheel-attach-shared-progress-")
  const launched = Promise.withResolvers<(status: RuntimeStartupStatus) => void>()
  const listening = Promise.withResolvers<void>()
  const phases: RuntimeStartupStatus[] = []
  const anotherCallerPhases: RuntimeStartupStatus[] = []
  let serving = false
  let launches = 0
  const attach = createAccountRuntimeAttach({
    projectRoot: root,
    executionCwd: root,
    accountHome: root,
    userDataRoot: join(root, ".flywheel"),
    allowPersistentProcesses: true,
  }, {
    isRuntimeListening: async () => serving,
    readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "1.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "current" }),
    installedBuildId: () => "current",
    startInstalledService: async () => false,
    launchRuntime: async (_options, report) => {
      launches += 1
      report({ kind: "phase", label: "Starting account service" })
      launched.resolve(report)
      await listening.promise
      serving = true
    },
  })
  try {
    const early = attach.ensure(() => {})
    const report = await launched.promise
    const joined = attach.ensure((status) => phases.push(status))
    const anotherCaller = attach.ensure((status) => anotherCallerPhases.push(status))
    expect(joined).toBe(early)
    expect(anotherCaller).toBe(early)
    expect(phases).toEqual([{ kind: "phase", label: "Starting account service" }])
    expect(anotherCallerPhases).toEqual(phases)

    report({ kind: "phase", label: "Opening project" })
    expect(phases).toEqual([
      { kind: "phase", label: "Starting account service" },
      { kind: "phase", label: "Opening project" },
    ])
    expect(anotherCallerPhases).toEqual(phases)
    expect(launches).toBe(1)

    listening.resolve()
    await Promise.all([early, joined, anotherCaller])
    const nextAttemptPhases: RuntimeStartupStatus[] = []
    await attach.ensure((status) => nextAttemptPhases.push(status))
    expect(nextAttemptPhases).toEqual([])
    expect(launches).toBe(1)
    expect(phases).toHaveLength(2)
    expect(anotherCallerPhases).toHaveLength(2)
  } finally {
    listening.resolve()
    attach.close()
  }
})
