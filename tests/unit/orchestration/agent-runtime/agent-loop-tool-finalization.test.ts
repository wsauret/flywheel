import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Scope } from "effect"

import { canonicalDirectory } from "../../../../src/infra/directory-authorities.js"
import { buildMutationEvidence, buildMutationFileEvidence } from "../../../../src/infra/mutation-evidence.js"
import type { StageSessionContentNodes } from "../../../../src/infra/session-content.js"
import { asRecord } from "../../../../src/infra/record.js"
import { createTurnDispatcher } from "../../../../src/orchestration/agent-runtime/agent-loop-tools.js"
import { readDefinition } from "../../../../src/orchestration/agent-runtime/tools/read.js"
import { fixedTurnOutputBound } from "../../../../src/orchestration/agent-runtime/compaction/compaction-policy.js"
import { settleTurn } from "../../../../src/orchestration/agent-runtime/agent-turn-settlement.js"
import type { StreamEvent, ToolCall } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { RuntimeTool, ToolContext, ToolResult } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import type { SessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { RequestToolMap } from "../../../helpers/request-tool-surface.js"
import { PersistenceWriteRefused } from "../../../../src/infra/event-store-types.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { makeCaptureClient } from "./context/_loop-fixtures.js"
import { blockedFailureRecord, describeAgentFailure } from "../../../../src/orchestration/agent-runtime/failure-message.js"

async function mutationSummary(stage: StageSessionContentNodes = async () => {}) {
  const file = await buildMutationFileEvidence({
    mutationId: "mutation-large",
    path: "large.json",
    before: { kind: "text", text: "a".repeat(40_000) },
    after: { kind: "text", text: "b".repeat(40_000) },
  }, stage)
  if (!file) throw new Error("expected changed file")
  return buildMutationEvidence([{ kind: "applied", file }], stage)
}

function makeTool(execute: RuntimeTool["execute"], name = "waiter"): RuntimeTool {
  return {
    name,
    action: "shell_exec",
    description: "Finalize a tool result",
    inputSchema: { type: "object" },
    isConcurrencySafe: false,
    execute,
  }
}

// Finalization spills large results under the project root's `.flywheel`
// directory, so each context gets its own project root that the test removes.
const temporaryDirectory = temporaryDirectories()

function makeContext(): ToolContext {
  const root = canonicalDirectory(temporaryDirectory("flywheel-tool-finalization-"), "test project root")
  return {
    executionCwd: root,
    artifactScopeId: "test-session",
    retrievalSessionId: "test-session",
    userDataRoot: `${root}/.test-account`, projectRoot: root,
  }
}

function harness(tools: RuntimeTool | readonly RuntimeTool[], toolContext = makeContext()) {
  const events: StreamEvent[] = []
  const turnScope = Scope.makeUnsafe()
  const onEvent = (event: StreamEvent): void => { events.push(event) }
  const dispatcher = createTurnDispatcher({
    tools: new RequestToolMap((Array.isArray(tools) ? tools : [tools]).map((tool) => [tool.name, tool])),
    executionAdmission: () => ({ ok: true }),
    toolContext,
    signal: undefined,
    background: undefined,
    turnScope,
    afterToolCall: undefined,
    onEvent,
    artifactScopeId: "test-session",
    outputBound: fixedTurnOutputBound(undefined),
  })
  const settleExit = async (...calls: ToolCall[]) => {
    try {
      return await Effect.runPromiseExit(settleTurn({
        dispatcher,
        stream: () => Promise.resolve(),
        commitAssistant: () => calls,
        commitAssistantBarrier: async () => {},
        commitResults: async () => {},
        commitDisplayBarrier: async () => {},
        onEvent,
        publishTerminal: () => {},
        publishSettlement: () => {},
      }))
    } finally {
      await Effect.runPromise(Scope.close(turnScope, Exit.void))
    }
  }
  return {
    events,
    onToolUse: dispatcher.onToolUse,
    settleExit,
    settle: async (call: ToolCall) => {
      const exit = await settleExit(call)
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
      return exit.value.batch
    },
  }
}

describe("tool result finalization", () => {
  it("does not publish an available result when its settled-file checkpoint is refused", async () => {
    const error = new PersistenceWriteRefused(129, 128)
    const mutationEvidence = await mutationSummary()
    const writer: SessionFactWriter = {
      record: async () => null, recordBatch: async () => [],
      recordGuarded: async () => null, transaction: async (fn) => { fn() }, dispose() {},
      putInFlight: async () => { throw error },
    }
    const tool = makeTool(async () => ({ content: "done", outcome: "ok", details: { mutationEvidence } }), "write")
    const turn = harness(tool, { ...makeContext(), conversationId: "c", sessionEventWriter: writer, flushCanonicalMessages: async () => {} })
    const call = { id: "failed-save", name: "write", input: {} }
    turn.onToolUse(call)
    await expect(turn.settle(call)).rejects.toThrow(error.message)
    expect(error.stage).toBe("final-result")
    expect(turn.events.some(event => event.kind === "tool_result_available")).toBe(false)
  })

  it("fails the turn with a typed refusal when a result save is refused while an earlier call still runs", async () => {
    const error = new PersistenceWriteRefused(13_268_930, 8_388_608)
    let releaseEarlier = () => {}
    const earlierRunning = new Promise<void>((resolve) => { releaseEarlier = resolve })
    const writer: SessionFactWriter = {
      record: async () => null, recordBatch: async () => [],
      recordGuarded: async () => null, transaction: async (fn) => { fn() }, dispose() {},
      putInFlight: async (_kind, key) => {
        if (!key.endsWith(":large")) return
        // The earlier call outlives the refusal by a macrotask, as a running
        // sibling bash call did when the executor died on this rejection.
        setTimeout(releaseEarlier, 5)
        throw error
      },
    }
    // bun test fails the test that was running when a rejection goes unhandled,
    // so this test also proves the refusal never escapes as one.
    const earlier = { ...makeTool(async () => { await earlierRunning; return { content: "earlier", outcome: "ok" } }, "earlier"), isConcurrencySafe: true }
    const large = { ...makeTool(async () => ({ content: "large", outcome: "ok" }), "large"), isConcurrencySafe: true }
    const turn = harness([earlier, large], { ...makeContext(), conversationId: "c", sessionEventWriter: writer, flushCanonicalMessages: async () => {} })
    const calls: ToolCall[] = [{ id: "earlier", name: "earlier", input: {} }, { id: "large", name: "large", input: {} }]
    for (const call of calls) turn.onToolUse(call)
    const exit = await turn.settleExit(...calls)

    if (Exit.isSuccess(exit)) throw new Error("expected the refused save to fail the turn")
    expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([error])
  })

  it("preserves a preparation refusal from the tool handler through its owned fiber", async () => {
    const error = new PersistenceWriteRefused(129, 128, "preparation")
    const turn = harness(makeTool(async () => { throw error }))
    const call = { id: "failed-prepare", name: "waiter", input: {} }
    turn.onToolUse(call)
    await expect(turn.settle(call)).rejects.toThrow(error.message)
    expect(turn.events.some(event => event.kind === "tool_result_available")).toBe(false)
  })
  it("emits output recovery metadata for semantic tool truncation", async () => {
    const call: ToolCall = { id: "tool_recovered", name: "waiter", input: {} }
    const tool = makeTool(async (): Promise<ToolResult> => ({
      content: "visible summary",
      fullContent: "raw line 1\nraw line 2",
      outcome: "ok",
    }))
    const turn = harness(tool)

    turn.onToolUse(call)
    await turn.settle(call)

    expect(turn.events[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: call.id,
      outcome: "ok",
      contentTruncated: true,
      originalContentBytes: 21,
      semanticOutputTruncated: true,
      byteOutputTruncated: false,
    })
    expect(turn.events[0]?.kind === "tool_result" ? turn.events[0].fullContentPath : undefined)
      .toContain(join("agent-outputs", "test-session", "waiter_"))
  })

  it("records the original evidence and path of a file the tool already retained", async () => {
    const call: ToolCall = { id: "tool_retained", name: "waiter", input: {} }
    const retainedFullContent = { path: "/scratch/bash-foreground.log", bytes: 1_300_000, sha256: "b".repeat(64) }
    const turn = harness(makeTool(async (): Promise<ToolResult> => ({ content: "head\n[... 9 lines omitted ...]\ntail", retainedFullContent, outcome: "ok" })))

    turn.onToolUse(call)
    await turn.settle(call)

    expect(turn.events[0]).toMatchObject({
      kind: "tool_result",
      contentTruncated: true,
      originalContentBytes: 1_300_000,
      originalContentSha256: "b".repeat(64),
      semanticOutputTruncated: true,
      byteOutputTruncated: false,
      fullContentPath: "/scratch/bash-foreground.log",
    })
  })

  it("byte-caps tool output above 30KB by default", async () => {
    const call: ToolCall = { id: "tool_capped", name: "waiter", input: {} }
    const tool = makeTool(async (): Promise<ToolResult> => ({ content: "x".repeat(40_000), outcome: "ok" }))
    const turn = harness(tool)

    turn.onToolUse(call)
    await turn.settle(call)

    expect(turn.events[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: call.id,
      outcome: "ok",
      contentTruncated: true,
      byteOutputTruncated: true,
    })
  })

  for (const outcome of ["ok", "error", "interrupted"] as const) {
  it(`retains reference-backed mutation evidence for ${outcome} through finalization and its durable checkpoint`, async () => {
    const mutationEvidence = await mutationSummary()
    const diagnostic = "\"\\\n\u0001é".repeat(8_000)
    const genericJson = JSON.stringify({ changedFiles: ["large.json"], diagnostic })

    let checkpoint: unknown
    const writer: SessionFactWriter = {
      record: async () => null,
      recordBatch: async () => { throw new Error("unused request audit") },
      recordGuarded: async () => null,
      transaction: async (fn) => { fn() },
      dispose: () => {},
      putInFlight: async (_kind, _key, payload) => { checkpoint = payload },
    }
    const call: ToolCall = { id: "tool_large_write", name: "write", input: {} }
    const tool = makeTool(async (): Promise<ToolResult> => ({
      content: "Wrote large.json",
      outcome,
      details: { changedFiles: ["large.json"], mutationEvidence, diagnostic },
    }), "write")
    const turn = harness(tool, {
      ...makeContext(),
      conversationId: "conversation-large-write",
      sessionEventWriter: writer,
      flushCanonicalMessages: async () => {},
    })

    turn.onToolUse(call)
    const batch = await turn.settle(call)
    const event = turn.events.find((candidate) => candidate.kind === "tool_result")

    expect(asRecord(checkpoint)?.version).toBe(2)
    const available = turn.events.find(candidate => candidate.kind === "tool_result_available")
    for (const value of [
      batch.published[0]?.details,
      event?.kind === "tool_result" ? event.details : undefined,
      available?.kind === "tool_result_available" ? available.details : undefined,
      asRecord(checkpoint)?.details,
    ]) {
      const details = asRecord(value)
      expect(details?.mutationEvidence).toEqual(mutationEvidence)
      expect(details?.mutation).toBeUndefined()
      expect(details?.truncated).toBe(true)
      expect(details?.diagnostic).toBeUndefined()
      const preview = details?.preview
      if (typeof preview !== "string") throw new Error("expected bounded details preview")
      expect(preview.length).toBeGreaterThan(0)
      // Escaping can double the stored size of a preview, so the bound applies to the encoded envelope.
      expect(Buffer.byteLength(JSON.stringify({ truncated: true, preview }))).toBeLessThanOrEqual(30_000)
      // The preview is the longest prefix that fits: one more code point would not.
      expect(genericJson.startsWith(preview)).toBe(true)
      const next = String.fromCodePoint(genericJson.codePointAt(preview.length) ?? 0)
      expect(Buffer.byteLength(JSON.stringify({ truncated: true, preview: preview + next }))).toBeGreaterThan(30_000)
    }
  })
  }

  it("classifies a canonical-message refusal after checkpointing as a local final-result failure", async () => {
    const mutationEvidence = await mutationSummary()
    const error = new PersistenceWriteRefused(129, 128)
    const checkpoints: unknown[] = []
    const writer: SessionFactWriter = {
      record: async () => null, recordBatch: async () => [],
      recordGuarded: async () => null, transaction: async fn => { fn() }, dispose() {},
      putInFlight: async (_kind, _key, payload) => { checkpoints.push(payload) },
    }
    const { client, capturedMessages } = makeCaptureClient([{ events: [
      { kind: "tool_use", toolCall: { id: "write-1", name: "write", input: {} } },
      { kind: "done", stopReason: "tool_use" },
    ] }])
    const context = makeContext()
    const events: StreamEvent[] = []
    const running = runAgentLoop({
      client, tools: new RequestToolMap([["write", makeTool(async () => ({
        content: "Wrote large.json", outcome: "ok", details: { mutationEvidence },
      }), "write")]]),
      systemPrompt: stableSystemPrompt("test"), instruction: "write the file",
      userDataRoot: `${context.projectRoot}/.test-account`, projectRoot: context.projectRoot, executionCwd: context.executionCwd,
      providerSessionKey: "final-save", promptCacheKey: "final-save", artifactScopeId: "final-save", retrievalSessionId: "final-save",
      conversationId: "conversation-final-save", sessionEventWriter: writer,
      seed: { kind: "fresh" }, completeOnIdle: {},
      persistence: { history: { append: () => {} } },
      flushCanonicalMessages: async (_pending, swaps) => {
        if (swaps?.length) throw error
      },
      onEvent: event => { events.push(event) },
    })
    await expect(running).rejects.toThrow(error.message)
    expect(checkpoints).toHaveLength(1)
    expect(error.stage).toBe("final-result")
    expect(capturedMessages).toHaveLength(1)
    expect(events.some(event => event.kind === "tool_result_available")).toBe(true)
    const notice = blockedFailureRecord(describeAgentFailure({ kind: "local_persistence_error", error }))
    expect(notice).toContain("The file changes already settled")
    expect(notice).not.toContain("provider")
  })

  it("settles a repaired read of a file over the cap as one whole-line window, uncut and with no saved output", async () => {
    const context = makeContext()
    const lines = Array.from({ length: 700 }, (_, index) => `Statement ${index + 1}: ${"x".repeat(55)}`)
    writeFileSync(join(context.projectRoot, "doc.md"), lines.join("\n"))
    const call: ToolCall = { id: "tool_read", name: "read", input: { path: "doc.md", offset: null } }
    const turn = harness(readDefinition, context)

    turn.onToolUse(call)
    await turn.settle(call)

    const event = turn.events[0]
    if (event?.kind !== "tool_result") throw new Error("expected tool result event")
    expect(event.contentTruncated).toBeUndefined()
    expect(event.fullContentPath).toBeUndefined()
    const text = event.content[0]?.type === "text" ? event.content[0].text : ""
    expect(text).toStartWith("Note: `offset` was null, so it was left out.\n1|Statement 1: ")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(30_000)
    expect(text).toMatch(/\n\(Output limit reached at line (\d+) of the requested 1-700\. Use offset=\1 to continue reading\.\)$/u)
    expect(existsSync(join(context.projectRoot, ".flywheel", "agent-outputs"))).toBe(false)
  })

  it("exempts uncappedOutput tools from the byte cap", async () => {
    const big = "x".repeat(40_000)
    const call: ToolCall = { id: "tool_uncapped", name: "step", input: {} }
    const tool: RuntimeTool = {
      ...makeTool(async (): Promise<ToolResult> => ({ content: big, outcome: "ok" }), "step"),
      uncappedOutput: true,
    }
    const turn = harness(tool)

    turn.onToolUse(call)
    await turn.settle(call)

    const event = turn.events[0]
    if (event?.kind !== "tool_result") throw new Error("expected tool result event")
    expect(event.contentTruncated).toBeUndefined()
    expect(event.content[0]).toEqual({ type: "text", text: big })
  })

  it("caps a large nested result in shared result middleware", async () => {
    const call: ToolCall = { id: "tool_nested", name: "nested_probe", input: {} }
    const tool = makeTool(async (): Promise<ToolResult> => ({
      content: [{ type: "text", text: "x".repeat(40_000) }],
      outcome: "ok",
    }), "nested_probe")
    const turn = harness(tool)

    turn.onToolUse(call)
    await turn.settle(call)

    expect(turn.events[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: call.id,
      contentTruncated: true,
      byteOutputTruncated: true,
    })
  })
})
