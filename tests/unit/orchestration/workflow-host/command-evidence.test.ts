import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js";
import { asAsyncEventReadSurface, type AsyncGuardedEventWriter, type EventStore, type EventStoreAppend } from "../../../../src/infra/event-store-types.js";
interface FactPayload { [key: string]: unknown }
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js";
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js";
import { createCommandEvidenceSource } from "../../../../src/orchestration/workflow-host/command-evidence.js";
import { buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts.js";
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js";

function immediateWriter(store: EventStore): AsyncGuardedEventWriter {
  return {
    append: async (event: EventStoreAppend) => store.append(event),
    appendBatch: async (events: readonly EventStoreAppend[]) => store.appendBatch(events),
    appendGuarded: async (event) => store.appendGuarded(event),
    appendBatchGuarded: async (events) => store.appendBatchGuarded(events),
    pruneSupersededEvents: async () => 0,
  };
}

function appendToolFact(store: EventStore, sessionId: string, type: string, payload: FactPayload): void {
  store.append({
    aggregateId: `session:${sessionId}`,
    type,
    version: 1,
    timestamp: Date.now(),
    actor: type === "tool.input.completed" ? "agent" : "flywheel",
    sessionId,
    payload,
  });
}

function appendFileChanged(store: EventStore, sessionId: string, displayPath: string): void {
  const endpoint = { bytes: 1, sha256: "a".repeat(64), preview: "x" };
  store.append({
    aggregateId: `session:${sessionId}`,
    type: "file.changed",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId,
    payload: { path: `/workspace/${displayPath}`, displayPath, changeKind: "modified", before: endpoint, after: endpoint },
  });
}

describe("command evidence source", () => {
  test("joins durable shell command facts, Bash or exec, with the directory each named and the files changed after it, only when the tool completed in the cited conversation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-command-evidence-"));
    const store = createSqliteEventStore(resolveEventStoreDbFile(root));
    const sessionId = "session-1";
    const conversationId = "conversation-1";
    const workflowCwd = path.join(root, "worktree");
    try {
      // The workflow recorded its own directory, which differs from the
      // project root; each call's directory resolves against it.
      store.append({
        aggregateId: "workflow:workflow",
        type: "workflow.run.registered",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: "workflow",
        payload: {
          settings: { workflowDefinitionId: "implement", label: "w", createdAt: "t", lastUpdated: "t", executionCwd: workflowCwd, roleAssignments: { defaults: {}, overrides: {} } },
          request: null,
          launchedFrom: { parentSessionId: "chat", conversationId: "chat-conversation", toolUseId: "launch" },
        },
      });
      store.append(buildSessionMetadataAppend(sessionId, buildSessionCreatedFact({
        kind: "workflow-agent", command: "workflow-agent", conversationId, label: "worker", lifecycleState: "inactive",
        lastUpdated: new Date().toISOString(), launchedFrom: { parentSessionId: "chat", toolUseId: "launch" },
        workflowMembership: { kind: "attempt", workflowId: "workflow", attemptId: "attempt" },
      })));
      const tree = await createConversationTree({
        conversationId,
        sessionId,
        store: asAsyncEventReadSurface(store),
        writer: immediateWriter(store),
      });
      // Builds before 2026-10-30 ran gpt-6-luna commands through `exec`; a
      // recorded `exec` result is command evidence exactly as Bash's is.
      await tree.appendMessages([
        { kind: "assistant", content: [
          { type: "tool_use", id: "tool-1", name: "bash", input: { command: "script/ci.sh" } },
          { type: "tool_use", id: "call_exec", name: "exec", input: { command: "node check.js", working_directory: "web" } },
          { type: "tool_use", id: "call_read", name: "read", input: { path: "check.js" } },
          { type: "tool_use", id: "tool-verify", name: "bash", input: { command: "bun test" } },
        ] },
        { kind: "toolResult", toolUseId: "tool-1", content: [{ type: "text", text: "passed\n[exit code: 0]" }] },
        { kind: "toolResult", toolUseId: "call_exec", content: [{ type: "text", text: "ok\nprocess_id: process-1\nprocess exit code was 1" }] },
        { kind: "toolResult", toolUseId: "call_read", content: [{ type: "text", text: "1|import" }] },
        { kind: "toolResult", toolUseId: "tool-verify", content: [{ type: "text", text: "pass\n[exit code: 0]" }] },
      ]);
      tree.getStorage().dispose();

      let drained = false;
      const source = createCommandEvidenceSource({
        workflowId: "workflow",
        projectRoot: root,
        projectionReader: asAsyncEventReadSurface(store),
        awaitDurableFacts: async () => {
          if (!drained) {
            appendFileChanged(store, sessionId, "before.ts");
            appendToolFact(store, sessionId, "tool.input.completed", {
              toolUseId: "tool-1",
              toolName: "bash",
              input: { command: "script/ci.sh" },
              inputBytes: 26,
              inputSha256: "input-hash",
              inputPreview: "script/ci.sh",
              executionMode: "foreground",
              traceKind: "tool",
              childHasOwnViewport: false,
            });
            appendToolFact(store, sessionId, "tool.result.recorded", {
              toolUseId: "tool-1",
              outcome: "ok",
              details: { background: false, exitCode: 0, durationMs: 10 },
            });
            appendFileChanged(store, sessionId, "between.ts");
            appendToolFact(store, sessionId, "tool.input.completed", {
              toolUseId: "call_exec",
              toolName: "exec",
              input: { command: "node check.js", working_directory: "web" },
              inputBytes: 27,
              inputSha256: "exec-input-hash",
              inputPreview: "node check.js",
              executionMode: "foreground",
              traceKind: "tool",
              childHasOwnViewport: false,
            });
            appendToolFact(store, sessionId, "tool.result.recorded", {
              toolUseId: "call_exec",
              outcome: "error",
              details: { background: false, exitCode: 1, durationMs: 5 },
            });
            appendFileChanged(store, sessionId, "after.ts");
            appendFileChanged(store, sessionId, "between.ts");
            appendToolFact(store, sessionId, "tool.input.completed", {
              toolUseId: "call_read",
              toolName: "read",
              input: { path: "check.js" },
              inputBytes: 20,
              inputSha256: "read-input-hash",
              inputPreview: "check.js",
              executionMode: "foreground",
              traceKind: "tool",
              childHasOwnViewport: false,
            });
            appendToolFact(store, sessionId, "tool.result.recorded", {
              toolUseId: "call_read",
              outcome: "ok",
            });
            // A run after the last change: its own earlier changes and every
            // change before it are not changes after it.
            appendFileChanged(store, sessionId, "verified.ts");
            appendToolFact(store, sessionId, "tool.input.completed", {
              toolUseId: "tool-verify",
              toolName: "bash",
              input: { command: "bun test" },
              inputBytes: 22,
              inputSha256: "verify-input-hash",
              inputPreview: "bun test",
              executionMode: "foreground",
              traceKind: "tool",
              childHasOwnViewport: false,
            });
            appendToolFact(store, sessionId, "tool.result.recorded", {
              toolUseId: "tool-verify",
              outcome: "ok",
              details: { background: false, exitCode: 0, durationMs: 7 },
            });
            appendToolFact(store, sessionId, "tool.input.completed", {
              toolUseId: "unrelated-malformed-tool",
            });
            drained = true;
          }
        },
      });
      await expect(source.forConversation(conversationId)()).resolves.toEqual([
        { toolUseId: "tool-1", command: "script/ci.sh", cwd: workflowCwd, exitCode: 0, changedAfter: ["between.ts", "after.ts", "verified.ts"], executionMode: "foreground" },
        { toolUseId: "call_exec", command: "node check.js", cwd: path.join(workflowCwd, "web"), exitCode: 1, changedAfter: ["after.ts", "between.ts", "verified.ts"], executionMode: "foreground" },
        { toolUseId: "call_read", command: undefined, cwd: undefined, exitCode: undefined, changedAfter: [], executionMode: "foreground" },
        { toolUseId: "tool-verify", command: "bun test", cwd: workflowCwd, exitCode: 0, changedAfter: [], executionMode: "foreground" },
      ]);
      expect(drained).toBe(true);
      await expect(source.forConversation("another-conversation")()).rejects.toThrow("has no member session");
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
