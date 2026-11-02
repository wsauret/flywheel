import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { LOG_DIR } from "../../../src/infra/paths.js"
import { joinIsolatedAccountService } from "./_account-service.js"
import { createReplacementHarness, sessionStatus, startHeldChat, until } from "./_replacement-harness.js"
import { COMMAND_DEADLINE_SECONDS, EDITED_CONTENT, EDITED_FILE } from "./_replacement-provider.js"

// A command a planned replacement hands to the next build keeps every
// contract a command the build launched has: Stop and its deadline end it,
// its result reaches its session once, and nothing of the previous build's
// end reaches it. Each case runs one chat whose held turn started one
// background command in a project of its own.
const harness = createReplacementHarness("replacement-handover")
const { tmp, userDataRoot, provider, makeProject, setInstalledBuild, activateCurrentLink, requestCutover, serviceListening, stopAccountService, startSuccessor, replace, handoverSessions, entriesCarrying, handoffRows, executorOf, readStore } = harness

afterAll(async () => {
  await harness.dispose()
}, 60_000)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits until the command `id` has recorded its pid. A background launch
 *  returns before the command's first statement runs, and a PowerShell
 *  command needs hundreds of milliseconds to get there. */
async function started(id: string): Promise<void> {
  await until(`${id} started`, async () => provider.commandStarted(id), Boolean)
}

/** Waits until the successor has adopted every command of `projectRoot`. */
async function adopted(projectRoot: string): Promise<void> {
  await until("the handed-over command adopted", async () => handoverSessions(projectRoot), (sessions) => sessions.length === 0)
}

/** The homes of the private copies of `mutates` commands under `projectRoot`, each with whether it holds its record. */
function copyHomes(projectRoot: string): ReadonlyArray<{ readonly home: string; readonly recorded: boolean }> {
  const state = path.join(projectRoot, ".flywheel")
  return [...new Bun.Glob("**/scratch/mutations/*").scanSync({ cwd: state, onlyFiles: false, dot: true })]
    .map((home) => ({ home, recorded: existsSync(path.join(state, home, "copy.json")) }))
}

/** Whether `executor` has recorded, in its project's debug log, that it
 *  handed a command to the next build. It records that once the command's
 *  supervisor took the command and the executor's guardian released it. */
function handedOver(projectRoot: string, executor: number): boolean {
  const logDir = path.join(projectRoot, LOG_DIR)
  if (!existsSync(logDir)) return false
  return [...new Bun.Glob(`*-${executor}-*.jsonl`).scanSync({ cwd: logDir, onlyFiles: true })]
    .some((file) => readFileSync(path.join(logDir, file), "utf8").includes("handed a command to the next build"))
}

describe("a command the successor adopted", () => {
  test("Stop after the adoption ends the command, and one stopped completion reaches its session", async () => {
    const project = makeProject("project-stop")
    const first = await harness.attach(project)
    let chat: string
    try {
      chat = await startHeldChat(first.client, provider, "stopTarget")
      await started("stop-target-1")
      await replace()
    } finally {
      await first.dispose()
    }
    const pid = provider.commandPid("stop-target-1")
    await startSuccessor(tmp)
    await adopted(project)
    await until("the turn continued", async () => provider.trace("stopTarget").continued, (count) => count === 1)
    const viewer = await harness.attach(project)
    try {
      await viewer.client.dispatch({ type: "background.terminate", sessionId: chat, toolUseId: "stop-target-1" })
      await until("the command ended", async () => alive(pid), (running) => !running)
      await until("the stopped completion delivered", async () => entriesCarrying(project, chat, "A person stopped this work with Stop"), (count) => count > 0)
      expect((await sessionStatus(viewer.client, chat))?.activeBackgroundCommands).toEqual([])
    } finally {
      await viewer.dispose()
    }
    await Bun.sleep(500)
    expect(entriesCarrying(project, chat, "A person stopped this work with Stop")).toBe(1)
    expect(entriesCarrying(project, chat, "fixture-command-finished")).toBe(0)
    expect(provider.commandLaunchCount("stop-target-1")).toBe(1)
    await stopAccountService()
  }, 180_000)

  test("a command whose deadline passes after the adoption ends with the deadline message", async () => {
    const project = makeProject("project-deadline")
    const first = await harness.attach(project)
    let chat: string
    let deadline: number
    try {
      chat = await startHeldChat(first.client, provider, "deadline")
      // The command started before its turn's next request, so its deadline is no later than this.
      deadline = Date.now() + COMMAND_DEADLINE_SECONDS * 1_000
      await started("deadline-1")
      await replace()
    } finally {
      await first.dispose()
    }
    const pid = provider.commandPid("deadline-1")
    await startSuccessor(tmp)
    await adopted(project)
    // Adopted before its deadline, so the successor is the one that ends it.
    expect(Date.now()).toBeLessThan(deadline)
    expect(alive(pid)).toBe(true)
    // The delivery can follow only the deadline, so its step starts there.
    await until("the deadline completion delivered", async () => entriesCarrying(project, chat, `reached its ${COMMAND_DEADLINE_SECONDS}s hard deadline and was terminated`), (count) => count > 0, deadline)
    expect(alive(pid)).toBe(false)
    expect(entriesCarrying(project, chat, "fixture-command-finished")).toBe(0)
    await stopAccountService()
  }, 180_000)

  test("a command that exits between the old service's exit and the successor's start publishes its recorded exit once", async () => {
    const project = makeProject("project-early")
    const first = await harness.attach(project)
    let chat: string
    try {
      chat = await startHeldChat(first.client, provider, "exitsEarly")
      await started("exits-early-1")
      await replace()
    } finally {
      await first.dispose()
    }
    const pid = provider.commandPid("exits-early-1")
    expect(handoverSessions(project)).toEqual([chat])
    // No build owns the command now; its own supervisor records its exit.
    provider.releaseCommand("exits-early-1")
    await until("the command exited", async () => alive(pid), (running) => !running)
    await startSuccessor(tmp)
    await adopted(project)
    await until("the recorded exit delivered", async () => provider.trace("exitsEarly").completedCommand, (count) => count > 0)
    await Bun.sleep(500)
    expect(entriesCarrying(project, chat, "fixture-command-finished")).toBe(1)
    expect(entriesCarrying(project, chat, "Background command exited with code 0")).toBe(1)
    // The completion the successor held at the adoption waits for the turn
    // the cut interrupted, which the successor then resumes once.
    expect(provider.trace("exitsEarly").continued).toBe(1)
    await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    await stopAccountService()
  }, 180_000)

  test("a predecessor executor killed after the handover leaves the command running, and the successor adopts it", async () => {
    const project = makeProject("project-killed")
    const first = await harness.attach(project)
    let chat: string
    try {
      chat = await startHeldChat(first.client, provider, "killedExecutor")
      await started("killed-executor-1")
      const executor = await executorOf(project)
      setInstalledBuild(`build-${crypto.randomUUID()}`, "1.0.0")
      const answer = requestCutover()
      // The moment the executor has handed the command over, it dies before
      // its stop ends, and its guardian sweeps what it still guards.
      const deadline = Date.now() + 30_000
      while (!handedOver(project, executor)) {
        if (Date.now() > deadline) throw new Error("the executor never handed the command over")
        await Bun.sleep(1)
      }
      process.kill(executor, "SIGKILL")
      expect(await answer).toBe("retiring")
      await until("service withdrawn", serviceListening, (listening) => !listening)
      expect(await joinIsolatedAccountService(userDataRoot)).toBe(SERVE_EXIT.restart)
    } finally {
      await first.dispose()
    }
    const pid = provider.commandPid("killed-executor-1")
    expect(alive(pid)).toBe(true)
    // The killed executor answered no stop, so its project stays in the handoff.
    expect(handoffRows()).toEqual([expect.objectContaining({ projectRoots: expect.arrayContaining([project]) })])
    await startSuccessor(tmp)
    await adopted(project)
    expect(provider.commandPid("killed-executor-1")).toBe(pid)
    expect(alive(pid)).toBe(true)
    provider.releaseCommand("killed-executor-1")
    await until("the completion delivered", async () => provider.trace("killedExecutor").completedCommand, (count) => count > 0)
    expect(entriesCarrying(project, chat, "fixture-command-finished")).toBe(1)
    expect(provider.commandLaunchCount("killed-executor-1")).toBe(1)
    await stopAccountService()
  }, 180_000)

  test("a mutating command that crosses the replacement lands its change on the successor, once, as an edit of its tool call", async () => {
    const project = makeProject("project-edits")
    writeFileSync(path.join(project, EDITED_FILE), "original\n")
    const first = await harness.attach(project)
    let chat: string
    try {
      chat = await startHeldChat(first.client, provider, "mutates")
      await replace()
    } finally {
      await first.dispose()
    }
    // The launching build handed the command and its copy over and landed nothing.
    expect(readFileSync(path.join(project, EDITED_FILE), "utf8")).toBe("original\n")
    expect(copyHomes(project)).toEqual([expect.objectContaining({ recorded: true })])
    await startSuccessor(tmp)
    await adopted(project)
    expect(readFileSync(path.join(project, EDITED_FILE), "utf8")).toBe("original\n")
    provider.releaseCommand("edits-1")
    await until("the landed completion delivered", async () => entriesCarrying(project, chat, `Updated ${EDITED_FILE}`), (count) => count > 0)
    await until("the copy removed", async () => copyHomes(project).length, (count) => count === 0)
    await Bun.sleep(500)
    expect(readFileSync(path.join(project, EDITED_FILE), "utf8")).toBe(`${EDITED_CONTENT}\n`)
    expect(entriesCarrying(project, chat, `Updated ${EDITED_FILE}`)).toBe(1)
    expect(entriesCarrying(project, chat, "fixture-command-finished")).toBe(1)
    const changes = readStore(project, (reader) => reader.read({ sessionId: chat, types: ["file.changed"] }).map((fact) => fact.payload))
    expect(changes).toEqual([expect.objectContaining({ displayPath: EDITED_FILE, origin: expect.objectContaining({ toolUseId: "edits-1" }) })])
    const recorded = readStore(project, (reader) => reader.read({ sessionId: chat, types: ["tool.execution_output.recorded"] }).map((fact) => fact.payload))
    expect(recorded).toEqual([expect.objectContaining({ toolUseId: "edits-1", mutationEvidence: expect.objectContaining({ applied: 1, samples: [{ kind: "applied", path: EDITED_FILE }] }) })])
    expect(provider.commandLaunchCount("edits-1")).toBe(1)
    await stopAccountService()
  }, 180_000)
})

describe("the account's current build", () => {
  test("replacing the current link with no cutover request retires the service long before the build tick", async () => {
    const project = makeProject("project-current")
    const first = await harness.attach(project)
    try {
      await first.client.query({ type: "updateSnapshot" })
      const buildId = `build-${crypto.randomUUID()}`
      setInstalledBuild(buildId, "1.0.0")
      const began = Date.now()
      activateCurrentLink(buildId)
      await until("service withdrawn", serviceListening, (listening) => !listening)
      // The build tick comes once a minute; the link's change alone started this.
      expect(Date.now() - began).toBeLessThan(15_000)
    } finally {
      await first.dispose()
    }
    expect(await joinIsolatedAccountService(userDataRoot)).toBe(SERVE_EXIT.restart)
  }, 120_000)
})
