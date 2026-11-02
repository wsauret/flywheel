import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type EventStore, type InFlightSwap } from "../../../../src/infra/event-store-types";
import { resolveSessionDir } from "../../../../src/infra/paths";
import { chatSessionActions, readChatTurnEnd } from "../../../../src/orchestration/session/chat-session-run-evidence";
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle";
import { turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record";
import { createSessionManager, ParentPublicationContendedError } from "../../../../src/orchestration/session/manager";
import { cleanupTmpRoot, makeDepsWithStore, racingPublicationWriter } from "./_session-manager-fixtures";
import { temporaryDirectories } from "../../../helpers/directories";
import { briefEntryId, isBriefEntry } from "../../../../src/orchestration/session/conversation/brief-entry";
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership";
import { recoverWorkflowControl } from "../../../../src/workflows/vm/recovery";
import { commitWorkflowEvent, publishWorkerAttempt } from "../workflow-host/_workflow-host-fixtures";

const tempDir = temporaryDirectories();

afterEach(() => {
  cleanupTmpRoot();
});

describe("runtime invocation publication", () => {
  type ParentRace = (store: EventStore, parentId: string, conversationId: string, attempt: number) => Promise<void>;

  /** Commits one parent entry as another writer would: an assistant reply
   *  for an `a` id, a person's message for a `u` id, so turns alternate. */
  async function appendParentEntry(store: EventStore, parentId: string, conversationId: string, id: string): Promise<void> {
    const writerTree = await tryOpenConversationTree({ conversationId, sessionId: parentId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
    await writerTree?.appendMessage(id.startsWith("u")
      ? { kind: "user", content: `concurrent message ${id}`, origin: "human" }
      : { kind: "assistant", content: `concurrent reply ${id}` }, id);
  }

  async function setupRace(options: {
    /** Lands while preparation reads the conversation, before that read returns. */
    readonly duringPreparation?: ParentRace
    /** Lands after preparation, just before each guarded publication batch. */
    readonly beforePublication?: ParentRace
    readonly parentEntryId?: string
  } = {}) {
    const { duringPreparation, beforePublication, parentEntryId = "launch-entry" } = options;
    const baseDir = tempDir("workflow-publication-");
    const { deps, store } = makeDepsWithStore(baseDir);
    const parentId = await createSessionManager(deps).createChat({ name: "Parent" });
    const parent = await createSessionManager(deps).read(parentId);
    if (parent?.kind !== "chat") throw new Error("expected the parent chat");
    const conversationId = parent.conversationId;
    const tree = await tryOpenConversationTree({ conversationId, sessionId: parentId, store: deps.projectionReader, writer: asAsyncEventWriter(store) });
    await tree?.appendMessage({ kind: "user", content: "start", origin: "human" }, "u1");
    let raced = false;
    // The first read of the conversation's sequence is where publication
    // starts preparing its parent entry. The race lands just before that
    // read returns, after the parent's session guards were read.
    const projectionReader: AsyncEventStateReadSurface = {
      ...deps.projectionReader,
      aggregateSeq: async (aggregateId) => {
        if (duringPreparation && !raced && aggregateId === `conversation:${conversationId}`) {
          raced = true;
          await duringPreparation(store, parentId, conversationId, 1);
        }
        return deps.projectionReader.aggregateSeq(aggregateId);
      },
    };
    const race = racingPublicationWriter(store, async (attempt) => {
      await beforePublication?.(store, parentId, conversationId, attempt);
    });
    const manager = createSessionManager({ ...deps, projectionReader, writer: race.writer });
    const publish = (childId: string, publisher = manager, retainedOperation?: InFlightSwap) => publisher.publishWorkflow({
      ...(retainedOperation === undefined ? {} : { retainedOperation }),
      id: childId,
      description: "verify",
      workflowDefinitionId: "qa",
      initialRoles: {},
      facts: [],
      launchedFrom: { parentSessionId: parentId, conversationId, workflowDefinitionId: "qa", description: "verify", toolUseId: "tool-1" },
      runtimeInvocation: {
        payload: {
          toolUseId: "tool-1",
          parentConversationId: conversationId,
          parentEntryId,
          initiator: "person",
          operation: { kind: "launch", input: { workflowDefinitionId: "qa", description: "verify" } },
        },
        anchor: { kind: "user", content: "Launched the qa workflow: verify", origin: "human" },
      },
    });
    const branch = async () => (await (await tryOpenConversationTree({ conversationId, sessionId: parentId, store: deps.projectionReader }))?.getBranch())?.map((entry) => entry.id);
    return { deps, store, manager, baseDir, parentId, conversationId, publish, branch, raced: () => raced, attempts: race.attempts };
  }

  it("publishes an aggregate without allocating or inspecting a workflow session directory", async () => {
    const launch = await setupRace();
    const childDir = resolveSessionDir("child-1", launch.baseDir);
    writeFileSync(childDir, "not a directory");
    await expect(launch.publish("child-1")).resolves.toBe("child-1");

    expect(launch.store.read({ aggregateId: "session:child-1" })).toEqual([]);
    expect(launch.store.read({ aggregateId: "workflow:child-1" }).some(({ type }) => type === "workflow.run.registered")).toBe(true);
    expect(await launch.branch()).toEqual(["u1", "launch-entry"]);
    expect(lstatSync(childDir).isDirectory()).toBe(false);
  });

  it("leaves neither aggregate facts nor session resources when append fails", async () => {
    const refusal = new Error("parent refused");
    const launch = await setupRace({ duringPreparation: async () => {
      expect(existsSync(resolveSessionDir("child-1", launch.baseDir))).toBe(false);
      throw refusal;
    } });
    const before = launch.store.read({ aggregateId: `session:${launch.parentId}` });

    await expect(launch.publish("child-1")).rejects.toBe(refusal);

    expect(launch.store.read({ aggregateId: "session:child-1" })).toEqual([]);
    expect(launch.store.read({ aggregateId: "workflow:child-1" })).toEqual([]);
    expect(launch.store.read({ aggregateId: `session:${launch.parentId}` })).toEqual(before);
    expect(existsSync(resolveSessionDir("child-1", launch.baseDir))).toBe(false);
  });

  it("keeps an existing session directory when append fails", async () => {
    const launch = await setupRace({ duringPreparation: async () => { throw new Error("parent refused"); } });
    const childDir = resolveSessionDir("child-1", launch.baseDir);
    mkdirSync(childDir);
    writeFileSync(`${childDir}/retained`, "retained");

    await expect(launch.publish("child-1")).rejects.toThrow("parent refused");

    expect(readFileSync(`${childDir}/retained`, "utf8")).toBe("retained");
  });

  it("keeps the committed aggregate when another publisher loses the same retained launch", async () => {
    // Both publishers retire the one retained launch cell, as a headless
    // run and a resident resume of the same launch do.
    const retainedLaunch = (store: EventStore, parentId: string): InFlightSwap => {
      const [cell] = store.readInFlight(parentId, "workflow.launch");
      if (cell === undefined) throw new Error("expected the retained launch cell");
      return { op: "swap", kind: cell.kind, key: cell.key, expectedRaw: cell.raw, payload: null };
    };
    const launch = await setupRace({ beforePublication: async (store, parentId) => {
      await launch.publish("child-1", createSessionManager(launch.deps), retainedLaunch(store, parentId));
    } });
    launch.store.swapInFlightBatch(launch.parentId, [{ op: "swap", kind: "workflow.launch", key: "accepted", expectedRaw: null, payload: { accepted: true } }]);
    const retained = retainedLaunch(launch.store, launch.parentId);

    await expect(launch.publish("child-1", launch.manager, retained)).rejects.toThrow();

    expect(await launch.manager.read("child-1")).toBeNull();
    expect(await launch.branch()).toEqual(["u1", "launch-entry"]);
    expect(launch.store.read({ aggregateId: "workflow:child-1" }).filter(({ type }) => type === "workflow.run.registered")).toHaveLength(1);
    expect(existsSync(resolveSessionDir("child-1", launch.baseDir))).toBe(false);
  });

  it("returns the committed child even when a change listener throws", async () => {
    const launch = await setupRace();
    launch.manager.subscribe(() => { throw new Error("listener failed"); });

    expect(await launch.publish("child-1")).toBe("child-1");
    expect(await launch.manager.read("child-1")).toBeNull();
    expect(launch.store.read({ aggregateId: `session:${launch.parentId}` }).some(({ type }) => type === "session.child.linked")).toBe(false);
  });

  it("appends the host's anchor verbatim, and a settled anchor leaves the parent nothing to resume or recover", async () => {
    const anchorId = turnEndEntryId({ reason: "settled" }, "operation-1");
    const launch = await setupRace({ parentEntryId: anchorId });
    await appendParentEntry(launch.store, launch.parentId, launch.conversationId, "a1");

    await launch.publish("child-1");

    const tree = await tryOpenConversationTree({ conversationId: launch.conversationId, sessionId: launch.parentId, store: launch.deps.projectionReader, writer: asAsyncEventWriter(launch.store) });
    if (!tree) throw new Error("expected the parent conversation");
    expect((await tree.getBranch()).at(-1)).toMatchObject({
      id: anchorId,
      message: { kind: "user", content: "Launched the qa workflow: verify", origin: "human" },
    });
    const turnEnd = await readChatTurnEnd(launch.deps.projectionReader, launch.conversationId);
    expect(turnEnd).toEqual({ end: { reason: "settled" }, recorded: true });
    expect(chatSessionActions("chat", "inactive", turnEnd)).toEqual(["session.delete"]);
    // Ownerless recovery over a parent whose owner died finds no turn to record.
    await tree.recordInterruptedTurn("crash", { ownerDead: true });
    expect((await tree.getBranch()).map((entry) => entry.id)).toEqual(["u1", "a1", anchorId]);
  });

  it("keeps a parent entry that commits during preparation on the active branch, before the invocation's entry", async () => {
    const race = await setupRace({ duringPreparation: (store, parentId, conversationId) => appendParentEntry(store, parentId, conversationId, "a1") });

    await race.publish("child-1");

    expect(race.raced()).toBe(true);
    expect(await race.branch()).toEqual(["u1", "a1", "launch-entry"]);
  });

  it("retries onto the new leaf when a parent entry commits after preparation read the guard", async () => {
    // The batch was prepared on u1, so only the conversation guard can
    // refuse it; the retry reads a1 as the leaf and nothing is orphaned.
    const race = await setupRace({ beforePublication: async (store, parentId, conversationId, attempt) => {
      if (attempt === 1) await appendParentEntry(store, parentId, conversationId, "a1");
    } });

    await race.publish("child-1");

    expect(race.attempts()).toBe(2);
    expect(await race.branch()).toEqual(["u1", "a1", "launch-entry"]);
  });

  it("reports a contended parent with nothing written when every attempt loses to a parent entry", async () => {
    const race = await setupRace({ beforePublication: (store, parentId, conversationId, attempt) =>
      appendParentEntry(store, parentId, conversationId, `${attempt % 2 === 1 ? "a" : "u"}${attempt}`) });

    const failure = await race.publish("child-1").then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ParentPublicationContendedError);
    expect(race.attempts()).toBe(3);
    expect(await race.branch()).toEqual(["u1", "a1", "u2", "a3"]);
    expect(race.store.read({ aggregateId: "session:child-1" })).toEqual([]);
  });

  it("refuses publication when the parent is deleted during preparation", async () => {
    const race = await setupRace({ duringPreparation: async (store, parentId) => {
      store.append({
        aggregateId: `session:${parentId}`,
        type: "session.deleted",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: parentId,
        payload: { lastUpdated: new Date().toISOString() },
      });
    } });

    await expect(race.publish("child-1")).rejects.toThrow(`Session not found: ${race.parentId}`);

    expect(race.raced()).toBe(true);
    expect(race.store.read({ aggregateId: "session:child-1" })).toEqual([]);
    expect(race.store.read({ aggregateId: `conversation:${race.conversationId}` }).flatMap(({ payload }) =>
      Array.isArray(payload.entries) ? payload.entries.map((entry: { readonly id: string }) => entry.id) : [])).toEqual(["u1"]);
  });
});

describe("workflow attempt continuation publication", () => {
  // A person resumes a failed run: its failed agent continues in a new
  // session that holds a copy of its predecessor's context. The copy keeps
  // the brief under the successor's brief entry id, so the worker does not
  // restate the brief and the successor holds it once.
  it("keeps the predecessor's brief as the successor's one brief", async () => {
    const baseDir = tempDir("workflow-continuation-");
    const { deps, store } = makeDepsWithStore(baseDir);
    const reader = deps.projectionReader;
    const writer = asAsyncEventWriter(store);
    const { manager, member, workflow } = await publishWorkerAttempt({ projectRoot: baseDir, reader, writer, workflowId: "run", attemptId: "first", conversationId: "first-conversation" });
    const predecessor = await tryOpenConversationTree({ conversationId: "first-conversation", sessionId: member.sessionId, store: reader, writer });
    await predecessor!.appendMessage({ kind: "user", content: "Do the work.", origin: "system" }, briefEntryId("first"));
    await predecessor!.appendMessage({ kind: "assistant", content: "Started." });
    predecessor!.getStorage().dispose();
    const commit = (event: Parameters<typeof commitWorkflowEvent>[3]) => commitWorkflowEvent({ manager, projectionReader: reader }, "run", workflow, event);
    await commit({ type: "ATTEMPT_FAILED", failure: { attemptId: "first", kind: "fatal", reason: "provider failed", conversationId: "first-conversation" } });
    await commit({ type: "RESUME", readers: {} });
    const recovered = recoverWorkflowControl((await reader.readSlice({ aggregateId: "workflow:run" }, true)).facts);
    if (!recovered.executable) throw new Error("Expected executable control");
    const successorAttemptId = recovered.control.attempts.at(-1)!.id;
    expect(successorAttemptId).not.toBe("first");
    await commit({ type: "ATTEMPT_STARTED", attemptId: successorAttemptId, conversationId: "second-conversation" });

    const successor = await workflowMembershipReader(reader).attempt("run", successorAttemptId);
    const tree = await tryOpenConversationTree({ conversationId: "second-conversation", sessionId: successor!.sessionId, store: reader });
    const branch = await tree!.getBranch();
    tree!.getStorage().dispose();
    expect(branch.filter((entry) => isBriefEntry(entry.id)).map((entry) => entry.id)).toEqual([briefEntryId(successorAttemptId)]);
    expect(branch.map((entry) => entry.kind === "message" ? entry.message.content : entry.kind)).toEqual(["Do the work.", "Started."]);
  });
});
