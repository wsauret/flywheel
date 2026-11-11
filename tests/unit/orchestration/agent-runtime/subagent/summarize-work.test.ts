import { describe, expect, it, spyOn } from "bun:test";

import {
  MIN_RECORDS_FOR_LLM_SUMMARY,
  summarizeSubagentWork,
  type SummarizeSubagentWorkInput,
} from "../../../../../src/orchestration/modules/subagents/execution/summarize-work.js";
import type { SubagentToolCallRecord } from "../../../../../src/orchestration/modules/subagents/execution/work-log.js";
import type { ModelClient, ProviderStreamEvent, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { renderSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { asModelClient } from "../_model-client.js";
import { failureSummaryInput } from "./_fixtures.js";
import { checkpointTestPersistences } from "../../../../helpers/checkpoint-store.js";

const persistence = checkpointTestPersistences();

interface UnknownRecord { [key: string]: unknown }

const sampleRecord = (toolName: string, input: UnknownRecord = {}): SubagentToolCallRecord => ({
  toolName,
  input,
  status: "done",
});

function makeMockClient(emitText: string, capture?: (options: StreamOptions) => void): ModelClient {
  return asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "claude-haiku-test",
    contextLimit: 200_000,
    outputLimit: 8_192,
    supportsReasoning: false,
    availableModels: undefined,
    async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      capture?.(options);
      yield { kind: "text_delta", text: emitText, blockKey: "text" };
      yield { kind: "done", stopReason: "end_turn" };
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  });
}

const enoughRecords = (count: number): SubagentToolCallRecord[] =>
  Array.from({ length: count }, (_, i) => sampleRecord(i % 2 === 0 ? "read" : "edit", { path: `f${i}.ts` }));

function summaryInput(client: () => Promise<ModelClient>, overrides: Partial<SummarizeSubagentWorkInput> = {}) {
  return failureSummaryInput(persistence({ kind: "session", sessionId: "child" }), client, { records: enoughRecords(MIN_RECORDS_FOR_LLM_SUMMARY), ...overrides });
}

describe("summarizeSubagentWork", () => {
  it("bounds client acquisition by the summary deadline, and the summary's run still settles once the late client arrives", async () => {
    const client = Promise.withResolvers<ModelClient>();
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const input = summaryInput(() => client.promise);
      const result = summarizeSubagentWork(input);
      await new Promise((resolve) => setImmediate(resolve));
      expect(await Promise.race([result, Promise.resolve("pending")])).toBe("pending");
      deadline.abort();
      expect(await result).toContain("## Work completed before error");
      client.resolve(makeMockClient('{"summary":"late"}'));
      expect((await input.runners[0]!.done).terminal.kind).toBe("aborted");
    } finally {
      deadline.abort();
      client.resolve(makeMockClient('{"summary":"late"}'));
      timeout.mockRestore();
    }
  });

  it("returns deterministic fallback below the LLM threshold without starting a run", async () => {
    const result = await summarizeSubagentWork(summaryInput(async () => makeMockClient(""), {
      records: enoughRecords(MIN_RECORDS_FOR_LLM_SUMMARY - 1),
      createRunner: () => { throw new Error("below the threshold no run starts"); },
    }));
    expect(result).toContain("## Work completed before error");
    expect(result).toContain("**Files read:**");
    expect(result).toContain("f0.ts");
  });

  it("uses LLM summary when JSON parses cleanly", async () => {
    expect(await summarizeSubagentWork(summaryInput(async () => makeMockClient(`{"summary":"hit the limit while editing"}`)))).toBe("hit the limit while editing");
  });

  it("extracts JSON from a fenced response", async () => {
    expect(await summarizeSubagentWork(summaryInput(async () => makeMockClient("```json\n{\"summary\":\"fenced summary\"}\n```")))).toBe("fenced summary");
  });

  it("falls back to deterministic on malformed JSON", async () => {
    expect(await summarizeSubagentWork(summaryInput(async () => makeMockClient("not json")))).toContain("## Work completed before error");
  });

  it("falls back on missing 'summary' field", async () => {
    expect(await summarizeSubagentWork(summaryInput(async () => makeMockClient(`{"other":"value"}`)))).toContain("## Work completed before error");
  });

  it("asks with the summary contract and the work log, on the child's provider session, told to call no tools", async () => {
    const captured: StreamOptions[] = [];
    await summarizeSubagentWork(summaryInput(async () => makeMockClient(`{"summary":"ok"}`, (options) => captured.push(options)), {
      terminalError: "context_overflow: 250k tokens",
    }));
    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(renderSystemPrompt(request.systemPrompt)).toStartWith("You summarize a failed subagent run for its parent agent");
    const messages = JSON.stringify(request.messages);
    expect(messages).toContain("context_overflow: 250k tokens");
    expect(messages).toContain("<workLog>");
    expect(messages).toContain("Call no tools. Every tool call is refused; answer in text.");
    expect(request.providerSessionKey).toBe("child-conversation");
    expect(request.tools.length).toBeGreaterThan(0);
  });

  it("returns 'No tool calls' on empty records", async () => {
    const result = await summarizeSubagentWork(summaryInput(async () => makeMockClient(`{"summary":"unused"}`), { records: [] }));
    expect(result).toContain("No tool calls completed");
  });
});
