import { afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import type { OwnedProcess, OwnedProcessExit } from "../../../src/infra/owned-subprocess.js"
import { watchContainerTerminations, type TerminationDecision } from "../../../src/infra/process-container.js"
import { createProcessDiagnosticReader } from "../../../src/infra/process-diagnostic-reader.js"
import { createRealProcessFixture, unguardedSpawnOwned, type RealProcessFixture } from "../../helpers/real-process-fixture.js"

const TARGET = fileURLToPath(new URL("../../fixtures/owned-process-target.ts", import.meta.url))

const fixtures: RealProcessFixture[] = []

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

/** Launches a real owned payload and follows the termination decisions for
 *  its container the way the account follows an executor's: the ones this
 *  process records, the supervisor's private diagnostic return, and payload
 *  stderr. Resolves with the exit and the last decision once stderr ends. */
async function launch(name: string, flags: readonly string[], killGraceMs: number): Promise<{
  readonly owned: OwnedProcess
  readonly payloadPid: number
  readonly settled: Promise<{ readonly exit: OwnedProcessExit; readonly termination: TerminationDecision | undefined }>
}> {
  const scratch = createRealProcessFixture(name)
  fixtures.push(scratch)
  const marker = scratch.file("payload-ran")
  let terminations: ReturnType<typeof watchContainerTerminations> | undefined
  const owned = await unguardedSpawnOwned(killGraceMs)([process.execPath, TARGET, marker, ...flags], {
    diagnostics: {
      observe(record, pid) {
        terminations ??= watchContainerTerminations(pid)
        terminations.read(record.payload)
      },
    },
  })
  scratch.guard(owned.pid)
  const decisions = terminations ?? watchContainerTerminations(owned.pid)
  terminations = decisions
  const decoder = new TextDecoder()
  const read = createProcessDiagnosticReader((_line, record) => { if (record) decisions.read(record.payload) })
  const drained = owned.stderr?.pipeTo(new WritableStream({
    write(bytes) { read(decoder.decode(bytes, { stream: true })) },
    close() { read(`${decoder.decode()}\n`) },
  })) ?? Promise.resolve()
  const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))
  const settled = (async () => {
    const exit = await owned.exited
    await drained
    const termination = decisions.last()
    decisions.dispose()
    return { exit, termination }
  })()
  return { owned, payloadPid, settled }
}

describe.skipIf(process.platform === "win32")("termination decisions for an owned container", () => {
  test("a payload killed from outside leaves no decision, because the supervisor's re-raise is the payload's status", async () => {
    const { payloadPid, settled } = await launch("decision-outside-kill", [], 5_000)

    process.kill(payloadPid, "SIGKILL")
    const { exit, termination } = await settled

    expect(exit).toMatchObject({ code: null, signal: "SIGKILL", statusOf: "payload" })
    expect(termination).toBeUndefined()
  }, 30_000)

  test("a payload the supervisor's escalation ended carries the supervisor's own decision", async () => {
    const { owned, settled } = await launch("decision-escalation", [], 5_000)

    await owned.terminate()
    const { exit, termination } = await settled

    expect(exit).toMatchObject({ code: null, signal: "SIGTERM", statusOf: "payload" })
    expect(termination).toMatchObject({ senderPid: owned.pid, container: owned.pid, target: -owned.pid, signal: "SIGTERM", reason: "stop requested" })
  }, 30_000)

  test("a supervisor killed while its payload runs carries the launcher's decision to end the group", async () => {
    const { owned, settled } = await launch("decision-launcher-end", ["--stubborn"], 300)

    process.kill(owned.pid, "SIGKILL")
    const { exit, termination } = await settled

    expect(exit).toMatchObject({ code: null, signal: "SIGKILL", statusOf: "supervisor" })
    expect(termination).toMatchObject({ senderPid: process.pid, container: owned.pid, target: -owned.pid, signal: "SIGKILL", reason: "command supervisor exited with work left" })
  }, 30_000)
})
