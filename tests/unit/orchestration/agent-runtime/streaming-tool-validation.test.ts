import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js";
import type { AnyBlock, ToolEntry } from "../../../../src/infra/output-blocks.js";
import type { StreamingToolTextStore } from "../../../../src/infra/output/streaming-tool-text.js";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js";
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js";
import { emitAssistant, emitToolInputComplete, emitToolInputDelta, emitToolResult } from "../../../../src/orchestration/agent-runtime/emit.js";
import type { ToolCall } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { createApplyPatchDefinition } from "../../../../src/orchestration/agent-runtime/tools/apply-patch.js";
import { executePreparedTool, prepareToolCall, preparedToolAdmission } from "../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { createOutputSession } from "../../../../src/orchestration/runner/output-session.js";
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection.js";
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js";
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/conversation-tree-writer.js";
import { createSessionManager } from "../../../../src/orchestration/session/manager.js";
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js";

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

describe("streaming tool validation and failure", () => {
  it("keeps advisory text live-only while canonical success, error, and interruption remain the reopened authority", async () => {
    const root = temporaryRoot("streaming-canonical-history");
    const store = createSqliteEventStore(resolveEventStoreDbFile(root));
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store });
    const sessionId = await manager.createChat({ name: "Canonical streaming history" });
    const conversationId = (await manager.listMetadata()).sessions.find(session => session.id === sessionId)?.conversationId;
    if (!conversationId) throw new Error("missing canonical history conversation");
    const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
    if (!tree) throw new Error("missing canonical history tree");
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn({ kind: "user", content: "edit files" });
    writer.beginTurn();
    let streamingToolText: ReturnType<StreamingToolTextStore["snapshot"]> = {};
    const output = createOutputSession({
      executionCwd: root,
      updateEntry: patch => {
        if (patch.streamingToolText) streamingToolText = patch.streamingToolText;
      },
    });
    const calls = [
      { id: "success", name: "edit", input: { path: "a.ts", old_string: "a", new_string: "b" }, result: "changed", isError: false },
      { id: "error", name: "edit", input: { path: "b.ts", old_string: "missing", new_string: "b" }, result: "no match", isError: true },
    ] as const;
    try {
      for (const call of calls) {
        emitAssistant(output.dispatchRuntimeEvent, [{ type: "tool_use", id: call.id, name: call.name, input: {} }]);
        emitToolInputDelta(output.dispatchRuntimeEvent, call.id, JSON.stringify(call.input).slice(0, -1));
        output.applyProjectionEvent({ type: "tool-preview-check", toolUseId: call.id, operation: { type: "set", advice: "live advisory" } });
        output.flush();
        expect(streamingToolText[call.id]).toEqual({ previewCheck: "live advisory" });
        emitToolInputComplete(output.dispatchRuntimeEvent, call);
      }
      emitAssistant(output.dispatchRuntimeEvent, [{ type: "tool_use", id: "interrupted", name: "edit", input: {} }]);
      emitToolInputDelta(output.dispatchRuntimeEvent, "interrupted", '{"path":"c.ts","old_string":"c');
      output.endTurn("paused");
      expect(toolBlock(output.getBlocks(), "interrupted")).toMatchObject({ status: "interrupted" });
      writer.enqueueMessage({ kind: "assistant", content: calls.map(call => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })) });
      for (const call of calls) writer.enqueueMessage({
        kind: "toolResult",
        toolUseId: call.id,
        content: [{ type: "text", text: call.result }],
        ...(call.isError ? { isError: true } : {}),
      });
      await writer.flushSavePoint();
      await tree.getStorage().dispose();
      store.close();

      const reopenedStore = createSqliteEventStore(resolveEventStoreDbFile(root));
      const reopened = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(reopenedStore) });
      if (!reopened) throw new Error("missing reopened canonical history tree");
      const blocks = projectBlocksFromEntries(await reopened.getBranch(), { executionCwd: root });
      expect(toolBlock(blocks, "success")).toMatchObject({ status: "completed" });
      expect(toolBlock(blocks, "error")).toMatchObject({ status: "error", errorMessage: "No match" });
      expect(JSON.stringify(blocks)).not.toContain("live advisory");
      expect(JSON.stringify(blocks)).not.toContain("interrupted");
      await reopened.getStorage().dispose();
      reopenedStore.close();
    } finally {
      output.dispose();
    }
  });

  it("keeps subagent children summary-only while standalone file edits surface advice and failure", () => {
    const root = temporaryRoot("streaming-child-presentation");
    let streamingToolText: ReturnType<StreamingToolTextStore["snapshot"]> = {};
    const output = createOutputSession({
      executionCwd: root,
      updateEntry: patch => {
        if (patch.streamingToolText) streamingToolText = patch.streamingToolText;
      },
    });
    try {
      emitAssistant(output.dispatchRuntimeEvent, [{ type: "tool_use", id: "agent", name: "subagent", input: { description: "child" } }]);
      output.applyProjectionEvent({ type: "tool-use", toolUseId: "grouped", name: "edit", input: {}, timestamp: 1, parentToolUseId: "agent" });
      output.applyProjectionEvent({ type: "tool-input-delta", toolUseId: "grouped", partialJson: '{"path":"private.ts","old_string":"before","new_string":"after', parentToolUseId: "agent" });
      output.applyProjectionEvent({ type: "tool-preview-check", toolUseId: "grouped", operation: { type: "set", advice: "private advisory" } });
      output.applyProjectionEvent({ type: "tool-result", toolUseId: "grouped", outcome: "error", content: [{ type: "text", text: "private failure" }], timestamp: 2, parentToolUseId: "agent" });
      const group = output.getBlocks().find(block => block.kind === "agentGroup");
      expect(group?.kind === "agentGroup" ? group.children : []).toEqual([
        expect.objectContaining({ id: "grouped", status: "error", errorMessage: "Private failure" }),
      ]);
      const grouped = group?.kind === "agentGroup" ? group.children[0] : undefined;
      expect(grouped).not.toHaveProperty("content");
      expect(grouped).not.toHaveProperty("proposedDiff");
      expect(JSON.stringify(grouped)).not.toContain("private advisory");
      emitAssistant(output.dispatchRuntimeEvent, [{ type: "tool_use", id: "standalone", name: "edit", input: {} }]);
      emitToolInputDelta(output.dispatchRuntimeEvent, "standalone", '{"path":"visible.ts","old_string":"before","new_string":"after');
      output.applyProjectionEvent({ type: "tool-preview-check", toolUseId: "standalone", operation: { type: "set", advice: "visible advisory" } });
      output.flush();
      expect(streamingToolText.standalone).toEqual({ previewCheck: "visible advisory" });
      emitToolResult(output.dispatchRuntimeEvent, "standalone", [{ type: "text", text: "visible failure" }], "error");
      expect(toolBlock(output.getBlocks(), "standalone")).toMatchObject({ status: "error", errorMessage: "Visible failure" });
    } finally {
      output.dispose();
    }
  });

  it("retains durable evidence for the verified prefix when a later publication is refused", async () => {
    const root = temporaryRoot("streaming-partial-publication");
    writeFileSync(join(root, "first.txt"), "before first\n");
    writeFileSync(join(root, "second.txt"), "before second\n");
    const store = createSqliteEventStore(resolveEventStoreDbFile(root));
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store });
    const sessionId = await manager.createChat({ name: "Partial publication" });
    const conversationId = (await manager.listMetadata()).sessions.find(session => session.id === sessionId)?.conversationId;
    if (!conversationId) throw new Error("missing partial publication conversation");
    const factWriter = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) });
    const originalTransaction = factWriter.transaction;
    let settlements = 0;
    factWriter.transaction = async run => {
      await originalTransaction(run);
      settlements += 1;
      if (settlements === 1) writeFileSync(join(root, "second.txt"), "raced second\n");
    };
    const output = createOutputSession({ executionCwd: root, updateEntry: () => {} });
    const patch = "*** Begin Patch\n*** Update File: first.txt\n@@\n-before first\n+after first\n*** Update File: second.txt\n@@\n-before second\n+after second\n*** End Patch\n";
    const tool = createApplyPatchDefinition();
    const call: ToolCall = { id: "partial-patch", name: "apply_patch", input: { input: patch }, modelRequestId: "partial-request" };
    const prepared = prepareToolCall(call, new Map([[tool.name, tool]]));
    try {
      expect(await preparedToolAdmission(prepared, { executionCwd: root })).toMatchObject({ kind: "paths" });
      emitAssistant(output.dispatchRuntimeEvent, [{ type: "tool_use", id: call.id, name: call.name, input: {} }]);
      emitToolInputComplete(output.dispatchRuntimeEvent, call);
      const result = await executePreparedTool(prepared, {
        executionCwd: root,
        userDataRoot: `${root}/.test-account`, projectRoot: root,
        scratchDir: join(root, "scratch"),
        artifactScopeId: sessionId,
        retrievalSessionId: sessionId,
        conversationId,
        sessionEventWriter: factWriter,
        flushCanonicalMessages: async () => {},
        toolNames: { logical: name => name === "apply_patch" ? "edit" : name, presented: name => name },
      });
      expect(result).toMatchObject({
        outcome: "error",
        details: {
          changedFiles: { total: 1, samples: ["first.txt"] },
          indeterminateFiles: { total: 0, samples: [] },
          remainingFiles: { total: 0, samples: [] },
          mutationEvidence: { version: 2, applied: 1, notApplied: 1 },
        },
      });
      const resultContent = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      emitToolResult(output.dispatchRuntimeEvent, call.id, [{ type: "text", text: resultContent }], result.outcome, { details: result.details });
      const failed = toolBlock(output.getBlocks(), call.id);
      expect(failed).toMatchObject({ status: "error" });
      expect(failed).not.toHaveProperty("proposedDiff");
      expect(failed).not.toHaveProperty("mutation");
      expect(JSON.stringify(failed)).not.toContain("no textual change");
      const durableChanges = store.read({ aggregateId: `session:${sessionId}`, types: ["file.changed"] });
      expect(durableChanges).toHaveLength(1);
      expect(durableChanges[0]?.payload).toMatchObject({ displayPath: "first.txt", after: { preview: "after first" } });
    } finally {
      output.dispose();
      factWriter.dispose();
      store.close();
    }
  });
});
