import { describe, expect, test } from "bun:test"
import { parseProjectionFact } from "../../../src/infra/event-projection"
import type { StoredFact } from "../../../src/infra/event-store-types"
import { InvariantViolation } from "../../../src/infra/invariant"
import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory"
import type { RuntimeEvent } from "../../../src/infra/runtime-event-types"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../src/infra/runtime-fact-mapper"
import { parseSessionRuntimeFact } from "../../../src/orchestration/session/session-runtime-event-types"
import { RUNTIME_EVENT_DEFINITIONS, RUNTIME_EVENT_TYPES, runtimeEventActor, runtimeEventDurableMapper } from "../../../src/infra/runtime-event-types"
import { SESSION_RUNTIME_FACT_DEFINITIONS } from "../../../src/infra/runtime-fact-types"
import { RETIRED_FACT_TYPES } from "../../../src/orchestration/session/event-store-maintenance.js"
import { buildMutationDiffEvidence } from "../../../src/infra/mutation-diff-evidence.js"
import { sessionContentFixture } from "../../helpers/session-content.js"

function requireInvariant(value: unknown): InvariantViolation {
  if (!(value instanceof InvariantViolation)) throw new Error("expected invariant violation");
  return value;
}

describe("tool execution output runtime facts", () => {
  test("tool.execution_output.delta is structurally ephemeral", () => {
    const event = createRuntimeEvent("tool.execution_output.delta", {
      type: "tool.execution_output.delta",
      tool_use_id: "tool-1",
      output: "live output\n",
      parent_tool_use_id: "parent-1",
      model_request_id: "request-1",
    })
    expect(mapRuntimeEventToSessionRuntimeFacts(event)).toEqual([])
  })

  test("tool.execution_output.recorded maps to one current durable fact", () => {
    const event = createRuntimeEvent("tool.execution_output.recorded", {
      tool_use_id: "tool-1",
      output: "last output\n",
      parent_tool_use_id: "parent-1",
      model_request_id: "request-1",
    })
    expect(mapRuntimeEventToSessionRuntimeFacts(event)).toEqual([{
      type: "tool.execution_output.recorded",
      version: 3,
      actor: "flywheel",
      payload: {
        toolUseId: "tool-1",
        output: "last output\n",
        parentToolUseId: "parent-1",
        modelRequestId: "request-1",
      },
    }])
  })
})

describe("runtime definition authority", () => {
  test("derives event types and indexed actors from each definition", () => {
    expect(RUNTIME_EVENT_TYPES).toEqual(RUNTIME_EVENT_DEFINITIONS.map(({ type }) => type))
    for (const definition of RUNTIME_EVENT_DEFINITIONS) {
      expect(runtimeEventActor(definition.type)).toBe(definition.actor)
    }
  })

  test("indexes each optional durable mapping from its event definition", () => {
    for (const definition of RUNTIME_EVENT_DEFINITIONS) {
      expect(runtimeEventDurableMapper(definition.type)).toBe(definition.durable)
    }
  })

  test("classifies current, historical, and non-runtime durable facts", () => {
    const runtimeTypes: ReadonlySet<string> = new Set(RUNTIME_EVENT_TYPES)
    const latestVersion = new Map<string, number>()
    for (const definition of SESSION_RUNTIME_FACT_DEFINITIONS) {
      latestVersion.set(definition.type, Math.max(latestVersion.get(definition.type) ?? 0, definition.version))
    }
    const historical = SESSION_RUNTIME_FACT_DEFINITIONS.filter((definition) =>
      runtimeTypes.has(definition.type) && definition.version < (latestVersion.get(definition.type) ?? 0))
    const nonRuntime = SESSION_RUNTIME_FACT_DEFINITIONS.filter((definition) => !runtimeTypes.has(definition.type))

    expect(historical.map(({ type, version }) => `${type}@${version}`)).toEqual([
      "tool.input.completed@1",
      "tool.result.recorded@1",
      "tool.execution_output.recorded@1",
      "model.usage.measured@1",
      "model.usage.measured@2",
      "model.usage.measured@3",
      "model.usage.measured@4",
      "model.usage.measured@5",
      "budget.stream.completed@1",
    ])
    expect(nonRuntime.map(({ type }) => type)).toContain("session.duration.recorded")
    // Only historical rows hold a workflow's agent boundaries, because a
    // workflow has no transcript that a live boundary would divide.
    expect(nonRuntime.map(({ type }) => type)).toContain("workflow.worker_boundary.recorded")
    const currentRuntimeFacts = SESSION_RUNTIME_FACT_DEFINITIONS.filter((definition) =>
      runtimeTypes.has(definition.type) && definition.version === latestVersion.get(definition.type))
    // Every current runtime fact definition is written by a mapper, durable
    // or debug, or belongs to a retired family whose definition stays only so
    // historical durable rows still parse.
    const mappedRuntimeTypes = RUNTIME_EVENT_DEFINITIONS
      .filter((definition) => definition.durable !== undefined || definition.debug !== undefined)
      .map(({ type }) => type)
    const mapped: ReadonlySet<string> = new Set(mappedRuntimeTypes)
    const current: ReadonlySet<string> = new Set(currentRuntimeFacts.map(({ type }) => type))
    const retired: ReadonlySet<string> = new Set(RETIRED_FACT_TYPES)

    expect([...mapped].filter((type) => !current.has(type))).toEqual([])
    expect([...current].filter((type) => !mapped.has(type) && !retired.has(type))).toEqual([])
  })
})

type RuntimeEventData<T extends RuntimeEvent["type"]> = Extract<RuntimeEvent, { type: T }>["data"]

function toolResultEvent(data: RuntimeEventData<"tool.result.recorded">): RuntimeEvent {
  return { type: "tool.result.recorded", data }
}

function toolInputCompleteEvent(data: RuntimeEventData<"tool.input.completed">): RuntimeEvent {
  return { type: "tool.input.completed", data }
}

/** `valid` with `edits` applied through the untyped object, which is how a
 *  malformed payload reaches a gate that the type system cannot see past.
 *  An edit whose value is `undefined` removes that key. */
function malformed<T extends object>(valid: T, edits: { readonly [key: string]: unknown }): T {
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) Reflect.deleteProperty(valid, key)
    else Reflect.set(valid, key, value)
  }
  return valid
}

const contextData = (): RuntimeEventData<"model.context.measured"> => ({ context_prompt_tokens: 1234, context_window: 200_000 })

describe("mapToolResult invariant guards", () => {
  test("missing tool_use_id throws InvariantViolation kind=schema-mismatch", () => {
    let caught: unknown
    try {
      mapRuntimeEventToSessionRuntimeFacts(toolResultEvent(malformed({ tool_use_id: "dropped", is_error: false }, { tool_use_id: undefined })))
    } catch (err) {
      caught = err
    }
    const invariant = requireInvariant(caught)
    expect(invariant.kind).toBe("schema-mismatch")
    expect(invariant.eventType).toBe("tool.result.recorded")
  })

  test("empty tool_use_id throws InvariantViolation", () => {
    let caught: unknown
    try {
      mapRuntimeEventToSessionRuntimeFacts(toolResultEvent({ tool_use_id: "", is_error: false }))
    } catch (err) {
      caught = err
    }
    const invariant = requireInvariant(caught)
    expect(invariant.kind).toBe("schema-mismatch")
  })

  test("output recovery metadata is mapped onto tool.result.recorded", () => {
    const [fact] = mapRuntimeEventToSessionRuntimeFacts(toolResultEvent({
      tool_use_id: "tool-call-recovered",
      is_error: false,
      content: [{ type: "text", text: "compressed" }],
      content_truncated: true,
      original_content_bytes: 60_000,
      original_content_sha256: "original-hash",
      full_content_path: "/scratch/full-output.txt",
      semantic_output_truncated: true,
      byte_output_truncated: false,
    }))
    expect(fact).toMatchObject({
      type: "tool.result.recorded",
      version: 3,
      payload: {
        toolUseId: "tool-call-recovered",
        contentTruncated: true,
        originalContentBytes: 60_000,
        originalContentSha256: "original-hash",
        fullContentPath: "/scratch/full-output.txt",
        semanticOutputTruncated: true,
        byteOutputTruncated: false,
      },
    })
  })

  test("persists reference-backed result details as the one tool-result artifact", async () => {
    const { stage } = sessionContentFixture()
    const mutationEvidence = await buildMutationDiffEvidence({
      version: 1,
      files: [{ path: "USER.md", change: "added", unifiedDiff: "+Exact global patch" }],
      omissions: [],
    }, "tool-call-global", stage)
    const [fact] = mapRuntimeEventToSessionRuntimeFacts(toolResultEvent({
      tool_use_id: "tool-call-global",
      is_error: false,
      content: [{ type: "text", text: "ok" }],
      details: { mutationEvidence },
    }))

    if (fact?.type !== "tool.result.recorded") throw new Error("expected tool result fact")
    expect(fact.payload.details).toEqual({ mutationEvidence })
  })

  test("stores capped full content only for nested tool results", () => {
    const longContent = `discarded-${"x".repeat(50 * 1024)}tail`
    const nested = mapRuntimeEventToSessionRuntimeFacts(toolResultEvent({
      tool_use_id: "nested",
      parent_tool_use_id: "code-1",
      content: [{ type: "text", text: longContent }],
      outcome: "ok",
    }))[0]
    const topLevel = mapRuntimeEventToSessionRuntimeFacts(toolResultEvent({
      tool_use_id: "top",
      content: [{ type: "text", text: longContent }],
      outcome: "ok",
    }))[0]

    if (nested?.type !== "tool.result.recorded" || topLevel?.type !== "tool.result.recorded") throw new Error("expected tool result facts")
    expect(Buffer.byteLength(nested.payload.content ?? "", "utf-8")).toBe(50 * 1024)
    expect(nested.payload.content?.endsWith("tail")).toBe(true)
    expect(nested.payload.contentTruncated).toBe(true)
    expect(topLevel.payload.content).toBeUndefined()
  })

  test("keeps the byte cap exact when the cut lands inside a multibyte code point", () => {
    // 3-byte euro signs guarantee the 51,200-byte tail cut splits a code point.
    const nested = mapRuntimeEventToSessionRuntimeFacts(toolResultEvent({
      tool_use_id: "nested-multibyte",
      parent_tool_use_id: "code-1",
      content: [{ type: "text", text: "€".repeat(20_000) }],
      outcome: "ok",
    }))[0]

    if (nested?.type !== "tool.result.recorded") throw new Error("expected tool result fact")
    expect(Buffer.byteLength(nested.payload.content ?? "", "utf-8")).toBeLessThanOrEqual(50 * 1024)
    expect(nested.payload.content?.includes("\uFFFD")).toBe(false)
    expect(nested.payload.contentTruncated).toBe(true)
  })

  test("keeps the same tail when the cap cuts a surrogate pair", () => {
    // The pair sits where the last 51,200 code units start, so a tail taken by
    // code units begins with a lone low surrogate.
    const text = `${"x".repeat(10)}\uD83D\uDE00${"y".repeat(50 * 1024 - 1)}`
    const nested = mapRuntimeEventToSessionRuntimeFacts(toolResultEvent({
      tool_use_id: "nested-surrogate",
      parent_tool_use_id: "code-1",
      content: [{ type: "text", text }],
      outcome: "ok",
    }))[0]

    if (nested?.type !== "tool.result.recorded") throw new Error("expected tool result fact")
    expect(nested.payload.content).toBe("y".repeat(50 * 1024 - 1))
  })

  test("rejects persisted content on a top-level fact and oversized nested content", () => {
    expect(() => parseSessionRuntimeFact({
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "top", outcome: "ok", content: "leaked" },
    })).toThrow()
    expect(() => parseSessionRuntimeFact({
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "nested", outcome: "ok", parentToolUseId: "code-1", content: "x".repeat(50 * 1024 + 1) },
    })).toThrow()
    expect(parseSessionRuntimeFact({
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "nested", outcome: "ok", parentToolUseId: "code-1", content: "fits" },
    }).type).toBe("tool.result.recorded")
  })
})

describe("mapToolCall execution metadata", () => {
  test("tool_input_complete persists runtime execution semantics", () => {
    const [fact] = mapRuntimeEventToSessionRuntimeFacts(toolInputCompleteEvent({
      model_request_id: "request-1",
      tool_use: {
        id: "tool-sub",
        name: "subagent",
        provider_call_id: "provider-call-1",
        provider_tool_name: "subagent",
        executable_tool_name: "subagent",
        input: { description: "review", prompt: "check code" },
        execution: {
          mode: "background",
          trace_kind: "subagent",
        },
      },
    }))

    expect(fact).toMatchObject({
      type: "tool.input.completed",
      payload: {
        toolUseId: "tool-sub",
        toolName: "subagent",
        executionMode: "background",
        traceKind: "subagent",
        childHasOwnViewport: false,
      },
    })
  })

  test("missing runtime execution metadata throws before writing an internal fact", () => {
    let caught: unknown
    try {
      mapRuntimeEventToSessionRuntimeFacts(toolInputCompleteEvent({
        tool_use: malformed({
          id: "tool-read",
          name: "read",
          input: { path: "a.ts" },
          execution: { mode: "foreground", trace_kind: "tool" },
        }, { execution: undefined }),
      }))
    } catch (err) {
      caught = err
    }

    const invariant = requireInvariant(caught)
    expect(invariant.eventType).toBe("tool.input.completed")
  })
})

describe("model.context.measured producer contract", () => {
  test("the writer gate rejects a payload missing context fields", () => {
    expect(() => createRuntimeEvent("model.context.measured", malformed(contextData(), { context_prompt_tokens: undefined, context_window: undefined }))).toThrow(
      /Invalid model\.context\.measured event payload/,
    )
  })

  test("the writer gate rejects non-numeric context_prompt_tokens", () => {
    expect(() =>
      createRuntimeEvent("model.context.measured", malformed(contextData(), { context_prompt_tokens: "abc" }))
    ).toThrow(/Invalid model\.context\.measured event payload/)
  })

  test("a valid event maps to a model.context.measured fact with both fields", () => {
    const [fact] = mapRuntimeEventToSessionRuntimeFacts({
      type: "model.context.measured",
      data: { context_prompt_tokens: 1234, context_window: 200_000 },
    })
    expect(fact).toMatchObject({
      type: "model.context.measured",
      payload: { promptTokens: 1234, contextWindow: 200_000 },
    })
  })
})

describe("v1 tool.result.recorded routed through parseProjectionFact", () => {
  test("v1 fact lacking tool_use_id throws InvariantViolation kind=schema-mismatch with eventPosition", () => {
    const v1Event: StoredFact = {
      id: "evt-1",
      position: 42,
      seq: 1,
      aggregateId: "session:s1",
      type: "tool.result.recorded",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "s1",
      payload: { toolUseId: "", outcome: "ok" },
    }
    let caught: unknown
    try {
      parseProjectionFact(v1Event, parseSessionRuntimeFact)
    } catch (err) {
      caught = err
    }
    const invariant = requireInvariant(caught)
    expect(invariant.kind).toBe("schema-mismatch")
    expect(invariant.eventPosition).toBe(42)
  })
})

describe("model.usage.measured billed split invariant", () => {
  test("rejects a fact whose billed portion exceeds the total", () => {
    expect(() =>
      parseSessionRuntimeFact({
        type: "model.usage.measured",
        version: 1,
        actor: "provider",
        payload: {
          totalCostUsd: 0.01,
          billedCostUsd: 0.02,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          reasoningTokens: 0,
        },
      }),
    ).toThrow(/billedCostUsd must not exceed totalCostUsd/)
  })
})

describe("model.usage.measured versions", () => {
  const payload = {
    totalCostUsd: 0.01,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    reasoningTokens: 0,
  };

  test("accepts legacy v1 facts without billing provenance", () => {
    expect(parseSessionRuntimeFact({
      type: "model.usage.measured",
      version: 1,
      actor: "provider",
      payload,
    }).version).toBe(1);
  });

  test("requires billedCostUsd on current v2 facts", () => {
    expect(() => parseSessionRuntimeFact({
      type: "model.usage.measured",
      version: 2,
      actor: "provider",
      payload,
    })).toThrow();

    expect(parseSessionRuntimeFact({
      type: "model.usage.measured",
      version: 2,
      actor: "provider",
      payload: { ...payload, billedCostUsd: 0 },
    }).version).toBe(2);
  });

  test("validates fully attributed v5 session mirrors", () => {
    const committed = {
      attemptId: "00000000-0000-4000-8000-000000000001",
      occurredAt: "2025-01-15T12:00:00.000Z",
      profileId: "profile-a",
      attribution: { kind: "candidate" as const, providerId: "openai_api" },
      spendMode: "direct_api" as const,
      credentialLineage: "00000000-0000-4000-8000-000000000002",
      model: "gpt-5",
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
      classification: "real_spend" as const,
      price: { kind: "priced" as const, estimatedUsd: 0.01, rateCard: { input: 2.5 }, provenance: "models.dev" },
      currency: "USD" as const,
      budgetStreamId: "session:one",
    };

    expect(parseSessionRuntimeFact({
      type: "model.usage.measured",
      version: 5,
      actor: "provider",
      payload: committed,
    }).version).toBe(5);
    expect(() => parseSessionRuntimeFact({
      type: "model.usage.measured",
      version: 5,
      actor: "provider",
      payload: { ...committed, profileId: "" },
    })).toThrow();
  });

  test("maps committed runtime entries to v6 and preserves full attribution", () => {
    const usageEntry = {
      attemptId: "00000000-0000-4000-8000-000000000001",
      occurredAt: "2025-01-15T12:00:00.000Z",
      profileId: "profile-a",
      attribution: { kind: "candidate" as const, providerId: "openai_api" },
      spendMode: "direct_api" as const,
      credentialLineage: "00000000-0000-4000-8000-000000000002",
      model: "gpt-5",
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      classification: "real_spend" as const,
      price: { kind: "priced" as const, estimatedUsd: 0.01, rateCard: {}, provenance: "models.dev" },
      currency: "USD" as const,
      coverage: "complete" as const,
    };
    const [fact] = mapRuntimeEventToSessionRuntimeFacts(createRuntimeEvent("model.usage.measured", {
      usage_entry: usageEntry,
      budget_stream_id: "learning-review:review-1",
    }));
    expect(fact).toEqual({
      type: "model.usage.measured",
      version: 6,
      actor: "provider",
      payload: { ...usageEntry, budgetStreamId: "learning-review:review-1" },
    });
  });
});

describe("tool.runtime_invocation.recorded versions", () => {
  test("reads the model choices of a version 2 launch, which named them `steps`, as `agents`", () => {
    // Builds before 2026-10-16 wrote version 2. Remove after 2027-04-30.
    const fact = parseSessionRuntimeFact({
      type: "tool.runtime_invocation.recorded",
      version: 2,
      actor: "flywheel",
      payload: {
        toolUseId: "runtime-launch",
        initiator: "person",
        parentConversationId: "conversation-1",
        parentEntryId: "entry-1",
        operation: { kind: "launch", input: { workflowDefinitionId: "implement", description: "Implement it.", steps: { implement: { model: "gpt-6-luna" } } } },
      },
    });
    if (fact.type !== "tool.runtime_invocation.recorded" || fact.payload.operation.kind !== "launch") throw new Error("Expected a launch invocation");
    expect(fact.payload.operation.input).toEqual({ workflowDefinitionId: "implement", description: "Implement it.", agents: { implement: { model: "gpt-6-luna" } } });
  });
});
