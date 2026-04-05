import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createChatSession,
  destroyChatSession,
  type ChatSession,
  type ChatAgentHandle,
  type ChatSessionConfig,
} from "../src/tui/session/chat-session";
import type { AgentLoopResult } from "../src/harness";
import type { FlywheelEvent } from "../src/events/types";

/**
 * Chat Session Tests
 *
 * Verifies the ChatSession lifecycle manager:
 * - Session creation returns expected shape (store, adapter, eventBus, methods)
 * - No TimerService is started (timer stays idle)
 * - Store initialized without a plan path
 * - Message routing: sendMessage flows through adapter's structured pipeline
 * - Shutdown stops adapter and aborts running agent
 * - Adapter isolation: only worker:output events emitted (no lifecycle events)
 * - Chat sessions are ephemeral (not registered with session manager)
 * - Chat sessions can coexist with workflow sessions (separate EventBus)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function completedResult(): AgentLoopResult {
  return {
    status: "completed",
    totalTurns: 1,
    totalUsage: { inputTokens: 100, outputTokens: 200 },
  };
}

/** Create a mock spawn factory that records stdout chunks and can be controlled. */
function createMockSpawnFactory() {
  let resolveResult: ((result: AgentLoopResult) => void) | null = null;
  let abortCalled = false;
  let capturedOnStdout: ((chunk: string) => void) | null = null;
  let capturedMessage: string | null = null;
  let spawnCount = 0;

  const spawnAgent = (message: string, onStdout: (chunk: string) => void): ChatAgentHandle => {
    spawnCount++;
    capturedMessage = message;
    capturedOnStdout = onStdout;
    abortCalled = false;

    const resultPromise = new Promise<AgentLoopResult>((resolve) => {
      resolveResult = resolve;
    });

    return {
      result: resultPromise,
      abort: () => { abortCalled = true; },
    };
  };

  return {
    spawnAgent,
    get spawnCount() { return spawnCount; },
    get capturedMessage() { return capturedMessage; },
    get abortCalled() { return abortCalled; },
    emitStdout(chunk: string) {
      if (!capturedOnStdout) throw new Error("No active agent to emit stdout to");
      capturedOnStdout(chunk);
    },
    complete(result?: AgentLoopResult) {
      if (!resolveResult) throw new Error("No active agent to complete");
      resolveResult(result ?? completedResult());
      resolveResult = null;
    },
  };
}

function createTestConfig(factory: ReturnType<typeof createMockSpawnFactory>): ChatSessionConfig {
  return { spawnAgent: factory.spawnAgent };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatSession", () => {
  let session: ChatSession;
  let factory: ReturnType<typeof createMockSpawnFactory>;

  beforeEach(() => {
    factory = createMockSpawnFactory();
  });

  afterEach(() => {
    if (session) {
      destroyChatSession(session);
    }
  });

  // ── Creation ──

  describe("createChatSession", () => {
    it("returns expected shape", () => {
      session = createChatSession(createTestConfig(factory));

      expect(session.store).toBeDefined();
      expect(session.adapter).toBeDefined();
      expect(session.eventBus).toBeDefined();
      expect(typeof session.sendMessage).toBe("function");
      expect(typeof session.shutdown).toBe("function");
      expect(typeof session.getConversationSummary).toBe("function");
    });

    it("initializes store with 'chat' plan name and idle workflow status", () => {
      session = createChatSession(createTestConfig(factory));

      const state = session.store.getState();
      expect(state.planName).toBe("chat");
      expect(state.workflowStatus).toBe("idle");
    });

    it("does not start a timer (timer stays idle)", () => {
      session = createChatSession(createTestConfig(factory));

      // The adapter creates a private TimerService but we never start it.
      // Verify by checking it's in idle state.
      expect(session.adapter.timer.getStatus()).toBe("idle");
      expect(session.adapter.timer.isRunning()).toBe(false);
    });

    it("connects adapter to event bus", () => {
      session = createChatSession(createTestConfig(factory));

      expect(session.adapter.isConnected()).toBe(true);
      expect(session.adapter.isRunning()).toBe(true);
    });
  });

  // ── Message Routing ──

  describe("sendMessage", () => {
    it("spawns agent with the message text", () => {
      session = createChatSession(createTestConfig(factory));
      session.sendMessage("Hello, world!");

      expect(factory.spawnCount).toBe(1);
      expect(factory.capturedMessage).toBe("Hello, world!");
    });

    it("ignores empty/whitespace messages", () => {
      session = createChatSession(createTestConfig(factory));
      session.sendMessage("");
      session.sendMessage("   ");

      expect(factory.spawnCount).toBe(0);
    });

    it("marks store as running when message sent", () => {
      session = createChatSession(createTestConfig(factory));
      session.sendMessage("test");

      const state = session.store.getState();
      expect(state.workflowStatus).toBe("running");
    });

    it("emits worker:output events on the event bus when agent produces stdout", () => {
      session = createChatSession(createTestConfig(factory));

      const receivedEvents: FlywheelEvent[] = [];
      session.eventBus.subscribe((e) => receivedEvents.push(e));

      session.sendMessage("test");

      // Simulate agent emitting NDJSON output
      factory.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}\n');

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0]!.type).toBe("worker:output");

      const outputEvent = receivedEvents[0] as Extract<FlywheelEvent, { type: "worker:output" }>;
      expect(outputEvent.stream).toBe("stdout");
      expect(outputEvent.engineId).toBe("harness");
    });

    it("routes agent output through the structured pipeline to output blocks", async () => {
      session = createChatSession(createTestConfig(factory));

      session.sendMessage("test");

      // Emit a text NDJSON event (Claude harness format)
      factory.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"Hello from AI"}]}}\n');

      // Wait for store's throttled notification (16ms + margin)
      await new Promise((resolve) => setTimeout(resolve, 30));

      const state = session.store.getState();
      // Output blocks should contain the text from the assistant message
      expect(state.outputBlocks.length).toBeGreaterThan(0);
      const textBlock = state.outputBlocks.find((b) => b.kind === "text");
      expect(textBlock).toBeDefined();
      if (textBlock?.kind === "text") {
        expect(textBlock.content).toContain("Hello from AI");
      }
    });
  });

  // ── Adapter Isolation ──

  describe("adapter isolation", () => {
    it("only emits worker:output events (no lifecycle events)", () => {
      session = createChatSession(createTestConfig(factory));

      const receivedEventTypes: string[] = [];
      session.eventBus.subscribe((e) => receivedEventTypes.push(e.type));

      session.sendMessage("test");
      factory.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"resp"}]}}\n');

      // Verify no queue, step, or timer lifecycle events were emitted
      for (const t of receivedEventTypes) {
        expect(t).toBe("worker:output");
      }
    });

    it("timer stays idle even after sending messages", () => {
      session = createChatSession(createTestConfig(factory));
      session.sendMessage("test");

      // Timer should still be idle — no queue:initialized event was emitted
      expect(session.adapter.timer.getStatus()).toBe("idle");
    });

    it("does not trigger workflow completion from output events", async () => {
      session = createChatSession(createTestConfig(factory));
      session.sendMessage("test");

      // Emit a result event (completion signal in NDJSON)
      factory.emitStdout('{"type":"result","subtype":"success"}\n');

      // Wait for any async processing
      await new Promise((resolve) => setTimeout(resolve, 30));

      // The store should NOT transition to completed (no queue:completed was emitted)
      const state = session.store.getState();
      // It's still running because only the caller controls the workflow status
      expect(state.workflowStatus).toBe("running");
    });
  });

  // ── Separate EventBus ──

  describe("event bus isolation", () => {
    it("chat session has its own EventBus instance", () => {
      session = createChatSession(createTestConfig(factory));
      const session2 = createChatSession(createTestConfig(factory));

      expect(session.eventBus).not.toBe(session2.eventBus);

      // Events on one bus don't reach the other
      let session2Received = false;
      session2.eventBus.subscribe(() => { session2Received = true; });

      session.sendMessage("test");
      factory.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');

      expect(session2Received).toBe(false);

      destroyChatSession(session2);
    });
  });

  // ── Shutdown ──

  describe("shutdown", () => {
    it("stops the adapter", () => {
      session = createChatSession(createTestConfig(factory));
      session.shutdown();

      expect(session.adapter.isRunning()).toBe(false);
      expect(session.adapter.isConnected()).toBe(false);
    });

    it("aborts a running agent", () => {
      session = createChatSession(createTestConfig(factory));
      session.sendMessage("test");

      expect(factory.abortCalled).toBe(false);

      session.shutdown();

      expect(factory.abortCalled).toBe(true);
    });

    it("is idempotent (safe to call twice)", () => {
      session = createChatSession(createTestConfig(factory));
      session.sendMessage("test");
      session.shutdown();
      session.shutdown(); // should not throw
    });
  });

  // ── destroyChatSession ──

  describe("destroyChatSession", () => {
    it("stops adapter and aborts agent", () => {
      session = createChatSession(createTestConfig(factory));
      session.sendMessage("test");

      destroyChatSession(session);

      expect(session.adapter.isRunning()).toBe(false);
      expect(session.adapter.isConnected()).toBe(false);
      expect(factory.abortCalled).toBe(true);
    });
  });

  // ── Conversation Summary ──

  describe("getConversationSummary", () => {
    it("returns 'No messages sent.' when empty", () => {
      session = createChatSession(createTestConfig(factory));
      expect(session.getConversationSummary()).toBe("No messages sent.");
    });

    it("lists sent messages", () => {
      session = createChatSession(createTestConfig(factory));
      session.sendMessage("Hello");
      factory.complete();
      session.sendMessage("World");
      factory.complete();

      const summary = session.getConversationSummary();
      expect(summary).toContain("[1] Hello");
      expect(summary).toContain("[2] World");
    });

    it("truncates long messages in summary", () => {
      session = createChatSession(createTestConfig(factory));
      const longMsg = "A".repeat(200);
      session.sendMessage(longMsg);
      factory.complete();

      const summary = session.getConversationSummary();
      expect(summary).toContain("...");
      // Should be truncated to 100 chars + ...
      expect(summary.length).toBeLessThan(200);
    });
  });
});