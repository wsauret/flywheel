import { afterEach, describe, expect, it } from "bun:test";
import type { EventStore, EventStoreAppend, GuardedEventStoreAppend } from "../../../../src/infra/event-store-types";

import { canonicalDirectory } from "../../../../src/infra/directory-authorities";
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types";
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import { createSessionManager, ParentPublicationContendedError } from "../../../../src/orchestration/session/manager";
import { buildWorkflowPausedFact } from "../../../../src/workflows/vm/fact-drafts";
import { readStoredSession } from "./_session-metadata-test-helpers";
import { adoptTestWorkflow, cleanupTmpRoot, makeDeps, makeDepsWithStore, makeTmpDir, publishTestWorkflow, racingPublicationWriter } from "./_session-manager-fixtures";
import { workflowParentBinding } from "../../../helpers/workflow-parent.js";
import { SubagentDepthLimitError, WorkflowParentRefusal } from "../../../../src/orchestration/session/child-session-publication";
import { workflowRunReader, workflowRunWriter } from "../../../../src/orchestration/module-catalog";
import { recoveredWorkflowRoot } from "../../../helpers/workflow-root-fixtures";
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts";
import { decodeSessionMetadataFactForReplay } from "../../../../src/orchestration/session/session-metadata-facts";
import { Schema } from "effect";
import { SessionSchema } from "../../../../src/orchestration/session/schemas";
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership";
import { replayWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold";

function appendParentTelemetry(store: EventStore, parentId: string, accumulatedActiveMs: number): void {
  store.append({
    aggregateId: `session:${parentId}`,
    type: "session.duration.recorded",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: parentId,
    payload: { accumulatedActiveMs },
  });
}

function promptAppend(childId: string, runId: string): EventStoreAppend {
  return {
    aggregateId: `session:${childId}`,
    type: "subagent.prompted",
    version: 3,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: childId,
    payload: { childRunId: runId, prompt: "inspect", task: "inspect", toolNames: [] },
  }
}

function bindingAppend(childSessionId: string, runId: string, parentSessionId: string): EventStoreAppend {
  return {
    aggregateId: `session:${childSessionId}`,
    type: "subagent.run.bound",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: childSessionId,
    runId,
    payload: {
      runId,
      childSessionId,
      parentSessionId,
      parentConversationId: "parent-conversation",
      parentToolCallId: `tool-${runId}`,
    },
  };
}

afterEach(() => {
  cleanupTmpRoot();
});

describe("SessionManager workflow relationships", () => {
  it("reads previous workflow containers for conversion but refuses them as current sessions", () => {
    const payload = {
      kind: "workflow", command: "workflow", workflowDefinitionId: "debug", label: "Debug",
      lifecycleState: "inactive", executionCwd: canonicalDirectory(makeTmpDir(), "historical directory"),
      lastUpdated: "2026-10-16T00:00:00.000Z", createdAt: "2026-10-16T00:00:00.000Z",
    };
    expect(decodeSessionMetadataFactForReplay({ type: "session.created", version: 5, actor: "flywheel", payload })).toMatchObject({ payload });
    expect(() => Schema.decodeUnknownSync(SessionSchema)(payload)).toThrow();
  });

  it("keeps aggregate settings, user labels, and original description across a recovered root", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const manager = createSessionManager(deps);
    const workflowId = await publishTestWorkflow(manager, { description: "original brief" });
    const settings = workflowRunWriter(deps.projectionReader, (input) => manager.commitWorkflow(input));
    expect(await settings.update(workflowId, (run) => ({ ...run, label: "My run", name: "My run", authProfileId: "selected", roleAssignments: { defaults: { worker: { model: "unit/model" } }, overrides: {} } }), "user")).toBe(true);
    expect(await settings.update(workflowId, (run) => ({ ...run, label: "Generated", name: "Generated" }), "generated")).toBe(false);
    expect(await settings.update(workflowId, (run) => ({ ...run, label: "Renamed", name: "Renamed" }), "user")).toBe(true);
    const control = replayWorkflowControl(store.read({ aggregateId: `workflow:${workflowId}` }));
    const recovered = recoveredWorkflowRoot(control, store.aggregateSeq(`workflow:${workflowId}`) + 1);
    store.append({ aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp: Date.now(), ...recovered });
    store.append({ aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp: Date.now(), ...buildContextInputSeededFact("debug", "replacement brief") });
    const runs = workflowRunReader(deps.projectionReader);
    expect(await runs.read(workflowId)).toMatchObject({
      label: "Renamed", name: "Renamed", userNamed: true, authProfileId: "selected",
      roleAssignments: { defaults: { worker: { model: "unit/model" } }, overrides: {} },
    });
    expect(await runs.readCreationRequest(workflowId)).toBe("original brief");
    expect(await runs.readRequest(workflowId)).toBe("replacement brief");
  });
  async function preparedStart(authProfileId?: string) {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const manager = createSessionManager(deps);
    const workflowId = await publishTestWorkflow(manager, { authProfileId });
    const advance = async (event: Parameters<typeof transitionWorkflow>[1]) => {
      const control = replayWorkflowControl(store.read({ aggregateId: `workflow:${workflowId}` }));
      const proposed = transitionWorkflow(replayWorkflow(control), event);
      if (proposed.command.kind !== "commit") throw new Error("expected a workflow commit");
      return proposed.command.proposal.facts.map((fact, index) => ({
        aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp: Date.now(),
        ...fact, ...(index === 0 ? { expectedSeq: proposed.command.kind === "commit" ? proposed.command.proposal.expectedSeq : 0 } : {}),
      }));
    };
    const started = await manager.commitWorkflow({ workflowId, events: await advance({ type: "START" }) });
    if (started.kind !== "stored") throw new Error("START conflicted");
    const attemptId = replayWorkflowControl(store.read({ aggregateId: `workflow:${workflowId}` })).attempts[0]!.id;
    const events = await advance({ type: "ATTEMPT_STARTED", attemptId, conversationId: "member-conversation" });
    const run = await workflowRunReader(deps.projectionReader).read(workflowId);
    if (!run) throw new Error("expected a registered run");
    return { baseDir, deps, store, manager, workflowId, attemptId, events, parentId: run.launchedFrom.parentSessionId };
  }

  it("publishes one ordinary member and its conversation in the winning attempt transaction", async () => {
    const launch = await preparedStart("run-profile");
    expect(await workflowMembershipReader(launch.deps.projectionReader).list(launch.workflowId)).toEqual([]);
    launch.manager.subscribe(() => { throw new Error("listener failed"); });
    const results = await Promise.all([
      launch.manager.commitWorkflow({ workflowId: launch.workflowId, events: launch.events }),
      launch.manager.commitWorkflow({ workflowId: launch.workflowId, events: launch.events }),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["conflict", "stored"]);
    const members = await workflowMembershipReader(launch.deps.projectionReader).list(launch.workflowId);
    expect(members).toHaveLength(1);
    const member = members[0]!;
    expect(await launch.manager.read(member.sessionId)).toMatchObject({
      kind: "workflow-agent", conversationId: "member-conversation",
      launchedFrom: { parentSessionId: launch.parentId },
      workflowMembership: { kind: "attempt", workflowId: launch.workflowId, attemptId: launch.attemptId },
    });
    expect((await launch.manager.read(launch.parentId))?.childSessionIds).toEqual([member.sessionId]);
    expect(await launch.manager.read(member.sessionId)).not.toHaveProperty("roleAssignments");
    expect(await launch.manager.read(member.sessionId)).not.toHaveProperty("authProfileId");
    expect(launch.store.read({ aggregateId: "conversation:member-conversation" })).toHaveLength(1);
    expect(launch.store.read({ types: ["session.created"] }).filter(({ payload }) => payload.kind === "workflow-agent")).toHaveLength(1);
    expect((await launch.manager.listMetadata()).sessions.filter(({ kind }) => kind === "chat")).toHaveLength(1);
  });

  it("creates no member when adoption advances the run before its attempt commit", async () => {
    const launch = await preparedStart();
    const parentSessionId = await launch.manager.createChat({ name: "New owner" });
    const parent = await launch.manager.read(parentSessionId);
    if (parent?.kind !== "chat") throw new Error("expected chat");
    expect(await launch.manager.adoptWorkflow({
      workflowId: launch.workflowId, launchedFrom: { parentSessionId, conversationId: parent.conversationId, toolUseId: "adopt" },
    })).toBe(true);
    const result = await launch.manager.commitWorkflow({ workflowId: launch.workflowId, events: launch.events });
    expect(result.kind).toBe("conflict");
    expect(await workflowMembershipReader(launch.deps.projectionReader).list(launch.workflowId)).toEqual([]);
    expect(launch.store.read({ aggregateId: "conversation:member-conversation" })).toEqual([]);
  });

  it("adopts live member edges without changing their immutable workflow membership", async () => {
    const launch = await preparedStart();
    expect((await launch.manager.commitWorkflow({ workflowId: launch.workflowId, events: launch.events })).kind).toBe("stored");
    const member = (await workflowMembershipReader(launch.deps.projectionReader).list(launch.workflowId))[0]!;
    const parentSessionId = await launch.manager.createChat({ name: "New owner" });
    const parent = await launch.manager.read(parentSessionId);
    if (parent?.kind !== "chat") throw new Error("expected chat");
    expect(await launch.manager.adoptWorkflow({ workflowId: launch.workflowId, launchedFrom: { parentSessionId, conversationId: parent.conversationId, toolUseId: "adopt" } })).toBe(true);
    expect((await launch.manager.read(launch.parentId))?.childSessionIds).toBeUndefined();
    expect((await launch.manager.read(parentSessionId))?.childSessionIds).toEqual([member.sessionId]);
    expect(await launch.manager.read(member.sessionId)).toMatchObject({
      launchedFrom: { parentSessionId },
      workflowMembership: { kind: "attempt", workflowId: launch.workflowId, attemptId: launch.attemptId },
    });
  });

  it("refuses a new member after its parent's deletion seals admission", async () => {
    const launch = await preparedStart();
    await launch.manager.admitDeletion(launch.parentId);
    await expect(launch.manager.commitWorkflow({ workflowId: launch.workflowId, events: launch.events })).rejects.toThrow("deletion");
    expect(await workflowMembershipReader(launch.deps.projectionReader).list(launch.workflowId)).toEqual([]);
  });

  it("publishes already-decoded workflow fact payloads without replacing them", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const batches: Array<readonly GuardedEventStoreAppend[]> = [];
    let payloadReads = 0;
    let payloadReadsBeforeAppend = -1;
    const fact = buildWorkflowPausedFact("Await operator input");
    Reflect.set(fact, "payload", new Proxy(fact.payload, {
      get: (target, property, receiver) => {
        payloadReads += 1;
        // oxlint-disable-next-line anti-slop/no-reflect-get -- boundary: a Proxy trap forwards an arbitrary property key to its target
        return Reflect.get(target, property, receiver);
      },
      ownKeys: (target) => {
        payloadReads += 1;
        return Reflect.ownKeys(target);
      },
    }));
    const manager = createSessionManager({
      ...deps,
      writer: {
        append: async (event) => store.append(event),
        appendBatch: async (events) => store.appendBatch(events),
        appendGuarded: async (event) => store.appendGuarded(event),
        appendBatchGuarded: async (events) => {
          batches.push(events);
          if (events.some(({ type }) => type === "workflow.paused")) payloadReadsBeforeAppend = payloadReads;
          return store.appendBatchGuarded(events);
        },
        pruneSupersededEvents: async (...args) => store.pruneSupersededEvents(...args),
      },
    });

    const launchedFrom = await workflowParentBinding(manager, { workflowDefinitionId: "debug" });
    batches.length = 0;
    await manager.publishWorkflow({
      id: manager.allocateId(),
      description: "Paused workflow",
      workflowDefinitionId: "debug",
      initialRoles: {},
      facts: [fact],
      launchedFrom,
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.find(({ type }) => type === fact.type)?.payload).toBe(fact.payload);
    expect(payloadReadsBeforeAppend).toBe(0);
  });

  it("publishes run ownership without a workflow session or a chat child link", async () => {
    const baseDir = makeTmpDir();
    const { deps } = makeDepsWithStore(baseDir);
    const manager = createSessionManager(deps);
    const parentId = await manager.createChat({ name: "Chat" });
    const launchedFrom = await workflowParentBinding(manager, {
      parentSessionId: parentId,
      workflowDefinitionId: "debug",
      toolUseId: "tc_1",
      description: "fix the bug",
    });
    const childId = await publishTestWorkflow(manager, { name: "Debug Run", workflowDefinitionId: "debug", launchedFrom });

    const parent = await readStoredSession(parentId, baseDir);
    const child = await readStoredSession(childId, baseDir);
    expect(parent?.childSessionIds).toBeUndefined();
    expect(child).toBeNull();
    expect(await workflowRunReader(deps.projectionReader).read(childId)).toMatchObject({ launchedFrom, label: "Debug Run" });
    expect((await workflowRunReader(deps.projectionReader).listForParent(parentId)).map(({ workflowId }) => workflowId)).toEqual([childId]);
  });

  it("refuses a workflow whose parent is missing, is not a chat, or names another conversation, and writes nothing", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const manager = createSessionManager(deps);
    const chat = await workflowParentBinding(manager, { workflowDefinitionId: "debug", toolUseId: "tc_1" });
    const workflowParent = await publishTestWorkflow(manager, { workflowDefinitionId: "debug", launchedFrom: chat });
    const childId = manager.allocateId();

    for (const launchedFrom of [
      { ...chat, parentSessionId: "missing-chat" },
      { ...chat, parentSessionId: workflowParent },
      { ...chat, conversationId: "another-conversation" },
    ]) {
      const failure = await publishTestWorkflow(manager, { id: childId, workflowDefinitionId: "debug", launchedFrom }).then(() => undefined, (error: unknown) => error);

      expect(failure).toBeInstanceOf(WorkflowParentRefusal);
      expect(failure).toMatchObject({ message: `Workflow parent ${launchedFrom.parentSessionId} is not the host-attested chat conversation` });
    }
    expect(store.read({ aggregateId: `session:${childId}` })).toEqual([]);
    expect(store.read({ aggregateId: `workflow:${childId}` })).toEqual([]);
    expect((await manager.read(chat.parentSessionId))?.childSessionIds).toBeUndefined();
  });

  it("folds the latest workflow adoption as the current binding without rewriting creation", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const manager = createSessionManager(deps);
    const originalParentId = await manager.createChat({ name: "Original" });
    const adoptingParentId = await manager.createChat({ name: "Adopter" });
    const latestParentId = await manager.createChat({ name: "Latest" });
    const original = await workflowParentBinding(manager, { parentSessionId: originalParentId, workflowDefinitionId: "fixture-workflow", toolUseId: "original-tool" });
    const childId = await publishTestWorkflow(manager, { launchedFrom: original });

    adoptTestWorkflow(store, { workflowSessionId: childId, previousParentId: originalParentId, parentSessionId: adoptingParentId, parentConversationId: "adopting-conversation", toolUseId: "adopting-tool" });
    adoptTestWorkflow(store, { workflowSessionId: childId, previousParentId: adoptingParentId, parentSessionId: latestParentId, parentConversationId: "latest-conversation", toolUseId: "latest-tool" });

    const expectedBinding = {
      parentSessionId: latestParentId,
      conversationId: "latest-conversation",
      toolUseId: "latest-tool",
    };
    const runs = workflowRunReader(deps.projectionReader);
    expect((await runs.read(childId))?.launchedFrom).toEqual(expectedBinding);
    expect((await runs.listForParent(latestParentId)).map(({ workflowId }) => workflowId)).toEqual([childId]);
    expect(await runs.listForParent(originalParentId)).toEqual([]);
    expect((await manager.read(originalParentId))?.childSessionIds).toBeUndefined();
    expect((await manager.read(adoptingParentId))?.childSessionIds).toBeUndefined();
    expect((await manager.read(latestParentId))?.childSessionIds).toBeUndefined();

    const childEvents = store.read({ aggregateId: `workflow:${childId}` });
    expect(childEvents.find(({ type }) => type === "workflow.run.registered")?.payload.launchedFrom).toEqual(original);
    expect(childEvents.filter(({ type }) => type === "workflow.run.adopted").map(({ payload }) => payload.launchedFrom)).toEqual([
      { parentSessionId: adoptingParentId, conversationId: "adopting-conversation", toolUseId: "adopting-tool" },
      expectedBinding,
    ]);
  });

  it("retries a parent telemetry conflict and publishes one run without a session relationship", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    let parentId = "";
    const race = racingPublicationWriter(store, (attempt) => {
      if (attempt === 1) appendParentTelemetry(store, parentId, attempt);
    });
    const manager = createSessionManager({ ...deps, writer: race.writer });
    parentId = await manager.createChat({ name: "Chat" });

    const childId = await publishTestWorkflow(manager, {
      launchedFrom: await workflowParentBinding(manager, { parentSessionId: parentId, workflowDefinitionId: "debug", description: "fix" }),
    });

    expect(race.attempts()).toBe(2);
    expect(store.read({ aggregateId: `session:${parentId}` }).filter(({ type }) => type === "session.child.linked")).toHaveLength(0);
    expect(store.read({ aggregateId: `session:${childId}` }).filter(({ type }) => type === "session.created")).toHaveLength(0);
    expect(store.read({ aggregateId: `workflow:${childId}` }).length).toBeGreaterThan(0);
    expect((await readStoredSession(parentId, baseDir))?.childSessionIds).toBeUndefined();
  });

  it("rejects a parent deletion race without publishing child or workflow facts", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    let parentId = "";
    const race = racingPublicationWriter(store, (attempt) => {
      if (attempt === 1) {
        store.append({
          aggregateId: `session:${parentId}`,
          type: "session.deleted",
          version: 1,
          timestamp: Date.now(),
          actor: "flywheel",
          sessionId: parentId,
          payload: { lastUpdated: new Date().toISOString() },
        });
      }
    });
    const manager = createSessionManager({ ...deps, writer: race.writer });
    parentId = await manager.createChat({ name: "Chat" });
    const childId = manager.allocateId();
    const launchedFrom = await workflowParentBinding(manager, { parentSessionId: parentId, workflowDefinitionId: "debug", description: "fix" });

    await expect(publishTestWorkflow(manager, { id: childId, launchedFrom })).rejects.toThrow(`Session not found: ${parentId}`);

    expect(race.attempts()).toBe(1);
    expect(store.read({ aggregateId: `session:${childId}` })).toEqual([]);
    expect(store.read({ aggregateId: `workflow:${childId}` })).toEqual([]);
    expect(await readStoredSession(parentId, baseDir)).toBeNull();
  });

  it("fails clearly and atomically when parent telemetry conflicts exhaust the retry bound", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    let parentId = "";
    const race = racingPublicationWriter(store, (attempt) => {
      appendParentTelemetry(store, parentId, attempt);
    });
    const manager = createSessionManager({ ...deps, writer: race.writer });
    parentId = await manager.createChat({ name: "Chat" });
    const childId = manager.allocateId();
    const launchedFrom = await workflowParentBinding(manager, { parentSessionId: parentId, workflowDefinitionId: "debug", description: "fix" });

    const failure = await publishTestWorkflow(manager, { id: childId, launchedFrom }).then(() => undefined, (error: unknown) => error);

    // The typed failure tells a caller that holds accepted work to keep it
    // for a later safe point: the parent exists and nothing was written.
    expect(failure).toBeInstanceOf(ParentPublicationContendedError);
    expect(failure).toMatchObject({ message: "Parent session changed during workflow publication after 3 attempts" });
    expect(race.attempts()).toBe(3);
    expect(store.read({ aggregateId: `session:${childId}` })).toEqual([]);
    expect(store.read({ aggregateId: `workflow:${childId}` })).toEqual([]);
    expect((await readStoredSession(parentId, baseDir))?.childSessionIds ?? []).toEqual([]);
  });

  it("refuses workflow publication below admitted deletion", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const manager = createSessionManager(deps);
    const parentId = await manager.createChat({ name: "Parent" });
    const subagentId = manager.allocateId();
    await manager.publishSubagent({
      id: subagentId,
      conversationId: manager.allocateId(),
      description: "Child",
      launchedFrom: { parentSessionId: parentId, toolUseId: "subagent-tool" },
      initialRoles: {},
      runBinding: bindingAppend(subagentId, "run-1", parentId),
      assignment: "inspect",
      promptFact: promptAppend(subagentId, "run-1"),
    });
    await manager.admitDeletion(parentId);
    const rejectedWorkflowId = manager.allocateId();

    await expect(publishTestWorkflow(manager, {
      id: rejectedWorkflowId,
      launchedFrom: { parentSessionId: parentId, conversationId: "parent-conversation", toolUseId: "workflow-tool" },
    })).rejects.toThrow(`Cannot publish a workflow below session ${parentId} while deletion is in progress`);

    expect(store.read({ aggregateId: `session:${rejectedWorkflowId}` })).toEqual([]);
  });

  it("reopens a published workflow with its identity, control, profile, and execution directory", async () => {
    const baseDir = makeTmpDir();
    const executionCwd = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const manager = createSessionManager(deps);
    const workflowId = await publishTestWorkflow(manager, {
      authProfileId: "profile-a",
      executionCwd,
    });
    store.close();

    const reopenedStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
    try {
      const reopened = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store: reopenedStore });
      expect(await reopened.read(workflowId)).toBeNull();
      expect(await workflowRunReader(asAsyncEventReadSurface(reopenedStore)).read(workflowId)).toMatchObject({
        authProfileId: "profile-a",
        executionCwd: canonicalDirectory(executionCwd, "test execution directory"),
      });
      expect(reopenedStore.read({ aggregateId: `workflow:${workflowId}` }).some(({ type }) => type === "workflow.control.initialized")).toBe(true);
    } finally {
      reopenedStore.close();
    }
  });

  it("removes an owned workflow from metadata after its parent is deleted", async () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));
    const parentId = await manager.createChat({ name: "Chat" });
    const childId = await publishTestWorkflow(manager, {
      name: "Debug",
      workflowDefinitionId: "debug",
      launchedFrom: await workflowParentBinding(manager, { parentSessionId: parentId, workflowDefinitionId: "debug", description: "fix" }),
    });

    const deletion = await manager.admitDeletion(parentId);
    for (const target of deletion.targets) await manager.finalizeDeletionTarget(target);

    expect(await readStoredSession(childId, baseDir)).toBeNull();
    expect((await manager.listMetadata()).sessions.find((session) => session.id === childId)).toBeUndefined();
  });

  it("lists only chats when a workflow has no started member", async () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));
    const parentId = await manager.createChat({ name: "Chat" });
    const childId = await publishTestWorkflow(manager, {
      name: "Debug",
      workflowDefinitionId: "debug",
      launchedFrom: await workflowParentBinding(manager, { parentSessionId: parentId, workflowDefinitionId: "debug", description: "x" }),
    });

    const sessions = (await manager.listMetadata()).sessions;
    expect(sessions.map(({ id }) => id)).toEqual([parentId]);
    expect(sessions.find((session) => session.id === parentId)?.childSessionIds).toBeUndefined();
    expect(sessions.find((session) => session.id === childId)).toBeUndefined();
  });
});

describe("SessionManager subagent relationships", () => {
  it("atomically publishes a conversation-backed child, parent link, and module-owned run binding", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const batches: Array<readonly GuardedEventStoreAppend[]> = [];
    const manager = createSessionManager({
      ...deps,
      writer: {
        append: async (event) => store.append(event),
        appendBatch: async (events) => store.appendBatch(events),
        appendGuarded: async (event) => store.appendGuarded(event),
        appendBatchGuarded: async (events) => {
          batches.push(events);
          return store.appendBatchGuarded(events);
        },
        pruneSupersededEvents: async (...args) => store.pruneSupersededEvents(...args),
      },
    });
    const parentId = await manager.createChat({ name: "Parent", authProfileId: "profile-a" });
    const parent = await manager.read(parentId);
    if (parent?.kind !== "chat") throw new Error("expected chat parent");
    batches.length = 0;
    const childId = manager.allocateId();
    const conversationId = manager.allocateId();
    const binding = bindingAppend(childId, "run-1", parentId);

    await manager.publishSubagent({
      id: childId,
      conversationId,
      description: "Inspect the runtime",
      launchedFrom: {
        parentSessionId: parentId,
        toolUseId: "tool-run-1",
        description: "Inspect the runtime",
      },
      initialRoles: {},
      authProfileId: "profile-a",
      runBinding: binding,
      promptFact: promptAppend(childId, "run-1"),
      forkHistory: [
        { kind: "user", content: "Look at the runtime" },
        { kind: "assistant", content: [{ type: "text", text: "Initial observation" }] },
      ],
      assignment: "Inspect the runtime",
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map(({ type }) => type)).toEqual([
      "chat.tree.created",
      "chat.entries.appended",
      "session.created",
      "session.auth.profile.selected",
      "session.roles.snapshotted",
      "subagent.run.bound",
      "subagent.prompted",
      "session.child.linked",
    ]);
    expect(batches[0]?.[0]?.expectedSeq).toBe(0);
    expect(batches[0]?.[1]?.expectedSeq).toBe(1);
    const entries = batches[0]?.[1]?.payload.entries;
    if (!Array.isArray(entries) || entries.length !== 3) throw new Error("expected the fork history and the assignment");
    expect(entries[0]).toMatchObject({ kind: "message", parentId: null, message: { kind: "user", content: "Look at the runtime" } });
    expect(entries[1]).toMatchObject({ kind: "message", parentId: entries[0]?.id, message: { kind: "assistant" } });
    // The assignment names the parent that gave it, as it was named at launch.
    expect(entries[2]).toMatchObject({ kind: "message", parentId: entries[1]?.id, message: {
      kind: "user", content: "Inspect the runtime", producer: { kind: "launch", sessionId: parentId, toolUseId: "tool-run-1", name: "Parent" },
    } });
    expect(batches[0]?.[1]?.version).toBe(6);
    expect(batches[0]?.find(({ type }) => type === "subagent.run.bound")?.payload).toBe(binding.payload);
    expect(await manager.read(childId)).toMatchObject({
      kind: "subagent",
      command: "subagent",
      conversationId,
      authProfileId: "profile-a",
      launchedFrom: { parentSessionId: parentId, toolUseId: "tool-run-1" },
    });
    expect((await manager.read(parentId))?.childSessionIds).toEqual([childId]);
    expect(store.read({ aggregateId: `conversation:${conversationId}` }).map(({ type }) => type)).toEqual([
      "chat.tree.created",
      "chat.entries.appended",
    ]);
  });

  it("admits depth three and rejects depth four before publishing any child facts", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const manager = createSessionManager(deps);
    let parentId = await manager.createChat({ name: "Root" });

    for (let depth = 1; depth <= 3; depth += 1) {
      const childId = manager.allocateId();
      await manager.publishSubagent({
        id: childId,
        conversationId: manager.allocateId(),
        description: `Depth ${depth}`,
        launchedFrom: { parentSessionId: parentId, toolUseId: `tool-${depth}` },
        initialRoles: {},
        runBinding: bindingAppend(childId, `run-${depth}`, parentId),
        assignment: "inspect",
        promptFact: promptAppend(childId, `run-${depth}`),
      });
      parentId = childId;
    }

    const rejectedId = manager.allocateId();
    const rejectedConversationId = manager.allocateId();
    await expect(manager.publishSubagent({
      id: rejectedId,
      conversationId: rejectedConversationId,
      description: "Depth 4",
      launchedFrom: { parentSessionId: parentId, toolUseId: "tool-4" },
      initialRoles: {},
      runBinding: bindingAppend(rejectedId, "run-4", parentId),
      assignment: "inspect",
      promptFact: promptAppend(rejectedId, "run-4"),
    })).rejects.toBeInstanceOf(SubagentDepthLimitError);

    expect(store.read({ aggregateId: `session:${rejectedId}` })).toEqual([]);
    expect(store.read({ aggregateId: `conversation:${rejectedConversationId}` })).toEqual([]);
    expect(store.read({ aggregateId: `session:${rejectedId}`, types: ["subagent.run.bound"] })).toEqual([]);
  });
});
