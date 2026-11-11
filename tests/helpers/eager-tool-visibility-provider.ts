import OpenAI from "openai";

import { asAsyncEventWriter } from "../../src/infra/event-store-types.js";
import { createRuntimeEvent } from "../../src/infra/runtime-event-factory.js";
import { createSqliteEventStore } from "../../src/infra/sqlite-event-store.js";
import { providerModelInfo } from "../../src/infra/llm/provider-model-info.js";
import { mapRuntimeEventToSessionRuntimeFacts } from "../../src/infra/runtime-fact-mapper.js";
import { createOpenAIChatCompletionsAdapter } from "../../src/orchestration/agent-runtime/llm/openai-completions.js";
import type { LLMClient } from "../../src/orchestration/agent-runtime/llm/types.js";
import { checkpointFinalizedToolResult } from "../../src/orchestration/session/finalized-tool-result-checkpoint.js";
import { createSessionFactWriter } from "../../src/orchestration/session/session-fact-writer.js";

export const EAGER_PROVIDER_MODEL = "fixture-streaming-model";
export const EAGER_WRITE_TOOL_USE_ID = "write-call";
export const EAGER_SLOW_TOOL_USE_ID = "slow-call";
export const EAGER_INPUT_PREFIX = "streamed body ".repeat(64);
export const EAGER_INPUT_SUFFIX = "completed body ".repeat(64);
export const FINALIZED_RESULT_CRASH_MODE = "--finalized-result-crash";

interface JsonRecord { [key: string]: unknown }

function sse(data: JsonRecord): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function completionChunk(delta: JsonRecord, finishReason: string | null = null): Uint8Array {
  return sse({
    id: "fixture-response",
    object: "chat.completion.chunk",
    model: EAGER_PROVIDER_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

export interface EagerToolVisibilityProvider {
  readonly baseUrl: string;
  readonly requests: readonly JsonRecord[];
  readonly inputHeld: Promise<void>;
  releaseInput(): void;
  createClient(): Promise<LLMClient>;
  stop(): void;
}

/** Starts a loopback OpenAI Chat Completions server whose first response pauses
 * inside one unfinished write argument. Releasing it completes that argument
 * and emits a controlled sibling call in the same assistant turn. */
export function createEagerToolVisibilityProvider(): EagerToolVisibilityProvider {
  const release = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const requests: JsonRecord[] = [];
  let stopped = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: EAGER_PROVIDER_MODEL, object: "model", created: 0, owned_by: "fixture" }] });
      }
      const parsed: unknown = await request.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return Response.json({ error: { message: "expected object request" } }, { status: 400 });
      const body = Object.fromEntries(Object.entries(parsed));
      requests.push(body);

      if (requests.length > 1) {
        const stream = [
          completionChunk({ content: "fixture complete" }),
          completionChunk({}, "stop"),
          sse({ id: "fixture-response", object: "chat.completion.chunk", model: EAGER_PROVIDER_MODEL, choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }),
          new TextEncoder().encode("data: [DONE]\n\n"),
        ];
        return new Response(new ReadableStream({
          start(controller) {
            for (const chunk of stream) controller.enqueue(chunk);
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }

      return new Response(new ReadableStream({
        async start(controller) {
          const unfinishedWriteInput = JSON.stringify({ path: "fixture.txt", content: EAGER_INPUT_PREFIX }).slice(0, -2);
          controller.enqueue(completionChunk({ tool_calls: [{ index: 0, id: EAGER_WRITE_TOOL_USE_ID, type: "function", function: { name: "write", arguments: unfinishedWriteInput } }] }));
          held.resolve();
          await release.promise;
          if (stopped) return;
          controller.enqueue(completionChunk({ tool_calls: [
            { index: 0, function: { arguments: `${EAGER_INPUT_SUFFIX}"}` } },
            { index: 1, id: EAGER_SLOW_TOOL_USE_ID, type: "function", function: { name: "bash", arguments: "{\"command\":\"printf sibling\"}" } },
          ] }));
          controller.enqueue(completionChunk({}, "tool_calls"));
          controller.enqueue(sse({ id: "fixture-response", object: "chat.completion.chunk", model: EAGER_PROVIDER_MODEL, choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    inputHeld: held.promise,
    releaseInput: () => release.resolve(),
    async createClient() {
      const client = new OpenAI({ apiKey: "fixture-key", baseURL: `http://127.0.0.1:${server.port}/v1`, maxRetries: 0 });
      return createOpenAIChatCompletionsAdapter(client, EAGER_PROVIDER_MODEL, providerModelInfo({ provider: "openai", id: EAGER_PROVIDER_MODEL }));
    },
    stop() {
      stopped = true;
      release.resolve();
      server.stop(true);
    },
  };
}

async function runFinalizedResultCrashWriter(args: readonly string[]): Promise<never> {
  const [dbPath, sessionId, conversationId, toolUseId] = args;
  if (!dbPath || !sessionId || !conversationId || !toolUseId) {
    throw new Error("finalized-result crash writer requires dbPath, sessionId, conversationId, and toolUseId");
  }
  const store = createSqliteEventStore(dbPath);
  const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) });
  await checkpointFinalizedToolResult(writer, {
    conversationId,
    toolUseId,
    toolName: "write",
    budgetExempt: false, turnBudgetChars: 200_000,
    registrationOrdinal: 0,
    content: [{ type: "text", text: "executed exactly once" }],
    outcome: "ok",
    details: { displayContent: "executed exactly once" },
  });
  const [resultFact] = mapRuntimeEventToSessionRuntimeFacts(createRuntimeEvent("tool.result.recorded", {
    tool_use_id: toolUseId,
    content: [{ type: "text", text: "executed exactly once" }],
    outcome: "ok",
    details: { displayContent: "executed exactly once" },
  }));
  if (!resultFact) throw new Error("fixture result event did not map to a durable fact");
  await writer.record(resultFact);
  console.log("READY");
  await new Promise<void>(() => {});
  throw new Error("unreachable");
}

if (import.meta.main) {
  const modeIndex = Bun.argv.indexOf(FINALIZED_RESULT_CRASH_MODE);
  if (modeIndex < 0) throw new Error(`expected ${FINALIZED_RESULT_CRASH_MODE}`);
  // This process entry owns its catalog bootstrap, like every production entry:
  // the session fact writer decodes module facts through the installed catalog.
  await import("../../src/orchestration/modules.js");
  await runFinalizedResultCrashWriter(Bun.argv.slice(modeIndex + 1));
}
