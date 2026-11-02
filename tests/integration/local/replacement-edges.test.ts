import { afterAll, describe, expect, test } from "bun:test"

import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { declinedByPausedProject } from "../../../src/protocol/client/connection-failures.js"
import { joinIsolatedAccountService } from "./_account-service.js"
import { createReplacementHarness, launchWorkflow, openChat, sessionRow, startHeldChat, systemRows, until } from "./_replacement-harness.js"
import { TASKS, type TaskKey } from "./_replacement-provider.js"

// The edges of a planned replacement's cut. The owner begins the stop once
// every executor has answered its cut, so a test holds the cut open by
// locking one project's store before the replacement: that project's cut
// cannot write its continuation row, and the test acts while it waits.
const harness = createReplacementHarness("replacement-edges")
const { tmp, userDataRoot, provider, makeProject, setInstalledBuild, requestCutover, serviceListening, stopAccountService, startSuccessor, continuationRows, conversationEntryIds, handoffRows, executorOf, lockStore, handoverSessions, entriesCarrying } = harness

afterAll(async () => {
  await harness.dispose()
}, 60_000)

/** Waits until the cut has interrupted `sessionId` and made the runtime's record durable. */
async function interruptRecorded(projectRoot: string, sessionId: string): Promise<void> {
  await until("the runtime's interrupt recorded", async () => conversationEntryIds(projectRoot, sessionId).some((id) => id.startsWith("itb-paused-runtime-")), Boolean)
}

/** The replacement finishes: the cutover answer arrives, the service
 *  withdraws, and it exits with the code that restarts it. */
async function retired(answer: Promise<"busy" | "retiring">): Promise<void> {
  expect(await answer).toBe("retiring")
  await until("service withdrawn", serviceListening, (listening) => !listening)
  expect(await joinIsolatedAccountService(userDataRoot)).toBe(SERVE_EXIT.restart)
}

async function continuedOnce(keys: readonly TaskKey[]): Promise<void> {
  await until("interrupted sessions continued", async () => keys.map((key) => provider.trace(key).continued), (counts) => counts.every((count) => count === 1))
  for (const key of keys) expect(provider.trace(key).crashRecorded).toBe(0)
}

describe("the edges of a planned replacement's cut", () => {
  test("work admitted while the cut settles, a message on a second surface, a workflow step that starts, and a project that opens, is resumed by the successor", async () => {
    const projectA = makeProject("project-a")
    const projectB = makeProject("project-b")
    const projectC = makeProject("project-c")
    const firstA = await harness.attach(projectA)
    const firstB = await harness.attach(projectB)
    let cutFirst: string
    let lateChat: string
    let lateWorkflow: string
    let lateOpen: string
    try {
      cutFirst = await startHeldChat(firstA.client, provider, "cutFirst")
      await startHeldChat(firstB.client, provider, "holding")
      setInstalledBuild("build-new", "1.0.0")
      const release = lockStore(projectB)
      const answer = requestCutover()
      try {
        // Project A's cut is done while project B's holds the handoff open.
        await interruptRecorded(projectA, cutFirst)
        // Surfaces attached now, as a replacement never blocks input: a
        // second surface of project A, and one that opens project C, which
        // the handoff did not name.
        const second = await harness.attachWhileDraining(projectA)
        const opener = await harness.attachWhileDraining(projectC)
        try {
          lateChat = await startHeldChat(second.client, provider, "lateChat")
          lateWorkflow = await launchWorkflow(second.client, "lateWorkflow")
          await provider.entered("lateWorkflow")
          lateOpen = await startHeldChat(opener.client, provider, "lateOpen")
          expect(await serviceListening()).toBe(true)
        } finally {
          await Promise.allSettled([second.dispose(), opener.dispose()])
        }
      } finally {
        release()
      }
      await retired(answer)
    } finally {
      await Promise.allSettled([firstA.dispose(), firstB.dispose()])
    }

    // The stop ran the cut's own steps for the work admitted after the cut:
    // each holds a row of the one handoff, and the project that opened
    // joined the handoff row.
    const [handoff, ...others] = handoffRows()
    expect(others).toEqual([])
    const handoffId = handoff?.handoffId
    expect(continuationRows(projectA, [lateChat, lateWorkflow])).toEqual(new Map([
      [lateChat, [expect.objectContaining({ version: 3, target: { kind: "chat", sessionId: lateChat }, handoffId })]],
      [lateWorkflow, [expect.objectContaining({ version: 3, target: { kind: "workflow", workflowId: lateWorkflow }, handoffId })]],
    ]))
    expect(continuationRows(projectC, [lateOpen]).get(lateOpen)).toEqual([expect.objectContaining({ version: 3, target: { kind: "chat", sessionId: lateOpen }, handoffId })])
    expect(handoff?.projectRoots).toEqual(expect.arrayContaining([projectA, projectB, projectC]))

    await startSuccessor(tmp)
    await continuedOnce(["cutFirst", "holding", "lateChat", "lateOpen", "lateWorkflow"])
    await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    // The step continues in its own conversation, the held request and then
    // the continued one, and never starts again.
    expect(provider.trace("lateWorkflow").requests).toBe(2)
    await stopAccountService()
  }, 240_000)

  test("a background command that work admitted while the cut settles started survives the old service, and the successor adopts it and delivers its completion once", async () => {
    const projectG = makeProject("project-g")
    const projectH = makeProject("project-h")
    const firstG = await harness.attach(projectG)
    const firstH = await harness.attach(projectH)
    let server: string
    try {
      const cutFirst = await startHeldChat(firstG.client, provider, "serverCutFirst")
      await startHeldChat(firstH.client, provider, "serverHolding")
      setInstalledBuild(`build-${crypto.randomUUID()}`, "1.0.0")
      const release = lockStore(projectH)
      const answer = requestCutover()
      try {
        await interruptRecorded(projectG, cutFirst)
        // Work admitted while project H holds the handoff open starts a
        // background command, which the stop hands over.
        const second = await harness.attachWhileDraining(projectG)
        try {
          server = await openChat(second.client, "admittedServer")
          await until("the admitted command started", async () => provider.commandStarted("admitted-server-1"), Boolean)
          await provider.entered("admittedServer")
        } finally {
          await second.dispose()
        }
      } finally {
        release()
      }
      await retired(answer)
    } finally {
      await Promise.allSettled([firstG.dispose(), firstH.dispose()])
    }

    const pid = provider.commandPid("admitted-server-1")
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(handoverSessions(projectG)).toEqual([server])
    provider.continueOnSuccessor("admittedServer")
    await startSuccessor(tmp)
    await continuedOnce(["serverCutFirst", "serverHolding", "admittedServer"])
    await until("the handed-over command adopted", async () => handoverSessions(projectG), (sessions) => sessions.length === 0)
    expect(provider.commandPid("admitted-server-1")).toBe(pid)
    expect(() => process.kill(pid, 0)).not.toThrow()

    provider.releaseCommand("admitted-server-1")
    await until("the completion delivered", async () => provider.trace("admittedServer").successorCompletedCommand, (count) => count > 0)
    expect(entriesCarrying(projectG, server, "fixture-command-finished")).toBe(1)
    expect(provider.commandLaunchCount("admitted-server-1")).toBe(1)
    expect(provider.trace("admittedServer").commandLaunches).toBe(1)
    await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    expect(handoverSessions(projectG)).toEqual([])
    await stopAccountService()
  }, 240_000)

  test("a cut that has not settled at the cut limit does not hold the stop, and the successor resumes the turn", async () => {
    const project = makeProject("project-d")
    const first = await harness.attach(project)
    let chat: string
    try {
      // The client starts its service at its first call, with a short cut limit.
      process.env.FLYWHEEL_TEST_REPLACEMENT_CUT_LIMIT_MS = "1500"
      try {
        chat = await startHeldChat(first.client, provider, "cutLimit")
      } finally {
        delete process.env.FLYWHEEL_TEST_REPLACEMENT_CUT_LIMIT_MS
      }
      setInstalledBuild(`build-${crypto.randomUUID()}`, "1.0.0")
      const release = lockStore(project)
      const answer = requestCutover()
      const began = Date.now()
      try {
        // The cut cannot write its row, and the service stops anyway, well
        // before the store's own lock retries would give the cut up.
        await until("service withdrawn", serviceListening, (listening) => !listening)
        expect(Date.now() - began).toBeLessThan(10_000)
      } finally {
        release()
      }
      await retired(answer)
    } finally {
      await first.dispose()
    }

    // The stop ended the turn as the planned cut, since the successor
    // continues it: the one turn end is the planned record no surface shows.
    expect(conversationEntryIds(project, chat).filter((id) => id.startsWith("itb-"))).toEqual([expect.stringMatching(/^itb-paused-runtime-planned-/)])

    await startSuccessor(tmp)
    await continuedOnce(["cutLimit"])
    await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    // The replacement is invisible: the transcript a client reads names no
    // interruption and no Resume.
    const viewer = await harness.attach(project)
    try {
      expect((await systemRows(viewer.client, chat)).filter((row) => row.startsWith("Interrupted") || row === "Resumed")).toEqual([])
    } finally {
      await viewer.dispose()
    }
    await stopAccountService()
  }, 180_000)

  test("an executor that dies after the cut and before its stop leaves its project in the row, and the successor resumes what the cut interrupted", async () => {
    const projectE = makeProject("project-e")
    const projectF = makeProject("project-f")
    const firstE = await harness.attach(projectE)
    const firstF = await harness.attach(projectF)
    try {
      const chat = await startHeldChat(firstE.client, provider, "cutKilled")
      await startHeldChat(firstF.client, provider, "killHolding")
      const executorE = await executorOf(projectE)
      setInstalledBuild(`build-${crypto.randomUUID()}`, "1.0.0")
      const release = lockStore(projectF)
      const answer = requestCutover()
      try {
        await interruptRecorded(projectE, chat)
        process.kill(executorE, "SIGKILL")
      } finally {
        release()
      }
      await retired(answer)
    } finally {
      await Promise.allSettled([firstE.dispose(), firstF.dispose()])
    }

    // No stop answered for project E, so it stays named.
    expect(handoffRows()).toEqual([expect.objectContaining({ projectRoots: expect.arrayContaining([projectE]) })])
    await startSuccessor(tmp)
    await continuedOnce(["cutKilled", "killHolding"])
    await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    await stopAccountService()
  }, 180_000)

  test("after an executor ends while a replacement waits, a tab's reattach starts nothing, and a person's message restarts it, is cut at the drain, and is resumed by the successor", async () => {
    const projectI = makeProject("project-i")
    const projectJ = makeProject("project-j")
    const firstI = await harness.attach(projectI)
    const firstJ = await harness.attach(projectJ)
    let chat: string
    try {
      const opened = await firstI.client.dispatch({ type: "chat.open" })
      if (!opened.ok || !opened.sessionId) throw new Error("chat did not open")
      chat = opened.sessionId
      // A call admitted in project J keeps the replacement requested: its
      // write waits on J's store, which the test holds. A running shell
      // command no longer delays a replacement, which hands it over. The
      // first chat creates J's store.
      expect(await firstJ.client.dispatch({ type: "chat.open" })).toMatchObject({ ok: true })
      const release = lockStore(projectJ)
      let call: Promise<unknown>
      try {
        call = firstJ.client.dispatch({ type: "chat.open" })
        setInstalledBuild(`build-${crypto.randomUUID()}`, "1.0.0")
        expect(await requestCutover()).toBe("busy")
        process.kill(await executorOf(projectI), "SIGKILL")
        await until("project I recovered", () => sessionRow(firstI.client, chat), (row) => row.lifecycleState === "inactive")
        // The tab reattaches its chat. The successor opens the project, so the
        // retiring service starts nothing for it, past the restart backoff.
        const reattach = firstI.client.dispatch({ type: "session.activate", sessionId: chat })
        // A read the project's history cannot serve is answered at once, as in
        // any paused project, and never waits on the reattach.
        expect(declinedByPausedProject(await firstI.client.query({ type: "commandUsageSnapshot" }).then(() => undefined, (error: unknown) => error))).toBe(true)
        await Bun.sleep(2_000)
        await expect(executorOf(projectI)).rejects.toThrow("no executor serves")
        // Nothing refuses the person's message: it restarts the executor here,
        // and the tab's reattach joins that generation.
        expect(await firstI.client.dispatch({ type: "session.send", sessionId: chat, input: TASKS.restarted })).toMatchObject({ ok: true })
        await provider.entered("restarted")
        expect(await reattach).toMatchObject({ ok: true })
      } finally {
        release()
      }
      // The call returns, nothing delays the replacement, and the drain cuts the message's turn.
      expect(await call).toMatchObject({ ok: true })
      await until("service withdrawn", serviceListening, (listening) => !listening)
      expect(await joinIsolatedAccountService(userDataRoot)).toBe(SERVE_EXIT.restart)
    } finally {
      await Promise.allSettled([firstI.dispose(), firstJ.dispose()])
    }

    expect(continuationRows(projectI, [chat]).get(chat)).toEqual([expect.objectContaining({ version: 3, target: { kind: "chat", sessionId: chat } })])
    await startSuccessor(tmp)
    await continuedOnce(["restarted"])
    await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    await stopAccountService()
  }, 180_000)
})
