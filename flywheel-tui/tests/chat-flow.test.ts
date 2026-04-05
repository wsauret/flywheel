import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  createChatController,
  type ChatControllerDeps,
  type ChatController,
  type ToastLike,
} from "../src/tui/shell/chat-controller";
import {
  createChatSession,
  destroyChatSession,
  type ChatSession,
  type ChatAgentHandle,
  type ChatSessionConfig,
} from "../src/tui/session/chat-session";
import {
  createInteractiveWorker,
  createToolRegistry,
} from "../src/harness";
import type {
  InteractiveWorkerOptions,
  LLMProvider,
  StreamEvent,
  StreamOptions,
} from "../src/harness";
import { createPromptHandler, type PromptHandlerDeps } from "../src/tui/shell/prompt-handler";
import {
  escapeForState,
  ctrlCForState,
  type AppState,
} from "../src/tui/shell/shell-modes";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";
import type { WorkState } from "../src/tui/types";
import type { ModelActivity } from "../src/tui/adapters/structured-output-builder";
import type { AgentLoopResult } from "../src/harness";

/**
 * Integration Test: Full Chat Flow
 *
 * Exercises the end-to-end chat lifecycle using mock providers (no real API calls):
 *   1. Boot → chatting state (ChatController.startChat with mock provider)
 *   2. Chat input → agent response → store updates (InteractiveWorker + ChatSession)
 *   3. /start command transitions to workflow mode (PromptHandler dispatch)
 *   4. Conversation summary captured on destroyChat()
 *   5. Restart chat after workflow completion (restartChat())
 *   6. Esc returns from chatting to idle
 *
 * This test integrates:
 *   - InteractiveWorker (mock LLM provider, no API key needed)
 *   - ChatSession (store, adapter, EventBus)
 *   - ChatController (lifecycle management)
 *   - PromptHandler (input routing)
 *   - Shell modes (state transitions)
 */

// ---------------------------------------------------------------------------
// Mock LLM provider (no real API calls)
// ---------------------------------------------------------------------------

function createMockProvider(
  responses: Array<{ text?: string }>,
): LLMProvider {
  let callIndex = 0;
  return {
    async *stream(_options: StreamOptions): AsyncIterable<StreamEvent> {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      if (response.text) {
        yield { type: "text_delta", text: response.text };
      }
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 25 } };
      yield { type: "message_stop" };
    },
  };
}

function makeTestWorkerOptions(
  provider: LLMProvider,
  overrides: Partial<InteractiveWorkerOptions> = {},
): InteractiveWorkerOptions {
  const registry = createToolRegistry();
  return {
    model: "test-model",
    maxTurnsPerMessage: 5,
    cwd: "/tmp/test",
    _provider: provider,
    _registry: registry,
    _toolDefs: [],
    _systemPrompt: "You are a test assistant for integration testing.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// State tracker — collects all state transitions for assertions
// ---------------------------------------------------------------------------

interface StateTracker {
  appStates: AppState[];
  stores: Array<UIActions | null>;
  workStates: Array<WorkState | null>;
  modelActivities: ModelActivity[];
  toastMessages: string[];
  subscriptions: number;
  unsubscriptions: number;
}

function createStateTracker(): StateTracker {
  return {
    appStates: [],
    stores: [],
    workStates: [],
    modelActivities: [],
    toastMessages: [],
    subscriptions: 0,
    unsubscriptions: 0,
  };
}

function createTrackedDeps(
  tracker: StateTracker,
  overrides: Partial<ChatControllerDeps> = {},
): ChatControllerDeps {
  const toastShow = mock((opts: { message: string; variant: string }) => {
    tracker.toastMessages.push(opts.message);
  });
  const toast: ToastLike = { show: toastShow as ToastLike["show"] };

  return {
    setAppState: mock((state: AppState) => {
      tracker.appStates.push(state);
    }),
    setActiveStore: mock((store: UIActions | null) => {
      tracker.stores.push(store);
    }),
    setWorkState: mock((state: WorkState | null) => {
      tracker.workStates.push(state);
    }),
    subscribeToStore: mock((_store: UIActions) => {
      tracker.subscriptions++;
    }),
    unsubscribeStore: mock(() => {
      tracker.unsubscriptions++;
    }),
    setModelActivity: mock((activity: ModelActivity) => {
      tracker.modelActivities.push(activity);
    }),
    toast,
    getProjectCwd: () => "/tmp/test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Full chat lifecycle integration
// ---------------------------------------------------------------------------

describe("Integration: Full Chat Flow", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env["ANTHROPIC_API_KEY"];
    // Set a fake key so the ChatController's tryCreateWorker() succeeds
    process.env["ANTHROPIC_API_KEY"] = "test-integration-key-not-real";
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = originalApiKey;
    } else {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  // ── Phase 1: Boot into chatting state ──

  it("boots into chatting state via ChatController.startChat()", () => {
    const tracker = createStateTracker();
    const deps = createTrackedDeps(tracker);
    const controller = createChatController(deps);

    const started = controller.startChat();

    expect(started).toBe(true);
    expect(controller.isActive()).toBe(true);
    expect(tracker.appStates).toContain("chatting");
    expect(tracker.subscriptions).toBe(1);
    expect(tracker.modelActivities).toContain("idle");

    controller.dispose();
  });

  it("falls back to idle when API key is missing", () => {
    delete process.env["ANTHROPIC_API_KEY"];

    const tracker = createStateTracker();
    const deps = createTrackedDeps(tracker);
    const controller = createChatController(deps);

    const started = controller.startChat();

    expect(started).toBe(false);
    expect(controller.isActive()).toBe(false);
    expect(tracker.toastMessages.length).toBe(1);
    expect(tracker.toastMessages[0]).toContain("API_KEY");
  });

  // ── Phase 2: Chat input → agent response ──

  it("InteractiveWorker with mock provider sends message and receives response", async () => {
    const provider = createMockProvider([{ text: "Hello! I can help with that." }]);
    const chunks: string[] = [];
    const worker = createInteractiveWorker(
      makeTestWorkerOptions(provider, {
        onStdout: (chunk) => chunks.push(chunk),
      }),
    );

    await worker.sendMessage("What can you do?");

    // Verify NDJSON output was emitted
    expect(chunks.length).toBeGreaterThan(0);

    // Parse and verify text event
    const events = chunks.map((c) => JSON.parse(c.trim()));
    const textEvents = events.filter((e: Record<string, unknown>) => e.type === "assistant");
    expect(textEvents.length).toBeGreaterThan(0);

    // Verify completion event
    const completionEvents = events.filter((e: Record<string, unknown>) => e.type === "result");
    expect(completionEvents.length).toBe(1);

    // Verify conversation summary captures the message
    const summary = worker.getConversationSummary();
    expect(summary).toContain("What can you do?");

    worker.shutdown();
  });

  it("ChatSession routes agent output through the structured pipeline", async () => {
    // Use a mock spawn factory that simulates agent NDJSON output
    let capturedOnStdout: ((chunk: string) => void) | null = null;
    let resolveResult: ((r: AgentLoopResult) => void) | null = null;

    const spawnAgent = (_message: string, onStdout: (chunk: string) => void): ChatAgentHandle => {
      capturedOnStdout = onStdout;
      return {
        result: new Promise<AgentLoopResult>((resolve) => {
          resolveResult = resolve;
        }),
        abort: () => {},
      };
    };

    const session = createChatSession({ spawnAgent });

    // Send a message
    session.sendMessage("Tell me about testing");

    // Verify store is in running state
    expect(session.store.getState().workflowStatus).toBe("running");

    // Simulate agent emitting NDJSON text output
    capturedOnStdout!(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Testing is important"}]}}\n'
    );

    // Wait for adapter throttled processing
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Verify output blocks contain the text
    const state = session.store.getState();
    expect(state.outputBlocks.length).toBeGreaterThan(0);
    const textBlock = state.outputBlocks.find((b) => b.kind === "text");
    expect(textBlock).toBeDefined();
    if (textBlock?.kind === "text") {
      expect(textBlock.content).toContain("Testing is important");
    }

    // Complete the agent
    resolveResult!({ status: "completed", totalTurns: 1, totalUsage: { inputTokens: 50, outputTokens: 25 } });

    destroyChatSession(session);
  });

  // ── Phase 3: /start transitions to workflow mode ──

  it("/start command transitions from chatting to workflow dispatch", () => {
    const tracker = createStateTracker();
    const deps = createTrackedDeps(tracker);
    const controller = createChatController(deps);
    controller.startChat();

    expect(controller.isActive()).toBe(true);
    expect(tracker.appStates).toContain("chatting");

    // Set up prompt handler with chatting state and dispatch mock
    let currentAppState: AppState = "chatting";
    let dispatchCalled = false;
    let dispatchedWorkflow = "";

    const promptDeps: PromptHandlerDeps = {
      appState: () => currentAppState,
      workState: () => null,
      isSessionResumable: () => false,
      viewedSessionId: () => null,
      isInterrupted: () => false,
      activeStore: () => null,
      isQueueRunning: () => false,
      activeStdinHandleRef: { current: null },
      pendingInjection: { current: null },
      getActiveSession: () => null,
      getDepsOrWarn: () => null,
      toast: { show: mock(() => {}) },
      resumeSession: mock(() => {}),
      resumeWorkerWithMessage: mock(() => {}),
      sendChatMessage: mock((text: string) => {
        controller.sendMessage(text);
      }),
      dispatch: mock((workflow: string, _args: Record<string, string>) => {
        dispatchCalled = true;
        dispatchedWorkflow = workflow;
        return { stepLabel: "Plan", workflowName: workflow };
      }),
      setActiveStepLabel: mock(() => {}),
      setActiveWorkflowName: mock(() => {}),
    };

    const { handlePromptInput } = createPromptHandler(promptDeps);

    // Send a /start command — should route through dispatch, not chat
    handlePromptInput("/start build a REST API");

    expect(dispatchCalled).toBe(true);
    expect(dispatchedWorkflow).toBe("start");

    controller.dispose();
  });

  it("bare text in chatting state routes to sendChatMessage, not dispatch", () => {
    const tracker = createStateTracker();
    const deps = createTrackedDeps(tracker);
    const controller = createChatController(deps);
    controller.startChat();

    let chatMessageReceived = "";
    let dispatchCalled = false;

    const promptDeps: PromptHandlerDeps = {
      appState: () => "chatting" as AppState,
      workState: () => null,
      isSessionResumable: () => false,
      viewedSessionId: () => null,
      isInterrupted: () => false,
      activeStore: () => null,
      isQueueRunning: () => false,
      activeStdinHandleRef: { current: null },
      pendingInjection: { current: null },
      getActiveSession: () => null,
      getDepsOrWarn: () => null,
      toast: { show: mock(() => {}) },
      resumeSession: mock(() => {}),
      resumeWorkerWithMessage: mock(() => {}),
      sendChatMessage: mock((text: string) => {
        chatMessageReceived = text;
      }),
      dispatch: mock((_workflow: string, _args: Record<string, string>) => {
        dispatchCalled = true;
        return null;
      }),
      setActiveStepLabel: mock(() => {}),
      setActiveWorkflowName: mock(() => {}),
    };

    const { handlePromptInput } = createPromptHandler(promptDeps);
    handlePromptInput("What is the best testing framework?");

    expect(chatMessageReceived).toBe("What is the best testing framework?");
    expect(dispatchCalled).toBe(false);

    controller.dispose();
  });

  // ── Phase 4: destroyChat captures conversation summary ──

  it("destroyChat() captures conversation summary before workflow start", async () => {
    const tracker = createStateTracker();
    const deps = createTrackedDeps(tracker);
    const controller = createChatController(deps);
    controller.startChat();

    expect(controller.isActive()).toBe(true);

    // Summary of chat session (will be 'No messages sent.' since we don't
    // actually send through the real InteractiveWorker in this test)
    const summary = await controller.destroyChat();

    expect(typeof summary).toBe("string");
    expect(controller.isActive()).toBe(false);
    // Verify teardown happened
    expect(tracker.unsubscriptions).toBeGreaterThan(0);
  });

  // ── Phase 5: Restart chat after workflow completion ──

  it("restartChat() creates a fresh session after workflow completion", () => {
    const tracker = createStateTracker();
    const deps = createTrackedDeps(tracker);
    const controller = createChatController(deps);

    // Start initial chat
    controller.startChat();
    expect(controller.isActive()).toBe(true);

    // Simulate workflow lifecycle: destroy → (workflow runs) → restart
    controller.dispose();
    expect(controller.isActive()).toBe(false);

    // Restart after workflow completion
    const restarted = controller.restartChat();
    expect(restarted).toBe(true);
    expect(controller.isActive()).toBe(true);

    // Should have set chatting state twice (once per startChat)
    const chattingCalls = tracker.appStates.filter((s) => s === "chatting");
    expect(chattingCalls.length).toBe(2);

    controller.dispose();
  });

  // ── Phase 6: Esc from chatting returns to idle ──

  it("Esc from chatting state maps to return-idle behavior", () => {
    // This tests the pure shell-modes logic that the keyboard controller uses
    const behavior = escapeForState("chatting");
    expect(behavior).toBe("return-idle");
  });

  it("Ctrl+C from chatting state maps to return-idle behavior", () => {
    const behavior = ctrlCForState("chatting");
    expect(behavior).toBe("return-idle");
  });

  // ── Phase 7: Multi-turn chat with mock provider (E2E through InteractiveWorker) ──

  it("multi-turn chat maintains conversation history across messages", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      async *stream(options: StreamOptions): AsyncIterable<StreamEvent> {
        callCount++;
        // Verify history grows with each turn
        if (callCount === 1) {
          expect(options.messages.length).toBe(1); // user only
        } else if (callCount === 2) {
          expect(options.messages.length).toBe(3); // user + assistant + user
        }
        yield { type: "text_delta", text: `Response ${callCount}` };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: "message_stop" };
      },
    };

    const worker = createInteractiveWorker(makeTestWorkerOptions(provider));

    await worker.sendMessage("First question");
    await worker.sendMessage("Follow-up question");

    expect(callCount).toBe(2);

    // Verify conversation summary includes both messages
    const summary = worker.getConversationSummary();
    expect(summary).toContain("First question");
    expect(summary).toContain("Follow-up question");

    worker.shutdown();
  });

  // ── Phase 8: Full lifecycle: boot → chat → workflow transition → restart ──

  it("full lifecycle: boot → chat → destroy → restart", async () => {
    const tracker = createStateTracker();
    const deps = createTrackedDeps(tracker);
    const controller = createChatController(deps);

    // Step 1: Boot into chatting
    const started = controller.startChat();
    expect(started).toBe(true);
    expect(controller.isActive()).toBe(true);
    expect(tracker.appStates[tracker.appStates.length - 1]).toBe("chatting");

    // Step 2: Destroy chat (simulating /start transition)
    const summary = await controller.destroyChat();
    expect(typeof summary).toBe("string");
    expect(controller.isActive()).toBe(false);

    // Step 3: Restart chat (simulating post-workflow return)
    const restarted = controller.restartChat();
    expect(restarted).toBe(true);
    expect(controller.isActive()).toBe(true);

    // Verify state transitions: chatting → (destroy) → chatting
    const chattingCalls = tracker.appStates.filter((s) => s === "chatting");
    expect(chattingCalls.length).toBe(2);

    controller.dispose();
  });

  // ── Phase 9: ChatSession event isolation ──

  it("chat session events do not leak to workflow event buses", () => {
    let resolveResult: ((r: AgentLoopResult) => void) | null = null;
    const spawnAgent = (_msg: string, _onStdout: (chunk: string) => void): ChatAgentHandle => ({
      result: new Promise<AgentLoopResult>((resolve) => { resolveResult = resolve; }),
      abort: () => {},
    });

    const session1 = createChatSession({ spawnAgent });
    const session2 = createChatSession({ spawnAgent });

    // Verify each session has its own event bus
    expect(session1.eventBus).not.toBe(session2.eventBus);

    // Events on session1 bus should not reach session2
    let session2EventCount = 0;
    session2.eventBus.subscribe(() => { session2EventCount++; });

    session1.sendMessage("test");

    expect(session2EventCount).toBe(0);

    destroyChatSession(session1);
    destroyChatSession(session2);
  });
});

// ---------------------------------------------------------------------------
// Tests: State machine transitions integration
// ---------------------------------------------------------------------------

describe("Integration: State machine transitions across chat lifecycle", () => {
  it("all AppState values have defined escape and ctrl-c behaviors", () => {
    const states: AppState[] = ["idle", "chatting", "working", "completed"];
    for (const state of states) {
      expect(() => escapeForState(state)).not.toThrow();
      expect(() => ctrlCForState(state)).not.toThrow();
    }
  });

  it("chatting escape/ctrl-c both return to idle", () => {
    expect(escapeForState("chatting")).toBe("return-idle");
    expect(ctrlCForState("chatting")).toBe("return-idle");
  });

  it("completed returns to chat on escape (not idle)", () => {
    expect(escapeForState("completed")).toBe("return-chat");
  });

  it("idle exits TUI on escape", () => {
    expect(escapeForState("idle")).toBe("exit-tui");
  });
});

// ---------------------------------------------------------------------------
// Tests: Prompt routing integration
// ---------------------------------------------------------------------------

describe("Integration: Prompt routing across AppStates", () => {
  function createMinimalPromptDeps(
    appState: AppState,
    overrides: Partial<PromptHandlerDeps> = {},
  ): PromptHandlerDeps {
    return {
      appState: () => appState,
      workState: () => null,
      isSessionResumable: () => false,
      viewedSessionId: () => null,
      isInterrupted: () => false,
      activeStore: () => null,
      isQueueRunning: () => false,
      activeStdinHandleRef: { current: null },
      pendingInjection: { current: null },
      getActiveSession: () => null,
      getDepsOrWarn: () => null,
      toast: { show: mock(() => {}) },
      resumeSession: mock(() => {}),
      resumeWorkerWithMessage: mock(() => {}),
      sendChatMessage: mock(() => {}),
      dispatch: mock(() => ({ stepLabel: "Step", workflowName: "work" })),
      setActiveStepLabel: mock(() => {}),
      setActiveWorkflowName: mock(() => {}),
      ...overrides,
    };
  }

  it("chatting: bare text goes to chat, slash command goes to dispatch", () => {
    const sendChatMessage = mock(() => {});
    const dispatch = mock(() => ({ stepLabel: "Step", workflowName: "start" }));

    const deps = createMinimalPromptDeps("chatting", { sendChatMessage, dispatch });
    const { handlePromptInput } = createPromptHandler(deps);

    // Bare text → chat
    handlePromptInput("help me with testing");
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();

    // Slash command → dispatch
    handlePromptInput("/start new feature");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sendChatMessage).toHaveBeenCalledTimes(1); // still 1
  });

  it("idle: slash command goes to dispatch, bare text shows error", () => {
    const toastShow = mock(() => {});
    const dispatch = mock(() => ({ stepLabel: "Step", workflowName: "work" }));

    const deps = createMinimalPromptDeps("idle", {
      dispatch,
      toast: { show: toastShow as ToastLike["show"] },
    });
    const { handlePromptInput } = createPromptHandler(deps);

    // Slash command → dispatch
    handlePromptInput("/work tests/fixture.md");
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Bare text → error toast
    handlePromptInput("just some text");
    expect(toastShow).toHaveBeenCalled();
  });

  it("chatting: empty input is ignored", () => {
    const sendChatMessage = mock(() => {});
    const deps = createMinimalPromptDeps("chatting", { sendChatMessage });
    const { handlePromptInput } = createPromptHandler(deps);

    handlePromptInput("");
    handlePromptInput("   ");

    expect(sendChatMessage).not.toHaveBeenCalled();
  });
});