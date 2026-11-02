import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "node:os"
import { DebugLog, type DebugLogRecordInput } from "../../../../src/infra/debug-log.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream.js"
import { withStreamAttempt } from "../../../../src/orchestration/agent-runtime/llm/stream-attempt.js"
import { stableSystemPrompt, type SystemPromptTiers } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { FUNCTION_TOOL_PRESENTATION, type CacheRetention, type Claim, type LLMClient, type ProviderStreamEvent, type ServingAttempt, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"
import { PREFIX_HOLD_CAP_MS, PREFIX_WARM_MS, PromptPrefixHold, type PrefixHoldClock } from "../../../../src/orchestration/agent-runtime/prompt-prefix-hold.js"
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { fixedRequestToolSurface, RequestToolMap } from "../../../helpers/request-tool-surface.js"
import { asModelClient, ownHistoryTarget } from "./_model-client.js"

/** A clock whose sleeps resolve only when the test advances it. */
function fakeClock() {
  let now = 0
  const sleepers = new Set<{ at: number; resolve: () => void }>()
  const clock: PrefixHoldClock = {
    now: () => now,
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      const sleeper = { at: now + ms, resolve }
      sleepers.add(sleeper)
      signal.addEventListener("abort", () => { sleepers.delete(sleeper); reject(signal.reason) }, { once: true })
    }),
  }
  return {
    clock,
    async advance(ms: number) {
      now += ms
      for (const sleeper of sleepers) if (sleeper.at <= now) { sleepers.delete(sleeper); sleeper.resolve() }
      await settle()
    },
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Bun.sleep(0)
}

interface Tracked<T> {
  settled: boolean
  value: T | undefined
}

function tracked<T>(promise: Promise<T>): Readonly<Tracked<T>> {
  const state: Tracked<T> = { settled: false, value: undefined }
  void promise.then((value) => { state.settled = true; state.value = value })
  return state
}

let records: DebugLogRecordInput[] = []
let recordSpy: ReturnType<typeof spyOn<typeof DebugLog, "record">> | undefined
beforeEach(() => {
  records = []
  recordSpy = spyOn(DebugLog, "record").mockImplementation((entry) => { records.push(entry) })
})
afterEach(() => { recordSpy?.mockRestore() })

describe("prompt prefix hold", () => {
  test("the leader runs at once and its followers run at its first response", async () => {
    const { clock, advance } = fakeClock()
    const hold = new PromptPrefixHold(clock)
    const leader = await hold.enter("prefix-a")
    expect(leader.leader).toBe(true)
    const first = tracked(hold.enter("prefix-a"))
    const second = tracked(hold.enter("prefix-a"))
    await advance(120)
    expect(first.settled).toBe(false)
    expect(second.settled).toBe(false)

    leader.responded()
    await settle()
    expect(first.value).toMatchObject({ leader: false, waitedMs: 120 })
    expect(second.value).toMatchObject({ leader: false, waitedMs: 120 })
    expect(records.map((record) => record.type)).toEqual(["model.prefix_hold.settled"])
    expect(records[0]?.payload).toEqual({
      prefix: "prefix-a", releasedBy: "response", leaderResponseMs: 120, followers: 2,
      releasedByResponse: 2, releasedByCap: 0, releasedByLeaderEnd: 0, aborted: 0, maxWaitMs: 120, totalWaitMs: 240,
    })

    // A warm key holds nobody, and it turns cold once its window ends.
    expect(await hold.enter("prefix-a")).toMatchObject({ leader: false, waitedMs: 0 })
    await advance(PREFIX_WARM_MS)
    expect((await hold.enter("prefix-a")).leader).toBe(true)
  })

  test("the cap releases a follower whose leader has not responded", async () => {
    const { clock, advance } = fakeClock()
    const hold = new PromptPrefixHold(clock)
    const leader = await hold.enter("prefix-a")
    const follower = tracked(hold.enter("prefix-a"))
    await advance(PREFIX_HOLD_CAP_MS - 1)
    expect(follower.settled).toBe(false)
    await advance(1)
    expect(follower.value).toMatchObject({ leader: false, waitedMs: PREFIX_HOLD_CAP_MS })
    expect(records).toEqual([])

    leader.responded()
    expect(records[0]?.payload).toMatchObject({ releasedBy: "response", followers: 1, releasedByCap: 1, maxWaitMs: PREFIX_HOLD_CAP_MS })
  })

  test("a leader that ends before any response releases its followers", async () => {
    const { clock, advance } = fakeClock()
    const hold = new PromptPrefixHold(clock)
    const leader = await hold.enter("prefix-a")
    const follower = tracked(hold.enter("prefix-a"))
    await advance(40)
    leader.done()
    await settle()
    expect(follower.value).toMatchObject({ leader: false, waitedMs: 40 })
    expect(records[0]?.payload).toMatchObject({ releasedBy: "leader_ended", leaderResponseMs: null, releasedByLeaderEnd: 1 })
    // The failed leader warmed nothing, so the next request leads again.
    expect((await hold.enter("prefix-a")).leader).toBe(true)
  })

  test("requests with different keys never wait, and an aborted follower stops waiting", async () => {
    const { clock } = fakeClock()
    const hold = new PromptPrefixHold(clock)
    await hold.enter("prefix-a")
    expect(await hold.enter("prefix-b")).toMatchObject({ leader: true, waitedMs: 0 })
    const abort = new AbortController()
    const follower = tracked(hold.enter("prefix-a", abort.signal))
    await settle()
    expect(follower.settled).toBe(false)
    abort.abort()
    await settle()
    expect(follower.value).toMatchObject({ leader: false })
  })
})

function attempt(): ServingAttempt {
  return {
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  }
}

/** A provider that answers each request only when the test opens it, and
 *  records the order in which requests reached it. Like every native adapter,
 *  it runs its stream inside `withStreamAttempt`, which announces the attempt
 *  before the request goes out. */
function gatedProvider(route: Partial<ServingAttempt> = {}, behavior: { readonly lateClaims?: boolean; readonly failing?: ReadonlySet<string> } = {}) {
  const started: string[] = []
  const gates = new Map<string, () => void>()
  const anticipated: StreamOptions[] = []
  const streamed: StreamOptions[] = []
  /** The sibling of each claim that its owner released, in order. */
  const released: string[] = []
  /** The resolve of each claim that resolves only when the test says so (`lateClaims`). */
  const lateClaims = new Map<string, () => void>()
  const client = asModelClient({ historyTarget: ownHistoryTarget,
    ...attempt(),
    ...route,
    anticipate(options) {
      anticipated.push(options)
      const sibling = options.providerSessionKey ?? "?"
      const claim: Claim = { release: async () => { released.push(sibling) } }
      if (behavior.lateClaims !== true) return Promise.resolve(claim)
      return new Promise<Claim>((resolve) => { lateClaims.set(sibling, () => { resolve(claim) }) })
    },
    streamWithTools(options): AsyncGenerator<ProviderStreamEvent> {
      streamed.push(options)
      return withStreamAttempt<ProviderStreamEvent>(async function* () {
        const sibling = options.providerSessionKey ?? "?"
        started.push(sibling)
        await new Promise<void>((resolve) => { gates.set(sibling, resolve) })
        if (behavior.failing?.has(sibling) === true) throw new Error(`request ${sibling} failed`)
        yield { kind: "provider_response_started" }
        yield { kind: "text_delta", text: "ok", blockKey: "text-0" }
        yield { kind: "done", stopReason: "end_turn" }
      }, {})
    },
  } satisfies LLMClient)
  return { client, started, anticipated, streamed, released, open: (sibling: string) => gates.get(sibling)?.(), resolveClaim: (sibling: string) => lateClaims.get(sibling)?.() }
}

function siblingTurn(provider: ReturnType<typeof gatedProvider>, sibling: string, hold: PromptPrefixHold, systemPrompt: SystemPromptTiers, cacheRetention: CacheRetention | undefined = "1h", tools: StreamOptions["tools"] = [], promptCacheKey = "tree") {
  return streamAssistantTurn({
    client: provider.client, executionCwd: "/scratch", interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
    messages: [{ kind: "user", content: `item ${sibling}` }], tools, systemPrompt,
    reasoningEffort: undefined, signal: undefined, cacheRetention, providerSessionKey: sibling, promptCacheKey, providerOptions: undefined,
    requestAudit: undefined, staleMasking: undefined, requestContext: undefined, turn: 1, messageCount: 1,
    estimatedContextTokens: 10, onEvent: () => {}, prefixHold: hold,
  })
}

describe("workflow step requests at the admission seam", () => {
  const shared = stableSystemPrompt("shared step prefix")

  test("a sibling with the same prefix reaches the provider only after the leader's first response", async () => {
    const provider = gatedProvider()
    const hold = new PromptPrefixHold()
    const leader = siblingTurn(provider, "a", hold, shared)
    const follower = siblingTurn(provider, "b", hold, shared)
    await settle()
    expect(provider.started).toEqual(["a"])
    provider.open("a")
    await leader
    await settle()
    expect(provider.started).toEqual(["a", "b"])
    provider.open("b")
    await follower
  })

  test("a request that enters the hold tells its client the request before it waits, so the client can start what it needs", async () => {
    const provider = gatedProvider()
    const hold = new PromptPrefixHold()
    const leader = siblingTurn(provider, "a", hold, shared)
    const follower = siblingTurn(provider, "b", hold, shared)
    await settle()
    // The follower waits for the leader, and its client already knows what it will send.
    expect(provider.started).toEqual(["a"])
    expect(provider.anticipated.map((options) => options.providerSessionKey)).toEqual(["a", "b"])
    provider.open("a")
    await leader
    await settle()
    provider.open("b")
    await follower
    const request = ({ signal: _signal, telemetry: _telemetry, onDispatch: _dispatch, ...rest }: StreamOptions) => rest
    expect(provider.anticipated.map(request)).toEqual(provider.streamed.map(request))

    // A request that never enters the hold never waits, so it tells its client nothing ahead.
    const uncached = gatedProvider()
    const plain = siblingTurn(uncached, "c", hold, shared, "none")
    await settle()
    uncached.open("c")
    await plain
    expect(uncached.anticipated).toEqual([])
  })

  test("a request that entered the hold releases its anticipation's claim when it settles, whether it succeeded or failed", async () => {
    const provider = gatedProvider({}, { failing: new Set(["b"]) })
    const hold = new PromptPrefixHold()
    const leader = siblingTurn(provider, "a", hold, shared)
    const follower = siblingTurn(provider, "b", hold, shared).then(() => "settled", () => "failed")
    await settle()
    expect(provider.released).toEqual([])
    provider.open("a")
    await leader
    await settle()
    expect(provider.released).toEqual(["a"])
    provider.open("b")
    await follower
    await settle()
    expect(provider.released).toEqual(["a", "b"])
  })

  test("a claim that resolves after its request settled is released on arrival", async () => {
    const provider = gatedProvider({}, { lateClaims: true })
    const hold = new PromptPrefixHold()
    const turn = siblingTurn(provider, "a", hold, shared)
    await settle()
    provider.open("a")
    await turn
    await settle()
    expect(provider.released).toEqual([])
    provider.resolveClaim("a")
    await settle()
    expect(provider.released).toEqual(["a"])
  })

  test("siblings with different prefixes or tool surfaces, or with caching disabled, start together", async () => {
    const differing = gatedProvider()
    const hold = new PromptPrefixHold()
    const turns = [siblingTurn(differing, "a", hold, shared), siblingTurn(differing, "b", hold, stableSystemPrompt("another step"))]
    await settle()
    expect(differing.started).toEqual(["a", "b"])
    differing.open("a"); differing.open("b")
    await Promise.all(turns)

    const differentTools = gatedProvider()
    const toolsHold = new PromptPrefixHold()
    const toolTurns = [
      siblingTurn(differentTools, "a", toolsHold, shared),
      siblingTurn(differentTools, "b", toolsHold, shared, "1h", [{ name: "probe", description: "probe tool", input_schema: { type: "object", properties: {} } }]),
    ]
    await settle()
    expect(differentTools.started).toEqual(["a", "b"])
    differentTools.open("a"); differentTools.open("b")
    await Promise.all(toolTurns)

    const uncached = gatedProvider()
    const uncachedTurns = [siblingTurn(uncached, "a", hold, shared, "none"), siblingTurn(uncached, "b", hold, shared, "none")]
    await settle()
    expect(uncached.started).toEqual(["a", "b"])
    uncached.open("a"); uncached.open("b")
    await Promise.all(uncachedTurns)
  })

  /** Two siblings of one session: equal stable tiers, and session tiers that
   *  are equal unless `sessions` says otherwise. */
  async function startOrder(route: Partial<ServingAttempt>, sessions: readonly [string, string] = ["step", "step"], cacheKeys: readonly [string, string] = ["tree", "tree"]) {
    const provider = gatedProvider(route)
    const hold = new PromptPrefixHold()
    const turns = (["a", "b"] as const).map((sibling, index) =>
      siblingTurn(provider, sibling, hold, { stable: "shared stable tier", session: sessions[index] ?? "", conversation: `notes of ${sibling}` }, "1h", [], cacheKeys[index]))
    await settle()
    const order = [...provider.started]
    provider.open("a")
    await settle()
    provider.open("b")
    await Promise.all(turns)
    return order
  }

  test("a route that keys no cache by conversation holds the sibling of another conversation", async () => {
    // Gemini and Chat Completions routes cache by byte prefix and send no
    // per-conversation cache key, so lanes of different conversations share.
    expect(await startOrder({ accessProvider: "google_api", modelFamily: "google" })).toEqual(["a"])
  })

  test("a route whose cache routing reads the prompt-cache key holds the siblings of one tree and never a request of another tree", async () => {
    expect(await startOrder({ sharedPromptPrefix: "cache-key" })).toEqual(["a"])
    expect(await startOrder({ sharedPromptPrefix: "cache-key" }, ["step", "step"], ["tree", "another tree"])).toEqual(["a", "b"])
  })

  test("a route that caches the session tier with the conversation tier keys the hold on the stable tier only", async () => {
    expect(await startOrder({ sharedPromptPrefix: "stable" }, ["task one", "task two"])).toEqual(["a"])
    expect(await startOrder({}, ["task one", "task two"])).toEqual(["a", "b"])
  })
})

test("a workflow step enters the hold only for the first request of its run", async () => {
  // A workflow agent is held once, when it starts. A later request
  // carries the step's own messages, so no sibling can share its prefix.
  const responses: ProviderStreamEvent[][] = [
    [{ kind: "tool_use", toolCall: { id: "probe-1", name: "probe", input: {} } }, { kind: "done", stopReason: "tool_use" }],
    [{ kind: "text_delta", text: "done", blockKey: "text-0" }, { kind: "done", stopReason: "end_turn" }],
  ]
  let requests = 0
  const client = asModelClient({ historyTarget: ownHistoryTarget,
    ...attempt(),
    async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
      yield* responses[requests++] ?? []
    },
  } satisfies LLMClient)
  const probe: RuntimeTool = {
    name: "probe", action: "ui_meta", description: "probe tool", inputSchema: { type: "object", properties: {} },
    isConcurrencySafe: true, execute: async () => ({ content: "ran", outcome: "ok" }),
  }
  const entered: string[] = []
  class CountingHold extends PromptPrefixHold {
    override async enter(key: string, signal?: AbortSignal) {
      entered.push(key)
      return super.enter(key, signal)
    }
  }

  await runAgentLoop({
    client,
    tools: await fixedRequestToolSurface(new RequestToolMap([[probe.name, probe]])),
    systemPrompt: () => stableSystemPrompt("test"),
    promptPrefixHold: new CountingHold(),
    instruction: "work",
    executionCwd: tmpdir(),
    userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
    providerSessionKey: "prefix-hold", promptCacheKey: "prefix-hold", artifactScopeId: "prefix-hold", retrievalSessionId: "prefix-hold",
    persistence: { history: { append: () => {} } },
    seed: { kind: "fresh" },
    onEvent: () => {},
  })

  expect(requests).toBe(2)
  expect(entered).toHaveLength(1)
})
