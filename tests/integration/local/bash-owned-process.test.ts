import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { createCliLauncher } from "../../../src/cli/runtime-launch.js"
import type { DebugLogRecordInput } from "../../../src/infra/debug-log.js"
import { Log } from "../../../src/infra/log.js"
import type { LauncherScope } from "../../../src/infra/process-supervisor.js"
import { createBackgroundWorkRegistry } from "../../../src/orchestration/agent-runtime/background-work.js"
import { createBashDefinition } from "../../../src/orchestration/agent-runtime/tools/bash.js"

const bashDefinition = createBashDefinition()
import { loadBashParser } from "../../../src/orchestration/agent-runtime/tools/bash-parser.js"
import type { ToolContext } from "../../../src/orchestration/agent-runtime/tools/types.js"
import { createRealProcessFixture, processAlive, type RealProcessFixture } from "../../helpers/real-process-fixture.js"
import { capabilityAccessHolding } from "../../unit/orchestration/agent-runtime/tools/_fixtures.js"

/** Bash ownership against the real guardian: every command bash starts is a
 *  container the guardian owns before the payload runs, and the only things
 *  that end one are the command itself, the session owner, and the generation
 *  that launched it. */

beforeAll(loadBashParser)
const OWNED_PROCESS_TARGET = fileURLToPath(new URL("../../fixtures/owned-process-target.ts", import.meta.url))
const targetCommand = (pidFile: string): string => `${process.execPath} ${JSON.stringify(OWNED_PROCESS_TARGET)} ${JSON.stringify(pidFile)}`
const fixtures: RealProcessFixture[] = []

function fixture(name: string): RealProcessFixture {
  const created = createRealProcessFixture(name)
  fixtures.push(created)
  return created
}

// Every command bash starts inherits this process's temporary directory, so
// whatever a command or its shell wrapper leaves there outside the scratch
// directory shows up here, including after a command was ended.
let temporaryBefore: ReadonlySet<string> = new Set()
beforeEach(() => {
  temporaryBefore = new Set(fs.readdirSync(os.tmpdir()))
})

afterEach(() => {
  const scratchDirs = new Set(fixtures.map((created) => path.basename(created.dir)))
  const leftBehind = fs.readdirSync(os.tmpdir()).filter((entry) => !temporaryBefore.has(entry) && !scratchDirs.has(entry))
  for (const created of fixtures.splice(0)) created.cleanup()
  expect(leftBehind).toEqual([])
})

function toolContext(scratch: RealProcessFixture, generation: LauncherScope, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    executionCwd: scratch.dir,
    userDataRoot: `${scratch.dir}/.test-account`, projectRoot: scratch.dir,
    scratchDir: scratch.dir,
    spawnOwned: generation.spawnOwned,
    artifactScopeId: "bash-ownership",
    retrievalSessionId: "bash-ownership",
    sessionId: "bash-ownership",
    capabilityAccess: capabilityAccessHolding(["background-commands"]),
    ...overrides,
  }
}

/** The container's own pid, written by the shell bash launched. */
async function containerPid(scratch: RealProcessFixture, file: string): Promise<number> {
  const contents = await scratch.waitForFile(file, 10_000)
  return scratch.guard(Number(contents.trim()))
}

describe("bash process ownership", () => {
  test("a foreground command is a container the turn's abort ends", async () => {
    const scratch = fixture("bash-foreground")
    const launcher = await createCliLauncher()
    const generation = launcher.scope.open()
    const pidFile = scratch.file("foreground.pid")
    const turn = new AbortController()

    try {
      const result = bashDefinition.execute(
        { command: targetCommand(pidFile) },
        toolContext(scratch, generation, { signal: turn.signal }),
      )
      const pid = await containerPid(scratch, pidFile)
      expect(processAlive(pid)).toBe(true)

      turn.abort()
      expect((await result).outcome).toBe("interrupted")
      await scratch.waitForGone(pid, 15_000)
    } finally {
      await launcher.dispose()
    }
  }, 60_000)

  test("a command its deadline ends reports no supervisor record, and its supervisor's termination decision reaches the log once", async () => {
    const scratch = fixture("bash-deadline")
    const records: DebugLogRecordInput[] = []
    await Log.init({ forward: (record) => { records.push(record) } })
    const launcher = await createCliLauncher()
    const generation = launcher.scope.open()

    try {
      const result = await bashDefinition.execute({ command: "sleep 30", timeout: 1 }, toolContext(scratch, generation))

      expect(result.content).toContain("[Command timed out after 1s; killed]")
      expect(result.content).not.toContain("termination requested")
      expect(result.content).not.toContain("{\"")
      const relayed = records.filter((record) => fieldOf(record, "message") === "termination requested")
      expect(relayed).toEqual([{ type: "log.info", payload: expect.objectContaining({ service: "process-termination", supervisorPid: expect.any(Number) }) }])
      // The supervisor that wrote the decision leads the container it ended.
      expect(fieldOf(relayed[0], "container")).toBe(fieldOf(relayed[0], "supervisorPid"))
    } finally {
      await launcher.dispose()
      await Log.closeGlobal()
    }
  }, 60_000)

  test("a backgrounded command outlives its turn and ends with the generation that launched it", async () => {
    const scratch = fixture("bash-background")
    const launcher = await createCliLauncher()
    const generation = launcher.scope.open()
    const pidFile = scratch.file("background.pid")
    const turn = new AbortController()
    const notifications: string[] = []
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) })

    try {
      const started = await bashDefinition.execute(
        { command: targetCommand(pidFile), background: true },
        toolContext(scratch, generation, { signal: turn.signal, backgroundTasks: registry, toolUseId: "toolu_bg" }),
      )
      expect(started.outcome).toBe("ok")
      const pid = await containerPid(scratch, pidFile)

      // The turn that started it is over; the command is the session's now.
      turn.abort()
      await Bun.sleep(200)
      expect(processAlive(pid)).toBe(true)
      expect(registry.activeTaskCount()).toBe(1)

      await generation.close()
      await scratch.waitForGone(pid, 15_000)
      expect(processAlive(pid)).toBe(false)
    } finally {
      await launcher.dispose()
    }
  }, 60_000)

  test("terminating the session's background task ends the container and notifies after it settled", async () => {
    const scratch = fixture("bash-background-terminate")
    const launcher = await createCliLauncher()
    const generation = launcher.scope.open()
    const pidFile = scratch.file("terminate.pid")
    const notifications: string[] = []
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) })

    try {
      await bashDefinition.execute(
        { command: targetCommand(pidFile), background: true },
        toolContext(scratch, generation, { backgroundTasks: registry, toolUseId: "toolu_bg" }),
      )
      const pid = await containerPid(scratch, pidFile)

      expect(registry.terminate("toolu_bg")).toBe(true)
      await scratch.waitForGone(pid, 15_000)

      // The notification is derived from a settled container: ownership was
      // surrendered before the model could ever be told the command finished.
      await waitFor(() => notifications.length === 1, "the completion notification")
      expect(notifications[0]).toContain("<background_command_notification>")
      expect(registry.activeTaskCount()).toBe(0)
    } finally {
      await launcher.dispose()
    }
  }, 60_000)
})

/** The string or number `field` of a captured log record's payload. */
function fieldOf(record: DebugLogRecordInput | undefined, field: string): string | number | undefined {
  const payload = record?.payload
  const value = typeof payload === "object" && payload !== null ? Object.entries(payload).find(([key]) => key === field)?.[1] : undefined
  return typeof value === "string" || typeof value === "number" ? value : undefined
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}
