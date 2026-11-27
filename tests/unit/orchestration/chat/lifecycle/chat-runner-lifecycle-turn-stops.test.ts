// Which ends of a chat's run record `chat.turn.stopped` and
// `chat.turn.started` (ARCH-SESSIONS-051), on the real chat runner lifecycle
// with a runner that ends as each case states.
import { describe, expect, it } from "bun:test"
import type { TurnParkedContext } from "../../../../../src/infra/substrate/events/agent-loop-events"
import type { ConversationEntry } from "../../../../../src/orchestration/session/conversation/conversation-entry-types"
import type { AgentRunTerminal } from "../../../../../src/orchestration/agent-runtime/types"
import { createChatInvocationCompletion } from "../../../../../src/orchestration/chat/runner-completion"
import type { SessionFact } from "../../../../../src/orchestration/session/persistence/session-fact-writer"
import { temporaryDirectories } from "../../../../helpers/directories"
import { countStateRequests, type StateRequest, type StateRequestCounter } from "../../../../helpers/state-requests"
import { flushMicrotasks, makeLifecycle, useStore } from "./_chat-runner-lifecycle-fixtures"

const makeDirectory = temporaryDirectories()

/** A lifecycle whose session writer reports each stop and start it records.
 *  With `store`, its tree writer is a real one, and `lookups` holds the
 *  state requests of each lookup of the answer that a stop names. */
function recordingLifecycle(options: { readonly unattended?: true; readonly holdStop?: Promise<void>; readonly store?: true } = {}) {
  let counter: StateRequestCounter | undefined
  let store: ReturnType<typeof useStore> | undefined
  const lookups: StateRequest[][] = []
  const made = makeLifecycle(undefined, (deps) => {
    if (options.unattended) deps.rootChatCompletion = createChatInvocationCompletion(undefined, true)
    if (options.store) {
      store = useStore(deps, makeDirectory("turn-stops-"), (surface) => (counter = countStateRequests(surface)).reader)
      const { treeWriter } = deps
      const lookup = treeWriter.newestSincePersonMessage.bind(treeWriter)
      treeWriter.newestSincePersonMessage = <T>(select: (entry: ConversationEntry) => T | undefined): T | undefined => {
        counter?.take()
        const answer = lookup(select)
        lookups.push(counter?.take() ?? [])
        return answer
      }
    }
  })
  const facts: string[] = []
  const stops: unknown[] = []
  const record = made.deps.infra.sessionEventWriter.record
  made.deps.infra.sessionEventWriter.record = (fact: SessionFact, ...rest) => {
    if (fact.type === "chat.turn.started") facts.push("start")
    if (fact.type !== "chat.turn.stopped") return record(fact, ...rest)
    facts.push("stop")
    stops.push(fact.payload)
    return (options.holdStop ?? Promise.resolve()).then(() => record(fact, ...rest))
  }
  const close = async () => {
    await made.lifecycle.terminateBackgroundWorks()
    if (!store) return
    await made.deps.treeWriter.dispose()
    store.close()
  }
  return { ...made, facts, stops, lookups, close }
}

/** Flushes until `done` holds, and fails when it never does. */
async function until(what: string, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !done(); attempt += 1) await flushMicrotasks()
  if (!done()) throw new Error(`never reached: ${what}`)
}

const PARK = { handoffWritten: false, turnCount: 1, activeBackgroundCount: 0, parkedOnBackgroundWork: false, waitRequested: false, userResumeRequired: false } as const satisfies Omit<TurnParkedContext, "park">

describe("chat runner lifecycle turn stops", () => {
  it.each<readonly [string, AgentRunTerminal, readonly unknown[]]>([
    ["a provider fault, as an auth or a rate-limit failure ends", { kind: "api_error", message: "overloaded", recovery: { kind: "retry" } }, [{ kind: "failed", failure: "api_error" }]],
    ["a refusal of the conversation content", { kind: "api_error", message: "cyber_policy", recovery: { kind: "none" }, contentRefused: true }, [{ kind: "refused" }]],
    ["a context overflow", { kind: "context_overflow" }, [{ kind: "failed", failure: "context_overflow" }]],
    ["a stalled stream", { kind: "stream_stalled", message: "stalled", attribution: { kind: "unattributed" } }, [{ kind: "failed", failure: "stream_stalled" }]],
    ["a stop that a caller asked for", { kind: "aborted" }, []],
    ["a run that ends completed with no park", { kind: "completed" }, []],
  ])("a run that ends on %s records the stop it owes, with no final entry", async (_name, terminal, endings) => {
    const { lifecycle, resolvers, stops, facts } = recordingLifecycle()
    try {
      await lifecycle.enqueueInput("first")
      await flushMicrotasks()
      resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal })
      await lifecycle.settle()
      expect(stops).toEqual(endings.map((ending) => ({ conversationId: expect.any(String), ending })))
      expect(facts).toEqual(["start", ...endings.map(() => "stop")])
    } finally {
      await lifecycle.terminateBackgroundWorks()
    }
  })

  it("a failed run whose queued input starts the next turn records no stop", async () => {
    const { lifecycle, resolvers, facts } = recordingLifecycle()
    try {
      await lifecycle.enqueueInput("first")
      await flushMicrotasks()
      await lifecycle.enqueueInput("second")
      resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "context_overflow" } })
      while (resolvers.length < 2) await flushMicrotasks()
      expect(facts).toEqual(["start"])
    } finally {
      resolvers.at(-1)?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
      await lifecycle.settle()
      await lifecycle.terminateBackgroundWorks()
    }
  })

  it("a message sent while a stalled run's stop is written starts the next run", async () => {
    const held = Promise.withResolvers<void>()
    const { lifecycle, resolvers, facts } = recordingLifecycle({ holdStop: held.promise })
    try {
      await lifecycle.enqueueInput("first")
      await flushMicrotasks()
      resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "stream_stalled", message: "stalled", attribution: { kind: "unattributed" } } })
      await until("the stop", () => facts.includes("stop"))
      await lifecycle.enqueueInput("second")
      held.resolve()
      await until("the second run", () => resolvers.length === 2)
      expect(facts).toEqual(["start", "stop", "start"])
    } finally {
      held.resolve()
      resolvers.at(-1)?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
      await lifecycle.settle()
      await lifecycle.terminateBackgroundWorks()
    }
  })

  it("a failed run records no stop while work that owes the chat a result still runs", async () => {
    const work = Promise.withResolvers<{ status: "completed"; content: string }>()
    const { lifecycle, resolvers, facts } = recordingLifecycle()
    try {
      await lifecycle.enqueueInput("first")
      await flushMicrotasks()
      lifecycle.backgroundTasks.track({ done: work.promise, meta: { id: "bash-bg-1", type: "background_command", description: "build" } })
      resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "context_overflow" } })
      await lifecycle.settle()
      expect(facts).toEqual(["start"])
    } finally {
      work.resolve({ status: "completed", content: "" })
      await lifecycle.terminateBackgroundWorks()
    }
  })

  it("a failed run that the person interrupts while it settles records no stop", async () => {
    const { lifecycle, resolvers, facts, deps } = recordingLifecycle()
    const settling = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const endTurn = deps.treeWriter.endTurn
    deps.treeWriter.endTurn = async () => { settling.resolve(); await release.promise; return endTurn() }
    try {
      await lifecycle.enqueueInput("first")
      await flushMicrotasks()
      resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "context_overflow" } })
      await settling.promise
      expect(lifecycle.interruptGeneration()).toBe(true)
      release.resolve()
      await lifecycle.settle()
      await flushMicrotasks()
      expect(facts).toEqual(["start"])
    } finally {
      release.resolve()
      await lifecycle.terminateBackgroundWorks()
    }
  })

  it("records a start at each logical start and a stop only at the idle park after a turn end, naming the newest answer since the person's message, with no store read", async () => {
    const { lifecycle, runnerOptions, stops, facts, lookups, deps, close } = recordingLifecycle({ store: true })
    try {
      await lifecycle.enqueueInput("first")
      await flushMicrotasks()
      const options = runnerOptions[0]
      const loop = options?.lifecycle
      const conversation = options?.conversation
      if (!loop || conversation?.kind !== "durable-tree") throw new Error("the runner has no durable conversation")
      loop.onLogicalTurnStarted?.({ origin: "user", reason: "queued_input" })
      await conversation.append({ kind: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "read-1", name: "read", input: {} }] }, "entry-call")
      await conversation.append({ kind: "assistant", content: "# Done\n\n```ts\nconst x = 1\n```" }, "entry-answer")
      await loop.onTurnEnded?.({ handoffWritten: false, turnCount: 1 })
      // The loop parks on owed work, or for the person after an interrupt: nothing stopped.
      await loop.onTurnParked?.({ ...PARK, park: "waiting_on_work", activeBackgroundCount: 1 })
      await loop.onTurnParked?.({ ...PARK, park: "interrupted", userResumeRequired: true })
      expect(stops).toEqual([])
      await loop.onTurnParked?.({ ...PARK, park: "idle" })
      const answered = { conversationId: expect.any(String), ending: { kind: "completed" }, finalEntryId: "entry-answer", firstLine: "const x = 1" }
      expect(stops).toEqual([answered])
      // A park that follows no new turn end, as after a compaction, records nothing.
      await loop.onTurnEnded?.({ handoffWritten: false, turnCount: 2 })
      await loop.onTurnParked?.({ ...PARK, park: "idle" })
      // A notice's turn that says nothing new names the answer before it,
      // which the person has still not read.
      loop.onLogicalTurnStarted?.({ origin: "background", reason: "queued_input" })
      await loop.onTurnEnded?.({ handoffWritten: false, turnCount: 3 })
      await loop.onTurnParked?.({ ...PARK, park: "idle" })
      expect(facts).toEqual(["start", "start", "stop", "start", "stop"])
      expect(stops.at(-1)).toEqual(answered)
      // The person read past that answer: a turn of theirs that says nothing new names none.
      await deps.treeWriter.commitUserTurn("again")
      loop.onLogicalTurnStarted?.({ origin: "user", reason: "queued_input" })
      await loop.onTurnEnded?.({ handoffWritten: false, turnCount: 4 })
      await loop.onTurnParked?.({ ...PARK, park: "idle" })
      expect(stops.at(-1)).toEqual({ conversationId: expect.any(String), ending: { kind: "completed" } })
      // Each lookup of the answer reads the tree writer's own state, never the store.
      expect(lookups).toEqual([[], [], []])
    } finally {
      await close()
    }
  })

  it("an unattended run records neither fact", async () => {
    const { lifecycle, resolvers, runnerOptions, facts } = recordingLifecycle({ unattended: true })
    try {
      await lifecycle.enqueueInput("first")
      await flushMicrotasks()
      const loop = runnerOptions[0]?.lifecycle
      loop?.onLogicalTurnStarted?.({ origin: "user", reason: "queued_input" })
      await loop?.onTurnEnded?.({ handoffWritten: false, turnCount: 1 })
      await loop?.onTurnParked?.({ ...PARK, park: "idle" })
      resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "context_overflow" } })
      await lifecycle.settle()
      expect(facts).toEqual([])
    } finally {
      await lifecycle.terminateBackgroundWorks()
    }
  })
})
