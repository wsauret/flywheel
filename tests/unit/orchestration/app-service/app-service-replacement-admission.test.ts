import { describe, expect, test } from "bun:test"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createReplacementReport } from "../../../../src/orchestration/app-service/replacement-blockers.js"
import { createRuntimeSummaryProjection } from "../../../../src/orchestration/app-service/runtime-summary-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import { chatEntry, fakeProjections, fakeSessionStore, runtimeSupervisor, workflowController, workflowProtocol } from "./app-service-doubles.js"
import { durableRow, managerWithSessions } from "./_frontend-projection-fixtures.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js";

/** The service while the account waits to replace it: its executor holds the
 *  account's requested replacement, wired as the project execution runtime
 *  wires it, and nothing a person does is refused for it (PI-REMOTE-020). */
function harness() {
  const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
  const manager = managerWithSessions([durableRow("chat-1")])
  const projections = fakeProjections()
  const resumes: string[] = []
  const bus = createRuntimeUiBus()
  const service = createFlywheelAppService({
    projectRoot: FIXTURE_EXECUTION_CWD,
    projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
    ...projections,
    moduleProtocol: workflowProtocol({ controller: {
      ...workflowController(store, manager),
      resumeWorkflow: async (sessionId) => {
        resumes.push(sessionId)
        return { kind: "resumed", sessionId }
      },
    } }),
    bus,
    runtimeSupervisor: runtimeSupervisor(),
  })
  const replacement = createReplacementReport({
    projectRoot: FIXTURE_EXECUTION_CWD, projectLabel: undefined, client: service, sessionStore: store,
    listMetadata: () => manager.listMetadata(), runningChildren: () => [], runningWorkflows: () => [], keptSessions: () => [],
  })
  replacement.set({ kind: "requested", blockers: [{ projectRoot: "/other", projectLabel: "other", reason: "call" }] })
  return { service, replacement, resumes }
}

describe("FlywheelAppService while a replacement waits", () => {
  test("a chat send and a workflow resume are admitted and run on the current runtime", async () => {
    const { service, replacement, resumes } = harness()
    expect(await service.dispatch({ type: "session.send", sessionId: "chat-1", input: "hello" })).toMatchObject({ ok: true })
    expect(await service.dispatch({ type: "workflow.resume", workflowId: "wf-1" })).toEqual({ ok: true })
    expect(resumes).toEqual(["wf-1"])
    replacement.stop()
  })

  test("a closed gate still refuses as a shutdown", async () => {
    const { service, replacement } = harness()
    replacement.stop()
    await runRuntimeShutdownBarrier(service.shutdown)
    expect(await service.dispatch({ type: "session.send", sessionId: "chat-1", input: "hello" })).toEqual({ ok: false, error: "Flywheel is shutting down" })
  })
})

describe("the executor's blocker question", () => {
  // The account's idle reaper asks this question just before it closes a
  // project. A summary read starts the executor's background Worker, so a
  // question that read summaries started a Worker only to stop it at close.
  test("reads no session summary, while a client catalog read admits one", async () => {
    const summaryReads: (readonly string[])[] = []
    const background = {
      sessionSummaryImmediate: async (sessionIds: readonly string[]) => {
        summaryReads.push(sessionIds)
        return { rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }
      },
      waitForTotals: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
    }
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1", { lifecycleState: "active" })])
    const summaries = createRuntimeSummaryProjection({ background, sessionPlacements: { placement: async () => null, observe: () => {} }, onStored: () => () => {} })
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD, summaries }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      runtimeSupervisor: runtimeSupervisor(),
    })
    const replacement = createReplacementReport({
      projectRoot: FIXTURE_EXECUTION_CWD, projectLabel: undefined, client: service, sessionStore: store,
      listMetadata: () => manager.listMetadata(), runningChildren: () => [], runningWorkflows: () => [], keptSessions: () => [],
    })

    expect(await replacement.blockers()).toEqual([])
    await summaries.settled()
    expect(summaryReads).toEqual([])

    await service.query({ type: "snapshot" })
    await summaries.settled()
    expect(summaryReads).toEqual([["chat-1"]])
    summaries.dispose()
  })

  // Some paths attach a runner and start a turn with no lifecycle write, such
  // as a subagent parent's reattach or a background notification. Such a chat
  // owns live work while its record still says inactive, and the idle reaper
  // must not close its project under it.
  test("a resident chat with a streaming turn blocks while its metadata says inactive", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry({ runnerState: "streaming" })]]))
    const manager = managerWithSessions([durableRow("chat-1", { label: "Streaming" }), durableRow("chat-cold", { label: "Cold" })])
    const projections = fakeProjections()
    const thinking = { activity: "thinking", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, waitingOnBackgroundWork: false, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: 0, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [] } as const
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...projections,
      // Every chat reports a turn, so only residence and records decide.
      statusProjection: { ...projections.statusProjection, snapshot: async () => thinking },
      runtimeSupervisor: runtimeSupervisor(),
    })
    const replacement = createReplacementReport({
      projectRoot: FIXTURE_EXECUTION_CWD, projectLabel: undefined, client: service, sessionStore: store,
      listMetadata: () => manager.listMetadata(), runningChildren: () => [], runningWorkflows: () => [], keptSessions: () => [],
    })

    expect((await replacement.blockers()).map(({ sessionId, sessionTitle, reason }) => ({ sessionId, sessionTitle, reason })))
      .toEqual([{ sessionId: "chat-1", sessionTitle: "Streaming", reason: "turn" }])
  })
})
