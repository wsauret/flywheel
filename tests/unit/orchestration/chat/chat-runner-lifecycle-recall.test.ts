import { describe, expect, it } from "bun:test"

import { temporaryDirectories } from "../../../helpers/directories"
import { flushMicrotasks, makeLifecycle, useStore } from "./_chat-runner-lifecycle-fixtures"

const makeDirectory = temporaryDirectories()

// A recall withdraws a queued message and awaits the retirement of its cell.
// The lifecycle's decisions whether queued input starts a turn wait for it.
describe("chat runner lifecycle queued input recall", () => {
  /** A lifecycle over a real store whose recall retirement waits on `gate`,
   *  then fails while `fail` is set, and otherwise retires the cells. */
  function makeRecallLifecycle(prefix: string) {
    let opened: ReturnType<typeof useStore> | undefined
    const made = makeLifecycle(undefined, (deps) => { opened = useStore(deps, makeDirectory(prefix)) })
    const store = opened!
    const retirement = { entered: Promise.withResolvers<void>(), gate: Promise.withResolvers<void>(), fail: false }
    const retire = made.deps.treeWriter.dropQueuedUserInputs
    made.deps.treeWriter.dropQueuedUserInputs = async (keys) => {
      retirement.entered.resolve()
      await retirement.gate.promise
      if (retirement.fail) throw new Error("database is locked")
      await retire(keys)
    }
    const interruptions: string[] = []
    const commitTurnEnd = made.deps.treeWriter.commitTurnEnd
    made.deps.treeWriter.commitTurnEnd = async (by) => {
      interruptions.push(by)
      return commitTurnEnd(by)
    }
    /** Holds the next preparation of a turn until `release`. */
    const holdPreparation = () => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const resolveRoles = made.deps.resolveRoles
      made.deps.resolveRoles = async () => {
        made.deps.resolveRoles = resolveRoles
        entered.resolve()
        await release.promise
        return resolveRoles()
      }
      return { entered: entered.promise, release: release.resolve }
    }
    /** Lets context building, which runs in task slices, start `count` runners. */
    const runners = async (count: number) => {
      for (let i = 0; i < 20 && made.runnerOptions.length < count; i++) await flushMicrotasks()
    }
    const cleanup = async () => {
      made.state.end()
      retirement.gate.resolve()
      for (const resolve of made.resolvers) resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
      await made.lifecycle.settle()
      await made.lifecycle.terminateBackgroundWorks()
      await made.deps.treeWriter.dispose()
      store.close()
    }
    return { ...made, retirement, interruptions, holdPreparation, runners, cleanup }
  }

  it.each(["after", "before"] as const)("a failed recall during an accepted startup interrupt restarts nothing, when the retirement fails %s the preparation ends", async (order) => {
    const { lifecycle, runnerOptions, retirement, interruptions, holdPreparation, cleanup } = makeRecallLifecycle("flywheel-recall-startup-interrupt-")
    const preparation = holdPreparation()
    try {
      lifecycle.requestWithContext({ text: "goal", invocation: { label: "/experiment start" } }, "private context")
      await preparation.entered
      await lifecycle.enqueueInput("queued before interrupt")
      const recall = lifecycle.recallQueuedUserInput()
      await retirement.entered.promise
      expect(lifecycle.interruptGeneration()).toBe(true)
      retirement.fail = true
      if (order === "before") {
        retirement.gate.resolve()
        await expect(recall).rejects.toThrow("database is locked")
      }
      preparation.release()
      await flushMicrotasks()
      retirement.gate.resolve()
      await expect(recall).rejects.toThrow("database is locked")
      await lifecycle.settle()
      await flushMicrotasks()

      expect(runnerOptions).toHaveLength(0)
      expect(interruptions).toEqual(["person"])
      expect(lifecycle.turnState).toBe("idle")
      retirement.fail = false
      await expect(lifecycle.recallQueuedUserInput()).resolves.toEqual({ text: "queued before interrupt" })
    } finally {
      preparation.release()
      await cleanup()
    }
  })

  it.each([
    { retirement: "fails", runnersStarted: 2 },
    { retirement: "passes", runnersStarted: 1 },
  ] as const)("a recall whose retirement $retirement while the turn ends decides the continuation on the queue after the recall", async ({ retirement: outcome, runnersStarted }) => {
    const { lifecycle, runnerOptions, runnerStarted, resolvers, retirement, runners, cleanup } = makeRecallLifecycle("flywheel-recall-turn-end-")
    try {
      await lifecycle.enqueueInput("first")
      await runnerStarted
      await lifecycle.enqueueInput("words I take back")
      const recall = lifecycle.recallQueuedUserInput()
      await retirement.entered.promise
      resolvers[0]?.({ servedRequests: 1, durationMs: 1, terminal: { kind: "completed" } })
      await flushMicrotasks()
      expect(lifecycle.turnState).toBe("active")
      retirement.fail = outcome === "fails"
      retirement.gate.resolve()
      if (outcome === "fails") await expect(recall).rejects.toThrow("database is locked")
      else await expect(recall).resolves.toEqual({ text: "words I take back" })
      await runners(2)

      expect(runnerOptions).toHaveLength(runnersStarted)
      if (outcome === "passes") {
        await lifecycle.settle()
        expect(lifecycle.turnState).toBe("idle")
      }
    } finally {
      await cleanup()
    }
  })

  it("a failed recall during an idle landing keeps the authority of the recalled message", async () => {
    const { lifecycle, deps, runnerOptions, retirement, holdPreparation, runners, cleanup } = makeRecallLifecycle("flywheel-recall-idle-landing-")
    const preparation = holdPreparation()
    const commitEntered = Promise.withResolvers<void>()
    const commitRelease = Promise.withResolvers<void>()
    try {
      // An accepted startup interrupt, so the landing holds and only a
      // person's input that arrives during it starts a turn.
      lifecycle.requestWithContext({ text: "goal", invocation: { label: "/experiment start" } }, "private context")
      await preparation.entered
      await lifecycle.enqueueInput("queued before interrupt")
      expect(lifecycle.interruptGeneration()).toBe(true)
      preparation.release()
      await lifecycle.settle()
      await flushMicrotasks()

      const commitNotification = deps.treeWriter.commitBackgroundNotification
      deps.treeWriter.commitBackgroundNotification = async (notification) => {
        commitEntered.resolve()
        await commitRelease.promise
        return commitNotification(notification)
      }
      const delivering = lifecycle.deliverBackgroundNotification({ key: "result", text: "background completed" })
      await commitEntered.promise
      await lifecycle.enqueueInput("sent during the commit")
      const recall = lifecycle.recallQueuedUserInput()
      await retirement.entered.promise
      commitRelease.resolve()
      await flushMicrotasks()
      retirement.fail = true
      retirement.gate.resolve()
      await expect(recall).rejects.toThrow("database is locked")
      await delivering
      await runners(1)

      expect(runnerOptions).toHaveLength(1)
    } finally {
      preparation.release()
      commitRelease.resolve()
      await cleanup()
    }
  })

  it.each(["during", "after"] as const)("a recall %s an idle landing's commit takes the held send out of the conversation", async (when) => {
    const { lifecycle, deps, retirement, cleanup } = makeRecallLifecycle("flywheel-recall-idle-commit-")
    const commitEntered = Promise.withResolvers<void>()
    const commitRelease = Promise.withResolvers<void>()
    const committed = Promise.withResolvers<void>()
    try {
      const commitNotification = deps.treeWriter.commitBackgroundNotification
      deps.treeWriter.commitBackgroundNotification = async (notification) => {
        commitEntered.resolve()
        await commitRelease.promise
        try { return await commitNotification(notification) } finally { committed.resolve() }
      }
      const delivering = lifecycle.deliverBackgroundNotification({ key: "result", text: "background completed" })
      await commitEntered.promise
      // A send while the landing holds the turn slot is held in its cell.
      const key = await deps.treeWriter.holdQueuedUserInput("words I take back")
      expect(key).not.toBeNull()
      await lifecycle.enqueueInput({ text: "words I take back", dispatchIds: [key!] })
      // The commit's recovery runs while the recall withdraws the send, or
      // while the send still waits in the mailbox.
      const recallDuring = when === "during" ? lifecycle.recallQueuedUserInput() : undefined
      if (recallDuring) await retirement.entered.promise
      commitRelease.resolve()
      await committed.promise
      const recall = recallDuring ?? lifecycle.recallQueuedUserInput()
      retirement.gate.resolve()

      await expect(recall).resolves.toEqual({ text: "words I take back" })
      await delivering
      const { messages } = await deps.treeWriter.buildContext()
      expect(messages.filter((message) => message.kind === "user" && JSON.stringify(message.content).includes("words I take back"))).toEqual([])
    } finally {
      commitRelease.resolve()
      await cleanup()
    }
  })
})
