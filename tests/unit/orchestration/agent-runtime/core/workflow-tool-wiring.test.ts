import { describe, expect, it } from "bun:test";
import type { AgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js";
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js";
import type { ProviderStreamEvent, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { asModelClient } from "../_model-client.js";
import { newTestRunner } from "../../../../helpers/agent-runner.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { capabilityAccessHolding } from "../tools/_fixtures.js";
import { MODULE_IDS } from "../../../../../src/protocol/module-ids.js";
import { makeDeps as makeSubagentDeps } from "../subagent/_fixtures.js";
import { renderSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

// ---------------------------------------------------------------------------
// Task 4: HarnessRunner wires the workflow tool into allToolDefs
// ---------------------------------------------------------------------------

/** Background dispatch (subagent, workflow) is exposed only to a runner whose
 *  host owns the work it starts, so every dispatch-exposing case supplies an
 *  owner. */
function makeOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  return {
    model: "claude-haiku-4-5-20251001",
    ...testDirectories("/scratch"),
    onEvent: () => {},
    purpose: { kind: "interactive-chat" },
    conversation: {
      kind: "durable-tree",
      reserveMessageId: async () => crypto.randomUUID(),
      sessionId: "tool-wiring-session",
      conversationId: "tool-wiring-conversation",
      priorMessages: [],
      append: () => {},
      captureCommittedForkMessages: async () => [],
      resolveLeafId: async () => null, committedTree: async () => ({ leafId: null, entriesById: {} }),
    },
    subagentSessions: makeSubagentDeps().subagentSessions,
    lifecycle: { kind: "one-shot" },
    // Empty agent registry prevents subagent tool from being added
    agentRegistry: new Map(),
    // Every optional tool these cases ask about names a capability, so the
    // runner holds a full selection unless a case narrows it.
    capabilityAccess: capabilityAccessHolding(MODULE_IDS),
    ...overrides,
    runtimeSurfaces: {
      background: createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })),
      askUser: {
        ask: async () => ({ kind: "cancelled" }),
        answerQuestion: () => {},
        cancelQuestion: () => {},
        suspendAll: () => false,
      },
      ...overrides?.runtimeSurfaces,
    },
  };
}

function makeFakeClient(captureToolNames: (names: string[]) => void) {
  return async () => asModelClient({
    accessProvider: "anthropic_api" as const,
    modelFamily: "anthropic" as const,
    model: "test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
    async *streamWithTools(opts: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      captureToolNames(opts.tools.map(t => t.name));
      yield { kind: "text_delta", text: "hi", blockKey: "text" } as const;
      yield { kind: "done", stopReason: "end_turn" } as const;
    },
  });
}

describe("LiveAgent workflow tool wiring", () => {
  it("when startWorkflow is present, allToolDefs includes workflow", async () => {
    const capturedToolNames: string[][] = [];
    const runner = newTestRunner(
      makeOptions({
        runtimeSurfaces: { startWorkflow: async () => ({ error: "no launch happens in this test" }) },
      }),
      makeFakeClient((names) => capturedToolNames.push(names)),
    );

    runner.send("hello");
    await runner.done;

    expect(capturedToolNames.length).toBeGreaterThanOrEqual(1);
    expect(capturedToolNames[0]).toContain("workflow");
  });

  it("exposes background management whenever the runner owns background work", async () => {
    const capturedToolNames: string[][] = [];
    const runner = newTestRunner(
      makeOptions(),
      makeFakeClient((names) => capturedToolNames.push(names)),
    );

    runner.send("hello");
    await runner.done;

    expect(capturedToolNames[0]).toContain("process");
    expect(capturedToolNames[0]).not.toContain("wait");
    expect(capturedToolNames[0]).not.toContain("stop");
  });

  it("workflow coexists with subagent when both are present", async () => {
    const capturedToolNames: string[][] = [];

    // Non-empty agent registry triggers subagent tool creation
    const agentRegistry = new Map<string, AgentDefinition>([
      ["explorer", {
        kind: "persona",
        name: "explorer",
        description: "Explores code",
        role: "explorer",
        tools: ["read", "search", "list"],
        systemPrompt: "You explore.",
        maxTurns: 10,
      }],
    ]);

    const runner = newTestRunner(
      makeOptions({
        runtimeSurfaces: { startWorkflow: async () => ({ error: "no launch happens in this test" }) },
        agentRegistry,
      }),
      makeFakeClient((names) => capturedToolNames.push(names)),
    );

    runner.send("hello");
    await runner.done;

    expect(capturedToolNames.length).toBeGreaterThanOrEqual(1);
    expect(capturedToolNames[0]).toContain("workflow");
    expect(capturedToolNames[0]).toContain("subagent");
  });

  it("system prompt includes workflow tool guidelines when startWorkflow is present", async () => {
    let capturedSystemPrompt = "";
    const runner = newTestRunner(
      makeOptions({
        runtimeSurfaces: { startWorkflow: async () => ({ error: "no launch happens in this test" }) },
      }),
      async () => asModelClient({
        accessProvider: "anthropic_api" as const,
        modelFamily: "anthropic" as const,
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
        async *streamWithTools(opts: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
          capturedSystemPrompt = renderSystemPrompt(opts.systemPrompt);
          yield { kind: "text_delta", text: "hi", blockKey: "text" } as const;
          yield { kind: "done", stopReason: "end_turn" } as const;
        },
      }),
    );

    runner.send("hello");
    await runner.done;

    expect(capturedSystemPrompt).toContain("checkpoint's approved Design intent and Decisions");
    expect(capturedSystemPrompt).not.toContain("Available workflows:");
  });

});
