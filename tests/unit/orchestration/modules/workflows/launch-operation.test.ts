import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types";
import { Log } from "../../../../../src/infra/log";
import { bindRetainedOperationHost, composeRetainedOperationHosts } from "../../../../../src/infra/retained-operation-hosts";
import { createLazyWorkflowController } from "../../../../../src/orchestration/app-service/lazy-workflow-controller";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work";
import { workflowLaunchRetainedOperation } from "../../../../../src/orchestration/modules/workflows/launch-operation";
import type { ConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree";
import { createConversationTreeWriter } from "../../../../../src/orchestration/session/conversation/conversation-tree-writer";
import { turnEndEntryId } from "../../../../../src/orchestration/session/conversation/turn-end-record";
import {
  WORKFLOW_LAUNCH_OPERATION_KIND,
  workflowLaunchHost,
  type WorkflowLaunchHost,
  type WorkflowLaunchOperation,
} from "../../../../../src/orchestration/workflow-host/launch-operation-contract";
import { fakeManager, fakeSessionStore, workflowController } from "../../app-service/app-service-doubles";
import { createSavePointContext, disposeSavePointContext, type SavePointTestContext } from "../../session/_save-point-fixtures";

let ctx: SavePointTestContext;
let tree: ConversationTree;

beforeEach(async () => {
  ctx = await createSavePointContext();
  tree = ctx.tree;
});

afterEach(async () => {
  await disposeSavePointContext(ctx);
});

/** A parent chat's launch cells, as the workflows module reads, reports, and
 *  holds them for its conversation writer. */
describe("workflow launch cells", () => {
  /** The module's launch authority over the fixture store, bound to a host
   *  that only retires the cell and counts each commit. */
  function retiringLaunchAuthority() {
    const reader = asAsyncEventReadSurface(ctx.store);
    const eventWriter = asAsyncEventWriter(ctx.store);
    const commits: WorkflowLaunchOperation[] = [];
    const host: WorkflowLaunchHost = {
      restoreLaunchTracking: async () => { throw new Error("Workflow tracking is not used in this test"); },
      commitLaunch: async (operation, cell) => {
        commits.push(operation);
        if (!eventWriter.swapInFlight) throw new Error("expected exact in-flight write authority");
        const retired = await eventWriter.swapInFlight(cell.sessionId, cell.kind, cell.key, cell.raw, null);
        return retired ? { kind: "committed", dispatch: () => {} } : { kind: "retained" };
      },
      stopLaunch: async () => { throw new Error("Workflow stops are not used in this test"); },
      launchCut: async () => undefined,
      resumeLaunch: async () => ({ ok: false, error: "Workflow resumes are not used in this test" }),
    };
    const authority = workflowLaunchRetainedOperation.bind({
      reader,
      writer: eventWriter,
      hosts: composeRetainedOperationHosts([bindRetainedOperationHost(workflowLaunchHost, host)]),
    });
    return { reader, eventWriter, authority, commits, host };
  }

  function launchCell(overrides: { readonly [key: string]: unknown } = {}): WorkflowLaunchOperation & { readonly [key: string]: unknown } {
    return {
      kind: WORKFLOW_LAUNCH_OPERATION_KIND,
      version: 1,
      operationId: "operation-1",
      parentSessionId: ctx.sessionId,
      parentConversationId: ctx.conversationId,
      childSessionId: "child-1",
      toolUseId: "tool-1",
      parentEntryId: turnEndEntryId({ reason: "settled" }, "operation-1"),
      acceptedAt: "2026-01-02T03:04:05.000Z",
      initiator: "person",
      launch: {
        workflowDefinitionId: "qa",
        description: "verify release",
      },
      ...overrides,
    };
  }

  it("reads a cell a candidate wrote with the person's raw command and a random acknowledgement id, and commits it under the settled id", async () => {
    const { authority, eventWriter, commits } = retiringLaunchAuthority();
    // The shape before 2026-10-03 carried `acceptedInput` and reserved a random id. Remove after 2027-04-03.
    await eventWriter.swapInFlight?.(ctx.sessionId, WORKFLOW_LAUNCH_OPERATION_KIND, "operation-1", null, launchCell({ acceptedInput: "/qa verify release", parentEntryId: "5f0c2d1e-draft" }));

    const [held] = await authority.read({ sessionId: ctx.sessionId, conversationId: ctx.conversationId });
    if (!held) throw new Error("the old cell did not decode");
    await createConversationTreeWriter({ tree }).acceptRetainedOperation(held);

    expect(commits.map(({ operationId, parentEntryId }) => [operationId, parentEntryId])).toEqual([["operation-1", turnEndEntryId({ reason: "settled" }, "operation-1")]]);
    expect(ctx.store.readInFlight(ctx.sessionId, WORKFLOW_LAUNCH_OPERATION_KIND)).toEqual([]);
  });

  it("starts a cell that a parent wrote before the agent lexicon, with its model choices as `launch.steps`", async () => {
    const { authority, eventWriter, commits } = retiringLaunchAuthority();
    // The shape before 2026-10-16 named the fixed model choices `steps`. Remove after 2027-04-30.
    const models = { implement: { model: "gpt-6-luna", effort: "high" } } as const;
    await eventWriter.swapInFlight?.(ctx.sessionId, WORKFLOW_LAUNCH_OPERATION_KIND, "operation-1", null, launchCell({ launch: { workflowDefinitionId: "qa", description: "verify release", steps: models } }));

    const [held] = await authority.read({ sessionId: ctx.sessionId, conversationId: ctx.conversationId });
    if (!held) throw new Error("the cell with launch steps did not decode");
    await createConversationTreeWriter({ tree }).acceptRetainedOperation(held);

    expect(commits.map(({ launch }) => launch)).toEqual([{ workflowDefinitionId: "qa", description: "verify release", agents: models }]);
    expect(ctx.store.readInFlight(ctx.sessionId, WORKFLOW_LAUNCH_OPERATION_KIND)).toEqual([]);
  });

  it("keeps a cell of an unknown version or shape: it reports pending work, warns once, and no commit consumes it", async () => {
    const { authority, eventWriter, reader, commits } = retiringLaunchAuthority();
    const warn = spyOn(Log.create({ service: "workflow-launch-operation" }), "warn").mockImplementation(() => {});
    try {
      await eventWriter.swapInFlight?.(ctx.sessionId, WORKFLOW_LAUNCH_OPERATION_KIND, "operation-1", null, launchCell({ version: 2 }));
      await eventWriter.swapInFlight?.(ctx.sessionId, WORKFLOW_LAUNCH_OPERATION_KIND, "operation-2", null, { kind: WORKFLOW_LAUNCH_OPERATION_KIND, version: 1, operationId: "operation-2" });

      expect(await authority.read({ sessionId: ctx.sessionId, conversationId: ctx.conversationId })).toEqual([]);
      expect(await workflowLaunchRetainedOperation.pending(reader, ctx.sessionId, ctx.conversationId)).toBe(true);
      expect(commits).toEqual([]);
      expect(ctx.store.readInFlight(ctx.sessionId, WORKFLOW_LAUNCH_OPERATION_KIND).map(({ key }) => key).sort()).toEqual(["operation-1", "operation-2"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({ sessionId: ctx.sessionId, reason: "unreadable", version: "2" });
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a readable cell that names another parent conversation: it warns once, and this parent neither reports nor commits it", async () => {
    const { authority, eventWriter, reader, commits } = retiringLaunchAuthority();
    const warn = spyOn(Log.create({ service: "workflow-launch-operation" }), "warn").mockImplementation(() => {});
    try {
      await eventWriter.swapInFlight?.(ctx.sessionId, WORKFLOW_LAUNCH_OPERATION_KIND, "operation-1", null, launchCell({ parentConversationId: "another-conversation" }));

      expect(await authority.read({ sessionId: ctx.sessionId, conversationId: ctx.conversationId })).toEqual([]);
      expect(await workflowLaunchRetainedOperation.pending(reader, ctx.sessionId, ctx.conversationId)).toBe(false);
      expect(commits).toEqual([]);
      expect(ctx.store.readInFlight(ctx.sessionId, WORKFLOW_LAUNCH_OPERATION_KIND).map(({ key }) => key)).toEqual(["operation-1"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({ sessionId: ctx.sessionId, reason: "foreign", version: "1" });
    } finally {
      warn.mockRestore();
    }
  });

  it("reads a parent's launches without loading the workflow controller, which only their commit loads", async () => {
    const { reader, eventWriter, host, commits } = retiringLaunchAuthority();
    let loads = 0;
    const workflows = createLazyWorkflowController({
      create: async () => {
        loads += 1;
        return { ...workflowController(fakeSessionStore(new Map()), fakeManager()), commitLaunch: host.commitLaunch };
      },
    });
    const authority = workflowLaunchRetainedOperation.bind({ reader, writer: eventWriter, hosts: composeRetainedOperationHosts([bindRetainedOperationHost(workflowLaunchHost, workflows)]) });
    await authority.accept({ sessionId: ctx.sessionId, conversationId: ctx.conversationId, operation: { kind: WORKFLOW_LAUNCH_OPERATION_KIND, key: "operation-1", payload: launchCell() } });

    const held = await authority.read({ sessionId: ctx.sessionId, conversationId: ctx.conversationId });
    await workflows.restoreLaunchTracking("child", createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
    expect(await workflowLaunchRetainedOperation.pending(reader, ctx.sessionId, ctx.conversationId)).toBe(true);
    expect(held).toHaveLength(1);
    expect(loads).toBe(0);

    await held[0]?.commit();
    expect(loads).toBe(1);
    expect(commits).toHaveLength(1);
  });

  it("reconstructs a strict launch passively and consumes it only at an explicit save point", async () => {
    const { authority, commits } = retiringLaunchAuthority();
    const accepted = { kind: WORKFLOW_LAUNCH_OPERATION_KIND, key: "operation-1", payload: launchCell() };

    await authority.accept({
      sessionId: ctx.sessionId,
      conversationId: ctx.conversationId,
      operation: accepted,
    });
    const reconstructed = await authority.read({
      sessionId: ctx.sessionId,
      conversationId: ctx.conversationId,
    });
    expect(reconstructed).toHaveLength(1);
    expect(commits).toHaveLength(0);

    const savePoint = createConversationTreeWriter({ tree });
    const operation = reconstructed[0];
    if (!operation) throw new Error("expected retained launch");
    await savePoint.acceptRetainedOperation(operation);

    expect(commits).toHaveLength(1);
    expect(await authority.read({
      sessionId: ctx.sessionId,
      conversationId: ctx.conversationId,
    })).toEqual([]);
  });
});
