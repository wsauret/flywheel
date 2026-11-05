import { afterAll, describe, expect, test } from "bun:test"

import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { joinIsolatedAccountService } from "./_account-service.js"
import { answerChoice, createReplacementHarness, openChat, sessionStatus, until } from "./_replacement-harness.js"
import { toolResult } from "./_replacement-provider.js"

/** POC 8, first half: one account service, two projects, and one replacement
 *  that waits for no shell command, refuses nothing, and shows nothing
 *  (PI-REMOTE-012, PI-REMOTE-019, PI-REMOTE-020). The busy project's command crosses to the next build,
 *  which serves every project at once. Which sessions delay a replacement is
 *  proven by the replacement-blockers unit tests, and what the replacement
 *  does to each owner kind by replacement-continuation.test.ts. */
const harness = createReplacementHarness("replacement-hold")
const { tmp, userDataRoot, provider, makeProject, setInstalledBuild, requestCutover, serviceListening, stopAccountService, startSuccessor, handoverSessions, entriesCarrying, handoffRows } = harness

/** How long a client of the new build may take to answer in the busy
 *  project: an ordinary attach, with no wait for the command. */
const ATTACH_ANSWER_MS = 10_000

afterAll(async () => {
  await harness.dispose()
}, 60_000)

describe("a replacement across two projects while a command runs", () => {
  test("a running foreground command in one project no longer keeps the cutover busy, both projects continue on the successor, and a new-build client answers at once in the busy project while the command runs", async () => {
    const projectA = makeProject("project-a")
    const projectB = makeProject("project-b")
    const firstA = await harness.attach(projectA)
    const firstB = await harness.attach(projectB)
    let ask: string
    let shell: string
    let shellPid: number
    try {
      // Project A parks a turn on a question nobody has answered; project B
      // runs a foreground command that waits for the test.
      ask = await openChat(firstA.client, "ask")
      await until("project A question", async () => (await firstA.client.query({ type: "questionSnapshot", sessionIds: [ask] })).views[0]?.view ?? null, (view) => view !== null)
      shell = await openChat(firstB.client, "shell")
      await until("project B foreground command", () => sessionStatus(firstB.client, shell), (status) => (status?.activeForegroundBashToolCallIds.length ?? 0) > 0)
      await until("project B command started", async () => provider.commandStarted("shell-1"), Boolean)
      shellPid = provider.commandPid("shell-1")

      // A newer build is installed. The command does not delay it: the
      // cutover answers at once, and the service hands off and exits.
      setInstalledBuild("build-new", "1.0.0")
      expect(await requestCutover()).toBe("retiring")
      await until("service withdrawn", serviceListening, (listening) => !listening)
      expect(await joinIsolatedAccountService(userDataRoot)).toBe(SERVE_EXIT.restart)
    } finally {
      await Promise.allSettled([firstA.dispose(), firstB.dispose()])
    }
    expect(() => process.kill(shellPid, 0)).not.toThrow()
    expect(handoverSessions(projectB)).toEqual([shell])

    // The successor starts with no client. A client of the new build
    // attaches to the busy project and is answered at once, while the
    // command still runs there.
    await startSuccessor(tmp)
    const began = Date.now()
    const second = await harness.attach(projectB)
    try {
      expect(await sessionStatus(second.client, shell)).not.toBeNull()
      expect(Date.now() - began).toBeLessThan(ATTACH_ANSWER_MS)
      expect(() => process.kill(shellPid, 0)).not.toThrow()

      // The successor adopts project B's command, which keeps running under
      // the new build. Project A's question is the person's, so nothing
      // continues it: the successor shows it unanswered, and the answer
      // continues the turn (PI-REMOTE-019, PI-REMOTE-020).
      await until("project B command adopted", async () => handoverSessions(projectB), (sessions) => sessions.length === 0)
      expect(provider.commandPid("shell-1")).toBe(shellPid)
      const status = await until("the adopted command shown", () => sessionStatus(second.client, shell), (view) => (view?.activeBackgroundCommands.length ?? 0) > 0)
      expect(status?.activeBackgroundCommands.map((command) => command.toolUseId)).toEqual(["shell-1"])
      const asked = await harness.attach(projectA)
      try {
        await until("question still open", async () => (await asked.client.query({ type: "questionSnapshot", sessionIds: [ask] })).views[0]?.view ?? null, (view) => view?.toolUseId === "ask-1")
        expect(provider.trace("ask").continued).toBe(0)
        expect(provider.trace("ask").requests).toBe(1)
        expect(await answerChoice(asked.client, ask, "ask-1", "Yes")).toMatchObject({ ok: true })
        await until("the answer continued the turn", async () => provider.trace("ask").requests, (count) => count === 2)
        expect(toolResult(JSON.parse(provider.trace("ask").lastBody ?? "null"), "ask-1")).toContain("Yes")
        expect(provider.trace("ask").continued).toBe(0)
      } finally {
        await asked.dispose()
      }

      // The command ends on the new build, and its completion reaches its
      // session once.
      provider.releaseCommand("shell-1")
      await until("the command's completion delivered", async () => provider.trace("shell").completedCommand, (count) => count > 0)
      expect(entriesCarrying(projectB, shell, "fixture-command-finished")).toBe(1)
      expect(provider.commandLaunchCount("shell-1")).toBe(1)
      await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    } finally {
      await second.dispose()
    }
    await stopAccountService()
  }, 240_000)
})
