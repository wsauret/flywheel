import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type LLMClient, type ModelClient, type ProviderStreamEvent as StreamEvent, type StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { ToolPromptFields } from "../../../../../src/orchestration/agent-runtime/system-prompt.js";
import { RequestToolMap, testBaseTools, testCapabilityModules, testDefinitionAvailability, testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { createCheckpointTool } from "../../../../../src/orchestration/agent-runtime/tools/session-checkpoint.js";
import { emptyConversationCheckpoint, type ConversationCheckpointOwner } from "../../../../../src/orchestration/session/conversation-checkpoint.js";
import { asModelClient, ownHistoryTarget } from "../_model-client.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createRequestToolSurface, type RequestToolSurfaceOwner } from "../../../../../src/orchestration/agent-runtime/request-tool-surface.js";
import { resolveModelInteractionProfile } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import type { ProviderRequestAuditWriter } from "../../../../../src/orchestration/agent-runtime/llm/provider-request-audit.js";

export function withSessionNotes(existing: ReadonlyMap<string, RuntimeTool> = new Map(), checkpoint: ConversationCheckpointOwner = {
  read: async () => undefined,
  replace: async () => emptyConversationCheckpoint(),
  decide: async () => emptyConversationCheckpoint(),
}) {
  const tools = new RequestToolMap(existing);
  for (const kind of ["read", "replace", "decide"] as const) tools.set(`checkpoint_${kind}`, createCheckpointTool(kind, checkpoint));
  return { tools, checkpoint };
}

export function specs(...names: string[]): ToolPromptFields[] {
  const base = testBaseTools();
  return names.map((n) => {
    const tool = base.get(n);
    if (!tool) throw new Error(`Unknown base tool: ${n}`);
    return tool;
  });
}

export function makeFakeLLMClient(
  responses: Array<{ events: StreamEvent[] }>,
): ModelClient {
  let callIndex = 0;

  return asModelClient({ historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,

    async *streamWithTools(_options: StreamOptions): AsyncGenerator<StreamEvent> {
      const response = responses[callIndex++];
      if (!response) throw new Error("No more mock responses");
      for (const event of response.events) {
        yield event;
      }
    },


    priceFor() {
      return { status: "unavailable", reason: "missing-rate-card" };
    },
  } satisfies LLMClient);
}

export function makeCaptureClient(
  responses: Array<{ events: StreamEvent[] }>,
  overrides: { contextLimit?: number; onRequest?: (options: StreamOptions) => void } = {},
) {
  let callIndex = 0;
  const capturedMessages: ConversationMessage[][] = [];

  const client: LLMClient = { historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    contextLimit: overrides.contextLimit ?? 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    async *streamWithTools(options: StreamOptions): AsyncGenerator<StreamEvent> {
      capturedMessages.push([...options.messages]);
      overrides.onRequest?.(options);
      const response = responses[callIndex++];
      if (!response) throw new Error("No more mock responses");
      for (const event of response.events) yield event;
    },
    priceFor() {
      return { status: "unavailable", reason: "missing-rate-card" };
    },
  };
  return { client: asModelClient(client), capturedMessages };
}

/** Real request-surface planning with two controlled provider generations.
 *  `onRequest` runs as each request streams, with the count of requests so far. */
export async function budgetCaptureSurface(
  tools: () => ReadonlyMap<string, RuntimeTool>,
  responses: readonly (readonly { events: StreamEvent[] }[])[],
  onRequest?: (requestCount: number) => void,
) {
  let generation = 0;
  const requests: Array<{ generation: number; options: StreamOptions }> = [];
  const admissions: Array<{ generation: number; uses: number }> = [];
  const gates: Array<{ generation: number; tool: string }> = [];
  const audits: Parameters<ProviderRequestAuditWriter["recordRequest"]>[0][] = [];
  const clients = responses.map((turns, index) => {
    let call = 0;
    const client = asModelClient({
      accessProvider: index === 0 ? "anthropic_api" : "openai_api",
      modelFamily: index === 0 ? "anthropic" : "openai",
      model: index === 0 ? "claude-opus-3" : "gpt-6-luna",
      contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options) {
        requests.push({ generation: index, options });
        onRequest?.(requests.length);
        const response = turns[call++];
        if (!response) throw new Error(`No response for generation ${index}`);
        yield* response.events;
      },
    });
    const admit = client.admitRequest.bind(client);
    client.admitRequest = async (...args) => {
      const record = { generation: index, uses: 0 };
      admissions.push(record);
      const request = await admit(...args);
      return {
        ...request,
        run: (input) => {
          record.uses++;
          return request.run(input);
        },
      };
    };
    return client;
  });
  const owner = await createRequestToolSurface(() => {
    const selected = tools();
    return {
      eligibleTools: selected, tools: selected, omitted: [], usable: new Set(selected.keys()), turnedOff: [],
      registrationIds: new Map([...selected.keys()].map((name) => [name, name])),
      registrationIdentities: new Map([...selected.keys()].map((name) => [name, name])),
      definitionAvailability: testDefinitionAvailability(),
    };
  }, () => {
    const captured = generation;
    return {
      ...testCapabilityModules(),
      gates: [{ seam: "toolExecution", id: "budget-test", gate: ({ call }) => {
        gates.push({ generation: captured, tool: call.name });
        return { kind: "allow" };
      } }],
    };
  }, testRuntimeConfigCapture, async () => {
    const client = clients[generation]!;
    const admittedRequest = await client.admitRequest();
    return {
      mainRoute: { client, providerOptions: { openai: { text_verbosity: generation === 0 ? "low" : "high" } } },
      plannedAttempt: await admittedRequest.plannedAttempt(),
      admittedRequest,
      interactionProfile: resolveModelInteractionProfile(client.model, client.modelFamily),
    };
  });
  const surface: RequestToolSurfaceOwner = {
    resolve: async () => {
      const captured = await owner.resolve();
      return { ...captured, executionAdmission: () => ({ ok: true }) };
    },
    current: owner.current,
  };
  const requestAudit: ProviderRequestAuditWriter = {
    recordRequest: async (input) => {
      audits.push(input);
      return { requestId: `budget-${audits.length}`, turn: input.turn };
    },
    recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
  };
  return {
    client: clients[0]!, surface, requests, admissions, gates, audits, requestAudit,
    advance: () => { generation++; },
  };
}

/** Polls `condition` for up to 2 s and fails with `message` when it never holds. */
export async function waitUntil(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(2);
  if (!condition()) throw new Error(message);
}

/** Rethrows an error that a loop under test reported, with its cause. */
export function throwLoopError(error: Error | undefined): void {
  if (error !== undefined) throw new Error(error.message, { cause: error });
}
