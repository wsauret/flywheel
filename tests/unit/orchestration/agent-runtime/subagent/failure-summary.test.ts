/**
 * Integration test for the subagent failure-summary path.
 *
 * Drives a mock runner that emits real `assistant` (with `tool_use` blocks)
 * and `result` events through the actual stream filter, then resolves with
 * a failure. Confirms the captured turn log reaches `summarizeOnFailure`
 * and the resulting summary is appended to the parent's tool_result.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { rmSync } from "node:fs";

import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { createSubagentTool } from "../../../../../src/orchestration/modules/subagents/tool.js";
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js";
import type { AgentRunResult, AgentRunTerminal, Agent, AgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js";
import { createNotificationCapture, makeContext, makeDeps, TEST_RATIONALE } from "./_fixtures.js";
import { asModelClient } from "../_model-client.js";
import { roleCapture } from "../../../../helpers/role-capture.js";
import type { StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { asAsyncEventWriter, type EventStore } from "../../../../../src/infra/event-store-types.js";
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { newTestRunner } from "../../../../helpers/agent-runner.js";

const temporaryDirectory = temporaryDirectories();
const stores: EventStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

interface UnknownRecord { [key: string]: unknown }

interface FailingRunnerOpts {
  toolUses?: Array<{ id: string; name: string; input: UnknownRecord }>;
  toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
  terminal?: AgentRunTerminal;
}

function makeFailingRunnerFactory(opts: FailingRunnerOpts) {
  const factory = (options: AgentOptions): Agent => {
    const { promise, resolve } = Promise.withResolvers<AgentRunResult>();
    const parentToolUseId = options.purpose.kind === "subagent" ? options.purpose.parentToolUseId : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      send(_text: string): void {
        timer = setTimeout(() => runFailingRunnerScript(opts, options, parentToolUseId, resolve), 0);
      },
      end() { clearTimeout(timer); },
      abort() { clearTimeout(timer); resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }); },
      done: promise,
    };
  };
  return { factory };
}

function runFailingRunnerScript(
  opts: FailingRunnerOpts,
  options: AgentOptions,
  parentToolUseId: string | undefined,
  resolve: (result: AgentRunResult) => void,
): void {
  emitFailingRunnerToolUses(opts, options, parentToolUseId);
  emitFailingRunnerToolResults(opts, options, parentToolUseId);
  options.onEvent(createRuntimeEvent("model.turn.completed", {
    type: "model.turn.completed",
    subtype: "success",
    session_id: "agent-mock",
    total_cost_usd: 0.001,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
  }));
  resolve({ servedRequests: 0,
    durationMs: 1,
    providerSessionKey: "agent-mock",
    terminal: opts.terminal ?? { kind: "completed" },
  });
}

function emitFailingRunnerToolUses(
  opts: FailingRunnerOpts,
  options: AgentOptions,
  parentToolUseId: string | undefined,
): void {
  if (!opts.toolUses?.length) return;
  // Mirror the real stream shape: a placeholder assistant message with
  // input: {} followed by tool.input.completed carrying the real arguments
  // (runner-stream-events.ts). The filter records tool uses off the latter.
  options.onEvent(createRuntimeEvent("model.assistant_message.recorded", {
    type: "model.assistant_message.recorded",
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    message: {
      content: opts.toolUses.map((u) => ({ type: "tool_use", id: u.id, name: u.name, input: {} })),
      usage: { input_tokens: 100 },
    },
  }));
  for (const u of opts.toolUses) {
    options.onEvent(createRuntimeEvent("tool.input.completed", {
      type: "tool.input.completed",
      model_request_id: "failure-summary-request",
      tool_use: {
        id: u.id,
        name: u.name,
        provider_call_id: u.id,
        provider_tool_name: u.name,
        executable_tool_name: u.name,
        input: u.input,
        execution: { mode: "foreground", trace_kind: "tool" },
      },
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }));
  }
}

function emitFailingRunnerToolResults(
  opts: FailingRunnerOpts,
  options: AgentOptions,
  parentToolUseId: string | undefined,
): void {
  for (const tr of opts.toolResults ?? []) {
    options.onEvent(createRuntimeEvent("tool.result.recorded", {
      type: "tool.result.recorded",
      tool_use_id: tr.toolUseId,
      content: [{ type: "text", text: tr.content }],
      is_error: tr.isError ?? false,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }));
  }
}

describe("subagent failure summary integration", () => {
  it("captures tool_use + tool_result events into the turn log and appends summary on failure", async () => {
    const { factory } = makeFailingRunnerFactory({
      toolUses: [
        { id: "tool_1", name: "read", input: { path: "src/foo.ts" } },
        { id: "tool_2", name: "edit", input: { path: "src/foo.ts" } },
        { id: "tool_3", name: "bash", input: { command: "bun run test" } },
      ],
      toolResults: [
        { toolUseId: "tool_1", content: "file contents..." },
        { toolUseId: "tool_2", content: "diff applied" },
        { toolUseId: "tool_3", content: "1 test failed", isError: true },
      ],
      terminal: { kind: "context_overflow" },
    });
    const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}-${Math.random()}`);

    const notification = createNotificationCapture();
    const store = createSqliteEventStore(path.join(temporaryDirectory("failure-summary-"), "flywheel.sqlite"));
    stores.push(store);
    const deps = makeDeps({
      sessionDir,
      createRunner: factory,
      backgroundTasks: notification.backgroundTasks,
      sessionEventWriter: createSessionFactWriter({ sessionId: "test-child", writer: asAsyncEventWriter(store) }),
    });
    let requestedModel: string | undefined;
    let requestedEffort: StreamOptions["reasoningEffort"];
    const createLLMClient = async (model: string) => {
      requestedModel = model;
      return asModelClient({
        accessProvider: "anthropic_api",
        modelFamily: "anthropic",
        model,
        contextLimit: 200_000,
        outputLimit: 8_192,
        supportsReasoning: false,
        promptNotes: { progress: "", modelNotes: "" },
        availableModels: undefined,
        async *streamWithTools(options) {
          requestedEffort = options.reasoningEffort;
          yield { kind: "text_delta", text: `{"summary":"Tried to edit src/foo.ts and ran the test suite; aborted on context overflow."}`, blockKey: "text" };
          yield { kind: "done", stopReason: "end_turn" };
        },
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
      });
    };
    const capture = async () => ({
      ...roleCapture(["claude-haiku-5.5"], { "subagent-summary": { model: "lost-model", effort: "high" } }),
      admit: () => ({ createLLMClient, createAgent: factory }),
    });
    const summaryPurposes: string[] = [];
    const tool = createSubagentTool({
      ...deps,
      captureProviderConnection: capture,
      // The summary is a side call that runs through the real runtime; the child is scripted.
      createRunner: (options) => {
        if (options.purpose.kind !== "subagent-failure-summary") return factory(options);
        summaryPurposes.push(options.purpose.kind);
        return newTestRunner({ ...options, agentsMd: "", resolveEnvSnapshot: undefined }, createLLMClient, undefined, capture);
      },
    }, () => true);

    await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "fix the test" }, {
      ...makeContext({ toolUseId: "tc_root" }),
      userDataRoot: "/scratch/test-account",
      retrievalSessionId: "test-session",
    });
    await notification.next;

    expect(notification.read()).toContain("<status>failed</status>");
    expect(notification.read()).toContain("Subagent 'explorer' (explorer) failed: Context window exceeded");
    expect(notification.read()).toContain("Tried to edit src/foo.ts");
    expect(summaryPurposes).toEqual(["subagent-failure-summary"]);
    expect(requestedModel).toBe("claude-haiku-5.5");
    expect(requestedEffort).toBe("low");

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("does not invoke summarizer when the run is user-aborted", async () => {
    const { factory } = makeFailingRunnerFactory({
      toolUses: [{ id: "tool_1", name: "bash", input: { command: "echo hi" } }],
      toolResults: [{ toolUseId: "tool_1", content: "hi" }],
      terminal: { kind: "aborted" },
    });
    const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}-${Math.random()}`);

    let summarizerCalled = false;
    const summarizeOnFailure = async (): Promise<string> => {
      summarizerCalled = true;
      return "should not appear";
    };

    const notification = createNotificationCapture();
    const deps = makeDeps({
      sessionDir,
      createRunner: factory,
      summarizeOnFailure,
      backgroundTasks: notification.backgroundTasks,
    });
    const tool = createSubagentDispatch(deps);

    await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "do stuff" }, makeContext({ toolUseId: "tc_abort" }));
    expect(notification.backgroundTasks.terminate("tc_abort")).toBe(true);
    await notification.next;

    expect(summarizerCalled).toBe(false);
    expect(notification.read()).not.toContain("should not appear");
    expect(notification.read()).toContain("<status>stopped</status>");

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("ships base failure message unchanged when summarizer throws", async () => {
    const { factory } = makeFailingRunnerFactory({
      toolUses: [
        { id: "tool_1", name: "read", input: { path: "a.ts" } },
        { id: "tool_2", name: "read", input: { path: "b.ts" } },
      ],
      toolResults: [
        { toolUseId: "tool_1", content: "contents a" },
        { toolUseId: "tool_2", content: "contents b" },
      ],
      terminal: { kind: "api_error", message: "rate limited", recovery: { kind: "none" } },
    });
    const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}-${Math.random()}`);

    const summarizeOnFailure = async (): Promise<string> => {
      throw new Error("cheap-tier client unavailable");
    };

    const notification = createNotificationCapture();
    const deps = makeDeps({
      sessionDir,
      createRunner: factory,
      summarizeOnFailure,
      backgroundTasks: notification.backgroundTasks,
    });
    const tool = createSubagentDispatch(deps);

    await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look at files" }, makeContext({ toolUseId: "tc_err" }));
    await notification.next;

    expect(notification.read()).toContain("Subagent 'explorer' (explorer) failed: Rate limited: The model provider is rate-limiting requests")
    expect(notification.read()).toContain("<status>failed</status>");
    // Summary is absent because the summarizer threw and we drop it gracefully
    expect(notification.read()).not.toContain("## Work completed");

    rmSync(sessionDir, { recursive: true, force: true });
  });
});
