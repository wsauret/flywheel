/**
 * Chat Session
 *
 * Manages the lifecycle of an ephemeral chat session that wires the harness
 * agent loop to the TUI adapter pipeline. Unlike WorkflowSession, ChatSession:
 *
 *   - Has NO TimerService (chat has no steps to time)
 *   - Has NO planPath (chat is freeform, not plan-driven)
 *   - Is never registered with the session manager (ephemeral)
 *   - Uses its own EventBus instance (can coexist with workflow sessions)
 *   - Only emits worker:output events through the bus (no queue/step lifecycle)
 *
 * ChatSession and WorkflowSession are explicitly sibling types, not sharing a
 * base interface. ChatSession is ephemeral and UI-focused; WorkflowSession is
 * persistent and orchestrator-managed.
 *
 * Init order:
 *   1. createStore("chat") — fresh store with chat display name
 *   2. new OpenTUIAdapter({ actions: store }) — adapter WITHOUT timer
 *   3. new EventBus() — fresh isolated event bus
 *   4. adapter.connect(bus) + adapter.start()
 *   5. Spawn harness agent loop, wire NDJSON output to bus via worker:output events
 */

import { EventBus } from "../../events/event-bus.js";
import { OpenTUIAdapter } from "../adapters/opentui.js";
import { createStore } from "../routes/work/context/ui-state/store.js";
import type { UIActions } from "../routes/work/context/ui-state/types.js";
import type { AgentLoopResult } from "../../harness/index.js";
import { Log } from "../../utils/log.js";

const log = Log.create({ service: "chat-session" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatSessionConfig {
  /**
   * Factory that spawns the agent loop for a given message.
   * Returns an object with:
   *   - result: Promise resolving when the agent loop completes
   *   - abort: function to cancel the running loop
   *   - onStdout: callback the factory should wire to emit NDJSON chunks
   *
   * The factory pattern decouples ChatSession from HarnessSpawner internals,
   * making the session testable without real API calls.
   */
  spawnAgent: (message: string, onStdout: (chunk: string) => void) => ChatAgentHandle;
}

export interface ChatAgentHandle {
  result: Promise<AgentLoopResult>;
  abort: () => void;
}

export interface ChatSession {
  store: UIActions;
  adapter: OpenTUIAdapter;
  eventBus: EventBus;
  sendMessage: (text: string) => void;
  shutdown: () => void;
  getConversationSummary: () => string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ephemeral chat session.
 *
 * The session wires a harness agent loop's NDJSON output through the TUI
 * adapter pipeline (NDJSONParser → StructuredEventParser → StructuredOutputBuilder).
 * Only worker:output events are emitted — no queue lifecycle, no step boundaries,
 * no timer. This keeps the chat path isolated from workflow lifecycle behaviors.
 */
export function createChatSession(config: ChatSessionConfig): ChatSession {
  const chatId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 1. Fresh store with chat display name (no plan path needed)
  const store = createStore("chat");

  // 2. Adapter WITHOUT timer — chat has no steps to time.
  //    Passing no timer means the adapter creates a private TimerService
  //    instance, but we never start it so it stays idle.
  const adapter = new OpenTUIAdapter({ actions: store });

  // 3. Fresh event bus (isolated from workflow sessions)
  const eventBus = new EventBus();

  // 4. Connect and start adapter
  adapter.connect(eventBus);
  adapter.start();

  // 5. Track active agent handle for abort/cleanup
  let activeAgent: ChatAgentHandle | null = null;
  const conversationTurns: string[] = [];

  function emitWorkerOutput(chunk: string): void {
    eventBus.emit({
      type: "worker:output",
      workflowId: chatId,
      stream: "stdout",
      data: chunk,
      timestamp: new Date().toISOString(),
      engineId: "harness",
    });
  }

  function sendMessage(text: string): void {
    if (!text.trim()) return;

    conversationTurns.push(text);
    log.info("chat message sent", { chatId, messageLength: text.length });

    // Mark workflow as running so the UI shows activity
    store.startWorkflow("chat");

    // Spawn agent and wire stdout to the event bus
    activeAgent = config.spawnAgent(text, emitWorkerOutput);

    activeAgent.result
      .then((result) => {
        log.info("chat agent completed", { chatId, status: result.status, turns: result.totalTurns });
        activeAgent = null;
      })
      .catch((err) => {
        log.error("chat agent error", { chatId, error: err instanceof Error ? err.message : String(err) });
        activeAgent = null;
      });
  }

  function shutdown(): void {
    log.info("chat session shutdown", { chatId });

    // Abort any running agent
    if (activeAgent) {
      activeAgent.abort();
      activeAgent = null;
    }

    // Stop and disconnect adapter (cleans up intervals)
    adapter.stop();
    adapter.disconnect();
  }

  function getConversationSummary(): string {
    if (conversationTurns.length === 0) return "No messages sent.";
    return conversationTurns
      .map((turn, i) => `[${i + 1}] ${turn.slice(0, 100)}${turn.length > 100 ? "..." : ""}`)
      .join("\n");
  }

  return {
    store,
    adapter,
    eventBus,
    sendMessage,
    shutdown,
    getConversationSummary,
  };
}

/**
 * Destroy a chat session.
 *
 * Shuts down the adapter and aborts any running agent.
 * Separate from ChatSession.shutdown() for symmetry with destroyWorkflowSession().
 */
export function destroyChatSession(session: ChatSession): void {
  session.shutdown();
}