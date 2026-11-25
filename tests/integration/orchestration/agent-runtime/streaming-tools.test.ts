import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";

import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/substrate/store/event-store-types.js";
import { createSqliteEventStore } from "../../../../src/infra/substrate/store/sqlite-event-store.js";
import type { AnyBlock, ToolEntry } from "../../../../src/infra/substrate/events/output-blocks.js";
import { resolveEventStoreDbFile } from "../../../../src/infra/platform/files/paths.js";
import { createTurnDispatcher, type ToolBatchEvent } from "../../../../src/orchestration/agent-runtime/loop/tool-calls/agent-loop-tools.js";
import { fixedTurnOutputBound } from "../../../../src/orchestration/agent-runtime/compaction/compaction-policy.js";
import { toolUseBlock } from "../../../../src/orchestration/agent-runtime/loop/turn/agent-state.js";
import { settleTurn } from "../../../../src/orchestration/agent-runtime/loop/tool-calls/agent-turn-settlement.js";
import { emitAssistant, emitToolInputComplete, emitToolInputDelta, emitToolResult, emitToolResultAvailable } from "../../../../src/orchestration/agent-runtime/runner/emit.js";
import type { LLMClient, ProviderStreamEvent, ToolCall } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import type { ConversationMessage } from "../../../../src/infra/providers/llm/conversation/conversation-message.js";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import type { RuntimeTool, ToolContext } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { createOutputSession, type OutputSession } from "../../../../src/orchestration/session-store/output-session.js";
import { recoverFinalizedToolResultCheckpoints } from "../../../../src/orchestration/agent-runtime/loop/tool-calls/finalized-tool-result-checkpoint.js";
import { createSessionManager } from "../../../../src/orchestration/session/manager.js";
import { createSessionFactWriter } from "../../../../src/orchestration/session/persistence/session-fact-writer.js";
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-writer.js";
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-handle.js";
import { branchBlocks } from "../../../helpers/branch-blocks.js";
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
// A test that times out never reaches its own finally, so a fixture server is stopped here too.
const providers: { stop(): void }[] = [];

afterEach(() => {
  for (const provider of providers.splice(0)) provider.stop();
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

/** The canonical id Flywheel gave the call that the provider streamed under `providerCallId`. */
function canonicalId(calls: readonly ToolCall[], providerCallId: string): string {
  const call = calls.find((candidate) => candidate.providerCallId === providerCallId);
  if (!call) throw new Error(`missing tool call for provider id ${providerCallId}`);
  return call.id;
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
    expect(branchBlocks(await tree.getBranch(), { executionCwd: root }).some((block) => block.kind === "tool" && block.id === "lost")).toBe(false);

    const canonicalInput = { path: "kept.ts", content: "canonical\n" };
    writer.enqueueMessage({ kind: "assistant", content: [{ type: "tool_use", id: "kept", name: "write", input: canonicalInput }] });
    await writer.flushSavePoint(new Set(["kept"]));
    await tree.dispose();
    store.close();

    const reopenedStore = createSqliteEventStore(resolveEventStoreDbFile(root));
    const reopened = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(reopenedStore), writer: asAsyncEventWriter(reopenedStore) });
    if (!reopened) throw new Error("missing reopened proposal recovery tree");
    const reconstructed = toolBlock(branchBlocks(await reopened.getBranch(), { executionCwd: root }), "kept");
    expect(reconstructed).toMatchObject({
      status: "interrupted",
      fileChangeKind: "create",
      proposedDiff: { files: [{ path: "kept.ts", action: "add" }] },
    });
    expect(JSON.stringify(await reopened.getBranch())).not.toContain("must not survive");
    await reopened.dispose();
    reopenedStore.close();
  });

  // A subagent's calls render in its own session, as top-level calls of that transcript, so they take the same path as a
  // workflow step's calls.
  it("keeps proposal identity and pending continuity for workflow and all-at-once provider publication", () => {
    const root = temporaryRoot("streaming-proposal-surfaces");
    const output = createOutputSession({ executionCwd: root, updateEntry: () => {} });
    try {
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
    providers.push(provider);
    const slowRelease = Promise.withResolvers<void>();
    const partialInputVisible = Promise.withResolvers<void>();
    const firstResultAvailable = Promise.withResolvers<void>();
    let streamedProposal: ToolEntry["proposedDiff"];
    let streamedWriteId: string | undefined;
    const output = createOutputSession({
      executionCwd: root,
      updateEntry(patch) {
        for (const [toolUseId, streaming] of Object.entries(patch.streamingToolText ?? {})) {
          if (!streaming?.proposedDiff?.files[0]?.hunks[0]?.lines.some((line) => line.text.includes(EAGER_INPUT_PREFIX))) continue;
          streamedWriteId = toolUseId;
          streamedProposal = streaming.proposedDiff;
          partialInputVisible.resolve();
        }
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
      if (streamedWriteId === undefined) throw new Error("missing streamed write id");
      const streamingRow = toolBlock(output.getBlocks(), streamedWriteId);
      expect(streamingRow).toMatchObject({ id: streamedWriteId, status: "streaming" });
      expect(streamedProposal).toMatchObject({ files: [{ path: "fixture.txt", action: "add" }] });
      provider.releaseInput();
      await firstTurn;

      // Flywheel gives each call its own canonical id and keeps the streamed provider id beside it.
      expect(calls.map((call) => call.providerCallId)).toEqual([EAGER_WRITE_TOOL_USE_ID, EAGER_SLOW_TOOL_USE_ID]);
      const writeId = canonicalId(calls, EAGER_WRITE_TOOL_USE_ID);
      const slowId = canonicalId(calls, EAGER_SLOW_TOOL_USE_ID);
      expect(writeId).toBe(streamedWriteId);
      const completedInputRow = toolBlock(output.getBlocks(), writeId);
      expect(completedInputRow?.id).toBe(streamingRow?.id);
      expect(completedInputRow).not.toHaveProperty("content");
      expect(completedInputRow).toMatchObject({
        status: "pending",
        proposedDiff: { files: [{ path: "fixture.txt", action: "add" }] },
      });
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
          if (event.toolUseId === writeId) firstResultAvailable.resolve();
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
          treeWriter.enqueueMessage({ kind: "assistant", content: calls.map(toolUseBlock) });
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
      expect(toolBlock(output.getBlocks(), writeId)).toMatchObject({ id: writeId, status: "completed" });
      expect(toolBlock(output.getBlocks(), slowId)?.status).not.toBe("completed");
      expect(conversationCommitted).toBe(false);
      expect(provider.requests).toHaveLength(1);
      expect(store.readInFlight(sessionId, "finalized-tool-result").map((row) => row.key)).toContain(`${conversationId}:${writeId}`);
      expect(store.readInFlight(sessionId, "finalized-tool-result")
        .find((row) => row.key === `${conversationId}:${writeId}`)?.payload)
        .toMatchObject({ budgetExempt: false, turnBudgetChars: 16_000 });

      slowRelease.resolve();
      await settling;
      await Effect.runPromise(Scope.close(turnScope, Exit.void));
      output.flush();
      expect(conversationCommitted).toBe(true);
      expect(store.readInFlight(sessionId, "finalized-tool-result")).toEqual([]);
      expect(output.getBlocks().filter((block) => block.kind === "tool" && block.id === writeId)).toHaveLength(1);

      await tree.dispose();
      store.close();
      const reopenedStore = createSqliteEventStore(resolveEventStoreDbFile(root));
      const reopened = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(reopenedStore), writer: asAsyncEventWriter(reopenedStore) });
      if (!reopened) throw new Error("missing reopened tree");
      const recoveredResults = (await reopened.buildContext()).messages.filter((message) => message.kind === "toolResult");
      expect(recoveredResults.map((message) => message.kind === "toolResult" ? message.toolUseId : "")).toEqual([writeId, slowId]);

      // The next request replays each call and its result under the provider's own id.
      await drainProviderTurn(client, output, (await reopened.buildContext()).messages, []);
      expect(provider.requests).toHaveLength(2);
      const secondMessages = provider.requests[1]?.messages;
      expect(Array.isArray(secondMessages) ? secondMessages.filter((message) => typeof message === "object" && message !== null && "tool_call_id" in message).map((message) => message.tool_call_id) : []).toEqual([EAGER_WRITE_TOOL_USE_ID, EAGER_SLOW_TOOL_USE_ID]);
      await reopened.dispose();
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
    await tree.dispose();
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
    await reopened.dispose();
    reopenedStore.close();
  });
});
