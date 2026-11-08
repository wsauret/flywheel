import { describe, expect, it, jest } from "bun:test"
import type { ChatInputLike } from "../../../../src/infra/chat-input"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import { createChatControls } from "../../../../src/orchestration/chat/controls"
import type { ConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import { ChatSessionState, type ChatCallbacks } from "../../../../src/orchestration/chat/types"
import type { ChatPorts } from "../../../../src/orchestration/chat/host-ports"
import type { OutputSession } from "../../../../src/orchestration/runner/output-session"
import type { Agent } from "../../../../src/orchestration/agent-runtime/types"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime"
import { isRuntimeInterruption } from "../../../../src/orchestration/session/conversation/turn-end-record"

function outputSessionStub(calls: string[], phase: () => OutputSession["streamPhase"], echoedEntryIds?: (string | undefined)[], echoedQueued?: boolean[]): OutputSession {
  const blocks: readonly AnyBlock[] = []
  return {
    dispatchRuntimeEvent() {},
    applyProjectionEvent() {},
    beginTurn() {},
    seedBlocks() {},
    pushUserMessage(message, _timestamp, options) {
      echoedEntryIds?.push(options?.entryId)
      echoedQueued?.push(options?.queued ?? false)
      calls.push(`user:${message}`)
      if (options?.submissionIds?.length) calls.push(`submissions:${options.submissionIds.join(",")}`)
      if (options?.images?.length) calls.push(`images:${JSON.stringify(options.images)}`)
    },
    hasQueued() { return false },
    drainQueued() { calls.push("drainQueued"); return [] },
    withdrawQueued() { return null },
    pushSystemMessage(message) { calls.push(`system:${message}`) },
    pushDivider(label) { calls.push(`boundary:${label}`) },
    pushQuestion() {},
    answerQuestion() {},
    cancelQuestion() {},
    getBlocks() { return blocks },
    endTurn(finalStatus = "completed") { calls.push(`endTurn:${finalStatus}`) },
    get streamPhase() { return phase() },
    sessionId: "session-1",
    flush() { calls.push("flush") },
    dispose() {},
  }
}

function lifecycleStub(): ChatPorts {
  return {
    chatModuleHosts: NO_MODULE_RUNTIMES,
    moduleRuntimes: NO_MODULE_RUNTIMES,
    onModuleRuntimesChange: () => () => {},
    backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {}, onChange: () => {} }),
    hold: async () => NO_MODULE_RUNTIMES,
    capabilities: async () => () => true,
    turnState: "active",
    enqueueInput(_input: ChatInputLike) {},
    deliverHeldMessage: async () => { throw new Error("unused") },
    messageState: async () => { throw new Error("unused") },
    deliverBackgroundNotification: async () => false,
    requestWithContext() { return false },
    drainQueuedUserInputs() { return [] },
    async recallQueuedUserInput() { return null },
    restartWithQueuedInputs(_inputs: readonly ChatInputLike[]) {},
    resumeCommitted() { return false },
    async awaitOwedCapacity() { return false },
    requestCompact() { return false },
    learn() { return false },
    interruptGeneration() { return false },
    turnRunning: false,
    turnCut: undefined,
    cutTurn() {},
    abortRunningTurn() { return false },
    setShown() {},
    servingChanged() {},
    abortGeneration() {},
    settle() { return Promise.resolve() },
    pendingTurnSettlement: undefined,
    awaitLogicalTurnDurability: async () => {},
    terminateBackgroundWorks: async () => {},
    terminateBackgroundWork() {},
    releaseForegroundBash() { return false },
    transferForegroundForReplacement: async () => {},
    adoptHandedOver: async () => {},
  }
}

function treeWriterStub(): ConversationTreeWriterController {
  return {
    commitUserTurn: async () => null,
    reserveMessageId: async () => "user-entry",
    releaseMessageId() {},
    commitQueuedUserInput: async () => { throw new Error("unused") },
    acceptRetainedOperation: async () => {},
    commitSystemTurn: async () => { throw new Error("unused") },
    commitBackgroundNotification: async () => { throw new Error("unused") },
    commitSystemMessage: async () => { throw new Error("unused") },
    commitTurnEnd: async () => { throw new Error("unused") },
    suspendPending() { throw new Error("unused") },
    holdBackgroundNotification: async () => { throw new Error("unused") },
    waitForBackgroundNotification: async () => { throw new Error("unused") },
    holdsBackgroundNotification: () => false,
    getState: async () => { throw new Error("unused") },
    recall: async () => { throw new Error("unused") },
    beginTurn() {},
    endTurn: async () => {},
    recordCanonicalMessage: async () => {},
    settleSuspendedTurn: async () => {},
    holdQueuedUserInput: async () => "held-entry",
    recordedPersonMessage: async () => undefined,
    commitHeldMessage: async () => null,
    dropQueuedUserInputs: async () => {},
    ownQueuedUserInputs: () => {},
    flushSavePoint: async () => {},
    buildContext: async () => { throw new Error("unused") },
    captureCommittedForkMessages: async () => { throw new Error("unused") },
    captureRawLiveMessages: async () => { throw new Error("unused") },
    recordCompaction: async () => null,
    getLeafId: async () => null,
    dispose: async () => {},
  }
}

function createControls(interruptResult: boolean, turnState: ChatPorts["turnState"] = "active", resumeResult = true, treeWriter: ConversationTreeWriterController = treeWriterStub(), pendingInputs: ChatInputLike[] = []) {
  const calls: string[] = []
  const echoedEntryIds: (string | undefined)[] = []
  const echoedQueued: boolean[] = []
  const restarts: ChatInputLike[][] = []
  const runner = { acceptsRequests: true }
  const state = new ChatSessionState(undefined, () => {})
  state.attachRunner({
    send() {},
    abort() {},
    end() {},
    interruptGeneration() { return false },
    done: new Promise(() => {}),
  })

  const callbacks: ChatCallbacks = { onError() {}, onEnded() {} }
  // The lifecycle's wait state owns who cut the turn in the slot; this
  // models one turn, so a cut holds for the stub's life.
  let cut: ChatPorts["turnCut"]
  const controls = createChatControls({
    lifecycle: {
      ...lifecycleStub(),
      turnState,
      drainQueuedUserInputs: () => pendingInputs,
      restartWithQueuedInputs: inputs => { restarts.push([...inputs]) },
      // A runner whose turn cannot be cut models one parked with its turn answered.
      get turnRunning() { return turnState === "active" && interruptResult && cut === undefined },
      get turnCut() { return cut },
      cutTurn(by) { if (turnState === "active") cut = isRuntimeInterruption(by) ? { kind: "aborted", by } : { kind: "interrupted", by } },
      interruptGeneration() { calls.push("runnerInterrupt"); return interruptResult },
      abortRunningTurn() { calls.push("runnerAbortRunningTurn"); return interruptResult },
      resumeCommitted(options) { calls.push(`resumeCommitted:${options?.explicit === true ? "explicit" : "wake"}`); return resumeResult },
      abortGeneration() { calls.push("runnerAbort") },
      enqueueInput(input) { calls.push(`enqueue:${typeof input === "string" ? input : input.text}`) },
      requestWithContext(input, context) { calls.push(`request:${typeof input === "string" ? input : input.text}|${context}`); return runner.acceptsRequests },
    },
    session: outputSessionStub(calls, () => null, echoedEntryIds, echoedQueued),
    callbacks,
    eventUnsubs: [],
    state,
    treeWriter,
    onTreeFailure(err) { calls.push(`treeFailure:${err.message}`) },
    drainEvents: async () => ({ kind: "drained", acked: [] }),
    recordInterruption(by) { calls.push(`recordInterruption:${by}`) },
    supersedeInterruptedTurn() { calls.push("supersede") },
  })
  return { controls, calls, echoedEntryIds, echoedQueued, restarts, runner }
}

describe("createChatControls", () => {
  it("interrupt cuts the turn, shows who interrupted it, and leaves the durable record to the parked loop", () => {
    const { controls, calls } = createControls(true)

    expect(controls.interrupt()).toBe(true)

    expect(calls).toEqual([
      "runnerInterrupt",
      "endTurn:paused",
      "system:Interrupted",
      "drainQueued",
      "flush",
    ])
  })

  it.each(["runtime", "close"] as const)("the runtime's %s stop cuts the turn through the teardown abort, shows a runtime interrupt, and records its own cut", (by) => {
    const { controls, calls } = createControls(true)

    expect(controls.interruptForRuntime(by)).toBe(true)

    expect(calls).toEqual([
      "runnerAbortRunningTurn",
      "endTurn:paused",
      "system:Interrupted by the runtime",
      `recordInterruption:${by}`,
      "flush",
    ])
  })

  it("a planned replacement's cut records the interrupt but shows nothing", () => {
    const { controls, calls } = createControls(true)

    expect(controls.interruptForRuntime("replacement")).toBe(true)

    expect(calls).toEqual([
      "runnerAbortRunningTurn",
      "endTurn:paused",
      "recordInterruption:replacement",
      "flush",
    ])
  })

  it("holds a running turn only while one runs that no one cut, and the runtime's stop cuts nothing otherwise: an idle turn, a runner that cannot be cut, or a turn after a person's interrupt", () => {
    expect(createControls(true).controls.holdsRunningTurn()).toBe(true)
    for (const [interruptResult, turnState] of [[true, "idle"], [false, "active"]] as const) {
      const { controls } = createControls(interruptResult, turnState)
      expect(controls.holdsRunningTurn()).toBe(false)
      expect(controls.interruptForRuntime("runtime")).toBe(false)
    }
    const { controls, calls } = createControls(true)
    expect(controls.interrupt()).toBe(true)
    calls.length = 0
    expect(controls.holdsRunningTurn()).toBe(false)
    expect(controls.interruptForRuntime("replacement")).toBe(false)
    expect(calls).toEqual([])
  })

  it("a new message after an interrupt, or into a session with no runner, supersedes the last turn; a Resume and a message into a running turn do not", async () => {
    const running = createControls(true)
    await running.controls.send("more context")
    expect(running.calls).not.toContain("supersede")
    expect(running.controls.interrupt()).toBe(true)
    await running.controls.send("try something else")
    expect(running.calls).toContain("supersede")

    const idle = createControls(true, "idle")
    expect(idle.controls.resume({ announce: true })).toBe(true)
    expect(idle.calls).not.toContain("supersede")
    await idle.controls.send("a new turn")
    expect(idle.calls).toContain("supersede")
  })

  it("resume continues from the committed leaf as the person's explicit act and says so", () => {
    const { controls, calls } = createControls(true, "idle")

    expect(controls.resume({ announce: true })).toBe(true)

    expect(calls).toEqual(["resumeCommitted:explicit", "system:Resumed", "flush"])
  })

  it("resume after a cut no one saw continues without saying so", () => {
    const { controls, calls } = createControls(true, "idle")

    expect(controls.resume({ announce: false })).toBe(true)

    expect(calls).toEqual(["resumeCommitted:explicit", "flush"])
  })

  it("resume says nothing when the runner refuses", () => {
    const { controls, calls } = createControls(true, "idle", false)

    expect(controls.resume({ announce: true })).toBe(false)

    expect(calls).toEqual(["resumeCommitted:explicit"])
  })

  it("does not mutate output when the active runner cannot interrupt", () => {
    const { controls, calls } = createControls(false)

    expect(controls.interrupt()).toBe(false)

    expect(calls).toEqual(["runnerInterrupt"])
  })

  it("does not consult the attached runner when the lifecycle turn is idle", () => {
    const { controls, calls } = createControls(true, "idle")

    expect(controls.interrupt()).toBe(false)
    expect(calls).toEqual([])
  })

  it("abort of an idle session records no Interrupted marker and preserves each queued input on restart", async () => {
    const { controls, calls } = createControls(false, "idle")

    controls.abort()

    // The dispose flush persists whatever abort stamps, so an idle teardown
    // must leave the transcript untouched -- no phantom "Interrupted" on reopen.
    expect(calls).toEqual([
      "runnerAbort",
      "drainQueued",
      "flush",
    ])
    const pending = [{ text: "first", dispatchIds: ["entry-1"] }, { text: "second", dispatchIds: ["entry-2"] }]
    const queued = createControls(false, "idle", true, treeWriterStub(), pending)
    queued.controls.abort()
    await Promise.resolve()
    expect(queued.restarts).toEqual([pending])
  })

  it("abort mid-turn records no Interrupted marker (teardown shelves the turn)", () => {
    const { controls, calls } = createControls(true, "active")

    controls.abort()

    expect(calls).toEqual([
      "runnerAbort",
      "drainQueued",
      "flush",
    ])
  })

  it("a quit-time abort after an interrupt does not show a second Interrupted row", () => {
    const { controls, calls } = createControls(true, "active")

    expect(controls.interrupt()).toBe(true)
    // Interrupt keeps the turn slot alive, so the shutdown abort still sees an
    // active turn; the interruption belongs to the person's interrupt alone.
    controls.abort()

    expect(calls.filter((call) => call === "system:Interrupted")).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith("recordInterruption:"))).toEqual([])
  })

  it("echoes an invocation send as its divider plus the raw args, not the expanded prompt", async () => {
    const { controls, calls } = createControls(true)

    await controls.send({ text: "expanded step prompt body", invocation: { label: "Adapt", args: "please adapt this box" } })

    expect(calls).toEqual([
      "boundary:Adapt",
      "user:please adapt this box",
      "enqueue:expanded step prompt body",
    ])
  })

  it("echoes an argument-less invocation send as only its divider", async () => {
    const { controls, calls } = createControls(true)

    await controls.send({ text: "expanded step prompt body", invocation: { label: "Code Review" } })

    expect(calls).toEqual(["boundary:Code Review", "enqueue:expanded step prompt body"])
  })

  it("shows a command's context request as its divider plus the raw args, never as a recallable queued row", () => {
    const { controls, calls, echoedQueued } = createControls(true, "active")

    expect(controls.requestWithContext({ text: "Run the campaign.\n\nonly the TUI ones", invocation: { label: "/papercuts", args: "only the TUI ones" } }, "backlog")).toBe(true)
    expect(controls.requestWithContext({ text: "Run the campaign.", invocation: { label: "/papercuts" } }, "backlog")).toBe(true)

    expect(calls).toEqual([
      "request:Run the campaign.\n\nonly the TUI ones|backlog",
      "boundary:/papercuts",
      "user:only the TUI ones",
      "request:Run the campaign.|backlog",
      "boundary:/papercuts",
    ])
    expect(echoedQueued).toEqual([false])
  })

  it("shows nothing for a context request the ended runner refuses", () => {
    const { controls, calls, runner } = createControls(true)
    runner.acceptsRequests = false

    expect(controls.requestWithContext({ text: "Run the campaign.", invocation: { label: "/papercuts" } }, "backlog")).toBe(false)
    expect(calls).toEqual(["request:Run the campaign.|backlog"])
  })

  it("carries client correlation and the canonical entry identity into idle and queued user echoes", async () => {
    const { controls, calls, echoedEntryIds } = createControls(true)
    await controls.send({ text: "hello", submissionIds: ["submission-1"] })
    expect(calls).toEqual(["user:hello", "submissions:submission-1", "enqueue:hello"])
    expect(echoedEntryIds).toEqual(["held-entry"])
    const committed: (string | undefined)[] = []
    const idle = createControls(false, "idle", true, {
      ...treeWriterStub(),
      commitUserTurn: async (_input, entryId) => { committed.push(entryId); return entryId ?? null },
    })
    await idle.controls.send("hello")
    expect(committed).toEqual(["user-entry"])
    expect(idle.echoedEntryIds).toEqual(committed)
  })
  it("echoes image attachments in order without treating file attachments as images", async () => {
    const { controls, calls } = createControls(true)
    await controls.send({ text: "[Image #1] [File #2] [Image #3]", attachments: [
      { marker: "[Image #1]", mediaType: "image/png", data: "aGk=" },
      { marker: "[File #2]", mediaType: "text/plain", data: "ZmlsZQ==" },
      { marker: "[Image #3]", mediaType: "image/jpeg", data: "Ynll" },
    ] })
    expect(calls).toEqual([
      "user:[Image #1] [File #2] [Image #3]",
      'images:[{"mediaType":"image/png","data":"aGk="},{"mediaType":"image/jpeg","data":"Ynll"}]',
      "enqueue:[Image #1] [File #2] [Image #3]",
    ])
  })
  it("a message the store cannot save fails its send alone: nothing is shown or started, and the chat stays open", async () => {
    const refused = new Error("database is locked")
    const released: string[] = []
    const idle = createControls(true, "idle", true, {
      ...treeWriterStub(),
      commitUserTurn: () => Promise.reject(refused),
      releaseMessageId: entryId => { released.push(entryId) },
    })
    const running = createControls(true, "active", true, { ...treeWriterStub(), holdQueuedUserInput: () => Promise.reject(refused) })

    for (const { controls, calls } of [idle, running]) {
      await expect(controls.send({ text: "hello" })).rejects.toBe(refused)
      expect(calls.filter((call) => /^(user|enqueue|treeFailure):/.test(call))).toEqual([])
    }
    expect(released).toEqual(["user-entry"])
    // The next message after a refused one is saved and started as usual.
    await expect(idle.controls.send("again")).rejects.toBe(refused)
    const recovered = createControls(true, "idle")
    await expect(recovered.controls.send("again")).resolves.toBe("accepted")
    expect(recovered.calls.filter((call) => /^(user|enqueue):/.test(call))).toEqual(["user:again", "enqueue:again"])
  })

  it("saves, shows, and starts messages one after another in the order they were sent", async () => {
    const saves: { readonly text: string; readonly done: () => void }[] = []
    const started = Promise.withResolvers<void>()
    const { controls, calls } = createControls(true, "idle", true, {
      ...treeWriterStub(),
      commitUserTurn: (input) => new Promise((resolve) => {
        saves.push({ text: typeof input === "string" ? input : input.text, done: () => resolve(null) })
        started.resolve()
      }),
    })
    const first = controls.send("first")
    const second = controls.send("second")
    await started.promise
    // The second save waits for the first, so a later copy of a submission
    // always finds the earlier copy in the ledger.
    expect(saves.map((save) => save.text)).toEqual(["first"])
    saves[0]!.done()
    await first
    for (let turn = 0; turn < 5 && saves.length < 2; turn++) await Promise.resolve()
    expect(saves.map((save) => save.text)).toEqual(["first", "second"])
    saves[1]!.done()
    await second
    expect(calls.filter((call) => /^(user|enqueue):/.test(call))).toEqual(["user:first", "enqueue:first", "user:second", "enqueue:second"])
  })

  it("answers a person's message that the ledger already holds under its submission with a receipt, before any refusal or side effect", async () => {
    for (const where of ["entry", "cell"] as const) {
      const asked: string[] = []
      // An idle chat would leave its last turn behind for a new message.
      const idle = createControls(true, "idle", true, {
        ...treeWriterStub(),
        recordedPersonMessage: async (key) => { asked.push(key); return where },
        commitUserTurn: async () => { throw new Error("a receipt saves nothing") },
        holdQueuedUserInput: async () => { throw new Error("a receipt holds nothing") },
      })
      expect(await idle.controls.send({ text: "again", submissionIds: ["submission-1"] })).toBe("recorded")
      expect(asked).toEqual(["person:submission-1"])
      expect(idle.calls.filter((call) => /^(user|enqueue|supersede)/.test(call))).toEqual([])
    }
  })

  it("records a second copy of a submission that arrives while the first is saved as a receipt, not a second message", async () => {
    const ledger = new Set<string>()
    const keys: (string | undefined)[] = []
    const { controls, calls } = createControls(true, "active", true, {
      ...treeWriterStub(),
      recordedPersonMessage: async (key) => (ledger.has(key) ? "cell" : undefined),
      holdQueuedUserInput: async (input) => {
        const key = `person:${typeof input === "string" ? "" : input.submissionIds?.[0]}`
        keys.push(key)
        await Promise.resolve()
        ledger.add(key)
        return key
      },
    })
    const input = { text: "once", submissionIds: ["submission-1"] }
    expect(await Promise.all([controls.send(input), controls.send(input)])).toEqual(["accepted", "recorded"])
    expect(keys).toEqual(["person:submission-1"])
    expect(calls.filter((call) => call.startsWith("enqueue:"))).toEqual(["enqueue:once"])
  })

  it("disposes nothing until the lifecycle has really quiesced, whatever a disposal timer does", async () => {
    const calls: string[] = []
    const state = new ChatSessionState(undefined, () => {})
    const runner: Agent = {
      send() {},
      abort() { calls.push("runnerAbort") },
      end() {},
      interruptGeneration() { return true },
      done: new Promise(() => {}),
    }
    state.attachRunner(runner)

    const quiesced = Promise.withResolvers<void>()
    const lifecycle: ChatPorts = {
      ...lifecycleStub(),
      abortGeneration() { calls.push("runnerAbort") },
      settle() { calls.push("settle"); return quiesced.promise },
      terminateBackgroundWorks: async () => { calls.push("terminateBackgroundWorks", "reviewUsage", "reviewCompleted") },
    }
    const controls = createChatControls({
      lifecycle,
      session: { ...outputSessionStub(calls, () => null), dispose() { calls.push("sessionDispose") } },
      callbacks: { onError() {}, onEnded() { calls.push("onEnded") } },
      eventUnsubs: [() => { calls.push("unsubscribe") }],
      state,
      treeWriter: { ...treeWriterStub(), dispose: async () => { calls.push("treeDispose") } },
      onTreeFailure() {},
      drainEvents: async () => { calls.push("drainEvents"); return { kind: "drained", acked: [] } },
      recordInterruption(by) { calls.push(`recordInterruption:${by}`) },
      supersedeInterruptedTurn() {},
    })

    // Every teardown timeout is fired before the turn settles. The tree writer
    // and the output session stay reachable from the turn that is still
    // unwinding, so a timer must never be what releases them. Fake timers hold
    // Bun.sleep as well, so the test yields its turns through setImmediate.
    jest.useFakeTimers()
    const turn = () => new Promise<void>((resolve) => { setImmediate(resolve) })

    let ended = false
    try {
      const ending = controls.end().then(() => { ended = true })
      await turn()
      jest.runAllTimers()
      await turn()

      expect(calls).toEqual(["runnerAbort", "settle"])
      expect(ended).toBe(false)

      quiesced.resolve()
      await ending
    } finally {
      jest.useRealTimers()
    }

    expect(ended).toBe(true)
    expect(calls).toEqual([
      "runnerAbort",
      "settle",
      "terminateBackgroundWorks",
      "reviewUsage",
      "reviewCompleted",
      "drainEvents",
      "unsubscribe",
      "flush",
      "treeDispose",
      "sessionDispose",
      "onEnded",
    ])
  })

})
