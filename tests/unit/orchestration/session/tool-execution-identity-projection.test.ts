import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import { asAsyncEventReadSurface, type EventStore } from "../../../../src/infra/event-store-types";
import { InvariantViolation } from "../../../../src/infra/invariant";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import { contentEvidence } from "../../../../src/infra/content-evidence";
import { countToolCall, createToolExecutionProjection as createAsyncToolExecutionProjection, initialToolCallCount, TOOL_EXECUTION_FACT_TYPES } from "../../../../src/orchestration/session/tool-execution-projection";
import type { SessionRuntimeFact } from "../../../../src/orchestration/session/session-runtime-event-types";

const TMP_ROOT = path.join(os.tmpdir(), `flywheel-tool-execution-identity-projection-test-${process.pid}-${Date.now()}`);
const createToolExecutionProjection = (store: EventStore, sessionId: string) =>
  createAsyncToolExecutionProjection(asAsyncEventReadSurface(store), sessionId);
let tmpDir: string;

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendFact(store: EventStore, sessionId: string, fact: SessionRuntimeFact): void {
  store.append({ aggregateId: `session:${sessionId}`, type: fact.type, version: fact.version, timestamp: Date.now(), actor: fact.actor, sessionId, payload: fact.payload });
}

function inputFact(toolUseId: string, withIdentity = false): SessionRuntimeFact {
  return {
    type: "tool.input.completed", version: 1, actor: "agent",
    payload: {
      toolUseId, toolName: "read", input: {}, inputBytes: 2, inputSha256: "hash", inputPreview: "{}",
      executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      ...(withIdentity ? { parentToolUseId: "parent", modelRequestId: "request" } : {}),
    },
  };
}

function resultFact(toolUseId: string, withIdentity = false, outcome: "ok" | "error" = "ok"): SessionRuntimeFact {
  return { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId, outcome, ...(withIdentity ? { parentToolUseId: "parent", modelRequestId: "request" } : {}) } };
}

function validationFact(toolUseId: string, withIdentity = false): SessionRuntimeFact {
  return {
    type: "tool.validation.failed", version: 1, actor: "flywheel",
    payload: {
      toolUseId, toolName: "read", input: {}, inputBytes: 2, inputSha256: "hash", inputPreview: "{}",
      executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false, reason: "invalid",
      ...(withIdentity ? { parentToolUseId: "parent", modelRequestId: "request" } : {}),
    },
  };
}

function outputFact(toolUseId: string): SessionRuntimeFact {
  return { type: "tool.execution_output.recorded", version: 1, actor: "flywheel", payload: { toolUseId, output: "tail" } };
}

function ackFact(toolUseId: string, withIdentity = false): SessionRuntimeFact {
  return { type: "tool.result.acknowledged", version: 1, actor: "provider", payload: { toolUseId, ...(withIdentity ? { parentToolUseId: "parent", modelRequestId: "request" } : {}) } };
}

beforeEach(() => { tmpDir = makeTmpDir(); });
afterEach(() => { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); });

describe("tool execution identity projection", () => {
  it("rejects every second terminal fact with its event position", async () => {
    const cases: readonly [string, SessionRuntimeFact[]][] = [
      ["validation then result", [validationFact("tool-1"), resultFact("tool-1")]],
      ["result then validation", [inputFact("tool-1"), resultFact("tool-1"), validationFact("tool-1")]],
      ["contradicting result", [inputFact("tool-1"), resultFact("tool-1"), resultFact("tool-1", false, "error")]],
    ];
    for (const [name, facts] of cases) {
      const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()));
      for (const fact of facts) appendFact(store, name, fact);
      try {
        await createToolExecutionProjection(store, name).replay();
        throw new Error(`expected ${name} to fail`);
      } catch (error) {
        expect(error).toBeInstanceOf(InvariantViolation);
        if (!(error instanceof InvariantViolation)) throw error;
        expect(error.detail).toContain("duplicates terminal evidence");
        expect(error.detail).toContain(`position ${error.eventPosition}`);
      } finally {
        store.close();
      }
    }
  });

  it("salvages child execution output stamped with its parent dispatch identity", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir));
    appendFact(store, "legacy-child-output", inputFact("child-shell"));
    appendFact(store, "legacy-child-output", {
      type: "tool.execution_output.recorded", version: 1, actor: "flywheel",
      payload: { toolUseId: "child-shell", output: "tail", parentToolUseId: "parent-dispatch" },
    });
    const state = await createToolExecutionProjection(store, "legacy-child-output").replay();
    store.close();
    expect(state.tools["child-shell"]).toMatchObject({ toolUseId: "child-shell" });
    expect(state.tools["child-shell"]?.parentToolUseId).toBeUndefined();
  });

  it("rejects an execution output that names a parent in its own session the input does not carry", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir));
    appendFact(store, "local-parent", inputFact("local-parent"));
    appendFact(store, "local-parent", inputFact("nested-shell"));
    appendFact(store, "local-parent", {
      type: "tool.execution_output.recorded", version: 1, actor: "flywheel",
      payload: { toolUseId: "nested-shell", output: "tail", parentToolUseId: "local-parent" },
    });
    try {
      await expect(createToolExecutionProjection(store, "local-parent").replay()).rejects.toBeInstanceOf(InvariantViolation);
    } finally {
      store.close();
    }
  });

  it("rejects every other follow-up identity the input does not carry", async () => {
    const mismatchedFacts: readonly [string, SessionRuntimeFact, SessionRuntimeFact][] = [
      ["result adds identity", inputFact("result-added"), resultFact("result-added", true)],
      ["validation adds identity", inputFact("validation-added"), validationFact("validation-added", true)],
      ["ack adds identity", inputFact("ack-added"), ackFact("ack-added", true)],
    ];
    for (const [name, input, fact] of mismatchedFacts) {
      const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()));
      appendFact(store, name, input);
      appendFact(store, name, fact);
      try {
        await createToolExecutionProjection(store, name).replay();
        throw new Error(`expected ${name} to fail`);
      } catch (error) {
        expect(error).toBeInstanceOf(InvariantViolation);
        if (!(error instanceof InvariantViolation)) throw error;
        expect(error.detail).toContain(`position ${error.eventPosition}`);
      } finally {
        store.close();
      }
    }
  });

  it("accepts follow-up facts that omit identity the input carries (not asserted)", async () => {
    const legacyFacts: readonly [string, SessionRuntimeFact, SessionRuntimeFact][] = [
      ["output missing identity", inputFact("output-missing", true), outputFact("output-missing")],
      ["result missing identity", inputFact("result-missing", true), resultFact("result-missing")],
      ["validation missing identity", inputFact("validation-missing", true), validationFact("validation-missing")],
      ["ack missing identity", inputFact("ack-missing", true), ackFact("ack-missing")],
    ];
    for (const [name, input, fact] of legacyFacts) {
      const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()));
      appendFact(store, name, input);
      appendFact(store, name, fact);
      await expect(createToolExecutionProjection(store, name).replay()).resolves.toBeDefined();
      store.close();
    }
  });

  it("accepts follow-up facts that omit modelRequestId even when the input carries providerCallId", async () => {
    // Ledgers written between 2026-08-19 and 2026-08-20 hold provider-aliased
    // inputs whose follow-up facts were emitted before the request id was
    // stamped onto the executing call. Replay must not lose those sessions.
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir));
    appendFact(store, "provider-aliased-legacy", {
      type: "tool.input.completed", version: 2, actor: "agent",
      payload: {
        toolUseId: "tool-1", toolName: "read", input: {}, inputBytes: 2, inputSha256: "hash", inputPreview: "{}",
        executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
        providerCallId: "tool-1", providerToolName: "read", modelRequestId: "request",
      },
    });
    appendFact(store, "provider-aliased-legacy", outputFact("tool-1"));
    appendFact(store, "provider-aliased-legacy", resultFact("tool-1"));
    appendFact(store, "provider-aliased-legacy", ackFact("tool-1"));
    const state = await createToolExecutionProjection(store, "provider-aliased-legacy").replay();
    store.close();
    expect(state.tools["tool-1"]).toMatchObject({ status: "completed", modelRequestId: "request" });
  });

  it("checks each identity field independently: one omitted, the other still compared", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir));
    appendFact(store, "field-isolated-parity", inputFact("tool-1", true));
    appendFact(store, "field-isolated-parity", { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "tool-1", outcome: "ok", parentToolUseId: "parent" } });
    const state = await createToolExecutionProjection(store, "field-isolated-parity").replay();
    store.close();
    expect(state.tools["tool-1"]).toMatchObject({ status: "completed", modelRequestId: "request", parentToolUseId: "parent" });
  });

  it("rejects conflicting parentToolUseId values even when modelRequestId matches", async () => {
    const conflictingFacts: readonly [string, SessionRuntimeFact][] = [
      ["result", { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "tool-1", outcome: "ok", parentToolUseId: "other-parent", modelRequestId: "request" } }],
      ["output", { type: "tool.execution_output.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "tool-1", output: "tail", parentToolUseId: "other-parent", modelRequestId: "request" } }],
    ];
    for (const [kind, fact] of conflictingFacts) {
      const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()));
      appendFact(store, kind, inputFact("tool-1", true));
      appendFact(store, kind, fact);
      await expect(createToolExecutionProjection(store, kind).replay()).rejects.toThrow("parentToolUseId");
      store.close();
    }
  });

  it("folds a repeated identical result on reload and fails closed on a contradicting one", async () => {
    // A history that agrees with itself must keep loading (ARCH-SUBSTRATE-012): the
    // repeat is salvaged as the recording it already is. Only a second
    // terminal fact that says something different is corruption.
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir));
    appendFact(store, "duplicate-reload", inputFact("tool-1"));
    appendFact(store, "duplicate-reload", resultFact("tool-1"));
    appendFact(store, "duplicate-reload", resultFact("tool-1"));
    expect((await createToolExecutionProjection(store, "duplicate-reload").replay()).completedCount).toBe(1);
    appendFact(store, "duplicate-reload", resultFact("tool-1", false, "error"));
    await expect(createToolExecutionProjection(store, "duplicate-reload").replay()).rejects.toThrow("duplicates terminal evidence");
    store.close();
  });

  it("counts the calls the reducer holds from stored facts, without tool content", async () => {
    const output = "captured execution output\n".repeat(200);
    const evidence = contentEvidence(output);
    const interrupted: SessionRuntimeFact = { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "guessed", outcome: "interrupted" } };
    const histories: readonly [string, readonly SessionRuntimeFact[]][] = [
      ["finished call", [inputFact("tool-1"), resultFact("tool-1"), ackFact("tool-1")]],
      ["nested call", [inputFact("nested", true), resultFact("nested", true), ackFact("nested", true)]],
      ["validation failed", [validationFact("invalid"), validationFact("invalid-nested", true)]],
      ["validation after input", [inputFact("tool-1"), validationFact("tool-1")]],
      ["result without input", [resultFact("lost"), resultFact("lost-nested", true)]],
      ["acknowledgement without input", [ackFact("lost-nested", true), ackFact("lost")]],
      ["output without input", [outputFact("lost"), { type: "tool.execution_output.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "lost-foreign", output: "tail", parentToolUseId: "parent-dispatch" } }]],
      ["foreign dispatch parent", [inputFact("child-shell"), { type: "tool.execution_output.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "child-shell", output: "tail", parentToolUseId: "parent-dispatch" } }]],
      ["repeated result", [inputFact("tool-1"), resultFact("tool-1"), resultFact("tool-1")]],
      ["interrupted guess replaced", [inputFact("guessed"), interrupted, resultFact("guessed")]],
      ["runtime invocation", [{
        type: "tool.runtime_invocation.recorded", version: 1, actor: "flywheel",
        payload: {
          toolUseId: "runtime-launch", initiator: "person", parentConversationId: "conversation-1", parentEntryId: "entry-1",
          operation: { kind: "launch", input: { workflowDefinitionId: "implementation", summary: "Implement", description: "Implement the design.", launchCwd: "worktree" } },
        },
      }, resultFact("runtime-launch")]],
    ];
    for (const [sessionId, facts] of histories) {
      const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()));
      try {
        for (const fact of facts) appendFact(store, sessionId, fact);
        // A referenced output names its call as the inline one does, and the
        // count reads it with no content row loaded.
        store.append({
          aggregateId: `session:${sessionId}`, type: "tool.execution_output.recorded", version: 2, timestamp: Date.now(), actor: "flywheel", sessionId,
          payload: { toolUseId: "referenced", output: { sha256: evidence.sha256, bytes: evidence.bytes, preview: evidence.preview } },
          contentRows: [{ sha256: evidence.sha256, content: output, bytes: evidence.bytes }],
        });
        const state = await createToolExecutionProjection(store, sessionId).replay();
        for (const count of [initialToolCallCount(), initialToolCallCount({ identityParity: true })]) {
          for (const fact of store.read({ aggregateId: `session:${sessionId}`, types: TOOL_EXECUTION_FACT_TYPES })) countToolCall(count, fact);
          expect({ sessionId, calls: count.calls.index.entries.slice(0, count.calls.size).map(({ key }) => key).toSorted(), topLevel: count.topLevel }).toEqual({
            sessionId,
            calls: Object.keys(state.tools).toSorted(),
            topLevel: Object.values(state.tools).filter((tool) => !tool.parentToolUseId).length,
          });
        }
      } finally {
        store.close();
      }
    }
  });

  it("refuses a follow-up whose identity conflicts with its call's first fact, as the reducer does, only with identity parity", async () => {
    const output = "captured execution output\n".repeat(200);
    const evidence = contentEvidence(output);
    const conflicts: readonly [string, (store: EventStore, sessionId: string) => void][] = [
      ["inline result", (store, sessionId) => appendFact(store, sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "nested", outcome: "ok", modelRequestId: "other" } })],
      ["inline acknowledgement", (store, sessionId) => appendFact(store, sessionId, { type: "tool.result.acknowledged", version: 1, actor: "provider", payload: { toolUseId: "nested", parentToolUseId: "other" } })],
      ["referenced output", (store, sessionId) => store.append({
        aggregateId: `session:${sessionId}`, type: "tool.execution_output.recorded", version: 2, timestamp: Date.now(), actor: "flywheel", sessionId,
        payload: { toolUseId: "nested", modelRequestId: "other", output: { sha256: evidence.sha256, bytes: evidence.bytes, preview: evidence.preview } },
        contentRows: [{ sha256: evidence.sha256, content: output, bytes: evidence.bytes }],
      })],
    ];
    for (const [sessionId, appendConflict] of conflicts) {
      const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()));
      try {
        appendFact(store, sessionId, inputFact("nested", true));
        appendConflict(store, sessionId);
        await expect(createToolExecutionProjection(store, sessionId).replay()).rejects.toThrow(InvariantViolation);
        const facts = store.read({ aggregateId: `session:${sessionId}`, types: TOOL_EXECUTION_FACT_TYPES });
        const parity = initialToolCallCount({ identityParity: true });
        expect(() => { for (const fact of facts) countToolCall(parity, fact); }).toThrow(InvariantViolation);
        const count = initialToolCallCount();
        for (const fact of facts) countToolCall(count, fact);
        expect(count.topLevel).toBe(0);
      } finally {
        store.close();
      }
    }
  });
});
