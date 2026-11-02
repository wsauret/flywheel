import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import type { DebugLogRecordInput } from "../../../../src/infra/debug-log.js"
import { Log } from "../../../../src/infra/log.js"
import { isRecord } from "../../../../src/infra/record.js"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import type { ModelClient } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { LLMClientFactory } from "../../../../src/orchestration/agent-runtime/factory"
import { FUNCTION_TOOL_PRESENTATION, type ProviderStreamEvent, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import { asModelClient } from "./_model-client"
import { makeOptions } from "./_runner-options"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import { capabilityAccessHolding, testGrant } from "./tools/_fixtures.js"
import { composeRealmModuleSnapshot } from "../../../../src/orchestration/modules.js"
import { ProviderRuntimeCache } from "../../../../src/orchestration/agent-runtime/provider-runtime-cache.js"
import { AllCandidatesExhaustedError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { ChatTurnMailbox } from "../../../../src/orchestration/chat/turn-mailbox.js"
import { wakeInput } from "../../../../src/infra/agent-loop-events.js"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

function makeFakeClientFactory() {
  return () => {
    throw new Error("Client should not be created in this test")
  }
}

/** Single-provider fake: every test here varies only the streamed events. */
function streamingClientFactory(streamWithTools: (options: StreamOptions) => AsyncGenerator<ProviderStreamEvent>, model = "test"): LLMClientFactory {
  return async () => asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor() { return { status: "unavailable", reason: "missing-rate-card" } },
    streamWithTools,
  })
}

function withProviderCleanup(create: LLMClientFactory, cleanup: () => Promise<void>): LLMClientFactory {
  return async (...args) => {
    const lifetime = args[3]
    if (lifetime) await Effect.runPromise(Scope.addFinalizer(lifetime.scope, Effect.promise(cleanup)))
    return create(...args)
  }
}

describe("LiveAgent RunnerPhase + Deferred", () => {
  test("send() preserves execution identity", async () => {
    const requests: StreamOptions[] = []
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
        conversation: { kind: "replay", sessionId: "execution-session", providerSessionKey: "execution-key", priorMessages: [] },
      }),
      streamingClientFactory(async function* (options) {
        requests.push(options)
        yield { kind: "done", stopReason: "end_turn" }
      }),
    )

    runner.send("hello")
    const result = await runner.done
    expect(result.terminal).toEqual({ kind: "completed" })
    expect(result.providerSessionKey).toBe(runner.providerSessionKey)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.providerSessionKey).toBe("execution-key")
  })

  test("the real runner recall tool awaits its injected conversation-search port", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ hits: [{ index: number; entryId: string; role: "user"; summary: string; snippet: string }]; totalMatches: number }>()
    let requests = 0
    let toolResult = ""
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
        runtimeSurfaces: {
          recall: async () => {
            entered.resolve()
            return release.promise
          },
        },
      }),
      streamingClientFactory(async function* (options) {
        requests += 1
        if (requests === 1) {
          yield { kind: "tool_use", toolCall: { id: "recall-1", name: "recall", input: { query: "lockneedle" } } }
          yield { kind: "done", stopReason: "tool_use" }
          return
        }
        const result = options.messages.find((message) => message.kind === "toolResult")
        toolResult = result?.kind === "toolResult"
          ? result.content.map((part) => part.type === "text" ? part.text : "").join("")
          : ""
        yield { kind: "done", stopReason: "end_turn" }
      }),
    )

    runner.send("use recall")
    await entered.promise
    let eventLoopProgressed = false
    queueMicrotask(() => { eventLoopProgressed = true })
    await Promise.resolve()
    expect(eventLoopProgressed).toBe(true)
    release.resolve({
      hits: [{ index: 0, entryId: "entry", role: "user", summary: "found", snippet: "Unique [lockneedle] survives." }],
      totalMatches: 1,
    })

    expect((await runner.done).terminal).toEqual({ kind: "completed" })
    expect(toolResult).toContain("Unique [lockneedle] survives.")
  })

  test("successful completion releases provider resources after turn finalization, before done", async () => {
    let unsubscribeCalls = 0
    const order: string[] = []
    const releasing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const cache = new ProviderRuntimeCache<ModelClient>(() => () => { unsubscribeCalls += 1 })
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(), agentsMd: "",
        lifecycle: { kind: "one-shot", onTurnEnded: async () => { await Promise.resolve(); order.push("turn finalized") } },
      }),
      withProviderCleanup(
        streamingClientFactory(async function* () { yield { kind: "done", stopReason: "end_turn" } }),
        async () => { releasing.resolve(); await release.promise; order.push("provider released") },
      ),
      cache,
    )

    runner.send("hello")
    let settled = false
    void runner.done.then(() => { settled = true })
    try {
      await Promise.race([releasing.promise, runner.done])
      expect(order).toEqual(["turn finalized"])
      expect(settled).toBe(false)
    } finally { release.resolve() }
    await runner.done
    order.push("done")
    runner.abort()

    expect(unsubscribeCalls).toBe(1)
    expect(order).toEqual(["turn finalized", "provider released", "done"])
  })

  test("releases a client that a request-time model change replaces before the replacement serves", async () => {
    let model = "model-a"
    const built: string[] = []
    const released: string[] = []
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(), agentsMd: "",
        requestSelection: () => ({ model }),
        runtimeSurfaces: { recall: async () => ({ hits: [], totalMatches: 0 }) },
      }),
      async (...args) => {
        const selected = args[0]
        built.push(selected)
        return withProviderCleanup(streamingClientFactory(async function* () {
          expect(released).toEqual(selected === "model-a" ? [] : ["model-a"])
          if (selected === "model-a") {
            model = "model-b"
            yield { kind: "tool_use", toolCall: { id: "recall-switch", name: "recall", input: { query: "switch" } } }
            yield { kind: "done", stopReason: "tool_use" }
          } else {
            yield { kind: "done", stopReason: "end_turn" }
          }
        }, selected), async () => { released.push(selected) })(...args)
      },
    )
    runner.send("switch models")
    expect((await runner.done).terminal.kind).toBe("completed")
    expect(built).toEqual(["model-a", "model-b"])
    expect(released).toEqual(["model-a", "model-b"])
  })

  test("send() on running phase is a no-op (idempotent)", async () => {
    let streamCalls = 0
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
      }),
      streamingClientFactory(async function* () {
        streamCalls++
        yield { kind: "done", stopReason: "end_turn" }
      }),
    )

    runner.send("first")
    runner.send("second") // should be no-op
    const result = await runner.done
    expect(result.terminal).toEqual({ kind: "completed" })
    // Only one stream call — the second send() did not fork a new loop
    expect(streamCalls).toBe(1)
  })

  test("abort() on idle phase completes the Deferred with AgentAborted immediately", async () => {
    const runner = newTestRunner(makeOptions(), makeFakeClientFactory())

    // Do NOT call send() — abort before starting
    runner.abort()

    const result = await runner.done
    expect(result.terminal.kind).toBe("aborted")
    expect(result.providerSessionKey).toBe(runner.providerSessionKey)
    expect(result.durationMs).toBe(0)
  })

  test("abort before start disposes its provider cache once", async () => {
    let unsubscribeCalls = 0
    const cache = new ProviderRuntimeCache<ModelClient>(() => () => { unsubscribeCalls += 1 })
    const runner = newTestRunner(makeOptions(), makeFakeClientFactory(), cache)

    runner.abort()
    await runner.done
    runner.abort()

    expect(unsubscribeCalls).toBe(1)
  })

  test("double-completion of Deferred is safe — abort racing with natural completion", async () => {
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
      }),
      streamingClientFactory(async function* () {
        // Complete immediately — race with abort
        yield { kind: "done", stopReason: "end_turn" }
      }),
    )

    runner.send("test")
    // Abort immediately — races with natural completion
    runner.abort()

    // Should not throw, regardless of which completion wins
    const result = await runner.done
    expect(["completed", "aborted"]).toContain(result.terminal.kind)
    expect(result.providerSessionKey).toBe(runner.providerSessionKey)
  })

  test("done promise resolves with AgentRunResult containing failure on error", async () => {
    let releases = 0
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
      }),
      withProviderCleanup(
        streamingClientFactory(async function* () {
          throw new AllCandidatesExhaustedError({ message: "kaboom", recovery: { kind: "none" } })
        }),
        async () => { releases += 1 },
      ),
    )

    runner.send("test")
    const result = await runner.done
    expect(result.terminal.kind).toBe("api_error")
    expect(result.providerSessionKey).toBe(runner.providerSessionKey)
    runner.abort()
    expect(releases).toBe(1)
  })

  test("rejected assembly closes acquired provider resources before done rejects", async () => {
    let releases = 0
    const runner = newTestRunner(
      makeOptions({ agentRegistry: new Map(), agentsMd: "" }),
      withProviderCleanup(async () => { throw new Error("assembly defect") }, async () => { releases += 1 }),
    )
    runner.send("test")
    await expect(runner.done).rejects.toThrow("assembly defect")
    runner.abort()
    expect(releases).toBe(1)
  })

  test("an aborted run records its completion, not a failure, however the abort surfaced", async () => {
    const records: DebugLogRecordInput[] = []
    await Log.init({ level: "INFO", forward: (record) => { records.push(record) } })
    try {
      const streamed = Promise.withResolvers<void>()
      const runner = newTestRunner(
        makeOptions({ agentRegistry: new Map(), agentsMd: "" }),
        streamingClientFactory(async function* (options) {
          streamed.resolve()
          await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
          // The provider's own teardown error surfaces from the aborted stream.
          throw new Error("stream torn down")
        }),
      )
      runner.send("test")
      await streamed.promise
      runner.abort()
      expect((await runner.done).terminal.kind).toBe("aborted")

      const runnerRecords = records.flatMap((record) => isRecord(record.payload) && record.payload.service === "agent-runner" ? [{ type: record.type, payload: record.payload }] : [])
      expect(runnerRecords.map((record) => [record.type, record.payload.message])).toEqual([["log.info", "agent runner completed"]])
      expect(runnerRecords[0]?.payload).toMatchObject({ terminal: "aborted" })
    } finally {
      await Log.closeGlobal()
    }
  })

  // A hosted provider names the end of its lifetime from this exit: an
  // interrupt is a stop, anything else is an ordinary end. A workflow stops
  // its agents through their lifecycle signal, never through abort().
  test.each([
    ["abort()", "interrupt"],
    ["the lifecycle signal", "interrupt"],
    ["an ordinary end", "normal"],
  ] as const)("the provider lifetime ends after %s as %s", async (stop, expected) => {
    const streamed = Promise.withResolvers<void>()
    const lifecycleStop = new AbortController()
    const ended = Promise.withResolvers<"interrupt" | "normal">()
    const create = streamingClientFactory(async function* (options) {
      streamed.resolve()
      if (stop !== "an ordinary end") await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
      yield { kind: "done", stopReason: "end_turn" }
    })
    const runner = newTestRunner(
      makeOptions({ agentRegistry: new Map(), agentsMd: "", lifecycle: { kind: "one-shot", signal: lifecycleStop.signal } }),
      async (...args) => {
        const lifetime = args[3]
        if (lifetime) await Effect.runPromise(Scope.addFinalizerExit(lifetime.scope, (exit) => Effect.sync(() => { ended.resolve(Exit.hasInterrupts(exit) ? "interrupt" : "normal") })))
        return create(...args)
      },
    )
    runner.send("test")
    await streamed.promise
    if (stop === "abort()") runner.abort()
    if (stop === "the lifecycle signal") lifecycleStop.abort()
    await runner.done
    expect(await ended.promise).toBe(expected)
  })

  test("abort keeps done pending until the run's own unwind really settles", async () => {
    const streamed = Promise.withResolvers<void>()
    const unwind = Promise.withResolvers<void>()
    const order: string[] = []

    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
      }),
      withProviderCleanup(streamingClientFactory(async function* () {
        streamed.resolve()
        // A worker-like external API that ignores abort: the run stays live
        // until its own unwind settles, and that is the only settlement a host
        // may act on before it disposes writers.
        await unwind.promise
        order.push("run unwound")
        yield { kind: "done", stopReason: "end_turn" }
      }), async () => { await Promise.resolve(); order.push("provider released") }),
    )

    runner.send("test")
    await streamed.promise
    void runner.done.then(() => { order.push("host finalizers") })
    runner.abort()
    await Bun.sleep(20)

    expect(order).toEqual([])

    unwind.resolve()
    const result = await runner.done
    await Bun.sleep(0)

    expect(order).toEqual(["run unwound", "provider released", "host finalizers"])
    expect(result.terminal.kind).toBe("aborted")
  })

})
describe("ordinary runtime request", () => {
  test("preserves native prompt context, recall, and managed Bash fields", async () => {
    const task = "TASK APPEARS EXACTLY ONCE";
    const memory = "PROJECT MEMORY (user preferences and working context for this project) [reach: project | sha256:candidate | 1% - 1/100 chars]\nCANDIDATE MEMORY";
    const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
    let request: StreamOptions | undefined;
    const runner = newTestRunner(
      makeOptions({
        model: "gpt-6-luna",
        agentsMd: "PROJECT INSTRUCTIONS",
        memorySnapshot: memory,
        conversation: { kind: "replay", priorMessages: [{ kind: "user", content: task, origin: "system" }] },
        runtimeSurfaces: { background, recall: async () => ({ hits: [] }) },
        capabilityAccess: {
          available: (capability) => capability === "bash" || capability === "background-commands" || capability === "learning",
          admit: async () => ({ ok: false, missing: [], reason: "not used" }),
        },
      }),
      streamingClientFactory(async function* (options: StreamOptions) {
        request = options;
        yield { kind: "done", stopReason: "end_turn" };
      }, "gpt-6-luna"),
    );

    try {
      runner.send(task);
      await runner.done;
      const shell = request?.tools.find((tool) => tool.name === "bash");
      expect(shell?.input_schema.properties).toHaveProperty("cwd");
      expect(shell?.input_schema.properties).toHaveProperty("background");
      expect(request?.tools.some((tool) => tool.name === "recall")).toBe(true);
      if (!request) throw new Error("expected provider request");
      const systemPrompt = renderSystemPrompt(request.systemPrompt);
      expect(systemPrompt).toContain("PROJECT INSTRUCTIONS");
      expect(systemPrompt).toContain("# Durable Memory");
      expect(systemPrompt).toContain("CANDIDATE MEMORY");
      expect(systemPrompt).toContain("- recall:");
      expect(systemPrompt).toContain("Open a run of tool work with one sentence that names the next step.");
      expect((JSON.stringify(request?.messages).match(new RegExp(task, "g")) ?? []).length).toBe(1);
    } finally {
      runner.end();
      await background.close();
    }
  });
});

  test("checks live Learning policy before using an explicit memory snapshot", async () => {
    const memory = "PROJECT MEMORY\nPINNED SNAPSHOT";
    const promptFor = async (learning: boolean, capabilityAccess: AgentOptions["capabilityAccess"]): Promise<string> => {
      let prompt = "";
      const runner = newTestRunner(
        makeOptions({
          memorySnapshot: memory,
          capabilityAccess,
          moduleSelection: () => composeRealmModuleSnapshot({ moduleIds: learning ? ["learning"] : [] }),
        }),
        streamingClientFactory(async function* (options: StreamOptions) {
          prompt = renderSystemPrompt(options.systemPrompt);
          yield { kind: "done", stopReason: "end_turn" };
        }),
      );
      runner.send("test");
      await runner.done;
      return prompt;
    };

    expect(await promptFor(false, capabilityAccessHolding([]))).not.toContain("PINNED SNAPSHOT");
    expect(await promptFor(true, capabilityAccessHolding([], testGrant("admitted review", ["learning"])))).toContain("PINNED SNAPSHOT");
    expect(await promptFor(false, capabilityAccessHolding([]))).not.toContain("Before making tool calls, send a brief preamble to the user explaining what you are about to do.");
  });

describe("prompt sources take effect at the person's message", () => {
  const directory = temporaryDirectories()

  /** Drives a chat runner through a person turn with a mid-turn write to both
   *  sources, a background turn, and a second person turn. Returns each
   *  request's source markers and the number of memory store reads. */
  async function driveTurns(start: "seeded instruction" | "queued message", overrides: Partial<AgentOptions> = {}) {
    const project = directory("runner-turn-sources-")
    writeFileSync(join(project, "AGENTS.md"), "INSTRUCTIONS V1")
    let memory = "MEMORY V1"
    let memoryReads = 0
    const learning = composeRealmModuleSnapshot({ moduleIds: ["learning"] })
    const composition = {
      ...learning,
      contributions: learning.contributions.map((entry) => entry.domain === "memory"
        ? { ...entry, value: { ...entry.value, snapshot: () => { memoryReads++; return memory } } }
        : entry),
    }
    const mailbox = new ChatTurnMailbox()
    const prompts: string[] = []
    const runner = newTestRunner(
      makeOptions({
        ...testDirectories(project),
        moduleSelection: () => composition,
        capabilityAccess: capabilityAccessHolding([], testGrant("admitted review", ["learning"])),
        lifecycle: { kind: "parkable", inputSource: mailbox },
        ...(start === "queued message" ? { conversation: { kind: "replay", priorMessages: [] } } : {}),
        ...overrides,
      }),
      streamingClientFactory(async function* (options: StreamOptions) {
        prompts.push(renderSystemPrompt(options.systemPrompt))
        if (prompts.length === 1) {
          // Writes during the person's turn: the turn's next request keeps its prompt.
          writeFileSync(join(project, "AGENTS.md"), "INSTRUCTIONS V2")
          memory = "MEMORY V2"
          yield { kind: "tool_use", toolCall: { id: "tc_missing", name: "missing_tool", input: {} } }
          yield { kind: "done", stopReason: "tool_use" }
          return
        }
        yield { kind: "text_delta", text: "Done.", blockKey: `reply-${prompts.length}` }
        yield { kind: "done", stopReason: "end_turn" }
      }),
    )
    const parkedAfter = async (requests: number): Promise<void> => {
      for (let waited = 0; prompts.length < requests || !mailbox.parked; waited++) {
        if (waited > 200) throw new Error(`runner did not park after ${requests} requests`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    try {
      if (start === "seeded instruction") runner.send("first person message")
      else {
        // The queued-input start: the first person message is drained from the mailbox.
        mailbox.enqueueNextTurn("first person message")
        runner.send(wakeInput())
      }
      await parkedAfter(2)
      mailbox.enqueueSilentSystem("background notice")
      await parkedAfter(3)
      const readsBeforeSecondMessage = memoryReads
      mailbox.enqueueNextTurn("second person message")
      await parkedAfter(4)
      const sources = (prompt: string) => ["INSTRUCTIONS V1", "MEMORY V1", "INSTRUCTIONS V2", "MEMORY V2", "FIXED INSTRUCTIONS", "FIXED MEMORY"].filter((marker) => prompt.includes(marker))
      return { sources: prompts.map(sources), readsBeforeSecondMessage, memoryReads }
    } finally {
      runner.abort()
      await runner.done
    }
  }

  test.each(["seeded instruction", "queued message"] as const)("after a %s start, one turn keeps one prompt, a background turn keeps it, and the next person message reloads memory and AGENTS.md once", async (start) => {
    expect(await driveTurns(start)).toEqual({
      sources: [
        ["INSTRUCTIONS V1", "MEMORY V1"],
        ["INSTRUCTIONS V1", "MEMORY V1"],
        ["INSTRUCTIONS V1", "MEMORY V1"],
        ["INSTRUCTIONS V2", "MEMORY V2"],
      ],
      readsBeforeSecondMessage: 1,
      memoryReads: 2,
    })
  })

  test("an override of either source is never reloaded", async () => {
    const fixed = await driveTurns("seeded instruction", { agentsMd: "FIXED INSTRUCTIONS", memorySnapshot: "FIXED MEMORY" })

    expect(fixed).toEqual({ sources: Array.from({ length: 4 }, () => ["FIXED INSTRUCTIONS", "FIXED MEMORY"]), readsBeforeSecondMessage: 0, memoryReads: 0 })
  })
})
