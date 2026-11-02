import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { decodeExecutionEvidence, ExecutionEvidenceSchema, type ExecutionEvidence } from "../../../../src/protocol/execution-evidence.js";
import { subcommandDispatch } from "../../../../src/cli/subcommands.js";
import type { EventStore } from "../../../../src/infra/event-store-types.js";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js";
import { createPersistentProcessManager } from "../../../../src/infra/persistent-process-manager.js";
import type { LauncherContext } from "../../../../src/infra/process-supervisor.js";
import * as sqliteEventStore from "../../../../src/infra/sqlite-event-store.js";
import type { UsageEntry } from "../../../../src/infra/llm/usage-entry.js";
import { Log } from "../../../../src/infra/log.js";
import type { CommandProcessResources } from "../../../../src/orchestration/cli-contribution.js";
import { hashSystemPrompt, hashToolSurface } from "../../../../src/orchestration/session/provider-request-audit-hash.js";
import { buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts.js";
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js";
import { canonicalTestDirectory, temporaryDirectories, testDirectories } from "../../../helpers/directories.js";

const temporary = temporaryDirectories();
const noLaunch = (): Promise<never> => Promise.reject(new Error("execution evidence must not launch a process"));
const launcher: LauncherContext = {
  scope: { spawnOwned: noLaunch, adoptOwned: noLaunch, open: () => launcher.scope, close: noLaunch },
  guardian: { openGeneration: noLaunch, pid: noLaunch },
  startGuardian: noLaunch,
};
const resources: CommandProcessResources = {
  persistentProcessManager: createPersistentProcessManager({ launch: noLaunch }),
  allowPersistentProcesses: false,
};
const measuredId = "00000000-0000-4000-8000-000000000001";
const unmatchedId = "00000000-0000-4000-8000-000000000002";
const usage = (attemptId: string): UsageEntry => ({
  attemptId, occurredAt: "2026-10-13T00:00:00.000Z", profileId: "profile",
  attribution: { kind: "candidate", providerId: "provider", instanceId: "account" },
  spendMode: "included", credentialLineage: "10000000-0000-4000-8000-000000000001",
  model: "model", tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 },
  classification: "subscription_equivalent", currency: "USD", coverage: "complete",
  price: { kind: "priced", estimatedUsd: 0.2, rateCard: {}, provenance: "fixture" },
});

function append(store: EventStore, sessionId: string, type: string, version: number, payload: { [key: string]: unknown }, actor = "flywheel"): void {
  store.append({ aggregateId: `session:${sessionId}`, sessionId, type, version, payload, actor, timestamp: 1 });
}

function session(store: EventStore, root: string, id: string, parent?: string): void {
  const common = { label: id, lifecycleState: "inactive" as const, executionCwd: root, lastUpdated: "2026-10-13T00:00:00.000Z" };
  store.append(buildSessionMetadataAppend(id, buildSessionCreatedFact(parent
    ? { ...common, kind: "subagent", command: "subagent", conversationId: id, launchedFrom: { parentSessionId: parent, toolUseId: `tool-${id}` } }
    : { ...common, kind: "chat", command: "chat", conversationId: id })));
}

function request(store: EventStore, sessionId: string, requestId: string, purpose?: "compaction"): void {
  const identity = { providerSessionKey: sessionId, conversationId: sessionId };
  append(store, sessionId, "prompt.assembled", 5, {
    requestId, identity, turn: 1, promptKind: "chat", ...(purpose ? { requestPurpose: purpose } : {}),
    systemPrompt: "private prompt", systemPromptHash: hashSystemPrompt("private prompt"),
    toolSurfaceHash: hashToolSurface([], []), promptSha256: "a".repeat(64),
    messageCount: 1, estimatedContextTokens: 100, attemptStaticTokens: 10, contextWindow: 200_000,
  });
  append(store, sessionId, "tool_surface.selected", 5, { requestId, identity, turn: 1, toolSurfaceHash: hashToolSurface([], []), tools: [], omittedTools: [] });
  append(store, sessionId, "model.requested", 6, {
    requestId, identity, turn: 1, model: "model", accessProvider: "provider", modelFamily: "openai",
    accessProviderCandidate: { kind: "subscription", providerId: "provider", instanceId: "account", spendMode: "included" },
    interactionProfileId: "default", reasoningEffort: "high", providerOptions: { openai: { service_tier: "private-option" } },
  });
}

async function invoke(root: string, sessionId: string): Promise<{ output: string; error: string; code: number }> {
  const output = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const previousCode = process.exitCode;
  process.exitCode = 0;
  try {
    const dispatch = await subcommandDispatch("events");
    if (!dispatch) throw new Error("events dispatch is missing");
    await dispatch(["evidence", "--session", sessionId], testDirectories(root), launcher, resources);
    return { output: output.mock.calls.map(([line]) => String(line)).join("\n"), error: error.mock.calls.map(([line]) => String(line)).join("\n"), code: Number(process.exitCode) };
  } finally {
    output.mockRestore();
    error.mockRestore();
    process.exitCode = previousCode;
  }
}

describe("durable execution evidence", () => {
  test("the consumer codec bundles for browsers and refuses unknown versions and unsafe identity fields", async () => {
    const bundled = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../../../../src/protocol/execution-evidence.ts", import.meta.url))],
      target: "browser",
    });
    expect(bundled.success).toBe(true);
    const value: ExecutionEvidence = {
      version: 2, projectRoot: "/scratch", rootSessionId: "root", descendantDiscovery: "current-metadata", metadataGaps: [],
      sessions: [{ sessionId: "root", kind: "chat", requests: [{
        requestId: "request", identity: { providerSessionKey: "root" }, turn: 1, dispatchState: "unknown",
        completionState: "unknown", purpose: "normal", measurement: "unavailable",
      }], usageEntries: [] }],
      accounting: { usage: "unavailable", price: "estimate", providerInvoicedCost: "unavailable" },
    };
    const decode = Schema.decodeUnknownSync(ExecutionEvidenceSchema, { onExcessProperty: "error" });
    expect(decode(value)).toEqual(value);
    expect(() => decode({ ...value, version: 3 })).toThrow();
    expect(() => decodeExecutionEvidence({ ...value, version: 3 })).toThrow();
    // Remove after 2027-04-30 with the version 1 conversion. Benchmark result directories keep version 1 evidence,
    // whose entries predate coverage and held the provider's final report.
    const { coverage: _coverage, ...uncovered } = usage(measuredId);
    const rootEvidence = value.sessions[0]!;
    expect(decodeExecutionEvidence({ ...value, version: 1, sessions: [{ ...rootEvidence, usageEntries: [uncovered] }] }))
      .toEqual({ ...value, sessions: [{ ...rootEvidence, usageEntries: [usage(measuredId)] }] });
    expect(() => decode({ ...value, sessions: [{
      ...value.sessions[0], requests: [{
        ...value.sessions[0]!.requests[0], identity: { providerSessionKey: "root", prompt: "private" },
      }],
    }] })).toThrow();
  });

  test("returns current descendants, safe attempts, and canonical entries without changing the closed store", async () => {
    const root = canonicalTestDirectory(temporary("execution-evidence-"));
    const file = resolveEventStoreDbFile(root);
    const store = sqliteEventStore.createSqliteEventStore(file);
    try {
      session(store, root, "root");
      session(store, root, "child", "root");
      session(store, root, "grandchild", "child");
      session(store, root, "unrelated");
      session(store, root, "deleted", "root");
      append(store, "deleted", "session.deleted", 1, { lastUpdated: "2026-10-13T00:00:00.000Z" });
      request(store, "root", "prepared");
      request(store, "child", "failed", "compaction");
      append(store, "child", "model.request.dispatched", 2, { requestId: "failed", identity: { providerSessionKey: "child", conversationId: "child" }, turn: 1 }, "provider");
      append(store, "child", "model.response_received", 3, { requestId: "failed", identity: { providerSessionKey: "child", conversationId: "child" }, turn: 1, outcome: "stream_error", durationMs: 5, error: { tag: "ProviderError", message: "private error" } }, "provider");
      request(store, "grandchild", measuredId);
      append(store, "grandchild", "model.request.dispatched", 2, { requestId: measuredId, identity: { providerSessionKey: "grandchild", conversationId: "grandchild" }, turn: 1 }, "provider");
      append(store, "grandchild", "model.usage.recorded", 3, { requestId: measuredId, attemptId: measuredId, identity: { providerSessionKey: "grandchild", conversationId: "grandchild" }, turn: 1, stepId: "implement", inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, reasoningTokens: 3, promptTokens: 13 }, "provider");
      append(store, "grandchild", "model.usage.measured", 6, { ...usage(measuredId), budgetStreamId: "budget" }, "provider");
      append(store, "grandchild", "model.usage.measured", 6, { ...usage(unmatchedId), budgetStreamId: "budget" }, "provider");
      // A newer build's usage fact: this build cannot read it, so it warns and counts nothing for it.
      append(store, "grandchild", "model.usage.measured", 99, { attemptId: unmatchedId }, "provider");
      request(store, "unrelated", "unrelated-request");
      append(store, "root", "tool-execution-output-recorded", 1, { content: "unrelated tool output" });
    } finally {
      store.close();
    }
    const before = readFileSync(file);
    const loadedTypes: string[] = [];
    const openReader = sqliteEventStore.openReadonlyEventReader;
    const readerSpy = spyOn(sqliteEventStore, "openReadonlyEventReader").mockImplementation((filePath) => {
      const reader = openReader(filePath);
      const read = reader.read.bind(reader);
      return {
        ...reader,
        read: (query) => {
          const facts = read(query);
          loadedTypes.push(...facts.map((fact) => fact.type));
          return facts;
        },
      };
    });
    const warned: unknown[] = [];
    const warn = spyOn(Log.create({ service: "durable-usage" }), "warn").mockImplementation((_message, fields) => { warned.push(fields); });
    let result: Awaited<ReturnType<typeof invoke>>;
    try {
      result = await invoke(root, "root");
    } finally {
      readerSpy.mockRestore();
      warn.mockRestore();
    }
    expect(warned).toEqual([{ version: 99, sessionId: "grandchild" }]);
    expect(loadedTypes).not.toContain("tool-execution-output-recorded");
    expect(loadedTypes).toContain("model.usage.measured");
    expect(result.code).toBe(0);
    expect(result.error).toBe("");
    const evidence = decodeExecutionEvidence(JSON.parse(result.output));
    expect(evidence.version).toBe(2);
    expect(evidence.rootSessionId).toBe("root");
    expect(evidence.sessions.map((row: { sessionId: string }) => row.sessionId)).toEqual(["root", "child", "grandchild"]);
    expect(evidence.sessions[0]?.requests[0]).toMatchObject({ requestId: "prepared", attemptId: "prepared", dispatchState: "prepared", completionState: "unknown", purpose: "normal", measurement: "unavailable", model: "model", accessProvider: "provider", reasoningEffort: "high" });
    expect(evidence.sessions[1]?.requests[0]).toMatchObject({ requestId: "failed", dispatchState: "dispatched", completionState: "terminal", purpose: "compaction", outcome: "stream_error", errorTag: "ProviderError", measurement: "unavailable" });
    expect(evidence.sessions[2]?.requests[0]).toMatchObject({ requestId: measuredId, attemptId: measuredId, workflowAttemptId: "implement", measurement: "available" });
    expect(evidence.sessions[2]?.usageEntries).toEqual([usage(measuredId), usage(unmatchedId)]);
    expect(evidence.accounting).toEqual({ usage: "available", price: "estimate", providerInvoicedCost: "unavailable" });
    for (const content of ["private prompt", "private error", "private-option"]) expect(result.output).not.toContain(content);
    expect(result.output).not.toContain("budgetStreamId");
    expect(readFileSync(file)).toEqual(before);
  });

  test("reports absent usage as unavailable and refuses missing, deleted, and corrupt roots", async () => {
    const root = canonicalTestDirectory(temporary("execution-evidence-empty-"));
    const store = sqliteEventStore.createSqliteEventStore(resolveEventStoreDbFile(root));
    try {
      session(store, root, "empty");
      append(store, "empty", "session.child.linked", 1, { childSessionId: "missing-child", lastUpdated: "2026-10-13T00:00:00.000Z" });
      session(store, root, "deleted");
      append(store, "deleted", "session.deleted", 1, { lastUpdated: "2026-10-13T00:00:00.000Z" });
      append(store, "corrupt", "session.created", 4, { kind: "invalid" });
    } finally {
      store.close();
    }
    const empty = await invoke(root, "empty");
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.output).accounting.usage).toBe("unavailable");
    expect(JSON.parse(empty.output).descendantDiscovery).toBe("incomplete");
    expect(JSON.parse(empty.output).metadataGaps).toEqual([
      { sessionId: "corrupt", kind: "corrupt", scope: "workspace" },
      { sessionId: "missing-child", kind: "missing", scope: "descendant" },
    ]);
    for (const id of ["missing", "deleted", "corrupt"]) {
      const result = await invoke(root, id);
      expect(result.code).toBe(1);
      expect(result.output).toBe("");
      expect(result.error).toContain(id);
    }
    const missingRoot = temporary("execution-evidence-no-store-");
    expect((await invoke(missingRoot, "missing")).code).toBe(1);
    expect(existsSync(resolveEventStoreDbFile(missingRoot))).toBe(false);
  });

  test("rejects invalid options without opening a store and accepts help", async () => {
    const root = temporary("execution-evidence-arguments-");
    const dispatch = await subcommandDispatch("events");
    if (!dispatch) throw new Error("events dispatch is missing");
    const output = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const previousCode = process.exitCode;
    try {
      for (const args of [[], ["--session"], ["--session="], ["--session", "a", "--session", "b"], ["--json"]]) {
        process.exitCode = 0;
        await dispatch(["evidence", ...args], testDirectories(root), launcher, resources);
        expect(process.exitCode).toBe(1);
      }
      process.exitCode = 0;
      await dispatch(["evidence", "--help"], testDirectories(root), launcher, resources);
      expect(process.exitCode).toBe(0);
      expect(output.mock.calls).toHaveLength(1);
      expect(output.mock.calls[0]?.[0]).toContain("--project-root");
      expect(existsSync(resolveEventStoreDbFile(root))).toBe(false);
    } finally {
      output.mockRestore();
      error.mockRestore();
      process.exitCode = previousCode;
    }
  });
});
