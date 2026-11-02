import { describe, expect, test, spyOn } from "bun:test"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createWorkflowViewProtocolProjection, createWorkflowViewProtocolReader } from "../../../../src/orchestration/modules/workflows/view-protocol.js"
import { workflowViewCursor } from "../../../../src/protocol/modules/workflows.js"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import type { FrontendWorkflowView, LoadedWorkflowView, WorkflowTree } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"
import { acceptanceWorkflow, SqliteVmDriver } from "../../workflows/vm/_sqlite-vm-driver.js"
import { createWorkflowsProtocol } from "../../../../src/orchestration/modules/workflows/protocol.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createSessionBudgetStore } from "../../../../src/orchestration/session/budget-store.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { composeModuleServices } from "../../../../src/infra/module-service.js"
import type { WorkflowDetail } from "../../../../src/protocol/modules/workflows.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { Log } from "../../../../src/infra/log.js"
import { publishWorkerAttempt } from "../workflow-host/_workflow-host-fixtures.js"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record.js"

const tmp = temporaryDirectories()
function loaded(view: FrontendWorkflowView | null): LoadedWorkflowView {
  if (view?.attemptsStatus !== "loaded") throw new Error("Expected a readable workflow view")
  return view
}
async function setup() {
  const root = tmp("workflow-view-protocol-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(root))
  const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
  return { root, store, manager, reader: asAsyncEventReadSurface(store) }
}
function registerRetainedRun(store: EventStore, workflowId: string) {
  store.append({
    aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp: 0, actor: "flywheel", type: "workflow.run.registered", version: 1,
    payload: {
      settings: { workflowDefinitionId: "work", label: "Retained work", createdAt: "2026-10-17T00:00:00.000Z", lastUpdated: "2026-10-17T00:00:00.000Z", roleAssignments: { defaults: {}, overrides: {} } },
      request: "Do the work", launchedFrom: { parentSessionId: "parent", conversationId: "conversation", toolUseId: "launch" },
    },
  })
}

describe("workflow-scoped view projection", () => {
  test("held detail publishes member and auxiliary usage without a control transition", async () => {
    const f = await setup()
    const patches: RuntimeUiPatchInput[] = []
    const sequencer = createRuntimeUiPatchSequencer()
    const detailReads: string[] = []
    const protocol = createWorkflowsProtocol({
      projectionReader: f.reader, eventStore: f.reader, eventWriter: asAsyncEventWriter(f.store), manager: f.manager,
      sessionStore: { onChange: () => () => {}, get: () => undefined, remove: async () => {} },
      modules: composeModuleServices([["workflows", {
        projectRoot: f.root, onAuthChanged: () => () => {}, onHostChanged: () => () => {}, isRunning: () => false,
        auth: { snapshot: async (id: string) => { detailReads.push(id); return {} } }, authStatus: { view: () => null },
      }]]),
      onStored: f.store.onStored, snapshotPosition: sequencer.snapshotPosition,
      publish: (patch: RuntimeUiPatchInput) => { patches.push(patch); return sequencer.publish(patch) },
    })
    const writers: ReturnType<typeof createSessionFactWriter>[] = []
    const budgets: ReturnType<typeof createSessionBudgetStore>[] = []
    try {
      const id = await publishTestWorkflow(f.manager, { id: "usage" })
      const member = await startTestWorkflowMember(f.manager, f.store, id)
      await publishTestWorkflow(f.manager, { id: "unchanged" })
      const heldDetails = new Set<unknown>()
      for (const workflowId of [id, "unchanged"]) heldDetails.add((await protocol.serve.workflowDetail({ type: "workflowDetail", workflowId })).view)
      const visits: number[] = []
      for (const owner of [{ kind: "session" as const, sessionId: member }, { kind: "workflow" as const, workflowId: id }]) {
        if (owner.kind === "workflow") {
          for (let index = 2; index < 20; index++) {
            const workflowId = await publishTestWorkflow(f.manager, { id: `held-${index}` })
            heldDetails.add((await protocol.serve.workflowDetail({ type: "workflowDetail", workflowId })).view)
          }
          await Bun.sleep(0)
        }
        detailReads.length = 0
        const writer = createSessionFactWriter({ owner, writer: asAsyncEventWriter(f.store) })
        const budget = createSessionBudgetStore({ sessionId: owner.kind === "session" ? member : id, owner, emitter: () => {}, reader: f.reader, recorder: writer.record })
        writers.push(writer); budgets.push(budget)
        let workflowVisits = 0
        const iterate = Map.prototype[Symbol.iterator]
        // Each map iteration returns its native iterator, whose steps count the visits to held details.
        const iteration = spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
          const entries = iterate.call(this)
          const step = entries.next.bind(entries)
          entries.next = () => {
            const result = step()
            const value: unknown = result.done ? undefined : result.value[1]
            if (heldDetails.has(value) || (typeof value === "object" && value !== null && "view" in value && heldDetails.has(value.view))) workflowVisits++
            return result
          }
          return entries
        })
        try {
          await budget.recordRuntimeEvent({ type: "model.turn.completed", data: { total_cost_usd: 1.5, usage: { input_tokens: 1000, output_tokens: 200 } } })
          await Bun.sleep(0)
        } finally { iteration.mockRestore() }
        visits.push(workflowVisits)
        // A usage move reads the totals alone, and no other input of any detail.
        expect(detailReads).toEqual([])
      }
      expect(visits).toEqual([0, 0])
      const details = patches.flatMap(patch => patch.payload.kind === "workflow_detail.changed" && patch.payload.view ? [patch.payload.view] : [])
      expect(details.map(detail => detail.totals.totalCost)).toEqual([1.5, 3])
      expect(details.at(-1)?.policyUsage).toMatchObject({ totalCost: 3, totalInputTokens: 2000, totalOutputTokens: 400 })
    } finally { for (const budget of budgets) budget.dispose(); for (const writer of writers) writer.dispose(); protocol.dispose(); f.store.close() }
  })
  test("a usage batch and one agent's entry each cost the held detail the same reads, whatever the number of started agents", async () => {
    /** Whether a published detail satisfies `holds` within about two seconds. */
    const published = async (details: readonly WorkflowDetail[], holds: (detail: WorkflowDetail) => boolean) => {
      for (let tick = 0; tick < 2000; tick++) {
        if (details.some(holds)) return true
        await Bun.sleep(1)
      }
      return false
    }
    const costs = async (agentCount: number) => {
      const f = await setup()
      const writer = asAsyncEventWriter(f.store)
      const bindings = Array.from({ length: agentCount }, (_, index) => ({ attemptId: `a${index}`, conversationId: `conv-${index}` }))
      await publishWorkerAttempt({ projectRoot: f.root, reader: f.reader, writer, workflowId: "wide", ...bindings[0]!, siblings: bindings.slice(1) })
      const member = await workflowMembershipReader(f.reader).attempt("wide", "a0")
      if (!member) throw new Error("Expected the first agent's member")
      const counter = countStateRequests(f.reader)
      const sequencer = createRuntimeUiPatchSequencer()
      const details: WorkflowDetail[] = []
      const protocol = createWorkflowsProtocol({
        projectionReader: counter.reader, eventStore: counter.reader, eventWriter: writer, manager: f.manager,
        sessionStore: { onChange: () => () => {}, get: () => undefined, remove: async () => {} },
        modules: composeModuleServices([["workflows", {
          projectRoot: f.root, onAuthChanged: () => () => {}, onHostChanged: () => () => {}, isRunning: () => false,
          auth: { snapshot: async () => ({}) }, authStatus: { view: () => null },
        }]]),
        onStored: f.store.onStored, snapshotPosition: sequencer.snapshotPosition,
        publish: (patch: RuntimeUiPatchInput) => {
          if (patch.payload.kind === "workflow_detail.changed" && patch.payload.view) details.push(patch.payload.view)
          return sequencer.publish(patch)
        },
      })
      const owner = { kind: "session" as const, sessionId: member.sessionId }
      const facts = createSessionFactWriter({ owner, writer })
      const budget = createSessionBudgetStore({ sessionId: member.sessionId, owner, emitter: () => {}, reader: f.reader, recorder: facts.record })
      try {
        expect((await protocol.serve.workflowDetail({ type: "workflowDetail", workflowId: "wide" })).view?.admittedActions).not.toContain("workflow.resume")
        counter.take()
        await budget.recordRuntimeEvent({ type: "model.turn.completed", data: { total_cost_usd: 1.5, usage: { input_tokens: 1000, output_tokens: 200 } } })
        const usagePublished = await published(details, (detail) => detail.totals.totalCost === 1.5)
        const usage = counter.take().length
        // A person's interrupt of one agent admits Resume of the workflow.
        const tree = await tryOpenConversationTree({ conversationId: member.conversationId, sessionId: member.sessionId, store: f.reader, writer })
        if (!tree) throw new Error("Expected the first agent's conversation")
        await tree.appendMessage({ kind: "user", content: interruptedTurnMessage("person", true), origin: "system" }, turnEndEntryId({ reason: "paused", pausedBy: "person" }, "k"))
        const entryPublished = await published(details, (detail) => detail.admittedActions.includes("workflow.resume"))
        const entry = counter.take().length
        return { usagePublished, usage, entryPublished, entry }
      } finally { budget.dispose(); facts.dispose(); protocol.dispose(); f.store.close() }
    }
    const narrow = await costs(10)
    const wide = await costs(150)
    expect({ usage: wide.usage, entry: wide.entry }).toEqual({ usage: narrow.usage, entry: narrow.entry })
    expect([narrow.usagePublished, narrow.entryPublished, wide.usagePublished, wide.entryPublished]).toEqual([true, true, true, true])
  }, 30_000)
  test("after a failed read of a held detail, the next change of a different input reads every part again", async () => {
    const f = await setup()
    const sequencer = createRuntimeUiPatchSequencer()
    const details: WorkflowDetail[] = []
    let authRevision = 0
    let failAuth = false
    let authChanged = () => {}
    let hostChanged = () => {}
    const protocol = createWorkflowsProtocol({
      projectionReader: f.reader, eventStore: f.reader, eventWriter: asAsyncEventWriter(f.store), manager: f.manager,
      sessionStore: { onChange: () => () => {}, get: () => undefined, remove: async () => {} },
      modules: composeModuleServices([["workflows", {
        projectRoot: f.root, isRunning: () => false,
        onAuthChanged: (listener: () => void) => { authChanged = listener; return () => {} },
        onHostChanged: (listener: () => void) => { hostChanged = listener; return () => {} },
        auth: { snapshot: async () => { if (failAuth) { failAuth = false; throw new Error("The auth store is not readable.") } return { authRevision } } },
        authStatus: { view: (snapshot: { readonly authRevision: number }) => snapshot },
      }]]),
      onStored: f.store.onStored, snapshotPosition: sequencer.snapshotPosition,
      publish: (patch: RuntimeUiPatchInput) => {
        if (patch.payload.kind === "workflow_detail.changed" && patch.payload.view) details.push(patch.payload.view)
        return sequencer.publish(patch)
      },
    })
    const warn = spyOn(Log.create({ service: "workflow-protocol" }), "warn").mockImplementation(() => {})
    try {
      const id = await publishTestWorkflow(f.manager, { id: "flaky" })
      expect((await protocol.serve.workflowDetail({ type: "workflowDetail", workflowId: id })).view).toMatchObject({ auth: { authRevision: 0 } })
      // The auth moves, and its read fails.
      authRevision = 1
      failAuth = true
      authChanged()
      for (let tick = 0; tick < 20 && warn.mock.calls.length === 0; tick++) await Bun.sleep(1)
      expect(warn).toHaveBeenCalledTimes(1)
      // A host change moves only the duration, but the failed read left every part stale.
      hostChanged()
      for (let tick = 0; tick < 200 && details.length === 0; tick++) await Bun.sleep(1)
      expect(details).toHaveLength(1)
      expect(details[0]).toMatchObject({ auth: { authRevision: 1 } })
    } finally { warn.mockRestore(); protocol.dispose(); f.store.close() }
  })
  test("pending agents have no invented session; started members publish their real conversation address", async () => {
    const f = await setup()
    const patches: RuntimeUiPatchInput[] = []
    const projection = createWorkflowViewProtocolProjection({ reader: f.reader, onStored: f.store.onStored, publish: (patch) => { patches.push(patch) } })
    try {
      const id = await publishTestWorkflow(f.manager, { id: "work" })
      const pending = loaded(await projection.snapshot(id))
      expect(await f.manager.read(id)).toBeNull()
      expect(pending.attempts[0]).toMatchObject({ status: "pending", history: [] })
      expect(pending.attempts[0]?.sessionId).toBeUndefined()
      const memberId = await startTestWorkflowMember(f.manager, f.store, id)
      const started = loaded(await projection.snapshot(id))
      expect(started.attempts[0]?.sessionId).toBe(memberId)
      expect((await f.manager.read(memberId))?.kind).toBe("workflow-agent")
      expect(patches.some((patch) => patch.cursor.scope === "workflow" && patch.cursor.workflowId === id)).toBe(true)
      expect(patches.every((patch) => patch.cursor.scope === "workflow")).toBe(true)
    } finally { projection.dispose(); f.store.close() }
  })

  test("damage and repair of one workflow leave its sibling and cursor independent", async () => {
    const f = await setup()
    const patches: RuntimeUiPatchInput[] = []
    const projection = createWorkflowViewProtocolProjection({ reader: f.reader, onStored: f.store.onStored, publish: (patch) => { patches.push(patch) } })
    try {
      await publishTestWorkflow(f.manager, { id: "damaged" })
      await publishTestWorkflow(f.manager, { id: "healthy" })
      loaded(await projection.snapshot("damaged"))
      const healthy = loaded(await projection.snapshot("healthy"))
      const queue = f.store.read({ aggregateId: "workflow:damaged", types: ["queue.created"] }).at(-1)
      if (!queue) throw new Error("Expected a queue companion")
      f.store.append({ ...queue, version: 999 })
      expect(await projection.snapshot("damaged")).toEqual({ attempts: [], attemptsStatus: "unavailable" })
      expect(loaded(await projection.snapshot("healthy"))).toEqual(healthy)
      f.store.append({ ...queue, timestamp: queue.timestamp + 1 })
      loaded(await projection.snapshot("damaged"))
      expect(patches.filter(({ cursor }) => cursor.scope === "workflow" && cursor.workflowId === "damaged").length).toBeGreaterThan(0)
      expect(workflowViewCursor("damaged")).not.toEqual(workflowViewCursor("healthy"))
    } finally { projection.dispose(); f.store.close() }
  })

  test("held background sweeps do not replay unchanged workflows from zero", async () => {
    const f = await setup()
    let starts = 0
    try {
      for (const id of ["first", "second", "third"]) await publishTestWorkflow(f.manager, { id })
      const counted = {
        ...f.reader,
        readPage: async (...args: Parameters<typeof f.reader.readPage>) => {
          if (args[2] === 0) starts += 1
          return f.reader.readPage(...args)
        },
      }
      const read = createWorkflowViewProtocolReader(counted)
      for (const id of ["first", "second", "third"]) loaded(await read(id))
      const seeded = starts
      expect(seeded).toBeGreaterThan(0)
      for (let pass = 0; pass < 4; pass++) for (const id of ["first", "second", "third"]) loaded(await read(id))
      expect(starts).toBe(seeded)
    } finally { f.store.close() }
  })

  test("retained queue-only history reports unavailable instead of inventing executable history", async () => {
    const f = await setup()
    try {
      f.store.append({
        aggregateId: "workflow:old", sessionId: "old", timestamp: 0, actor: "flywheel", type: "queue.created", version: 10,
        payload: { rows: { attempts: [], cursor: 0, status: "failed", mutationLog: [] } },
      })
      registerRetainedRun(f.store, "old")
      expect(await createWorkflowViewProtocolReader(f.reader)("old")).toEqual({ attempts: [], attemptsStatus: "unavailable" })
    } finally { f.store.close() }
  })

  test("conditional hierarchy survives the published view", async () => {
    const [work, review] = acceptanceWorkflow.phases
    if (!work || !review || "repeat" in work || "repeat" in review) throw new Error("Expected acceptance phases")
    const driver = new SqliteVmDriver({
      root: tmp("workflow-protocol-conditional-"), retain: true,
      workflow: { ...acceptanceWorkflow, phases: [
        { ...work, phase: "investigate", name: "Investigate" },
        { ...work, phase: "fix", name: "Fix", if: "investigate" },
        { ...review, phase: "verify", name: "Verify", if: "fix" },
      ] },
    })
    try {
      await driver.initialize()
      registerRetainedRun(driver.store, driver.sessionId)
      const view = loaded(await createWorkflowViewProtocolReader(asAsyncEventReadSurface(driver.store))(driver.sessionId))
      expect(view.tree.nodes.filter((node) => node.kind === "agent").map(({ label, disposition }) => ({ label, disposition }))).toEqual([
        { label: "Investigate", disposition: "pending" }, { label: "Fix", disposition: "conditional" }, { label: "Verify", disposition: "conditional" },
      ])
    } finally { await driver.close() }
  })

  test("tree-only updates preserve coverage, selection and repeat outcomes", async () => {
    const f = await setup()
    const patches: RuntimeUiPatchInput[] = []
    const projection = createWorkflowViewProtocolProjection({ reader: f.reader, onStored: f.store.onStored, publish: (patch) => { patches.push(patch) } })
    try {
      await publishTestWorkflow(f.manager, { id: "tree" })
      const before = loaded(await projection.snapshot("tree"))
      const tree: WorkflowTree = { nodes: [
        { id: "coverage", kind: "phase", form: "list", phaseId: "review", label: "Review", parentId: null, disposition: "completed",
          join: { reducer: "coverage@1", state: "settled", slots: 2, completed: 1, failed: 1, pending: 0, missing: 0, coverage: { status: "partial", required: { surveyed: 1, total: 2 }, unsurveyed: ["b"] } } },
        { id: "loop", kind: "repeat", label: "Hunt", parentId: null, disposition: "completed", loop: { iteration: 1, maxIterations: 3, outcome: "dry" } },
        { id: "selected", kind: "phase", form: "list", phaseId: "findings", label: "Findings", parentId: "loop", disposition: "completed",
          round: { number: 1, outcome: "dry" }, join: { reducer: "dedupe@2", state: "settled", slots: 2, completed: 2, failed: 0, pending: 0, missing: 0, selection: { verb: "kept", kept: 0, dropped: 2 } } },
      ] }
      f.store.append({ aggregateId: "workflow:tree", sessionId: "tree", timestamp: 1, type: "queue.tree.changed", version: 4, actor: "flywheel", payload: { tree } })
      const after = loaded(await projection.snapshot("tree"))
      expect(after.attempts).toEqual(before.attempts)
      expect(after.tree).toEqual(tree)
      expect(patches.at(-1)?.payload).toMatchObject({ kind: "workflow_view.updated", workflowView: { tree } })
    } finally { projection.dispose(); f.store.close() }
  })

  test("a readable old root restores the tree a previous build did not record", async () => {
    const driver = new SqliteVmDriver({ root: tmp("old-workflow-tree-"), retain: true })
    try {
      await driver.initialize()
      registerRetainedRun(driver.store, driver.sessionId)
      const before = loaded(await createWorkflowViewProtocolReader(asAsyncEventReadSurface(driver.store))(driver.sessionId))
      const db = new Database(join(driver.root, ".flywheel", "flywheel.sqlite"))
      try { db.run("delete from event where type = 'queue.tree.changed'") } finally { db.close() }
      const after = loaded(await createWorkflowViewProtocolReader(asAsyncEventReadSurface(driver.store))(driver.sessionId))
      expect(after.tree).toEqual(before.tree)
      expect(after.attempts).toEqual(before.attempts)
    } finally { driver.close() }
  })
})
