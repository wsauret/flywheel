import { expect, test } from "bun:test";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createProcessTool } from "../../../../../src/orchestration/agent-runtime/tools/process.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { makeCaptureClient } from "./_loop-fixtures.js";

const loopIdentity = { userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", providerSessionKey: "run-end", promptCacheKey: "run-end", artifactScopeId: "run-end", retrievalSessionId: "run-end" };

test("a run that completes on idle over a running service tells the model once that the service ends with the run, where it can launch one to persist", async () => {
  // The host's close ends every managed command once such a run completes,
  // so a server launched without persist_after_exit dies before later work.
  const end = { events: [{ kind: "text_delta" as const, text: "The server runs.", blockKey: "text" }, { kind: "done" as const, stopReason: "end_turn" as const }] };
  const run = async (persistable: boolean) => {
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "tool_use", toolCall: { id: "tc_1", name: "start", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      end,
      ...(persistable ? [end] : []),
    ]);
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const start: RuntimeTool = { name: "start", action: "shell_exec", description: "starts a service", inputSchema: { type: "object" }, isConcurrencySafe: true, execute: async () => {
      registry.track({ done: new Promise<BackgroundWorkResult>(() => {}), meta: { id: "bash-bg-1", type: "background_command", description: "bun server.ts" }, service: true });
      return { content: "Running in background as managed process bash-bg-1.", outcome: "ok" };
    } };
    const result = await runAgentLoop({
      client, tools: new RequestToolMap([[start.name, start], ["process", createProcessTool(registry)]]), systemPrompt: stableSystemPrompt("test"), instruction: "start the server",
      executionCwd: "/scratch", ...loopIdentity, completeOnIdle: {}, persistence: { history: { append: () => {} } }, seed: { kind: "fresh" },
      background: createBackgroundExecutionOwner(registry),
      persistentProcesses: { launch: async () => { throw new Error("unused"); }, list: async () => [], read: async () => { throw new Error("unused"); }, stop: async () => "already_exited", release: async () => {}, close: () => {} },
      allowPersistentProcesses: () => persistable,
      inputSource: { drainPending: () => null, prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }) },
      onEvent: () => {},
    });
    const notices = capturedMessages.flat().filter((message) => message.kind === "user" && typeof message.content === "string" && message.content.startsWith("[run-end notice]"));
    return { result, requests: capturedMessages.length, notices: [...new Set(notices.map((message) => message.content))] };
  };

  const persistable = await run(true);
  expect(persistable.result.kind).toBe("completed");
  expect(persistable.requests).toBe(3);
  expect(persistable.notices).toHaveLength(1);
  expect(persistable.notices[0]).toContain("- bash-bg-1: bun server.ts");
  expect(persistable.notices[0]).toContain("launch it again with persist_after_exit=true");
  const unpersistable = await run(false);
  expect(unpersistable.result.kind).toBe("completed");
  expect(unpersistable.requests).toBe(2);
  expect(unpersistable.notices).toEqual([]);
});
