// Drives the real agent loop with the real background work registry, the real
// process tool, and the real chat mailbox. A scripted model makes the tool
// calls; fake tools return ok or error. The tests observe only the
// repetition notices that reach the model in its requests, so they hold for
// any design that decides inside the runtime which waits count.
import { describe, expect, it } from "bun:test";

import { runAgentLoop } from "../src/orchestration/agent-runtime/agent-loop.js";
import { createBackgroundExecutionOwner } from "../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../src/orchestration/agent-runtime/background-work.js";
import type { AgentLoopTerminal } from "../src/orchestration/agent-runtime/agent-loop-types.js";
import { RunLifecycle } from "../src/orchestration/agent-runtime/run-lifecycle.js";
import { createProcessTool } from "../src/orchestration/agent-runtime/tools/process.js";
import type { RuntimeTool, ToolResult } from "../src/orchestration/agent-runtime/tools/types.js";
import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type ProviderStreamEvent, type StreamOptions } from "../src/orchestration/agent-runtime/llm/types.js";
import { stableSystemPrompt } from "../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { ChatTurnMailbox } from "../src/orchestration/chat/turn-mailbox.js";
import { asModelClient, RequestToolMap } from "./loop-harness.js";

type Call = { name: string; input: Record<string, unknown> };
type Turn = Call[] | "reply";

const NOTICE = "<repetition_notice>";

function fakeTool(name: string, outcome: "ok" | "error"): RuntimeTool {
  return {
    name, action: "shell_exec", description: name, inputSchema: { type: "object" }, isConcurrencySafe: true,
    execute: async (): Promise<ToolResult> => ({ content: outcome, outcome }),
  } as RuntimeTool;
}

/** Runs one scripted session. `running` is the number of background commands
 *  that are live when the session starts. Each time the loop parks while a
 *  command runs, the oldest command finishes and its completion notification
 *  wakes the loop. The first park with nothing running ends the session.
 *  Returns the number of repetition notices the model received. */
async function runSession(turns: readonly Turn[], running: number): Promise<number> {
  const mailbox = new ChatTurnMailbox();
  const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text, key) => mailbox.enqueueBackgroundNotification({ text, ...(key ? { key } : {}) }) });
  const commands = Array.from({ length: running }, (_, index) => {
    const command = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({ done: command.promise, meta: { id: `bash-bg-${index}`, type: "background_command", description: "build", notificationKey: `command:bash-bg-${index}` } });
    return command;
  });
  let finished = 0;
  let turnIndex = 0;
  let callCount = 0;
  const requests: ConversationMessage[][] = [];
  const client = asModelClient({
    accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION, contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      requests.push([...options.messages]);
      const turn = turns[turnIndex++];
      if (turn === undefined || turn === "reply") {
        yield { kind: "text_delta", text: "Done.", blockKey: `text-${turnIndex}` };
        yield { kind: "done", stopReason: "end_turn" };
        return;
      }
      for (const call of turn) yield { kind: "tool_use", toolCall: { id: `tc_${callCount++}`, name: call.name, input: call.input } };
      yield { kind: "done", stopReason: "tool_use" };
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  });
  const tools = new RequestToolMap([
    ["process", createProcessTool(registry)],
    ["Read", fakeTool("Read", "ok")],
    ["bash", fakeTool("bash", "error")],
  ]);
  await tools.resolve();
  const run = new RunLifecycle<AgentLoopTerminal>();
  run.start((signal) => runAgentLoop({
    client, tools, systemPrompt: stableSystemPrompt("test"),
    instruction: null, executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "nudge", promptCacheKey: "nudge", artifactScopeId: "nudge", retrievalSessionId: "nudge",
    seed: { kind: "resume", priorMessages: [{ kind: "user", content: "Build the project and report.", origin: "human" }] },
    persistence: { history: { append: () => {} } },
    background: createBackgroundExecutionOwner(registry), inputSource: mailbox, signal, currentTurn: run,
    scheduleWaitExpiry: () => () => {},
    lifecycle: {
      onTurnParked: () => {
        queueMicrotask(() => {
          const command = commands[finished];
          if (command) { finished++; command.resolve({ status: "completed", content: "exit 0" }); }
          else run.abort({ kind: "aborted" });
        });
      },
    },
    onEvent: () => {},
  }));
  await run.done;
  for (const command of commands) command.resolve({ status: "completed", content: "" });
  const last = JSON.stringify(requests.at(-1) ?? []);
  return last.split(NOTICE).length - 1;
}

const wait: Call = { name: "process", input: { action: "wait" } };
const waitWithTimeout: Call = { name: "process", input: { action: "wait", soft_timeout: 600 } };
const list: Call = { name: "process", input: { action: "list" } };
const readLog: Call = { name: "Read", input: { file_path: "/work/build.log" } };
const failingCommand: Call = { name: "bash", input: { command: "bun run missing-script" } };

describe("process waits on running background work", () => {
  it("three waits while three background commands finish, then a reply, get no notice", async () => {
    expect(await runSession([[wait], [wait], [wait], "reply"], 3)).toBe(0);
  });

  it("four waits with a timeout while four background commands finish, then a reply, get no notice", async () => {
    expect(await runSession([[waitWithTimeout], [waitWithTimeout], [waitWithTimeout], [waitWithTimeout], "reply"], 4)).toBe(0);
  });

  it("an earlier notice for a repeated read is not followed by another notice after waits on running work", async () => {
    expect(await runSession([[readLog, readLog, readLog], [wait], [wait], [wait], "reply"], 3)).toBe(1);
  });
});

describe("regression guards: real loops still get the notice", () => {
  it("regression guard (an exemption for every wait): three waits with nothing running", async () => {
    expect(await runSession([[wait], [wait], [wait], "reply"], 0)).toBeGreaterThan(0);
  });

  it("regression guard (a lasting exemption once work ran): four waits after the only command finished", async () => {
    expect(await runSession([[wait], [wait], [wait], [wait], "reply"], 1)).toBeGreaterThan(0);
  });

  it("regression guard (an exemption that hides other calls): the same failing command retried between waits on running work", async () => {
    expect(await runSession([[failingCommand, wait], [failingCommand, wait], [failingCommand, wait], "reply"], 3)).toBeGreaterThan(0);
  });

  it("regression guard (an exemption for every process action): the same process list repeated while work runs", async () => {
    expect(await runSession([[list], [list], [list], "reply"], 3)).toBeGreaterThan(0);
  });
});
