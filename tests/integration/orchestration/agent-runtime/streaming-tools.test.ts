import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Exit, Scope } from "effect";

import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js";
import type { AnyBlock, ToolEntry } from "../../../../src/infra/output-blocks.js";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js";
import { createTurnDispatcher, type ToolBatchEvent } from "../../../../src/orchestration/agent-runtime/agent-loop-tools.js";
import { fixedTurnOutputBound } from "../../../../src/orchestration/agent-runtime/compaction/compaction-policy.js";
import { settleTurn } from "../../../../src/orchestration/agent-runtime/agent-turn-settlement.js";
import { emitAssistant, emitToolInputComplete, emitToolInputDelta, emitToolResult, emitToolResultAvailable } from "../../../../src/orchestration/agent-runtime/emit.js";
import type { ConversationMessage, LLMClient, ProviderStreamEvent, ToolCall } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import type { RuntimeTool, ToolContext } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { createOutputSession, type OutputSession } from "../../../../src/orchestration/runner/output-session.js";
import { recoverFinalizedToolResultCheckpoints } from "../../../../src/orchestration/session/finalized-tool-result-checkpoint.js";
import { createSessionManager } from "../../../../src/orchestration/session/manager.js";
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js";
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/conversation-tree-writer.js";
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js";
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection.js";
import {
  createEagerToolVisibilityProvider,
  EAGER_INPUT_PREFIX,
  EAGER_PROVIDER_MODEL,
  EAGER_SLOW_TOOL_USE_ID,
  EAGER_WRITE_TOOL_USE_ID,
  FINALIZED_RESULT_CRASH_MODE,
} from "../../../helpers/eager-tool-visibility-provider.js";

const CRASH_HELPER = join(import.meta.dir, "..", "..", "..", "helpers", "eager-tool-visibility-provider.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flywheel-${label}-`));
  roots.push(root);
  return root;
}

function toolBlock(blocks: readonly AnyBlock[], id: string): ToolEntry | undefined {
  const block = blocks.find((candidate) => candidate.kind === "tool" && candidate.id === id);
  return block?.kind === "tool" ? block : undefined;
}

function runtimeTool(name: string, execute: RuntimeTool["execute"]): RuntimeTool {
  return { name, action: "shell_exec", description: `${name} fixture`, inputSchema: {}, isConcurrencySafe: true, execute };
}

function publishProviderEvent(output: OutputSession, event: ProviderStreamEvent, calls: ToolCall[]): void {
  if (event.kind === "tool_input_start") {
    emitAssistant(output.dispatchRuntimeEvent, [{ type: "tool_use", id: event.toolUseId, name: event.name, input: {} }]);
  } else if (event.kind === "tool_input_delta") {
    emitToolInputDelta(output.dispatchRuntimeEvent, event.toolUseId, event.partialJson);
  } else if (event.kind === "tool_use") {
    calls.push(event.toolCall);
    emitToolInputComplete(output.dispatchRuntimeEvent, event.toolCall);
  }
}

async function drainProviderTurn(
  client: LLMClient,
  output: OutputSession,
  messages: readonly ConversationMessage[],
  calls: ToolCall[],
): Promise<void> {
  for await (const event of client.streamWithTools({ messages: [...messages], tools: [
    { name: "write", description: "write fixture", input_schema: {} },
    { name: "bash", description: "controlled sibling fixture", input_schema: {} },
  ], systemPrompt: stableSystemPrompt(""), model: EAGER_PROVIDER_MODEL })) publishProviderEvent(output, event, calls);
}

async function waitForReady(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("READY\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`crash fixture exited before READY: ${await new Response(child.stderr).text()}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
}

describe("deterministic provider streaming and recovery", () => {
  it("projects create, replace, and multifile patch proposals from provider deltas without preview I/O or raw bodies", () => {
    const root = temporaryRoot("streaming-file-proposals");
    const cases = [
      {
        id: "create",
        name: "write",
        partial: '{"path":"missing/new.ts","content":"export const draft = 1',
        input: { path: "missing/new.ts", content: "export const finalValue = 2\n" },
        expected: { fileChangeKind: "create", files: [{ path: "missing/new.ts", action: "add" }] },
      },
      {
        id: "replace",
        name: "edit",
        partial: '{"path":"missing/edit.ts","old_string":"before\\n","new_string":"after',
        input: { path: "missing/edit.ts", old_string: "before\n", new_string: "after\n" },
        expected: { fileChangeKind: "replace", files: [{ path: "missing/edit.ts", action: "update" }] },
      },
      {
        id: "patch",
        name: "apply_patch",
        partial: '{"input":"*** Begin Patch\\n*** Add File: first.ts\\n+one\\n*** Update File: second.ts\\n@@\\n-old\\n+new',
        input: { input: "*** Begin Patch\n*** Add File: first.ts\n+one\n*** Update File: second.ts\n@@\n-old\n+new\n*** End Patch\n" },
        expected: { fileChangeKind: "patch", files: [{ path: "first.ts", action: "add" }, { path: "second.ts", action: "update" }] },
      },
    ] as const;

    for (const testCase of cases) {
      const updates: Array<NonNullable<Parameters<typeof createOutputSession>[0]["updateEntry"]> extends (patch: infer P) => void ? P : never> = [];
      const output = createOutputSession({ executionCwd: root, updateEntry: (patch) => { updates.push(patch); } });
      try {
        emitAssistant(output.dispatchRuntimeEvent, [{ type: "tool_use", id: testCase.id, name: testCase.name, input: {} }]);
        emitToolInputDelta(output.dispatchRuntimeEvent, testCase.id, testCase.partial);
        output.flush();

        const partial = updates.at(-1)?.streamingToolText?.[testCase.id];
        expect(partial?.proposedDiff).toMatchObject({ files: testCase.expected.files });
        const streaming = toolBlock(output.getBlocks(), testCase.id);
        expect(streaming).toMatchObject({ status: "streaming" });
        expect(streaming).not.toHaveProperty("content");
        expect(streaming).not.toHaveProperty("invocationBody");
        expect(streaming).not.toHaveProperty("proposedDiff");

        emitToolInputComplete(output.dispatchRuntimeEvent, {
          id: testCase.id,
          name: testCase.name,
          input: testCase.input,
          modelRequestId: "request",
        });
        output.flush();
        expect(toolBlock(output.getBlocks(), testCase.id)).toMatchObject({
          status: "pending",
          fileChangeKind: testCase.expected.fileChangeKind,
          proposedDiff: { files: testCase.expected.files },
        });
        expect(updates.at(-1)?.streamingToolText ?? {}).toEqual({});
      } finally {
        output.dispose();
      }
    }
  });

  it("retains interrupted proposals in the same process and reconstructs only completed canonical input after restart", async () => {
    const root = temporaryRoot("streaming-proposal-recovery");
    const output = createOutputSession({ executionCwd: root, updateEntry: () => {} });
    emitAssistant(output.dispatchRuntimeEvent, [{ type: "tool_use", id: "partial", name: "write", input: {} }]);
    emitToolInputDelta(output.dispatchRuntimeEvent, "partial", '{"path":"partial.ts","content":"transient bytes');
    output.endTurn("paused");
    expect(toolBlock(output.getBlocks(), "partial")).toMatchObject({
      status: "interrupted",
      proposedDiff: { files: [{ path: "partial.ts", action: "add" }] },
    });
    output.dispose();

    const store = createSqliteEventStore(resolveEventStoreDbFile(root));
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store });
    const sessionId = await manager.createChat({ name: "Proposal recovery" });
    const conversationId = (await manager.listMetadata()).sessions.find((session) => session.id === sessionId)?.conversationId;
    if (!conversationId) throw new Error("missing proposal recovery conversation");
    const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
    if (!tree) throw new Error("missing proposal recovery tree");
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn({ kind: "user", content: "write files" });
    writer.beginTurn();

    const transientOnly = createOutputSession({ executionCwd: root, updateEntry: () => {} });
    emitAssistant(transientOnly.dispatchRuntimeEvent, [{ type: "tool_use", id: "lost", name: "write", input: {} }]);
    emitToolInputDelta(transientOnly.dispatchRuntimeEvent, "lost", '{"path":"lost.ts","content":"must not survive');
    transientOnly.dispose();
    expect(projectBlocksFromEntries(await tree.getBranch(), { executionCwd: root }).some((block) => block.kind === "tool" && block.id === "lost")).toBe(false);

    const canonicalInput = { path: "kept.ts", content: "canonical\n" };
    writer.enqueueMessage({ kind: "assistant", content: [{ type: "tool_use", id: "kept", name: "write", input: canonicalInput }] });
    await writer.flushSavePoint(new Set(["kept"]));
    await tree.getStorage().dispose();
    store.close();

    const reopenedStore = createSqliteEventStore(resolveEventStoreDbFile(root));
    const reopened = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(reopenedStore), writer: asAsyncEventWriter(reopenedStore) });
    if (!reopened) throw new Error("missing reopened proposal recovery tree");
    const reconstructed = toolBlock(projectBlocksFromEntries(await reopened.getBranch(), { executionCwd: root }), "kept");
    expect(reconstructed).toMatchObject({
      status: "interrupted",
      fileChangeKind: "create",
      proposedDiff: { files: [{ path: "kept.ts", action: "add" }] },
    });
    expect(JSON.stringify(await reopened.getBranch())).not.toContain("must not survive");
    await reopened.getStorage().dispose();
    reopenedStore.close();
  });

  it("keeps proposal identity and pending continuity for child, workflow, and all-at-once provider publication", () => {
    const root = temporaryRoot("streaming-proposal-surfaces");
    const output = createOutputSession({ executionCwd: root, updateEntry: () => {} });
    try {
      emitAssistant(output.dispatchRuntimeEvent, [{ type: "tool_use", id: "agent", name: "subagent", input: { description: "child" } }]);
      output.applyProjectionEvent({ type: "tool-use", toolUseId: "child-write", name: "write", input: {}, timestamp: 1, parentToolUseId: "agent" });
      output.applyProjectionEvent({ type: "tool-input-delta", toolUseId: "child-write", partialJson: '{"path":"child.ts","content":"draft', parentToolUseId: "agent" });
      output.applyProjectionEvent({ type: "tool-input-complete", toolUseId: "child-write", name: "write", input: { path: "child.ts", content: "final\n" }, timestamp: 2, parentToolUseId: "agent" });
      const group = output.getBlocks().find((block) => block.kind === "agentGroup");
      // A compact subagent row carries its proposed file as the change kind and
      // file link; the full proposal body stays out of the hidden child row.
      expect(group?.kind === "agentGroup" ? group.children : []).toEqual([
        expect.objectContaining({
          id: "child-write",
          status: "streaming",
          fileChangeKind: "create",
          linkUri: pathToFileURL(join(root, "child.ts")).href,
          presentation: expect.objectContaining({ detail: "child.ts" }),
        }),
      ]);
      expect(group?.kind === "agentGroup" ? group.children[0] : undefined).not.toHaveProperty("proposedDiff");

      output.pushDivider("Workflow step", 3);
      emitAssistant(output.dispatchRuntimeEvent, [{ type: "tool_use", id: "workflow-write", name: "write", input: {} }]);
      emitToolInputDelta(output.dispatchRuntimeEvent, "workflow-write", '{"path":"workflow.ts","content":"draft');
      emitToolInputComplete(output.dispatchRuntimeEvent, { id: "workflow-write", name: "write", input: { path: "workflow.ts", content: "final\n" } });
      expect(toolBlock(output.getBlocks(), "workflow-write")).toMatchObject({ id: "workflow-write", status: "pending", proposedDiff: { files: [{ path: "workflow.ts" }] } });

      emitAssistant(output.dispatchRuntimeEvent, [{
        type: "tool_use",
        id: "all-at-once",
        name: "write",
        input: { path: "complete.ts", content: "complete\n" },
      }]);
      expect(toolBlock(output.getBlocks(), "all-at-once")).toMatchObject({
        id: "all-at-once",
        status: "pending",
        proposedDiff: { files: [{ path: "complete.ts", action: "add" }] },
      });
    } finally {
      output.dispose();
    }
  });

  it("updates one streaming body in place and publishes the first result before its sibling", async () => {
    const root = temporaryRoot("streaming-tools");
    const provider = createEagerToolVisibilityProvider();
    const slowRelease = Promise.withResolvers<void>();
    const partialInputVisible = Promise.withResolvers<void>();
    const firstResultAvailable = Promise.withResolvers<void>();
    let streamedProposal: ToolEntry["proposedDiff"];
    const output = createOutputSession({
      executionCwd: root,
      updateEntry(patch) {
        streamedProposal = patch.streamingToolText?.[EAGER_WRITE_TOOL_USE_ID]?.proposedDiff;
        if (streamedProposal?.files[0]?.hunks[0]?.lines.some((line) => line.text.includes(EAGER_INPUT_PREFIX))) partialInputVisible.resolve();
      },
    });
    const store = createSqliteEventStore(resolveEventStoreDbFile(root));
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store });
    const sessionId = await manager.createChat({ name: "Streaming" });
    const conversationId = (await manager.listMetadata()).sessions.find((session) => session.id === sessionId)?.conversationId;
    if (!conversationId) throw new Error("missing fixture conversation");
    const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
    if (!tree) throw new Error("missing fixture tree");
    const treeWriter = createConversationTreeWriter({ tree });
    const factWriter = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) });
    const turnScope = Scope.makeUnsafe();

    try {
      await treeWriter.commitUserTurn({ kind: "user", content: "run both tools" });
      treeWriter.beginTurn();
      const client = await provider.createClient();
      const calls: ToolCall[] = [];
      const firstTurn = drainProviderTurn(client, output, (await tree.buildContext()).messages, calls);

      await partialInputVisible.promise;
      const streamingRow = toolBlock(output.getBlocks(), EAGER_WRITE_TOOL_USE_ID);
      expect(streamingRow).toMatchObject({ id: EAGER_WRITE_TOOL_USE_ID, status: "streaming" });
      expect(streamedProposal).toMatchObject({ files: [{ path: "fixture.txt", action: "add" }] });
      provider.releaseInput();
      await firstTurn;

      const completedInputRow = toolBlock(output.getBlocks(), EAGER_WRITE_TOOL_USE_ID);
      expect(completedInputRow?.id).toBe(streamingRow?.id);
      expect(completedInputRow).not.toHaveProperty("content");
      expect(completedInputRow).toMatchObject({
        status: "pending",
        proposedDiff: { files: [{ path: "fixture.txt", action: "add" }] },
      });
      expect(calls.map((call) => call.id)).toEqual([EAGER_WRITE_TOOL_USE_ID, EAGER_SLOW_TOOL_USE_ID]);
      expect(calls.map((call) => call.name)).toEqual(["write", "bash"]);

      const tools = new Map<string, RuntimeTool>([
        ["write", runtimeTool("write", async () => ({ content: "write completed", outcome: "ok", details: { displayContent: "write completed" } }))],
        ["bash", runtimeTool("bash", async () => { await slowRelease.promise; return { content: "slow completed", outcome: "ok" }; })],
      ]);
      const context: ToolContext = {
        executionCwd: root,
        userDataRoot: `${root}/.test-account`, projectRoot: root,
        artifactScopeId: "streaming-tools",
        retrievalSessionId: "streaming-tools",
        sessionEventWriter: factWriter,
        conversationId,
        flushCanonicalMessages: () => treeWriter.flushSavePoint(),
      };
      let conversationCommitted = false;
      const publish = (event: ToolBatchEvent): void => {
        if (event.kind === "tool_result_available") {
          emitToolResultAvailable(output.dispatchRuntimeEvent, event.toolUseId, event.content, event.outcome, event.details == null ? {} : { details: event.details });
          if (event.toolUseId === EAGER_WRITE_TOOL_USE_ID) firstResultAvailable.resolve();
          return;
        }
        if (event.kind === "tool_result") {
          emitToolResult((runtimeEvent) => {
            output.dispatchRuntimeEvent(runtimeEvent);
          }, event.toolUseId, event.content, event.outcome, event.details == null ? {} : { details: event.details });
        }
      };
      const dispatcher = createTurnDispatcher({
        tools,
        executionAdmission: (name) => tools.has(name) ? { ok: true } : { ok: false, refusal: { content: "missing", outcome: "error" } },
        toolContext: context,
        signal: undefined,
        background: undefined,
        turnScope,
        afterToolCall: undefined,
        onEvent: publish,
        artifactScopeId: sessionId,
        outputBound: fixedTurnOutputBound(8_192),
      });
      for (const call of calls) dispatcher.onToolUse(call);

      const settling = Effect.runPromise(settleTurn({
        dispatcher,
        stream: async () => calls,
        commitAssistant: () => {
          treeWriter.enqueueMessage({ kind: "assistant", content: calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })) });
          return calls;
        },
        commitAssistantBarrier: (assistantCalls) => treeWriter.flushSavePoint(new Set(assistantCalls.map((call) => call.id))),
        commitDisplayBarrier: async () => {},
        commitResults: async (results, published) => {
          for (const result of results) treeWriter.enqueueMessage({ kind: "toolResult", toolUseId: result.toolUseId, content: result.content, ...(result.outcome === "ok" ? {} : { isError: true }) });
          const checkpoints = store.readInFlight(sessionId, "finalized-tool-result");
          await treeWriter.flushSavePoint(undefined, published.map((call) => {
            const row = checkpoints.find((candidate) => candidate.key === `${conversationId}:${call.tc.id}`);
            if (!row) throw new Error(`missing checkpoint ${call.tc.id}`);
            return { kind: "finalized-tool-result", key: row.key, expectedRaw: row.raw };
          }));
          conversationCommitted = true;
        },
        onEvent: publish,
        publishTerminal: () => {},
        publishSettlement: () => {},
      }));

      await firstResultAvailable.promise;
      expect(toolBlock(output.getBlocks(), EAGER_WRITE_TOOL_USE_ID)).toMatchObject({ id: EAGER_WRITE_TOOL_USE_ID, status: "completed" });
      expect(toolBlock(output.getBlocks(), EAGER_SLOW_TOOL_USE_ID)?.status).not.toBe("completed");
      expect(conversationCommitted).toBe(false);
      expect(provider.requests).toHaveLength(1);
      expect(store.readInFlight(sessionId, "finalized-tool-result").map((row) => row.key)).toContain(`${conversationId}:${EAGER_WRITE_TOOL_USE_ID}`);
      expect(store.readInFlight(sessionId, "finalized-tool-result")
        .find((row) => row.key === `${conversationId}:${EAGER_WRITE_TOOL_USE_ID}`)?.payload)
        .toMatchObject({ budgetExempt: false, turnBudgetChars: 16_000 });

      slowRelease.resolve();
      await settling;
      await Effect.runPromise(Scope.close(turnScope, Exit.void));
      output.flush();
      expect(conversationCommitted).toBe(true);
      expect(store.readInFlight(sessionId, "finalized-tool-result")).toEqual([]);
      expect(output.getBlocks().filter((block) => block.kind === "tool" && block.id === EAGER_WRITE_TOOL_USE_ID)).toHaveLength(1);

      await tree.getStorage().dispose();
      store.close();
      const reopenedStore = createSqliteEventStore(resolveEventStoreDbFile(root));
      const reopened = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(reopenedStore), writer: asAsyncEventWriter(reopenedStore) });
      if (!reopened) throw new Error("missing reopened tree");
      const recoveredResults = (await reopened.buildContext()).messages.filter((message) => message.kind === "toolResult");
      expect(recoveredResults.map((message) => message.kind === "toolResult" ? message.toolUseId : "")).toEqual([EAGER_WRITE_TOOL_USE_ID, EAGER_SLOW_TOOL_USE_ID]);

      await drainProviderTurn(client, output, (await reopened.buildContext()).messages, []);
      expect(provider.requests).toHaveLength(2);
      const secondMessages = provider.requests[1]?.messages;
      expect(Array.isArray(secondMessages) ? secondMessages.filter((message) => typeof message === "object" && message !== null && "tool_call_id" in message).map((message) => message.tool_call_id) : []).toEqual([EAGER_WRITE_TOOL_USE_ID, EAGER_SLOW_TOOL_USE_ID]);
      await reopened.getStorage().dispose();
      reopenedStore.close();
    } finally {
      provider.releaseInput();
      slowRelease.resolve();
      provider.stop();
      output.dispose();
      factWriter.dispose();
    }
  }, 10_000);

  it("recovers a killed process after display facts but before budgeted history without rerunning", async () => {
    const root = temporaryRoot("streaming-crash");
    const dbPath = resolveEventStoreDbFile(root);
    const store = createSqliteEventStore(dbPath);
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store });
    const sessionId = await manager.createChat({ name: "Crash" });
    const conversationId = (await manager.listMetadata()).sessions.find((session) => session.id === sessionId)?.conversationId;
    if (!conversationId) throw new Error("missing crash conversation");
    const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
    if (!tree) throw new Error("missing crash tree");
    const treeWriter = createConversationTreeWriter({ tree });
    await treeWriter.commitUserTurn({ kind: "user", content: "run once" });
    treeWriter.beginTurn();
    treeWriter.enqueueMessage({ kind: "assistant", content: [{ type: "tool_use", id: EAGER_WRITE_TOOL_USE_ID, name: "write", input: { path: "fixture.txt", content: "once" } }] });
    await treeWriter.flushSavePoint(new Set([EAGER_WRITE_TOOL_USE_ID]));
    await tree.getStorage().dispose();
    store.close();

    const child = Bun.spawn([process.execPath, CRASH_HELPER, FINALIZED_RESULT_CRASH_MODE, dbPath, sessionId, conversationId, EAGER_WRITE_TOOL_USE_ID], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    await waitForReady(child);
    child.kill();
    expect(await child.exited).not.toBe(0);

    const reopenedStore = createSqliteEventStore(dbPath);
    const reopened = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(reopenedStore), writer: asAsyncEventWriter(reopenedStore) });
    if (!reopened) throw new Error("missing recovered crash tree");
    expect(reopenedStore.read({ aggregateId: `session:${sessionId}`, types: ["tool.result.recorded"] })).toHaveLength(1);
    expect((await reopened.buildContext()).messages.filter((message) => message.kind === "toolResult")).toHaveLength(0);
    expect(reopenedStore.readInFlight(sessionId, "finalized-tool-result")).toHaveLength(1);

    await recoverFinalizedToolResultCheckpoints({
      conversationId,
      sessionId,
      store: asAsyncEventReadSurface(reopenedStore),
      writer: asAsyncEventWriter(reopenedStore),
      tree: reopened,
    });

    const results = (await reopened.buildContext()).messages.filter((message) => message.kind === "toolResult");
    expect(results).toEqual([{ kind: "toolResult", toolUseId: EAGER_WRITE_TOOL_USE_ID, content: [{ type: "text", text: "executed exactly once" }] }]);
    expect(reopenedStore.read({ aggregateId: `session:${sessionId}`, types: ["tool.result.recorded"] })).toHaveLength(1);
    expect(reopenedStore.readInFlight(sessionId, "finalized-tool-result")).toEqual([]);
    await reopened.getStorage().dispose();
    reopenedStore.close();
  });
});
