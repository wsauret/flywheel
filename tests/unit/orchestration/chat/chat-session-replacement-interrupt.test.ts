import { afterEach, describe, expect, it } from "bun:test"
import { EventBus } from "../../../../src/infra/event-bus"
import type { PausedBy } from "../../../../src/infra/output-blocks"
import { createChatSession, type ChatSessionDeps } from "../../../../src/orchestration/chat/session"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import type { StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import type { RuntimeInterruption } from "../../../../src/orchestration/session/conversation/turn-end-record"
import type { SessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { asModelClient } from "../agent-runtime/_model-client"
import { captureBlocks, createSessionFactWriter, createTestChatSessionDeps, makeMemoryTreeWriter } from "./_chat-session-agent-runtime-fixtures"

const ASK_ID = "ask-1"

type FirstReply = "asks" | "answers" | "streams" | "silent"

/** A chat whose first turn asks a question and waits on the person, with
 *  every durable write it makes recorded in order. */
async function askingChat(log: string[], updateEntry?: ChatSessionDeps["updateEntry"]): Promise<ChatRunner> {
  const session = await scriptedChat(log, "asks", updateEntry)
  const deadline = Date.now() + 2_000
  while (!log.includes("agent_input.requested") && Date.now() < deadline) await Bun.sleep(5)
  expect(log).toContain("agent_input.requested")
  return session
}

/** A chat whose first turn answers and parks, its turn finished. */
async function answeredChat(log: string[]): Promise<ChatRunner> {
  const session = await scriptedChat(log, "answers")
  const deadline = Date.now() + 2_000
  while (!log.includes("turn-parked") && Date.now() < deadline) await Bun.sleep(5)
  expect(log).toContain("turn-parked")
  return session
}

/** A chat whose first turn streams until it is cut. */
async function streamingChat(log: string[], updateEntry: ChatSessionDeps["updateEntry"]): Promise<ChatRunner> {
  const session = await scriptedChat(log, "streams", updateEntry)
  const deadline = Date.now() + 2_000
  while (!log.includes("streaming") && Date.now() < deadline) await Bun.sleep(5)
  expect(log).toContain("streaming")
  return session
}

/** A chat whose first reply says nothing, so its turn's logical end is
 *  followed by the request of the reply nudge, which streams until it is cut. */
async function nudgingChat(log: string[]): Promise<ChatRunner> {
  const session = await scriptedChat(log, "silent")
  const deadline = Date.now() + 2_000
  while (!log.includes("nudge-streaming") && Date.now() < deadline) await Bun.sleep(5)
  expect(log).toContain("nudge-streaming")
  return session
}

async function scriptedChat(log: string[], first: FirstReply, updateEntry?: ChatSessionDeps["updateEntry"]): Promise<ChatRunner> {
  const facts = createSessionFactWriter()
  const sessionEventWriter: SessionFactWriter = {
    ...facts,
    record: async (fact, contentRows, inFlight) => {
      log.push(fact.type === "agent_input.withdrawn" ? `withdrawn:${JSON.stringify(fact.payload)}` : fact.type)
      return facts.record(fact, contentRows, inFlight)
    },
  }
  const treeWriter = makeMemoryTreeWriter()
  let requests = 0
  const createClient = async () => asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools(options: StreamOptions) {
      const request = requests++
      if (first === "silent" && request === 1) {
        log.push("nudge-streaming")
        await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
        return
      }
      // Only the first request asks; any later one would mean the question
      // did not park the turn, and waits to be cut rather than spinning.
      if (request > 0) {
        log.push("unexpected-request")
        await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
        return
      }
      if (first === "streams") {
        yield { kind: "text_delta", text: "Working.", blockKey: "b0" } as const
        log.push("streaming")
        await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
        return
      }
      if (first === "silent") {
        yield { kind: "done", stopReason: "end_turn" } as const
        return
      }
      if (first === "answers") {
        yield { kind: "text_delta", text: "Done.", blockKey: "b0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
        return
      }
      yield { kind: "text_delta", text: "One decision is needed.", blockKey: "b0" } as const
      yield { kind: "tool_use", toolCall: { id: ASK_ID, name: "ask_user", input: { context: "One decision is needed before this continues.", question: "Proceed?", header: "Go", options: [{ label: "Yes" }, { label: "No" }] } } } as const
      yield { kind: "done", stopReason: "tool_use" } as const
    },
  })
  const defaults = createTestChatSessionDeps({ sessionId: "asking-chat", createAgent: () => { throw new Error("replaced below") } })
  const eventBus = new EventBus()
  eventBus.subscribeToType("agent.turn.parked", () => { log.push("turn-parked") }, { deliveryClass: "ui", label: "test-turn-parked" })
  const session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
    sessionId: "asking-chat",
    createAgent: (options) => newTestRunner(options, createClient),
    eventBus,
    ...(updateEntry ? { updateEntry } : {}),
    infra: { ...defaults.infra, sessionEventWriter },
    treeWriter: {
      ...treeWriter,
      async commitTurnEnd(by: PausedBy) {
        log.push(`turn-end:${by}`)
        return treeWriter.commitTurnEnd(by)
      },
    },
  }))
  void session.send(first === "asks" ? "Ask me before continuing" : "Answer and stop")
  return session
}

describe("a chat turn parked on a question", () => {
  let session: ChatRunner | null = null
  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it("is not running work for a planned replacement's cut: the cut leaves it, and nothing is withdrawn or recorded", async () => {
    const log: string[] = []
    session = await askingChat(log)
    expect(session.holdsRunningTurn()).toBe(false)
    expect(await session.interruptForReplacement()).toBe(false)
    expect(log.some((entry) => entry.startsWith("withdrawn:"))).toBe(false)
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual([])
  })

  it("that a person already interrupted is left parked for the person: the replacement neither waits on it nor records over it", async () => {
    const log: string[] = []
    session = await askingChat(log)
    expect(session.interrupt()).toBe(true)
    // A cut that waited on the parked turn would never settle, and the test would time out.
    expect(await session.interruptForReplacement()).toBe(false)
    expect(log).not.toContain("turn-end:replacement")
  })

  it.each(["replacement", "runtime"] as const)("keeps its question through a stop as %s, for the person to answer after the restart", async (by) => {
    const log: string[] = []
    const blocks = captureBlocks()
    session = await askingChat(log, blocks.updateEntry)
    session.prepareForShutdown(by)
    await session.dispose()
    session = null
    expect(log.some((entry) => entry.startsWith("withdrawn:"))).toBe(false)
    expect(log).not.toContain("agent_input.cancelled")
    expect(log).not.toContain("agent_input.answered")
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual([])
    const question = blocks.blocks().find((block) => block.kind === "question" && block.toolUseId === ASK_ID)
    expect(question).toBeDefined()
    expect(question).not.toHaveProperty("answers")
    expect(question).not.toHaveProperty("cancelled")
    expect(blocks.blocks().filter((block) => block.kind === "system" && block.message.startsWith("Interrupted"))).toEqual([])
  })
})

describe("a chat whose turn has answered", () => {
  it("gets nothing written by an ordinary stop: no turn end, no interrupt", async () => {
    const log: string[] = []
    const session = await answeredChat(log)
    session.prepareForShutdown("runtime")
    await session.dispose()
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual([])
    expect(log).not.toContain("unexpected-request")
  })
})

describe("a chat whose silent reply drew the reply nudge", () => {
  let session: ChatRunner | null = null
  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  // The turn's logical end is reported before the nudge's request, so only
  // the runner can say that the turn still runs.
  it("holds its running turn while the nudge's request streams, and a planned replacement's cut ends that turn as the planned cut", async () => {
    const log: string[] = []
    session = await nudgingChat(log)
    expect(session.holdsRunningTurn()).toBe(true)
    expect(await session.interruptForReplacement()).toBe(true)
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual(["turn-end:replacement"])
    expect(session.holdsRunningTurn()).toBe(false)
  })
})

describe("a streaming chat turn", () => {
  let session: ChatRunner | null = null
  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it("that the planned cut ended takes a person's interrupt over the cut, recorded and shown as theirs; while it runs, only the ordinary interrupt applies", async () => {
    const log: string[] = []
    const blocks = captureBlocks()
    session = await streamingChat(log, blocks.updateEntry)
    expect(await session.interruptPlannedCut("person")).toBe("running")
    expect(await session.interruptForReplacement()).toBe(true)

    expect(await session.interruptPlannedCut("person")).toBe("recorded")
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual(["turn-end:replacement", "turn-end:person"])
    expect(blocks.blocks()).toContainEqual(expect.objectContaining({ kind: "system", message: "Interrupted" }))
  })

  it("that the planned cut ended answers a person's interrupt with ended once a stop has ended its runner, and records nothing, so its caller records the person's turn end", async () => {
    const log: string[] = []
    const runner = await streamingChat(log, captureBlocks().updateEntry)
    expect(await runner.interruptForReplacement()).toBe(true)

    await runner.dispose()

    expect(await runner.interruptPlannedCut("person")).toBe("ended")
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual(["turn-end:replacement"])
  })

  const stops: { by: RuntimeInterruption; turnEnds: string[]; shown: string[] }[] = [
    { by: "replacement", turnEnds: ["turn-end:replacement"], shown: [] },
    { by: "runtime", turnEnds: ["turn-end:runtime"], shown: ["Interrupted by the runtime"] },
  ]
  it.each(stops)("that a stop ends as $by records that turn end and shows the interruptions $shown: a stop a planned replacement owns shows none", async ({ by, turnEnds, shown }) => {
    const log: string[] = []
    const blocks = captureBlocks()
    session = await streamingChat(log, blocks.updateEntry)
    session.prepareForShutdown(by)
    await session.dispose()
    session = null
    expect(log.filter((entry) => entry.startsWith("turn-end:"))).toEqual(turnEnds)
    expect(blocks.blocks().flatMap((block) => block.kind === "system" && block.message.startsWith("Interrupted") ? [block.message] : [])).toEqual(shown)
  })
})
