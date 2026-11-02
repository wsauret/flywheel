import { afterAll, afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { ContainedDirectory } from "../../../src/infra/descriptor-directory.js"
import { FLYWHEEL_DIR_NAME } from "../../../src/infra/directory-authorities.js"
import { registerSharedHolderIn, releaseSharedHolderIn, sharedHoldersIn } from "../../../src/infra/ownership-file-lock.js"
import { accountServeRecordPath, LOG_DIR } from "../../../src/infra/paths.js"
import type { RuntimeClient } from "../../../src/protocol/app-service-types.js"
import { attachAccountProject, joinIsolatedAccountService } from "./_account-service.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import { loadSubagentRunsFromEvents, SUBAGENT_RUN_FACT_TYPES } from "../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { TASKS, toolResult } from "./_replacement-provider.js"
import { answerChoice, childOf, createReplacementHarness, LANE, launchWorkflow, openChat, parentCard, sessionRow, sessionStatus, startHeldChat, systemRows, until, workflowMember, workflowParent, workflowState } from "./_replacement-harness.js"

const harness = createReplacementHarness("replacement-continuation")
const { tmp: TMP, accountHome, userDataRoot, provider, makeProject, setInstalledBuild, requestCutover, serviceListening, stopAccountService, killAccountServiceUncleanly, startSuccessor, replace, continuationRows, allContinuationSessions, handoverSessions, entriesCarrying, conversationEntryIds, handoffRows, lockStore, useChatModel } = harness
const SERVING_GATE = `project-serving.${LANE}.lock`

/** Whether the child's latest run completed after exactly one resume, read
 *  from the project store. */
function childRunCompletedAfterOneResume(projectRoot: string, childSessionId: string): boolean {
  return harness.readStore(projectRoot, (reader) => {
    const run = loadSubagentRunsFromEvents(reader.read({ aggregateId: `session:${childSessionId}`, types: SUBAGENT_RUN_FACT_TYPES })).at(-1)
    return run?.status === "completed" && run.continuationCount === 1
  })
}

/** Whether `pid` still names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** One INFO record, as a process's log file holds it. */
interface InfoRecord {
  readonly ts: number
  readonly sessionId: string | undefined
  readonly fields: object
}

/** The INFO records with `message` in the log directory under `root`, which
 *  the account service writes under the account home and each executor
 *  under its project, oldest first. */
function infoRecords(root: string, message: string): readonly InfoRecord[] {
  const directory = path.join(root, LOG_DIR)
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl")).flatMap((name) =>
    fs.readFileSync(path.join(directory, name), "utf8").split("\n").flatMap((line): InfoRecord[] => {
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        // An empty line, or a last line its writer has not finished yet.
        return []
      }
      if (typeof record !== "object" || record === null || !("type" in record) || record.type !== "log.info" || !("ts" in record) || typeof record.ts !== "number" || !("payload" in record)) return []
      const payload = record.payload
      if (typeof payload !== "object" || payload === null || !("message" in payload) || payload.message !== message) return []
      return [{ ts: record.ts, sessionId: "sessionId" in record && typeof record.sessionId === "string" ? record.sessionId : undefined, fields: payload }]
    })).toSorted((a, b) => a.ts - b.ts)
}

/** The sessions the first case builds across its two projects. */
interface ReplacementSessions {
  readonly chat: string
  readonly parent: string
  readonly child: string
  readonly ask: string
  readonly workflow: string
  readonly stepParent: string
  readonly stepMember: string
  readonly stepChild: string
  readonly followUp: string
  readonly shell: string
  readonly person: string
}

// Every case ends the service it started, whether it passed or failed, so a
// failure in one case never leaves a running service for the next one.
afterEach(async () => {
  await stopAccountService()
  useChatModel()
  delete process.env.FLYWHEEL_PROJECT_IDLE_TIMEOUT_SECONDS
}, 60_000)

afterAll(async () => {
  await harness.dispose()
}, 60_000)

describe("planned interruption and automatic continuation", () => {
  test("a replacement waits for no shell command, interrupts everything else with its handoff, hands the running command over, and the successor resumes exactly that work with no client attached", async () => {
    const projectA = makeProject("project-a")
    const projectB = makeProject("project-b")
    prepareWorkspaceState({ accountHome, userDataRoot, projectRoot: projectA }).generation.release()
    // Debug's investigation declares no subagents; this scenario needs a
    // delegated child that stays active across the replacement.
    const workflows = path.join(projectA, ".flywheel", "workflows")
    fs.mkdirSync(workflows, { recursive: true })
    fs.writeFileSync(path.join(workflows, "replacement-delegate.yaml"), [
      "id: replacement-delegate",
      "name: Replacement delegate",
      "phases:",
      "  - phase: work",
      "    name: Work",
      "    brief: Delegate the investigation to an explorer and wait for its result.",
      "    subagents: [explorer]",
      "    output: { summary: The investigation result. }",
      "    writes: []",
      "",
    ].join("\n"))
    const base = { accountHome, userDataRoot }
    const firstA = await attachAccountProject({ ...base, executionCwd: projectA, projectRoot: projectA })
    const firstB = await attachAccountProject({ ...base, executionCwd: projectB, projectRoot: projectB })
    const a = firstA.client
    const b = firstB.client
    let sessions: ReplacementSessions
    let shellPid: number
    try {
      const chat = await startHeldChat(a, provider, "chat")
      const parent = await openChat(a, "parent")
      const child = await childOf(a, parent)
      await provider.entered("child")
      const workflow = await launchWorkflow(a, "workflow")
      await provider.entered("workflow")
      const stepParent = await launchWorkflow(a, "stepParent", "replacement-delegate")
      const stepMember = await workflowMember(a, stepParent)
      const stepChild = await childOf(a, stepMember)
      await provider.entered("stepChild")
      await until("step waits on its child", () => sessionStatus(a, stepMember), (status) => status?.waitingOnBackgroundWork === true)
      // A completed workflow takes no more chat, so the follow-up turn runs
      // in the chat the workflow belongs to.
      const followStep = await launchWorkflow(a, "followStep")
      await until("follow-up workflow completed", () => workflowState(a, followStep), (state) => state === "completed")
      const followUp = await workflowParent(a, followStep)
      expect(await a.dispatch({ type: "session.send", sessionId: followUp, input: TASKS.followUp })).toMatchObject({ ok: true })
      await provider.entered("followUp")
      const ask = await openChat(a, "ask")
      await until("question pending", async () => (await a.query({ type: "questionSnapshot", sessionIds: [ask] })).views[0]?.view ?? null, (view) => view !== null)

      const shell = await openChat(b, "shell")
      await until("shell command running", () => sessionStatus(b, shell), (status) => (status?.activeForegroundBashToolCallIds.length ?? 0) > 0)
      await until("shell command started", async () => provider.commandStarted("shell-1"), Boolean)
      shellPid = provider.commandPid("shell-1")
      const person = await startHeldChat(b, provider, "person")
      expect(await b.dispatch({ type: "chat.interrupt", sessionId: person })).toMatchObject({ ok: true })
      await until("person interrupt recorded", () => sessionRow(b, person), (row) => row.admittedActions.includes("chat.resume"))
      sessions = { chat, parent, child, ask, workflow, stepParent, stepMember, stepChild, followUp, shell, person }

      // A newer build is installed, and the foreground command still runs.
      // Nothing delays the replacement: the cutover answers at once, and the
      // service moves the command to the background, interrupts its work,
      // hands off, and exits by itself with the code that tells its service
      // manager to restart it.
      setInstalledBuild("build-new", "1.0.0")
      expect(await requestCutover()).toBe("retiring")
      await until("service withdrawn", serviceListening, (listening) => !listening)
      expect(await joinIsolatedAccountService(userDataRoot)).toBe(SERVE_EXIT.restart)
    } finally {
      await Promise.allSettled([firstA.dispose(), firstB.dispose()])
    }

    // Each interrupted session holds one continuation row with the handoff
    // id, the person's interrupt and the open question hold none, and the
    // account's handoff row names both projects.
    const [handoff, ...otherHandoffs] = handoffRows()
    expect(otherHandoffs).toEqual([])
    if (!handoff) throw new Error("no handoff row")
    expect(Array.isArray(handoff.projectRoots) ? [...handoff.projectRoots].sort() : handoff.projectRoots).toEqual([projectA, projectB].sort())
    const rowsA = continuationRows(projectA, [sessions.chat, sessions.child, sessions.ask, sessions.workflow, sessions.stepParent, sessions.stepChild, sessions.followUp, sessions.parent])
    for (const [sessionId, kind] of [
      [sessions.chat, "chat"], [sessions.child, "subagent"], [sessions.workflow, "workflow"],
      [sessions.stepParent, "workflow"], [sessions.stepChild, "subagent"], [sessions.followUp, "chat"],
    ] as const) {
      expect(rowsA.get(sessionId)).toEqual([expect.objectContaining({ version: 3, target: kind === "workflow" ? { kind, workflowId: sessionId } : { kind, sessionId }, handoffId: handoff.handoffId })])
    }
    // A turn that waits on a question is the person's, not running work, so
    // the cut leaves its question open (PI-REMOTE-012).
    expect(rowsA.get(sessions.ask)).toEqual([])
    // The parent waiting on its child is cut in silence and continues on the
    // successor, where it waits for the child's result again.
    expect(rowsA.get(sessions.parent)).toEqual([expect.objectContaining({ version: 3, target: { sessionId: sessions.parent, kind: "chat" }, handoffId: handoff.handoffId })])
    const rowsB = continuationRows(projectB, [sessions.shell, sessions.person])
    expect(rowsB.get(sessions.shell)).toEqual([expect.objectContaining({ version: 3, target: { sessionId: sessions.shell, kind: "chat" }, handoffId: handoff.handoffId })])
    expect(rowsB.get(sessions.person)).toEqual([])
    // The command outlived the old service on its own supervisor, and one
    // handover row carries it to the successor.
    expect(() => process.kill(shellPid, 0)).not.toThrow()
    expect(handoverSessions(projectB)).toEqual([sessions.shell])
    for (const key of ["chat", "child", "ask", "workflow", "stepParent", "stepChild", "shell", "person"] as const) expect(provider.trace(key).continued).toBe(0)
    expect(provider.trace("followUp").requests).toBe(1)

    // The service manager starts the successor with no client attached. It
    // opens both projects and resumes the three interrupted turns that ran
    // exactly once; the record each resumed turn continues from says the
    // runtime interrupted it. The step cut while it waited on its child
    // parks on that wait again, with no continuation message and no request
    // (ARCH-SESSIONS-038), and its child's result is what wakes it.
    provider.probeAtNextRequest("stepParent", () => childRunCompletedAfterOneResume(projectA, sessions.stepChild))
    await startSuccessor(TMP)
    await until("interrupted sessions continued", async () => (["chat", "workflow", "shell"] as const).map((key) => provider.trace(key).continued), (counts) => counts.every((count) => count === 1))
    await until("children continued", async () => [provider.trace("child").requests, provider.trace("stepChild").requests], (counts) => counts.every((count) => count >= 2))
    await until("follow-up continued", async () => provider.trace("followUp").requests, (count) => count === 2)
    await until("step woke on its child's result", async () => provider.trace("stepParent").requests, (count) => count >= 3)
    await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    // The child under the step resumed once and finished before its step
    // sent its next request; the step went on in its own conversation from
    // its restored wait, never resumed by a message and never started again.
    expect(provider.trace("stepParent").probedAtNextRequest).toBe(true)
    expect(provider.trace("stepParent").requests).toBe(3)
    expect(provider.trace("stepParent").continued).toBe(0)
    expect(provider.trace("stepChild").runtimeRecorded).toBeGreaterThan(0)
    expect(provider.trace("stepParent").runtimeRecorded).toBeGreaterThan(0)
    // The successor's recovery pass read each record as recorded and added
    // no record of a dead process over it.
    for (const key of ["chat", "workflow", "shell", "child", "stepParent", "stepChild", "followUp"] as const) {
      expect(provider.trace(key).runtimeRecorded).toBeGreaterThan(0)
      expect(provider.trace(key).crashRecorded).toBe(0)
    }
    expect(provider.trace("person").continued).toBe(0)
    // The step continues in its own conversation: the held request, then the
    // continued one, and never a fresh start of the step.
    expect(provider.trace("workflow").requests).toBe(2)
    // The delegating step's first two requests delegated and waited; no
    // later request delegated again.
    expect(provider.trace("stepChild").requests).toBeLessThanOrEqual(3)
    // The successor adopted the running command before it resumed the
    // shell session, whose continued turn read the transfer result that
    // names the replaced runtime. The command's completion then reaches the
    // session once, from the same process, launched once.
    expect(handoverSessions(projectB)).toEqual([])
    expect(provider.trace("shell").firstContinuedBody).toContain("because the runtime was replaced")
    expect(provider.trace("shell").completedCommand).toBe(0)
    expect(provider.commandPid("shell-1")).toBe(shellPid)
    expect(() => process.kill(shellPid, 0)).not.toThrow()
    provider.releaseCommand("shell-1")
    await until("the command's completion delivered", async () => provider.trace("shell").completedCommand, (count) => count > 0)
    expect(entriesCarrying(projectB, sessions.shell, "fixture-command-finished")).toBe(1)
    expect(provider.commandLaunchCount("shell-1")).toBe(1)

    const secondA = await attachAccountProject({ ...base, executionCwd: projectA, projectRoot: projectA })
    const secondB = await attachAccountProject({ ...base, executionCwd: projectB, projectRoot: projectB })
    try {
      // The question is still open, unanswered, and the person's answer
      // continues the turn with no Resume.
      const asked = await until("question still open", async () => (await secondA.client.query({ type: "questionSnapshot", sessionIds: [sessions.ask] })).views[0]?.view ?? null, (view) => view?.toolUseId === "ask-1")
      expect(asked?.answers).toBeUndefined()
      expect(provider.trace("ask").requests).toBe(1)
      expect(await answerChoice(secondA.client, sessions.ask, "ask-1", "Yes")).toMatchObject({ ok: true })
      await until("the answer continued the turn", async () => provider.trace("ask").requests, (count) => count === 2)
      expect(toolResult(JSON.parse(provider.trace("ask").lastBody ?? "null"), "ask-1")).toContain("Yes")
      // The request the answer continued carries no turn-end record: none was
      // written over the open question, by the cut or by recovery.
      expect(provider.trace("ask").runtimeRecorded).toBe(0)
      expect(provider.trace("ask").crashRecorded).toBe(0)
      // The child finishes and its result reaches the waiting parent once.
      await until("parent finished", async () => provider.trace("parent").requests, (count) => count >= 3)
      expect(await parentCard(secondA.client, sessions.parent)).toMatchObject({ status: "completed" })
      // The parent's wait was cut by the runtime alone: its conversation says
      // so once and never reads as an unexpected exit.
      expect(conversationEntryIds(projectA, sessions.parent).filter((id) => id.startsWith("itb-crash-"))).toEqual([])
      // The step's child finishes and its result reaches the step, in the attempt it was dispatched from.
      await provider.entered("stepParent")
      await until("step's card completed", () => parentCard(secondA.client, sessions.stepMember), (card) => card?.status === "completed")
      expect(await until("delegating workflow finished", () => workflowState(secondA.client, sessions.stepParent), (state) => state === "completed" || state === "failed")).toBe("completed")
      expect(provider.trace("followUp").requests).toBe(2)
      // The person's interrupt outlived the replacement.
      const person = await sessionRow(secondB.client, sessions.person)
      expect(person.admittedActions).toContain("chat.resume")
      expect(await systemRows(secondB.client, sessions.person)).toContain("Interrupted")
      expect(provider.trace("person").continued).toBe(0)
      expect(allContinuationSessions(projectA)).toEqual([])
      expect(allContinuationSessions(projectB)).toEqual([])
      for (const key of ["chat", "workflow", "shell"] as const) expect(provider.trace(key).continued).toBe(1)
      for (const key of ["ask", "stepParent"] as const) expect(provider.trace(key).continued).toBe(0)
    } finally {
      await Promise.allSettled([secondA.dispose(), secondB.dispose()])
    }
  }, 300_000)

  test("a successor killed mid-continuation leaves the session it resumed alone, and the next start resumes the rest once and none twice", async () => {
    // Two projects, one interrupted chat each. The successor continues each
    // project on its own, and project D's store is locked while it starts, so
    // a kill on the first continued request lands after it resumed project C
    // and before project D could continue.
    const projectC = makeProject("project-c")
    const projectD = makeProject("project-d")
    const base = { accountHome, userDataRoot }
    const firstC = await attachAccountProject({ ...base, executionCwd: projectC, projectRoot: projectC })
    const firstD = await attachAccountProject({ ...base, executionCwd: projectD, projectRoot: projectD })
    let firstChat: string
    let secondChat: string
    try {
      firstChat = await startHeldChat(firstC.client, provider, "first")
      secondChat = await startHeldChat(firstD.client, provider, "second")
      await replace()
    } finally {
      await Promise.allSettled([firstC.dispose(), firstD.dispose()])
    }
    expect(continuationRows(projectC, [firstChat]).get(firstChat)).toHaveLength(1)
    expect(continuationRows(projectD, [secondChat]).get(secondChat)).toHaveLength(1)

    const continuedEntered = provider.holdContinuedRequests()
    const releaseD = lockStore(projectD)
    try {
      await startSuccessor(TMP)
      await continuedEntered
      await killAccountServiceUncleanly()
    } finally {
      releaseD()
    }
    // The resumed session's row went once its resume settled, before the
    // resumed turn's request; the other project's row and the handoff remain
    // for the next start.
    expect(provider.trace("first").continued).toBe(1)
    expect(provider.trace("second").continued).toBe(0)
    expect(allContinuationSessions(projectC)).toEqual([])
    expect(allContinuationSessions(projectD)).toEqual([secondChat])
    expect(handoffRows()).toHaveLength(1)

    provider.answerContinuedRequests()
    await startSuccessor(TMP)
    await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    await until("second continued by the next start", async () => provider.trace("second").continued, (count) => count === 1)
    await Bun.sleep(1_000)
    expect(provider.trace("first").continued).toBe(1)
    expect(provider.trace("second").continued).toBe(1)
    expect(allContinuationSessions(projectC)).toEqual([])
    expect(allContinuationSessions(projectD)).toEqual([])
  }, 240_000)

  test("an ordinary graceful stop with a running turn writes no continuation, and the next start resumes nothing", async () => {
    const project = makeProject("project-e")
    const base = { accountHome, userDataRoot }
    const first = await attachAccountProject({ ...base, executionCwd: project, projectRoot: project })
    let chat: string
    try {
      chat = await startHeldChat(first.client, provider, "stop")
      await stopAccountService()
    } finally {
      await first.dispose()
    }
    expect(allContinuationSessions(project)).toEqual([])
    expect(handoffRows()).toEqual([])

    const second = await attachAccountProject({ ...base, executionCwd: project, projectRoot: project })
    try {
      const row = await until("chat interrupted by the runtime", () => sessionRow(second.client, chat), (candidate) => candidate.admittedActions.includes("chat.resume"))
      expect(row.admittedActions).toContain("chat.resume")
      await Bun.sleep(1_000)
      expect(provider.trace("stop").continued).toBe(0)
      expect(provider.trace("stop").requests).toBe(1)
    } finally {
      await second.dispose()
    }
  }, 180_000)

  test("an ordinary graceful stop keeps an empty chat while a client holds its project, and a stop that no client holds removes every empty chat", async () => {
    const project = makeProject("project-h")
    const base = { accountHome, userDataRoot }
    // A project that no client holds stays open this long, so the stop of
    // the service, not the project's sleep, decides its empty chats.
    process.env.FLYWHEEL_PROJECT_IDLE_TIMEOUT_SECONDS = "600"
    /** Opens an empty chat in a tab and waits for its runner to attach. */
    const openEmptyChat = async (client: RuntimeClient): Promise<string> => {
      const opened = await client.dispatch({ type: "chat.open" })
      if (!opened.ok || !opened.sessionId) throw new Error("the empty chat did not open")
      const sessionId = opened.sessionId
      expect(await client.dispatch({ type: "session.activate", sessionId })).toMatchObject({ ok: true })
      await until("empty chat runner ready", () => sessionStatus(client, sessionId), (status) => status?.activity === "idle")
      return sessionId
    }
    /** What each executor stop of the project decided, in order. */
    const stops = async (count: number) => (await until(`${count} executor stops recorded`, async () => infoRecords(project, "dispose all done"), (records) => records.length === count))
      .map(({ fields }) => ({ clientsHold: "clientsHold" in fields ? fields.clientsHold : undefined, removedEmptyChats: "removedEmptyChats" in fields ? fields.removedEmptyChats : undefined }))
    try {
      const first = await attachAccountProject({ ...base, executionCwd: project, projectRoot: project })
      let held: string
      try {
        held = await openEmptyChat(first.client)
        // The client still shows the chat as its service stops, as it does
        // through `flywheel kill` and every restart of the account service.
        await stopAccountService()
      } finally {
        await first.dispose()
      }
      expect(await stops(1)).toEqual([{ clientsHold: true, removedEmptyChats: [] }])

      const second = await attachAccountProject({ ...base, executionCwd: project, projectRoot: project })
      let unheld: string
      try {
        expect((await sessionRow(second.client, held)).lifecycleState).toBe("inactive")
        unheld = await openEmptyChat(second.client)
      } finally {
        await second.dispose()
      }
      // The last client has left, and the project stays open without it.
      const holds = () => infoRecords(accountHome, "project held").map(({ fields }) => ({ projectRoot: "projectRoot" in fields ? fields.projectRoot : undefined, held: "held" in fields ? fields.held : undefined }))
      await until("the project has no hold", async () => holds().filter((hold) => hold.projectRoot === project).at(-1), (hold) => hold?.held === false)
      await stopAccountService()
      // The stop found no hold. It closed the chat open in its executor as a
      // tab's close does, and it removed the chat the first stop kept, whose
      // tab has gone.
      expect(await stops(2)).toEqual([{ clientsHold: true, removedEmptyChats: [] }, { clientsHold: false, removedEmptyChats: [held] }])

      const third = await attachAccountProject({ ...base, executionCwd: project, projectRoot: project })
      try {
        const listed = (await third.client.query({ type: "snapshot" })).rows.map((row) => row.id)
        expect(listed).not.toContain(held)
        expect(listed).not.toContain(unheld)
      } finally {
        await third.dispose()
      }
      await stopAccountService()
    } finally {
      delete process.env.FLYWHEEL_PROJECT_IDLE_TIMEOUT_SECONDS
    }
  }, 180_000)

  test.each([
    ["background", "background-1"],
    ["idleBackground", "idle-background-1"],
    ["stepBackground", "step-background-1"],
    ["childBackground", "child-background-1"],
    ["childForeground", "child-foreground-1"],
    ["followUpBackground", "follow-up-background-1"],
  ] as const)("the %s command crosses the replacement", async (key, commandId) => {
    const project = makeProject(`project-f-${key}`)
    const base = { accountHome, userDataRoot }
    const first = await attachAccountProject({ ...base, executionCwd: project, projectRoot: project })
    const client = first.client
    let owner: string
    let shellPid: number
    try {
      // A client warms the runtime at its first frame, which loads the shell
      // analysis a read-only step needs before it runs a command.
      await client.dispatch({ type: "background.warm" })
      if (key === "stepBackground") owner = await workflowMember(client, await launchWorkflow(client, key))
      else if (key === "followUpBackground") {
        // The follow-up to a completed workflow runs in its parent chat.
        const followStep = await launchWorkflow(client, "followStep")
        await until("workflow completed", () => workflowState(client, followStep), (state) => state === "completed")
        owner = await workflowParent(client, followStep)
        expect(await client.dispatch({ type: "session.send", sessionId: owner, input: TASKS[key] })).toMatchObject({ ok: true })
      } else if (key === "childBackground" || key === "childForeground") {
        owner = await childOf(client, await openChat(client, key === "childBackground" ? "backgroundParent" : "foregroundParent"))
      } else owner = await openChat(client, key)
      await until(`${key} command started`, async () => provider.commandStarted(commandId), Boolean)
      if (key !== "childForeground") await provider.entered(key)
      if (key === "idleBackground") {
        await until("idle chat's command running", () => sessionStatus(client, owner), (status) => status?.activity === "idle" && status.activeBackgroundCommands.length === 1)
      }
      shellPid = provider.commandPid(commandId)
      expect(provider.commandLaunchCount(commandId)).toBe(1)
      // The running command does not delay the replacement: the cutover
      // answers at once, and the service hands the command over and exits.
      setInstalledBuild(`build-${crypto.randomUUID()}`, "1.0.0")
      expect(await requestCutover()).toBe("retiring")
      await until("old service gone", serviceListening, (listening) => !listening)
      expect(await joinIsolatedAccountService(userDataRoot)).toBe(SERVE_EXIT.restart)
    } finally {
      await first.dispose()
    }
    // The command outlived the old service on its own supervisor, and one
    // handover row carries it to the successor.
    expect(() => process.kill(shellPid, 0)).not.toThrow()
    expect(handoverSessions(project)).toHaveLength(1)
    // No person sends a message. The successor adopts the same process,
    // and its completion reaches the owner that parks on it or wakes for it.
    provider.continueOnSuccessor(key)
    await startSuccessor(project)
    await until("the command adopted", async () => handoverSessions(project), (sessions) => sessions.length === 0)
    expect(provider.commandPid(commandId)).toBe(shellPid)
    expect(() => process.kill(shellPid, 0)).not.toThrow()
    provider.releaseCommand(commandId)
    await until(`${key} successor received completed output`, async () => provider.trace(key).successorCompletedCommand, (count) => count > 0)
    expect(provider.trace(key).lastBody?.split("fixture-command-finished").length).toBe(2)
    await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    expect(handoverSessions(project)).toEqual([])
    expect(provider.commandLaunchCount(commandId)).toBe(1)
    expect(provider.trace(key).commandLaunches).toBe(1)
    expect(provider.trace(key).crashRecorded, provider.trace(key).lastUserText).toBe(0)
    // The replacement is invisible: the transcript a client reads names no
    // interruption and no Resume.
    const viewer = await attachAccountProject({ ...base, executionCwd: project, projectRoot: project })
    try {
      expect((await systemRows(viewer.client, owner)).filter((row) => row.startsWith("Interrupted") || row === "Resumed")).toEqual([])
    } finally {
      await viewer.dispose()
    }
  }, 240_000)

  test("the running command of a workflow step a person paused has a host in the successor: it keeps its project open, its status shows Stop, Stop ends it, and the resumed step reads its end", async () => {
    const project = makeProject("project-paused-step")
    const base = { accountHome, userDataRoot }
    const first = await attachAccountProject({ ...base, executionCwd: project, projectRoot: project })
    let workflow: string
    let member: string
    let shellPid: number
    let toolUseId: string
    try {
      await first.client.dispatch({ type: "background.warm" })
      workflow = await launchWorkflow(first.client, "pausedStep")
      member = await workflowMember(first.client, workflow)
      await until("paused step's command started", async () => provider.commandStarted("paused-step-1"), Boolean)
      await provider.entered("pausedStep")
      shellPid = provider.commandPid("paused-step-1")
      const running = await until("the step's command shows Stop", () => sessionStatus(first.client, member), (status) => (status?.activeBackgroundCommands.length ?? 0) === 1)
      toolUseId = running?.activeBackgroundCommands[0]?.toolUseId ?? ""
      expect(await first.client.dispatch({ type: "workflow.interrupt", workflowId: workflow })).toMatchObject({ interrupted: true })
      await until("a person paused the step", async () => (await first.client.query({ type: "workflowDetail", workflowId: workflow })).view, (view) => view?.admittedActions.includes("workflow.resume") === true)
      await replace()
    } finally {
      await first.dispose()
    }
    // The paused step is not resumed, and its running command was handed over.
    expect(alive(shellPid)).toBe(true)
    expect(continuationRows(project, [workflow]).get(workflow)).toEqual([])
    expect(handoverSessions(project)).toEqual([member])

    provider.continueOnSuccessor("pausedStep")
    // The successor sleeps a project that nothing holds after one second, and
    // the kept command is what keeps this one open.
    process.env.FLYWHEEL_PROJECT_IDLE_TIMEOUT_SECONDS = "1"
    await startSuccessor(project)
    let viewer: Awaited<ReturnType<typeof attachAccountProject>> | undefined
    try {
      const deferred = await until("the kept command keeps its project open", async () => infoRecords(accountHome, "idle project close deferred by running work").find(({ fields }) => "projectRoot" in fields && fields.projectRoot === project), (record) => record !== undefined)
      expect(deferred?.fields).toMatchObject({ blockers: ["shell"] })
      expect(alive(shellPid)).toBe(true)
      viewer = await attachAccountProject({ ...base, executionCwd: project, projectRoot: project })
      const { client } = viewer
      // The workflow's status shows the command with its Stop, though
      // nothing resumed the step, and the keeper adopts it, whose row stands
      // while it holds it.
      await until("the handed-over command shows Stop", () => sessionStatus(client, member), (status) => status?.activeBackgroundCommands.some((command) => command.toolUseId === toolUseId) === true)
      await until("the keeper adopted the command", async () => infoRecords(project, "adopted a handed-over command").filter(({ fields }) => "holder" in fields && fields.holder === "keeper").map(({ fields }) => "row" in fields ? fields.row : undefined), (rows) => rows.length === 1 && rows[0] === "kept")
      expect(handoverSessions(project)).toEqual([member])
      expect(provider.trace("pausedStep").continued).toBe(0)
      expect(alive(shellPid)).toBe(true)

      expect(await client.dispatch({ type: "background.terminate", sessionId: member, toolUseId })).toMatchObject({ ok: true })
      await until("Stop ended the command", async () => alive(shellPid), (live) => !live)
      await until("the command's row retired", async () => handoverSessions(project), (sessions) => sessions.length === 0)
      await until("the status withdraws it", () => sessionStatus(client, member), (status) => (status?.activeBackgroundCommands.length ?? 0) === 0)

      // The person's Resume re-enters the step, whose request reads the
      // command's end once.
      expect(await client.dispatch({ type: "workflow.resume", workflowId: workflow })).toMatchObject({ ok: true })
      await until("the resumed step's request", async () => provider.trace("pausedStep").continued, (count) => count > 0)
      const body = provider.trace("pausedStep").firstContinuedBody ?? ""
      expect(body.split("A person stopped this work with Stop").length - 1).toBe(1)
      expect(provider.trace("pausedStep").commandLaunches).toBe(1)
    } finally {
      // A command no host stopped ends on its own, so a failure leaks none.
      provider.releaseCommand("paused-step-1")
      await viewer?.dispose()
    }
  }, 240_000)

  test("a successor does not open a project a previous service of its lane still holds until that service has gone", async () => {
    const project = makeProject("project-g")
    const flywheel = ContainedDirectory.open(project, [FLYWHEEL_DIR_NAME], { privateDirectories: true })
    // This test process stands in for a predecessor still closing the
    // project after it withdrew its socket: a live process of the same lane
    // that holds the project's serving gate.
    const predecessor = registerSharedHolderIn(flywheel, SERVING_GATE)
    let attached: Awaited<ReturnType<typeof attachAccountProject>> | undefined
    try {
      const attaching = attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
        .then(async (value) => { attached = value; await value.client.query({ type: "updateSnapshot" }); return value })
      await Bun.sleep(1_500)
      expect(sharedHoldersIn(flywheel, SERVING_GATE).pids).toEqual([process.pid])
      releaseSharedHolderIn(flywheel, predecessor)
      const client = (await attaching).client
      expect(await client.query({ type: "updateSnapshot" })).toBeDefined()
      const service = readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))
      if (!service) throw new Error("no service identity record")
      expect(sharedHoldersIn(flywheel, SERVING_GATE).pids).toEqual([service.pid])
    } finally {
      await attached?.dispose()
      flywheel.close()
    }
  }, 120_000)
})
