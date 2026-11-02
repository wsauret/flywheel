import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Exit } from "effect"
import { DebugLog, type DebugLogRecordInput } from "../../../../src/infra/debug-log.js"
import { isRecord } from "../../../../src/infra/record.js"
import { createAssistantMessageSettlement } from "../../../../src/orchestration/agent-runtime/assistant-message-settlement.js"
import type { AssistantTurnResult, TurnOutcome } from "../../../../src/orchestration/agent-runtime/assistant-turn-result.js"
import { AgentAborted } from "../../../../src/orchestration/agent-runtime/errors.js"
import type { ContentBlock } from "../../../../src/orchestration/agent-runtime/llm/types.js"

function turn(outcome: TurnOutcome): AssistantTurnResult {
  return {
    outcome,
    assistantContent: [{ type: "text", text: "step-4 is running" }],
    toolCalls: [],
    assistantMetadata: undefined,
    lastAssistantMetadata: undefined,
    usageAnchor: undefined,
    terminalEvent: undefined,
    transportContext: undefined,
  }
}

const records: DebugLogRecordInput[] = []
beforeEach(async () => {
  records.length = 0
  await DebugLog.forward((record) => { records.push(record) })
})
afterEach(async () => { await DebugLog.close() })

interface Pushed {
  readonly content: readonly ContentBlock[]
  readonly incomplete: true | undefined
}

function settle(outcome: TurnOutcome) {
  const pushed: Pushed[] = []
  const commit = createAssistantMessageSettlement({
    interruptSignal: new AbortController().signal,
    observedCalls: () => [],
    pushAssistant: (content, _metadata, incomplete) => { pushed.push({ content, incomplete }) },
  })
  return { pushed, done: commit(Exit.succeed(turn(outcome))) }
}

const warnings = (): unknown[] => records
  .filter((record) => record.type === "log.warn" || record.type === "log.error")
  .map((record) => isRecord(record.payload) ? record.payload.message : undefined)

describe("assistant message settlement", () => {
  test("partial settlement retains text on both sides of its original tool boundary", async () => {
    const call = { id: "call", name: "read", input: { path: "file.ts" } };
    const content: ContentBlock[] = [
      { type: "text", text: "before" },
      { type: "tool_use", ...call },
      { type: "text", text: "after" },
    ];
    const pushed: ContentBlock[][] = [];
    const commit = createAssistantMessageSettlement({
      interruptSignal: new AbortController().signal,
      observedCalls: () => [call],
      pushAssistant: (parts) => { pushed.push(parts) },
    });
    await commit(Exit.succeed({ ...turn({ kind: "aborted" }), assistantContent: content, toolCalls: [call] }));
    expect(pushed).toEqual([content]);
  })
  test("an interrupted turn keeps its partial output for the resume and records no warning", async () => {
    const { pushed, done } = settle({ kind: "aborted" })
    await done
    expect(pushed).toEqual([{ content: [{ type: "text", text: "step-4 is running" }], incomplete: true }])
    expect(warnings()).toEqual([])
  })

  test("a provider that failed mid-turn keeps its partial output and records the failure", async () => {
    const { pushed, done } = settle({ kind: "stream_error", error: new AgentAborted() })
    await done
    expect(pushed).toEqual([{ content: [{ type: "text", text: "step-4 is running" }], incomplete: true }])
    expect(warnings()).toEqual(["provider failed mid-turn, persisting partial output for resume"])
  })
})
