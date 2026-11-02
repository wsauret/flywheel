import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"

import { EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages.js"
import type { ChatHostAttach } from "../../../../src/orchestration/app-service/executor-command-handover.js"
import { continueAfterReplacement } from "../../../../src/orchestration/app-service/replacement-continuation.js"
import { readChatTurnEnd, readChatTurnEndEvidence } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { COMMAND_HANDOVER_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/command-handover.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId, type TurnInterruption } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { authorizePlannedSessionContinuation, awaitsPlannedContinuation, createContinuationLanes, pendingRetainedOperationContinuations, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, readPlannedSessionContinuationAsync } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorWithRunner, resumeDispatch, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime.js"
import { handedOverRow } from "../agent-runtime/_command-handover-fixtures.js"
import { workflowLaunchRetainedOperation } from "../../../../src/orchestration/modules/workflows/launch-operation.js"
import { WORKFLOW_LAUNCH_OPERATION_KIND, workflowLaunchHost } from "../../../../src/orchestration/workflow-host/launch-operation-contract.js"
import { bindRetainedOperationHost, composeRetainedOperationHosts } from "../../../../src/infra/retained-operation-hosts.js"
import { prepareWorkflowLaunch } from "../../../../src/orchestration/workflow-host/publish.js"
import { fixtureDefinitions, FIXTURE_WORKFLOW_ID, workflowIn } from "../../../helpers/project-definitions.js"
import { makeWorkflowDeps } from "../workflow-host/_workflow-controller-fixtures.js"
import { publishTestSubagent, publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"
import { prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer.js"
import { buildSubagentPaused } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { holdReplyWait } from "../../../../src/orchestration/session/conversation/reply-wait-cells.js"

/** A supervisor that records each chat it attaches and each adoption of an
 *  attached chat's host, which takes a moment to settle. */
function attachingSupervisor(steps: string[]): ChatHostAttach["supervisor"] {
  return {
    activateSession: async (sessionId) => { steps.push(`attach ${sessionId}`); return true },
    ensureChatRunner: async (sessionId) => ({
      adoptHandedOver: async () => {
        await Bun.sleep(5)
        steps.push(`adopted ${sessionId}`)
      },
    }),
  }
}

describe("continuing a planned replacement's work", () => {
  let ctx: SupervisorTestContext

  beforeEach(() => {
    ctx = createSupervisorTestContext()
  })

  afterEach(async () => {
    setSystemTime()
    await disposeSupervisorTestContext(ctx)
  })

  /** A chat whose last turn ended with the interrupt `by` recorded, holding
   *  a continuation row of `handoffId` unless it is absent. */
  async function interruptedChat(by: TurnInterruption, handoffId: string | undefined, wait?: { seconds: number; reply?: boolean }): Promise<string> {
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    const conversationId = `conversation-${crypto.randomUUID()}`
    const sessionId = await ctx.manager.createChat({ conversationId })
    const tree = await tryOpenConversationTree({ conversationId, sessionId, now: () => new Date().toISOString(), store: asAsyncEventReadSurface(ctx.store), writer })
    if (!tree) throw new Error("the chat has no conversation tree")
    const end = interruptedTurnEnd(by)
    await tree.appendMessage({ kind: "user", content: "Do the fixture work.", origin: "human" })
    if (wait) {
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait", name: wait.reply ? "message_session" : "process", input: wait.reply ? { target: "session", to: "child", wait: true } : { action: "wait", soft_timeout: wait.seconds } }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: "wait", content: [{ type: "text", text: "Wait acknowledged." }], isError: false })
      if (wait.reply) await holdReplyWait(writer, sessionId, { addresseeSessionId: "child", toolUseId: "wait", openedAtMs: Date.now() })
    }
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, true), origin: "system" }, turnEndEntryId(end, sessionId))
    tree.getStorage().dispose()
    if (handoffId !== undefined) await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(ctx.store), writer, continuation: { target: { sessionId, kind: "chat" }, handoffId } })
    return sessionId
  }

  const owed = (sessionId: string): Promise<boolean> => awaitsPlannedContinuation({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), manager: ctx.manager }, sessionId)

  async function interruptedChild(id: string, parent: string, parentConversationId: string) {
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    await publishTestSubagent(ctx.manager, ctx.baseDir, id, parent, parentConversationId)
    const tree = await tryOpenConversationTree({ conversationId: `${id}-conversation`, sessionId: id, store: asAsyncEventReadSurface(ctx.store), writer })
    if (!tree) throw new Error("The child has no conversation tree")
    const end = interruptedTurnEnd("replacement")
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, id))
    tree.getStorage().dispose()
    await writer.append(prepareSessionFactAppend(id, buildSubagentPaused({ childRunId: `${id}-run`, pausedBy: "runtime" })))
    await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(ctx.store), writer, continuation: { target: { sessionId: id, kind: "subagent" }, runId: `${id}-run`, handoffId: "nested-handoff" } })
    return id
  }

  test.each(["workflow", "chat"] as const)("reattaches nested children after their live parent and before a chat turn (%s)", async (kind) => {
    const parent = kind === "workflow"
      ? await startTestWorkflowMember(ctx.manager, ctx.store, await publishTestWorkflow(ctx.manager))
      : await interruptedChat("replacement", "nested-handoff")
    const metadata = await ctx.manager.read(parent)
    if (!metadata || !("conversationId" in metadata)) throw new Error("Expected a conversation owner")
    const parentConversationId = metadata.conversationId
    const first = await interruptedChild("parent-child", parent, parentConversationId)
    const second = await interruptedChild("nested-child", first, `${first}-conversation`)
    const order: string[] = []
    const resumed = await continueAfterReplacement({
      reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store),
      writer: ctx.runtime.runSync(EventStoreWriterService), manager: ctx.manager, lanes: ctx.continuationLanes,
      supervisor: attachingSupervisor([]), keep: async () => {},
      resumePlannedWorkflow: async () => { throw new Error("unexpected workflow continuation") },
      dispatch: resumeDispatch(async (mutation) => {
        order.push(mutation.sessionId)
        return { ok: true }
      }),
      handoffId: "nested-handoff", settled: () => {},
    })
    expect(resumed).toEqual(kind === "workflow" ? [first, second] : [first, second, parent])
    expect(order).toEqual([...resumed])
  })

  /** A command of `sessionId`'s chat conversation that `handoffId` handed over. */
  async function handedOver(sessionId: string, handoffId: string): Promise<void> {
    const session = await ctx.manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error("the fixture session is not a chat")
    const row = handedOverRow("/scratch", { sessionId, conversationId: session.conversationId }, { handoffId, processId: `bash-bg-${sessionId}` })
    await ctx.runtime.runSync(EventStoreWriterService).putInFlight?.(sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND, row.processId, row)
  }

  function retainedLaunch(parentSessionId: string, parentConversationId: string, childSessionId: string) {
    return {
      kind: WORKFLOW_LAUNCH_OPERATION_KIND,
      version: 1 as const,
      operationId: `operation-${childSessionId}`,
      parentSessionId,
      parentConversationId,
      childSessionId,
      toolUseId: `tool-${childSessionId}`,
      parentEntryId: `entry-${childSessionId}`,
      acceptedAt: "2026-01-02T03:04:05.000Z",
      initiator: "person" as const,
      launch: {
        workflowDefinitionId: FIXTURE_WORKFLOW_ID,
        description: "replacement",
      },
    }
  }

  test("transfers a published retained launch to its reserved child and resumes it through the workflow operator path", async () => {
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    const projectionReader = asAsyncEventReadSurface(ctx.store)
    const parentConversationId = `conversation-${crypto.randomUUID()}`
    const parentSessionId = await ctx.manager.createChat({ conversationId: parentConversationId })
    const parentTree = await tryOpenConversationTree({
      conversationId: parentConversationId,
      sessionId: parentSessionId,
      store: projectionReader,
      writer,
    })
    if (!parentTree) throw new Error("the retained launch parent has no conversation tree")
    parentTree.getStorage().dispose()
    const childSessionId = "reserved-published-workflow"
    const prepared = await prepareWorkflowLaunch({
      workflow: workflowIn(fixtureDefinitions().captureRevision(), FIXTURE_WORKFLOW_ID),
      description: "replacement",
      deps: makeWorkflowDeps(),
      authProfileId: "default",
      projectRoot: ctx.baseDir,
      definitionRevision: fixtureDefinitions().captureRevision(),
    })
    const launch = retainedLaunch(parentSessionId, parentConversationId, childSessionId)
    await ctx.manager.publishWorkflow({
      id: childSessionId,
      description: prepared.description,
      workflowDefinitionId: prepared.workflowDefinitionId,
      initialRoles: prepared.initialRoles,
      authProfileId: prepared.authProfileId,
      facts: prepared.workflowFacts,
      launchedFrom: {
        parentSessionId,
        conversationId: parentConversationId,
        toolUseId: launch.toolUseId,
      },
      runtimeInvocation: {
        payload: {
          toolUseId: launch.toolUseId,
          parentConversationId,
          parentEntryId: launch.parentEntryId,
          initiator: launch.initiator,
          operation: { kind: "launch", input: launch.launch },
        },
        anchor: { kind: "user", content: "Launched the repair workflow: replacement", origin: "human" },
      },
    })
    const operations = await pendingRetainedOperationContinuations({
      reader: asAsyncEventReadSurface(ctx.store),
      projectionReader,
      manager: ctx.manager,
      sessionId: parentSessionId,
      conversationId: parentConversationId,
    })
    expect(operations).toEqual([{
      kind: WORKFLOW_LAUNCH_OPERATION_KIND,
      key: `published:${childSessionId}`,
      ownerSessionId: parentSessionId,
      target: { workflowId: childSessionId, kind: "workflow" },
      bindingId: launch.toolUseId,
    }])
    await authorizePlannedSessionContinuation({
      reader: projectionReader,
      writer,
      continuation: { target: { sessionId: parentSessionId, kind: "chat" }, handoffId: "handoff-published", operations },
    })
    const dispatched: FrontendMutation[] = []
    const planned: string[] = []

    const resumed = await continueAfterReplacement({
      reader: asAsyncEventReadSurface(ctx.store),
      projectionReader,
      writer,
      manager: ctx.manager,
      lanes: ctx.continuationLanes,
      supervisor: attachingSupervisor([]),
      keep: async () => {},
      resumePlannedWorkflow: async (sessionId: string) => {
        planned.push(sessionId)
        expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), parentSessionId)).toBeNull()
        return { kind: "resumed" as const, sessionId }
      },
      dispatch: resumeDispatch(async (mutation) => {
        dispatched.push(mutation)
        expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), parentSessionId)).toBeNull()
        expect((await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), childSessionId))?.handoffId).toBe("handoff-published")
        return { ok: true }
      }),
      handoffId: "handoff-published",
      settled: () => {},
    })

    expect(resumed).toEqual([childSessionId])
    expect(dispatched).toEqual([])
    expect(planned).toEqual([childSessionId])
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), childSessionId)).toBeNull()
  })

  test("continues a retained launch through the parent Resume save point without a model turn", async () => {
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    const projectionReader = asAsyncEventReadSurface(ctx.store)
    const parentConversationId = `conversation-${crypto.randomUUID()}`
    const parentSessionId = await ctx.manager.createChat({ conversationId: parentConversationId })
    const launch = retainedLaunch(parentSessionId, parentConversationId, "reserved-retained-workflow")
    await writer.putInFlight?.(parentSessionId, WORKFLOW_LAUNCH_OPERATION_KIND, launch.operationId, launch)
    const operations = await pendingRetainedOperationContinuations({
      reader: asAsyncEventReadSurface(ctx.store),
      projectionReader,
      manager: ctx.manager,
      sessionId: parentSessionId,
      conversationId: parentConversationId,
    })
    await authorizePlannedSessionContinuation({
      reader: projectionReader,
      writer,
      continuation: { target: { sessionId: parentSessionId, kind: "chat" }, handoffId: "handoff-retained", operations },
    })
    let preparations = 0
    const authority = workflowLaunchRetainedOperation.bind({
      reader: projectionReader,
      writer,
      hosts: composeRetainedOperationHosts([bindRetainedOperationHost(workflowLaunchHost, {
        restoreLaunchTracking: async () => { throw new Error("Workflow tracking is not used in this test") },
        commitLaunch: async (_operation, cell) => {
          preparations += 1
          if (!writer.swapInFlight) throw new Error("expected exact in-flight write authority")
          const committed = await writer.swapInFlight(cell.sessionId, cell.kind, cell.key, cell.raw, null)
          return committed ? { kind: "committed", dispatch: () => {} } : { kind: "retained" }
        },
        stopLaunch: async () => { throw new Error("Workflow stops are not used in this test") },
        launchCut: async () => undefined,
        resumeLaunch: async () => ({ ok: false, error: "Workflow resumes are not used in this test" }),
      })]),
    })
    const dispatched: FrontendMutation[] = []

    expect(await continueAfterReplacement({
      reader: asAsyncEventReadSurface(ctx.store),
      projectionReader,
      writer,
      manager: ctx.manager,
      lanes: ctx.continuationLanes,
      supervisor: attachingSupervisor([]),
      keep: async () => {},
      resumePlannedWorkflow: async () => { throw new Error("unexpected workflow continuation") },
      dispatch: resumeDispatch(async (mutation) => {
        dispatched.push(mutation)
        const retained = await authority.read({ sessionId: parentSessionId, conversationId: parentConversationId })
        await Promise.all(retained.map((operation) => operation.commit()))
        return { ok: true }
      }),
      handoffId: "handoff-retained",
      settled: () => {},
    })).toEqual([parentSessionId])
    expect(dispatched).toEqual([{ type: "chat.resume", sessionId: parentSessionId }])
    expect(preparations).toBe(1)
    expect(ctx.store.readInFlight(parentSessionId, WORKFLOW_LAUNCH_OPERATION_KIND)).toEqual([])
  })

  test("a person's interrupt withdraws automatic continuation without consuming retained work", async () => {
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    const projectionReader = asAsyncEventReadSurface(ctx.store)
    const parentConversationId = `conversation-${crypto.randomUUID()}`
    const parentSessionId = await ctx.manager.createChat({ conversationId: parentConversationId })
    const launch = retainedLaunch(parentSessionId, parentConversationId, "reserved-interrupted-workflow")
    await writer.putInFlight?.(parentSessionId, WORKFLOW_LAUNCH_OPERATION_KIND, launch.operationId, launch)
    const operations = await pendingRetainedOperationContinuations({
      reader: asAsyncEventReadSurface(ctx.store),
      projectionReader,
      manager: ctx.manager,
      sessionId: parentSessionId,
      conversationId: parentConversationId,
    })
    await authorizePlannedSessionContinuation({
      reader: projectionReader,
      writer,
      continuation: { target: { sessionId: parentSessionId, kind: "chat" }, handoffId: "handoff-interrupted", operations },
    })
    const resolving = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let delayed = true
    const manager = {
      ...ctx.manager,
      read: async (sessionId: string) => {
        if (delayed && sessionId === parentSessionId) {
          delayed = false
          resolving.resolve()
          await release.promise
        }
        return await ctx.manager.read(sessionId)
      },
    }
    const dispatched: FrontendMutation[] = []
    const continuation = continueAfterReplacement({
      reader: asAsyncEventReadSurface(ctx.store),
      projectionReader,
      writer,
      manager,
      lanes: ctx.continuationLanes,
      supervisor: attachingSupervisor([]),
      keep: async () => {},
      resumePlannedWorkflow: async () => { throw new Error("unexpected workflow continuation") },
      dispatch: resumeDispatch(async (mutation) => { dispatched.push(mutation); return { ok: true } }),
      handoffId: "handoff-interrupted",
      settled: () => {},
    })
    await resolving.promise
    const interrupted = ctx.continuationLanes.interrupt({ by: "person",
      reader: asAsyncEventReadSurface(ctx.store),
      projectionReader,
      writer,
      manager: ctx.manager,
      sessionId: parentSessionId,
      runs: () => false,
      interrupt: () => false,
    })
    release.resolve()

    expect(await continuation).toEqual([])
    expect(await interrupted).toBe(true)
    expect(dispatched).toEqual([])
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), parentSessionId)).toBeNull()
    expect(ctx.store.readInFlight(parentSessionId, WORKFLOW_LAUNCH_OPERATION_KIND)).toHaveLength(1)

    let preparations = 0
    const authority = workflowLaunchRetainedOperation.bind({
      reader: asAsyncEventReadSurface(ctx.store),
      writer,
      hosts: composeRetainedOperationHosts([bindRetainedOperationHost(workflowLaunchHost, {
        restoreLaunchTracking: async () => { throw new Error("Workflow tracking is not used in this test") },
        commitLaunch: async (_operation, cell) => {
          preparations += 1
          if (!writer.swapInFlight) throw new Error("expected exact in-flight write authority")
          const committed = await writer.swapInFlight(cell.sessionId, cell.kind, cell.key, cell.raw, null)
          return committed ? { kind: "committed", dispatch: () => {} } : { kind: "retained" }
        },
        stopLaunch: async () => { throw new Error("Workflow stops are not used in this test") },
        launchCut: async () => undefined,
        resumeLaunch: async () => ({ ok: false, error: "Workflow resumes are not used in this test" }),
      })]),
    })
    const retained = await authority.read({ sessionId: parentSessionId, conversationId: parentConversationId })
    expect(preparations).toBe(0)
    expect(retained).toHaveLength(1)
    await retained[0]?.commit()
    expect(preparations).toBe(1)
  })

  test("gives every command the handoff handed over a host before any resume: each chat's is attached and adopts, and the keeper holds every other; a chat that holds only a command is attached and not resumed", async () => {
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    const cut = await interruptedChat("replacement", "handoff-3")
    const idle = await interruptedChat("person", undefined)
    const other = await interruptedChat("person", undefined)
    await handedOver(cut, "handoff-3")
    await handedOver(idle, "handoff-3")
    await handedOver(other, "handoff-earlier")
    // The step of a workflow a person paused, which no chat owns and no resume re-enters.
    const step = handedOverRow("/scratch", { sessionId: "workflow-paused", conversationId: "agent-step-1" }, { handoffId: "handoff-3", processId: "bash-bg-step" })
    await writer.putInFlight?.(step.sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND, step.processId, step)
    const steps: string[] = []

    const resumed = await continueAfterReplacement({
      reader: asAsyncEventReadSurface(ctx.store),
      writer,
      projectionReader: asAsyncEventReadSurface(ctx.store),
      manager: ctx.manager,
      lanes: ctx.continuationLanes,
      supervisor: attachingSupervisor(steps),
      keep: async (rows) => { steps.push(`keep ${rows.map((stored) => stored.row.processId).join(",")}`) },
      resumePlannedWorkflow: async () => { throw new Error("unexpected workflow continuation") },
      dispatch: resumeDispatch(async (mutation) => {
        steps.push(`resume ${mutation.sessionId}`)
        return { ok: true }
      }),
      handoffId: "handoff-3",
      settled: () => {},
    })

    expect(resumed).toEqual([cut])
    expect(steps.slice(-2)).toEqual(["keep bash-bg-step", `resume ${cut}`])
    expect(steps.toSorted()).toEqual([`adopted ${cut}`, `adopted ${idle}`, `attach ${cut}`, `attach ${idle}`, "keep bash-bg-step", `resume ${cut}`].toSorted())
  })

  test("resumes the work the runtime interrupted for the replacement, at the cut or at the stop; a session a person interrupted stays interrupted, and its stale row is retired", async () => {
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    const byRuntime = await interruptedChat("replacement", "handoff-1")
    const byPerson = await interruptedChat("person", "handoff-1")
    // The runtime's ordinary interrupt, not the planned cut, ended this turn
    // that the handoff owns; the successor resumes it all the same, so an
    // owed session is never left behind.
    const byStop = await interruptedChat("runtime", "handoff-1")
    const dispatched: FrontendMutation[] = []
    const settled: string[] = []

    const resumed = await continueAfterReplacement({
      reader: asAsyncEventReadSurface(ctx.store),
      writer,
      projectionReader: asAsyncEventReadSurface(ctx.store),
      manager: ctx.manager,
      lanes: ctx.continuationLanes,
      supervisor: attachingSupervisor([]),
      keep: async () => {},
      dispatch: resumeDispatch(async (mutation) => { dispatched.push(mutation); return { ok: true } }),
      handoffId: "handoff-1",
      resumePlannedWorkflow: async () => { throw new Error("unexpected workflow continuation") },
      settled: (sessionId) => { settled.push(sessionId) },
    })

    expect(resumed.toSorted()).toEqual([byRuntime, byStop].toSorted())
    expect(dispatched).toHaveLength(2)
    expect(dispatched).toEqual(expect.arrayContaining([{ type: "chat.resume", sessionId: byRuntime }, { type: "chat.resume", sessionId: byStop }]))
    expect(settled.toSorted()).toEqual([byPerson, byRuntime, byStop].toSorted())
    for (const sessionId of [byRuntime, byPerson, byStop]) expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), sessionId)).toBeNull()
  })

  test.each((["ahead", "expired"] as const).flatMap((deadline) => [false, true].map((reply) => ({ deadline, reply }))))("reattaches a chat's $deadline background wait (reply: $reply) without Resume and retires its owed continuation", async ({ deadline, reply }) => {
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    const duration = reply ? 240_000 : 60_000
    const at = Date.now() - (deadline === "ahead" ? 30_000 : duration + 30_000)
    setSystemTime(at)
    const waiting = await interruptedChat("replacement", "waiting-handoff", { seconds: 60, reply })
    const person = await interruptedChat("person", "waiting-handoff", { seconds: 60, reply })
    setSystemTime()
    const session = await ctx.manager.read(waiting)
    if (session?.kind !== "chat") throw new Error("missing chat")
    ctx.sessionStore.openSessionRuntime({ sessionId: waiting, conversationId: session.conversationId, description: "Waiting chat" })
    expect((await readChatTurnEndEvidence(asAsyncEventReadSurface(ctx.store), session.conversationId, { restoreWait: true }))?.restoredWait).toEqual({ deadlineMs: at + duration })
    expect(await owed(waiting)).toBe(true)
    const held: string[] = []
    const supervisor = supervisorWithRunner(ctx, async ({ sessionId }) => mockRunner(sessionId, {
      hold: async () => { held.push(sessionId); return NO_MODULE_RUNTIMES },
      resumeCommitted: () => { throw new Error("restoration must not resume a model turn") },
    }))
    const continued = await continueAfterReplacement({
      reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store),
      writer, manager: ctx.manager, lanes: ctx.continuationLanes,
      supervisor, keep: async () => {},
      dispatch: async () => { throw new Error("a waiting chat must not dispatch Resume") },
      resumePlannedWorkflow: async () => { throw new Error("not a workflow") },
      handoffId: "waiting-handoff", settled: () => {},
    })
    expect(continued).toEqual([waiting])
    expect(held).toEqual([waiting])
    expect(await owed(waiting)).toBe(false)
    expect(await owed(person)).toBe(false)
    expect((await readChatTurnEndEvidence(asAsyncEventReadSurface(ctx.store), session.conversationId, { restoreWait: true }))?.restoredWait).toEqual({ deadlineMs: at + duration })
    const tree = await tryOpenConversationTree({ conversationId: session.conversationId, sessionId: waiting, now: () => new Date().toISOString(), store: asAsyncEventReadSurface(ctx.store), writer })
    if (!tree) throw new Error("missing tree")
    const end = interruptedTurnEnd("replacement")
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "second-cut"))
    tree.getStorage().dispose()
    expect((await readChatTurnEndEvidence(asAsyncEventReadSurface(ctx.store), session.conversationId, { restoreWait: true }))?.restoredWait).toEqual({ deadlineMs: at + duration })
    await supervisor.disposeAll()
  })

  test.each([["refused", false], ["failed", false], ["refused", true]] as const)("records an ordinary stop over a chat's cut background wait whose attach %s before it retires the row, so no later attach arms its deadline (record fails: %p)", async (outcome, recordFails) => {
    const reader = asAsyncEventReadSurface(ctx.store)
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    // A failed write of the stop record keeps the row for the duty's retry.
    const fail = async (): Promise<never> => { throw new Error("the disk is full") }
    const at = Date.now() - 30_000
    setSystemTime(at)
    const waiting = await interruptedChat("replacement", "failed-handoff", { seconds: 60 })
    setSystemTime()
    const session = await ctx.manager.read(waiting)
    if (session?.kind !== "chat") throw new Error("missing chat")
    const run = continueAfterReplacement({
      reader, projectionReader: reader, manager: ctx.manager, lanes: ctx.continuationLanes,
      writer: recordFails ? { ...writer, append: fail, appendBatch: fail, appendGuarded: fail, appendBatchGuarded: fail } : writer,
      supervisor: { activateSession: async () => { if (outcome === "failed") throw new Error("the runner did not start"); return false }, ensureChatRunner: async () => { throw new Error("no runner attaches") } },
      keep: async () => {}, dispatch: async () => { throw new Error("a waiting chat must not dispatch Resume") }, resumePlannedWorkflow: async () => { throw new Error("not a workflow") }, handoffId: "failed-handoff", settled: () => {},
    })
    if (recordFails) await expect(run).rejects.toThrow("the disk is full")
    else expect(await run).toEqual([])
    expect(await owed(waiting)).toBe(recordFails)
    expect((await readChatTurnEnd(reader, session.conversationId))?.end).toEqual(interruptedTurnEnd(recordFails ? "replacement" : "runtime"))
    expect((await readChatTurnEndEvidence(reader, session.conversationId, { restoreWait: true }))?.restoredWait).toEqual({ deadlineMs: at + 60_000, ...(recordFails ? {} : { parkOnly: true }) })
  })

  test("a session is owed its continuation from the cut until its resume settles, and never once a person's interrupt or a refusal ends it", async () => {
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    const cut = await interruptedChat("replacement", "handoff-2")
    const byPerson = await interruptedChat("person", "handoff-2")
    // A runtime interrupt with no row, as a successor leaves a session whose
    // row it retired, is resumable by hand only.
    const unowed = await interruptedChat("replacement", undefined)
    expect(await owed(cut)).toBe(true)
    expect(await owed(byPerson)).toBe(false)
    expect(await owed(unowed)).toBe(false)

    // Another process reads the same store through its own connection: the
    // account's history, which serves the status and the detail of a session
    // its executor does not hold yet.
    const elsewhere = createSqliteEventStore(resolveEventStoreDbFile(ctx.baseDir))
    const owedElsewhere = (sessionId: string): Promise<boolean> => awaitsPlannedContinuation({ reader: asAsyncEventReadSurface(elsewhere), projectionReader: asAsyncEventReadSurface(elsewhere), manager: ctx.manager }, sessionId)
    const owedDuringResume: (readonly [boolean, boolean])[] = []
    const rowsDuringResume: unknown[] = []
    const settled: string[] = []
    try {
      await continueAfterReplacement({
        reader: asAsyncEventReadSurface(ctx.store),
        writer,
        projectionReader: asAsyncEventReadSurface(ctx.store),
        manager: ctx.manager,
        lanes: ctx.continuationLanes,
        supervisor: attachingSupervisor([]),
        keep: async () => {},
        resumePlannedWorkflow: async () => { throw new Error("unexpected workflow continuation") },
        dispatch: resumeDispatch(async (mutation) => {
          owedDuringResume.push([await owed(mutation.sessionId), await owedElsewhere(mutation.sessionId)])
          rowsDuringResume.push(...ctx.store.readInFlight(mutation.sessionId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND).map((row) => row.payload))
          return { ok: false, error: "The runner did not resume the turn" }
        }),
        handoffId: "handoff-2",
        settled: (sessionId) => { settled.push(sessionId) },
      })
      expect(await owedElsewhere(cut)).toBe(false)
    } finally {
      elsewhere.close()
    }

    // While the successor resumes the session, every process reads it as
    // owed, from the row exactly as the cut wrote it: no durable marker says
    // that a resume began.
    expect(owedDuringResume).toEqual([[true, true]])
    expect(rowsDuringResume).toEqual([{ version: 3, target: { sessionId: cut, kind: "chat" }, handoffId: "handoff-2" }])
    // A refused resume leaves the session at rest, resumable by hand, and
    // the caller is told so that what every surface shows follows it.
    expect(await owed(cut)).toBe(false)
    expect(settled).toContain(cut)
  })

  test("a resume that began before its process exited is never repeated: the next attempt resumes nothing, and the session stays interrupted for a person to resume", async () => {
    const cut = await interruptedChat("replacement", "handoff-3")
    // The first attempt's Resume recorded its continuation before its first
    // request, and its process exited there, leaving the row the cut wrote.
    const chat = await ctx.manager.read(cut)
    if (chat?.kind !== "chat") throw new Error("the cut session is not a chat")
    const tree = await tryOpenConversationTree({ conversationId: chat.conversationId, sessionId: cut, now: () => new Date().toISOString(), store: asAsyncEventReadSurface(ctx.store), writer: ctx.runtime.runSync(EventStoreWriterService) })
    if (!tree) throw new Error("the chat has no conversation tree")
    await tree.appendMessage({ kind: "user", content: CONTINUATION_MESSAGES.resumed, origin: "system" })
    tree.getStorage().dispose()
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), cut)).toEqual({ version: 3, target: { sessionId: cut, kind: "chat" }, handoffId: "handoff-3" })

    // The next attempt runs in the executor that replaces it.
    const restarted = createSqliteEventStore(resolveEventStoreDbFile(ctx.baseDir))
    const dispatched: FrontendMutation[] = []
    try {
      const resumed = await continueAfterReplacement({
        reader: asAsyncEventReadSurface(restarted),
        projectionReader: asAsyncEventReadSurface(restarted),
        writer: asAsyncEventWriter(restarted),
        manager: ctx.manager,
        // The executor that replaces it has lanes of its own.
        lanes: createContinuationLanes(),
        supervisor: attachingSupervisor([]),
        keep: async () => {},
        dispatch: resumeDispatch(async (mutation) => { dispatched.push(mutation); return { ok: true } }),
        handoffId: "handoff-3",
        resumePlannedWorkflow: async () => { throw new Error("unexpected workflow continuation") },
        settled: () => {},
      })
      expect(resumed).toEqual([])
      expect(dispatched).toEqual([])
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(restarted), cut)).toBeNull()
      expect(await awaitsPlannedContinuation({ reader: asAsyncEventReadSurface(restarted), projectionReader: asAsyncEventReadSurface(restarted), manager: ctx.manager }, cut)).toBe(false)
      // The turn the resume began reads as interrupted, which a person resumes.
      expect((await readChatTurnEnd(asAsyncEventReadSurface(restarted), chat.conversationId))?.end.reason).toBe("paused")
    } finally {
      restarted.close()
    }
  })

  test("a session whose continuation evidence cannot be read yet keeps its row, never keeps the other sessions from resuming, and resumes on the next attempt", async () => {
    const writer = ctx.runtime.runSync(EventStoreWriterService)
    const unreadable = await interruptedChat("replacement", "handoff-4")
    const readable = await interruptedChat("replacement", "handoff-4")
    const dispatched: FrontendMutation[] = []
    const settled: string[] = []
    let readFails = true
    const attempt = (): Promise<readonly string[]> => continueAfterReplacement({
      reader: asAsyncEventReadSurface(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
      writer,
      // The metadata that names the one chat's conversation cannot be read
      // for a while, as a read across the state Worker's channel can fail.
      manager: { read: async (sessionId) => {
        if (readFails && sessionId === unreadable) throw new Error("session metadata could not be read")
        return await ctx.manager.read(sessionId)
      } },
      lanes: ctx.continuationLanes,
      supervisor: attachingSupervisor([]),
      keep: async () => {},
      dispatch: resumeDispatch(async (mutation) => { dispatched.push(mutation); return { ok: true } }),
      handoffId: "handoff-4",
      resumePlannedWorkflow: async () => { throw new Error("unexpected workflow continuation") },
      settled: (sessionId) => { settled.push(sessionId) },
    })

    // The attempt fails for the one session, so the caller's duty tries the
    // handoff again; the other session resumed and settled all the same.
    const failure = await attempt().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure instanceof AggregateError ? failure.message : "").toContain(unreadable)
    expect(dispatched).toEqual([{ type: "chat.resume", sessionId: readable }])
    expect(settled).toEqual([readable])
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), readable)).toBeNull()
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), unreadable)).toEqual({ version: 3, target: { sessionId: unreadable, kind: "chat" }, handoffId: "handoff-4" })
    expect(await owed(unreadable)).toBe(true)

    // The retry resumes only the session the first attempt left.
    readFails = false
    expect(await attempt()).toEqual([unreadable])
    expect(dispatched).toEqual([{ type: "chat.resume", sessionId: readable }, { type: "chat.resume", sessionId: unreadable }])
    expect(settled).toEqual([readable, unreadable])
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), unreadable)).toBeNull()
  })
})
