// Drives the real agent loop and the real workflow loop-observer wiring with a
// scripted model, fake background work, and fake tools. The tests observe only
// the nudges that the observers enqueue for the agent, so any turn context the
// loop passes to the repetition guard is the one production passes.
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";

import { runAgentLoop } from "../src/orchestration/agent-runtime/agent-loop.js";
import { messageInput, type AgentLoopInput } from "../src/infra/agent-loop-events.js";
import { createRepetitionGuard } from "../src/orchestration/agent-runtime/doom-loop.js";
import { createObserverChain } from "../src/orchestration/agent-runtime/stream-observers.js";
import { createWorkflowLoopObservers } from "../src/orchestration/workflow-host/loop-observers.js";
import type { RuntimeTool, ToolResult } from "../src/orchestration/agent-runtime/tools/types.js";
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ProviderStreamEvent, type StreamOptions } from "../src/orchestration/agent-runtime/llm/types.js";
import { stableSystemPrompt } from "../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { asModelClient, RequestToolMap } from "./loop-harness.js";

type Call = { name: string; input: Record<string, unknown> };
type Turn = Call[] | "reply";

const NUDGE = "Doom loop detected";

function fakeTool(name: string, outcome: "ok" | "error"): RuntimeTool {
  return {
    name, action: "shell_exec", description: name, inputSchema: { type: "object" }, isConcurrencySafe: true,
    execute: async (): Promise<ToolResult> => ({ content: outcome, outcome }),
  } as RuntimeTool;
}

/** Runs one scripted session. `running` is the number of background tasks
 *  (builds or subagents) that are live when the session starts. Each time the
 *  loop parks for background input, one task finishes and its completion
 *  notification wakes the loop. Returns every nudge enqueued for the agent. */
async function runSession(turns: readonly Turn[], running: number): Promise<string[]> {
  let live = running;
  let turnIndex = 0;
  let callCount = 0;
  const nudges: string[] = [];
  const pending: AgentLoopInput[] = [];
  const chain = createObserverChain([createRepetitionGuard()]);
  const observers = createWorkflowLoopObservers({
    injectionQueue: { enqueue: (message: string) => { nudges.push(message); }, onDrain: () => {} } as never,
    observerChain: chain,
    backgroundTasks: { activeTaskCount: () => live, assertHandoffReady: () => true, clearPending: () => {} } as never,
    emit: (() => {}) as never,
    sessionId: "s",
  });
  const client = asModelClient({
    accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION, contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    async *streamWithTools(_options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      const turn = turns[turnIndex++];
      if (turn === undefined || turn === "reply") {
        // The workflow host maps an assistant text message to this event.
        chain.onEvent({ type: "text" });
        yield { kind: "text_delta", text: "done", blockKey: `t${turnIndex}` };
        yield { kind: "done", stopReason: "end_turn" };
        return;
      }
      for (const call of turn) {
        const id = `tc_${callCount++}`;
        // The workflow host maps each completed tool input to this event.
        chain.onEvent({ type: "tool_use", toolUseId: id, toolName: call.name, toolInput: call.input });
        yield { kind: "tool_use", toolCall: { id, name: call.name, input: call.input } };
      }
      yield { kind: "done", stopReason: "tool_use" };
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  } satisfies LLMClient);
  await runAgentLoop({
    client,
    tools: new RequestToolMap([
      ["process", fakeTool("process", "ok")],
      ["Read", fakeTool("Read", "ok")],
      ["bash", fakeTool("bash", "error")],
    ]),
    systemPrompt: () => stableSystemPrompt("test"),
    instruction: "work",
    executionCwd: tmpdir(), projectRoot: tmpdir(),
    providerSessionKey: "p", artifactScopeId: "p", retrievalSessionId: "p",
    persistence: { history: { append: () => {}, rewrite: () => {} } },
    seed: { kind: "fresh" },
    onEvent: () => {},
    background: { tasks: { activeTaskCount: () => live, holdsWait: () => false, flushSettledNotifications: () => {} } } as never,
    lifecycle: { onTurnEnded: (context) => observers.onTurnEnded(context) },
    inputSource: {
      drainPending: () => pending.shift() ?? null,
      enqueueSilentSystem: (text: string) => { pending.push(messageInput(text, { origin: "system" })); },
      prepareWaitForInput: () => ({
        commit: async () => {
          if (live === 0) return null;
          live--;
          return messageInput("[background task finished]", { origin: "system" });
        },
        cancel: async () => {},
      }),
    },
  } as never);
  return nudges;
}

const wait: Call = { name: "process", input: { action: "wait" } };
const waitWithLimit: Call = { name: "process", input: { action: "wait", limit: 100 } };
const list: Call = { name: "process", input: { action: "list" } };
const readLog: Call = { name: "Read", input: { file_path: "/work/build.log" } };
const failingCommand: Call = { name: "bash", input: { command: "bun run missing-script" } };

function nudgeCount(nudges: readonly string[]): number {
  return nudges.filter((message) => message.includes(NUDGE)).length;
}

describe("process waits on running background work", () => {
  it("three waits while three background tasks finish, then a reply, get no nudge", async () => {
    expect(nudgeCount(await runSession([[wait], [wait], [wait], "reply"], 3))).toBe(0);
  });

  it("four waits with a limit while four background tasks finish, then a reply, get no nudge", async () => {
    expect(nudgeCount(await runSession([[waitWithLimit], [waitWithLimit], [waitWithLimit], [waitWithLimit], "reply"], 4))).toBe(0);
  });

  it("an earlier nudge for a repeated read is not followed by another nudge after waits on running work", async () => {
    expect(nudgeCount(await runSession([[readLog, readLog, readLog], [wait], [wait], [wait], "reply"], 3))).toBe(1);
  });
});

describe("regression guards: real loops still get the nudge", () => {
  it("regression guard (an exemption for every wait): three waits with nothing running", async () => {
    expect(nudgeCount(await runSession([[wait], [wait], [wait], "reply"], 0))).toBeGreaterThan(0);
  });

  it("regression guard (a lasting exemption once work ran): three waits after the only task finished", async () => {
    expect(nudgeCount(await runSession([[wait], [wait], [wait], [wait], "reply"], 1))).toBeGreaterThan(0);
  });

  it("regression guard (an exemption that hides other calls): the same failing command retried between waits on running work", async () => {
    expect(nudgeCount(await runSession([[failingCommand, wait], [failingCommand, wait], [failingCommand, wait], "reply"], 3))).toBeGreaterThan(0);
  });

  it("regression guard (an exemption for every process action): the same process list repeated while work runs", async () => {
    expect(nudgeCount(await runSession([[list], [list], [list], "reply"], 3))).toBeGreaterThan(0);
  });
});
