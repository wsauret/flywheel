import { describe, expect, it } from "bun:test";
import { runAgentLoop, ContextLengthExceededError } from "../../src/harness/agent-loop.js";
import type { AgentLoopOptions, AgentLoopResult } from "../../src/harness/agent-loop.js";
import { FakeLLMProvider } from "../fixtures/fake-llm-provider.js";
import type { HarnessTool, ToolResult } from "../../src/harness/tools/types.js";
import type { StreamEvent, UsageInfo } from "../../src/harness/llm.js";
import type { TurnResult } from "../../src/harness/turn-executor.js";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function validHandoff() {
  return {
    summary: "Implemented the feature successfully with full test coverage and verified output.",
  };
}

function makeEchoTool(): HarnessTool {
  return {
    name: "echo",
    description: "Echoes input back",
    inputSchema: z.object({ text: z.string() }),
    concurrency: "shared",
    async execute(input: unknown): Promise<ToolResult> {
      const parsed = input as { text: string };
      return { content: `Echo: ${parsed.text}` };
    },
  };
}

function makeFailingTool(): HarnessTool {
  return {
    name: "fail_tool",
    description: "Always fails",
    inputSchema: z.object({ attempt: z.string().optional() }),
    concurrency: "shared",
    async execute(): Promise<ToolResult> {
      return { content: "Tool error", isError: true };
    },
  };
}

function textResponse(text: string): StreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "message_stop" },
  ];
}

function toolCallResponse(
  toolName: string,
  input: Record<string, unknown>,
  id = "call_1",
): StreamEvent[] {
  return [
    { type: "tool_use", id, name: toolName, input },
    { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } },
    { type: "message_stop" },
  ];
}

function completionResponse(handoff: Record<string, unknown>, id = "call_complete"): StreamEvent[] {
  return [
    { type: "tool_use", id, name: "task_complete", input: handoff },
    { type: "usage", usage: { inputTokens: 15, outputTokens: 8 } },
    { type: "message_stop" },
  ];
}

function makeBaseOptions(provider: FakeLLMProvider, tools: HarnessTool[] = []): AgentLoopOptions {
  return {
    provider,
    tools,
    systemPrompt: "You are a test agent.",
    initialMessage: "Do something.",
    model: "test-model",
    maxTokens: 1024,
    cwd: "/tmp/test",
    env: {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Simple text response (no tools) — returns after one turn
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — text-only response nudges toward task_complete", () => {
  it("nudges the model to call task_complete instead of silently completing", async () => {
    const provider = new FakeLLMProvider();
    // Turn 1: text only — gets nudged
    provider.enqueue(textResponse("Hello, I'm done."));
    // Turn 2: model complies and calls task_complete (first -> pending)
    provider.enqueue(completionResponse(validHandoff()));
    // Turn 3: model confirms (second -> confirmed)
    provider.enqueue(completionResponse(validHandoff()));

    const result = await runAgentLoop(makeBaseOptions(provider));

    expect(result.status).toBe("completed");
    expect(result.totalTurns).toBe(3);
    expect(result.handoff).toBeDefined();
  });

  it("hits max_turns if model never calls task_complete", async () => {
    const provider = new FakeLLMProvider();
    // Keep responding with text only
    for (let i = 0; i < 5; i++) {
      provider.enqueue(textResponse("I think I'm done."));
    }

    const result = await runAgentLoop({ ...makeBaseOptions(provider), maxTurns: 5 });

    expect(result.status).toBe("max_turns");
    expect(result.totalTurns).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool use followed by completion — multi-turn conversation
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — tool use + completion", () => {
  it("executes tools then completes via double-confirm", async () => {
    const provider = new FakeLLMProvider();

    // Turn 1: agent calls echo tool
    provider.enqueue(toolCallResponse("echo", { text: "testing" }));

    // Turn 2: agent calls task_complete (first confirm -> pending)
    provider.enqueue(completionResponse(validHandoff()));

    // Turn 3: agent calls task_complete again (second confirm -> confirmed)
    provider.enqueue(completionResponse(validHandoff()));

    const result = await runAgentLoop(
      makeBaseOptions(provider, [makeEchoTool()]),
    );

    expect(result.status).toBe("completed");
    expect(result.totalTurns).toBe(3);
    expect(result.handoff).toBeDefined();
    expect((result.handoff as Record<string, unknown>).summary).toBe(
      validHandoff().summary,
    );
  });

  it("accumulates usage across turns", async () => {
    const provider = new FakeLLMProvider();
    // Turn 1: tool call
    provider.enqueue(toolCallResponse("echo", { text: "step 1" }));
    // Turn 2: task_complete (pending)
    provider.enqueue(completionResponse(validHandoff()));
    // Turn 3: task_complete (confirmed)
    provider.enqueue(completionResponse(validHandoff()));

    const result = await runAgentLoop(
      makeBaseOptions(provider, [makeEchoTool()]),
    );

    expect(result.status).toBe("completed");
    expect(result.totalTurns).toBe(3);
    // 20+15+15=50 input, 10+8+8=26 output
    expect(result.totalUsage.inputTokens).toBe(50);
    expect(result.totalUsage.outputTokens).toBe(26);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Max turns limit — returns max_turns status
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — max turns", () => {
  it("returns max_turns when limit is reached", async () => {
    const provider = new FakeLLMProvider();

    // Each turn uses a tool, keeping the loop going
    for (let i = 0; i < 5; i++) {
      provider.enqueue(toolCallResponse("echo", { text: `turn ${i}` }, `call_${i}`));
    }

    const result = await runAgentLoop({
      ...makeBaseOptions(provider, [makeEchoTool()]),
      maxTurns: 5,
    });

    expect(result.status).toBe("max_turns");
    expect(result.totalTurns).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Doom loop detection
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — doom loop detection", () => {
  it("returns doom_loop when same tool is called repeatedly", async () => {
    const provider = new FakeLLMProvider();

    // Same tool call repeated 3 times (threshold is 3)
    for (let i = 0; i < 3; i++) {
      provider.enqueue(toolCallResponse("echo", { text: "same input" }, `call_${i}`));
    }

    const result = await runAgentLoop({
      ...makeBaseOptions(provider, [makeEchoTool()]),
      maxTurns: 10,
    });

    expect(result.status).toBe("doom_loop");
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("Doom loop detected");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Double-confirm flow
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — double-confirm flow", () => {
  it("first task_complete returns pending, second returns confirmed", async () => {
    const provider = new FakeLLMProvider();
    const turns: number[] = [];

    // Turn 1: task_complete (pending — checklist injected)
    provider.enqueue(completionResponse(validHandoff()));

    // Turn 2: task_complete again (confirmed)
    provider.enqueue(completionResponse(validHandoff()));

    const result = await runAgentLoop({
      ...makeBaseOptions(provider),
      onTurnComplete: (turn) => turns.push(turn),
    });

    expect(result.status).toBe("completed");
    expect(result.totalTurns).toBe(2);
    expect(result.handoff).toBeDefined();
    expect(turns).toEqual([0, 1]);

    // Verify the checklist was injected: the second stream call should
    // have messages containing the verification checklist
    expect(provider.calls.length).toBe(2);
    const secondCallMessages = provider.calls[1]!.messages;
    const userMessages = secondCallMessages.filter((m) => m.role === "user");
    const hasChecklist = userMessages.some((m) => {
      const content = typeof m.content === "string" ? m.content : "";
      return content.includes("Test Engineer") || content.includes("verify");
    });
    expect(hasChecklist).toBe(true);
  });

  it("handles invalid handoff on first attempt", async () => {
    const provider = new FakeLLMProvider();

    // Turn 1: invalid task_complete (error — message injected)
    provider.enqueue(completionResponse({ summary: "" }));

    // Turn 2: valid task_complete (pending — checklist injected)
    provider.enqueue(completionResponse(validHandoff()));

    // Turn 3: valid task_complete (confirmed)
    provider.enqueue(completionResponse(validHandoff()));

    const result = await runAgentLoop(makeBaseOptions(provider));

    expect(result.status).toBe("completed");
    expect(result.totalTurns).toBe(3);
    expect(result.handoff).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Context overflow recovery
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — context overflow recovery", () => {
  it("truncates history and retries on context length error", async () => {
    let callCount = 0;

    const customProvider = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          throw new ContextLengthExceededError();
        }
        // Succeed on retry with task_complete
        yield { type: "tool_use" as const, id: "tc", name: "task_complete", input: validHandoff() };
        yield { type: "usage" as const, usage: { inputTokens: 5, outputTokens: 3 } };
        yield { type: "message_stop" as const };
      },
    };

    // First call throws, retry succeeds with task_complete (pending), then need confirm
    // But the custom provider always returns the same thing, so call 3 will confirm
    const result = await runAgentLoop({
      ...makeBaseOptions(new FakeLLMProvider()),
      provider: customProvider,
      maxTurns: 5,
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("recovers from context length error message patterns", async () => {
    let callCount = 0;

    const customProvider = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          throw new Error("maximum context length exceeded for this model");
        }
        yield { type: "tool_use" as const, id: "tc", name: "task_complete", input: validHandoff() };
        yield { type: "message_stop" as const };
      },
    };

    const result = await runAgentLoop({
      ...makeBaseOptions(new FakeLLMProvider()),
      provider: customProvider,
      maxTurns: 5,
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Abort signal
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — abort signal", () => {
  it("returns aborted when signal is already aborted", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue(textResponse("should not be reached"));

    const controller = new AbortController();
    controller.abort();

    const result = await runAgentLoop({
      ...makeBaseOptions(provider),
      abortSignal: controller.signal,
    });

    expect(result.status).toBe("aborted");
    expect(result.totalTurns).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Consecutive tool failure safety valve
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — consecutive tool failures", () => {
  it("injects warning after maxToolFailures consecutive failures", async () => {
    const provider = new FakeLLMProvider();

    // 3 consecutive failure turns with different inputs to avoid doom loop detection
    for (let i = 0; i < 3; i++) {
      provider.enqueue(toolCallResponse("fail_tool", { attempt: `try_${i}` }, `fail_${i}`));
    }

    // After warning, agent calls task_complete
    provider.enqueue(completionResponse(validHandoff()));
    provider.enqueue(completionResponse(validHandoff()));

    const result = await runAgentLoop({
      ...makeBaseOptions(provider, [makeFailingTool()]),
      maxToolFailures: 3,
    });

    expect(result.status).toBe("completed");

    // The fourth call should have the warning in its messages
    expect(provider.calls.length).toBeGreaterThanOrEqual(4);
    const fourthMessages = provider.calls[3]!.messages;
    const warningMsg = fourthMessages.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("consecutive tool calls have failed"),
    );
    expect(warningMsg).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Abnormal exit
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — model refuses task_complete", () => {
  it("nudges model and hits max_turns if it never complies", async () => {
    const provider = new FakeLLMProvider();

    // Agent uses tools then keeps responding with text only
    provider.enqueue(toolCallResponse("echo", { text: "work" }));
    for (let i = 0; i < 4; i++) {
      provider.enqueue(textResponse("I'm done now."));
    }

    const result = await runAgentLoop({
      ...makeBaseOptions(provider, [makeEchoTool()]),
      maxTurns: 5,
    });

    expect(result.status).toBe("max_turns");
    expect(result.handoff).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Usage callback
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — callbacks", () => {
  it("calls onUsage for each turn", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue(toolCallResponse("echo", { text: "hi" }));
    provider.enqueue(completionResponse(validHandoff()));
    provider.enqueue(completionResponse(validHandoff()));

    const usages: UsageInfo[] = [];
    const turnResults: Array<{ turn: number; result: TurnResult }> = [];

    const result = await runAgentLoop({
      ...makeBaseOptions(provider, [makeEchoTool()]),
      onUsage: (u) => usages.push(u),
      onTurnComplete: (turn, r) => turnResults.push({ turn, result: r }),
    });

    expect(result.status).toBe("completed");
    expect(usages).toHaveLength(3);
    expect(turnResults).toHaveLength(3);
    expect(turnResults[0]!.turn).toBe(0);
    expect(turnResults[1]!.turn).toBe(1);
    expect(turnResults[2]!.turn).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — error handling", () => {
  it("returns error status on non-recoverable stream errors", async () => {
    const provider = new FakeLLMProvider();
    provider.setError(new Error("API key invalid"));

    const result = await runAgentLoop(makeBaseOptions(provider));

    expect(result.status).toBe("error");
    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe("API key invalid");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Output overflow recovery
// ═══════════════════════════════════════════════════════════════════════════

describe("runAgentLoop — output overflow recovery", () => {
  it("adds continuation message on output length error", async () => {
    let callCount = 0;

    const customProvider = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          throw new Error("output length limit exceeded");
        }
        // On retry, complete via task_complete
        yield { type: "tool_use" as const, id: "tc", name: "task_complete", input: validHandoff() };
        yield { type: "message_stop" as const };
      },
    };

    const result = await runAgentLoop({
      ...makeBaseOptions(new FakeLLMProvider()),
      provider: customProvider,
      maxTurns: 10,
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
