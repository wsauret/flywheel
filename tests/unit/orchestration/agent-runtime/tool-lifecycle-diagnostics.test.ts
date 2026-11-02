import { expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { Effect, Exit, Scope } from "effect";

import { canonicalDirectory } from "../../../../src/infra/directory-authorities.js";
import { createTurnDispatcher } from "../../../../src/orchestration/agent-runtime/agent-loop-tools.js";
import { fixedTurnOutputBound } from "../../../../src/orchestration/agent-runtime/compaction/compaction-policy.js";
import { settleTurn } from "../../../../src/orchestration/agent-runtime/agent-turn-settlement.js";
import type { ToolCall } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import type { RuntimeTool, ToolContext } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { RequestToolMap } from "../../../helpers/request-tool-surface.js";

it("emits ordered tool lifecycle diagnostics when the trace is enabled", async () => {
  const root = canonicalDirectory(tmpdir(), "test project root");
  const context: ToolContext = {
    executionCwd: root,
    userDataRoot: `${root}/.test-account`, projectRoot: root,
    artifactScopeId: "test-session",
    retrievalSessionId: "test-session",
  };
  const tool: RuntimeTool = {
    name: "waiter",
    action: "shell_exec",
    description: "Return immediately",
    inputSchema: { type: "object" },
    isConcurrencySafe: true,
    execute: async () => ({ content: "finished", outcome: "ok" }),
  };
  const toolCall: ToolCall = { id: "tool_trace", name: tool.name, input: {} };
  const turnScope = Scope.makeUnsafe();
  const dispatcher = createTurnDispatcher({
    tools: new RequestToolMap([[tool.name, tool]]),
    toolContext: context,
    signal: undefined,
    background: undefined,
    turnScope,
    afterToolCall: undefined,
    onEvent: () => {},
    artifactScopeId: "test-session",
    outputBound: fixedTurnOutputBound(undefined),
  });
  const previous = process.env.FLYWHEEL_TOOL_LIFECYCLE_TRACE;
  const originalWrite = process.stderr.write;
  const chunks: string[] = [];
  process.env.FLYWHEEL_TOOL_LIFECYCLE_TRACE = "1";
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    dispatcher.onToolUse(toolCall);
    await Effect.runPromise(settleTurn({
      dispatcher,
      stream: () => Promise.resolve(),
      commitAssistant: () => [toolCall],
      commitResults: async () => {},
      onEvent: () => {},
      publishTerminal: () => {},
      publishSettlement: () => {},
    }));
  } finally {
    await Effect.runPromise(Scope.close(turnScope, Exit.void));
    process.stderr.write = originalWrite;
    if (previous === undefined) delete process.env.FLYWHEEL_TOOL_LIFECYCLE_TRACE;
    else process.env.FLYWHEEL_TOOL_LIFECYCLE_TRACE = previous;
  }

  const phases = chunks
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.startsWith("FLYWHEEL_TOOL_LIFECYCLE "))
    .map((line) => JSON.parse(line.slice("FLYWHEEL_TOOL_LIFECYCLE ".length)).phase);
  expect(phases).toEqual([
    "registration-started",
    "fiber-entered",
    "stream-gate-released",
    "registered",
    "admission-wait",
    "admitted",
    "handler-started",
    "permit-released",
    "handler-settled",
    "fiber-exited",
  ]);
});
