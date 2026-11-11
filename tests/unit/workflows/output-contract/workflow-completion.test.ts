import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { asAsyncEventReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { COMPLETION_AGENT_RESULTS_CAP_BYTES, readWorkflowCompletionEvidence, terminalWorkflow, workflowCompletionContent } from "../../../../src/workflows/output-contract/workflow-completion.js"
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection.js"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { reassessmentProposal } from "../../../../src/workflows/vm/reassessment.js"
import { buildWorkflowControlCommittedFact, buildWorkflowControlInitializedFact } from "../../../../src/workflows/vm/session-facts.js"
import { createMemoryStore, fixtureSkills, initialFacts, sequentialWorkflow, testHost } from "../vm/host-test-support.js"
import { createAttemptExecutor } from "../../../../src/workflows/vm/attempt-runner.js"
import { createWorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store.js"
import { EVERY_CAPABILITY } from "../../../helpers/attempt-brief.js"
import type { WorkflowTree } from "../../../../src/protocol/workflow-view-protocol-types.js"
import type { WorkflowTreeV1Schema } from "../../../../src/workflows/view/schemas.js"

/** The facts as builds before the phase tree wrote them: each agent of a
 *  single phase is a top-level step, and a parallel phase holds its steps. */
function historicalVariants(events: readonly StoredFact[], tree: WorkflowTree): StoredFact[][] {
  const singles = new Map(tree.nodes.flatMap((node) => node.kind === "phase" && node.form === "single" ? [[node.id, node.parentId] as const] : []))
  const oldNodes = tree.nodes.flatMap<typeof WorkflowTreeV1Schema.Type.nodes[number]>((node) => {
    if (node.kind === "agent") {
      const { id, label, disposition, attempts, currentAttemptId, definitionId } = node
      const parentId = node.parentId !== null && singles.has(node.parentId) ? singles.get(node.parentId) ?? null : node.parentId
      return [{ id, label, parentId, disposition, attempts, ...(currentAttemptId === undefined ? {} : { currentAttemptId }), kind: "step", stepId: definitionId }]
    }
    if (node.kind !== "phase" || node.form === "single") return []
    return [{ id: node.id, label: node.label, parentId: node.parentId, disposition: node.disposition, attempts: 0, kind: "phase", concurrent: true }]
  })
  const absent = events.filter(({ type }) => type !== "queue.tree.changed")
  const v1 = events.map((event) => event.type === "queue.tree.changed"
    ? { ...event, version: 1, payload: { tree: { nodes: oldNodes } } }
    : event)
  const last = v1.at(-1)!
  return [absent, v1, [...v1, {
    ...last, ...buildWorkflowControlCommittedFact("invalid-completion-proposal", { type: "START" }),
    id: "invalid-completion", seq: last.seq + 1, position: last.position + 1,
  }]]
}

// An agent that fails for good fails only itself and its phase. The parent
// learns which agents failed and why from the completion result, as a
// script sees a null for each agent that failed.
describe("the workflow completion result", () => {
  const record = (id: string, extra: { readonly [key: string]: unknown } = {}) => ({ name: id, brief: `Run ${id}.`, writes: [], ...extra })

  it.each([
    { named: false, failed: false },
    { named: false, failed: true },
    { named: true, failed: false },
    { named: true, failed: true },
  ])("keeps every agent result (named $named, failed $failed)", async ({ named, failed }) => {
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "completion-chain", name: "Completion chain",
      phases: named
        ? [{ phase: "pair", agents: [{ agent: "first", ...record("first") }, { agent: "second", ...record("second") }] }, { phase: "last", ...record("last") }]
        : ["first", "second", "last"].map((id) => ({ phase: id, ...record(id) })),
    })
    const store = createMemoryStore(initialFacts(workflow))
    const host = testHost(store, {
      workflow,
      attemptRunner: {
        run: async (input, active) => failed && input.definitionId === "last"
          ? { kind: "fatal", attemptId: input.attemptId, conversationId: active.conversationId, reason: "last failed" }
          : { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: input.definitionId }, reassessment: null },
      },
    })
    try {
      expect((await host.run()).kind).toBe(failed ? "failed" : "completed")
      const evidence = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(store), "session")
      if (!failed) {
        const terminal = terminalWorkflow(replayWorkflowControl(store.events), loadQueueFromEvents(store.events))!
        expect(terminal).toMatchObject({ completedAgents: 3, totalAgents: 3 })
        expect(workflowCompletionContent({ ...terminal, label: "Chain", sessionId: "session", ...evidence })).toContain("3/3 agents finished.")
      }
      expect(evidence.results).toEqual([
        { label: "first", status: "completed", content: { summary: "first" } },
        { label: "second", status: "completed", content: { summary: "second" } },
        failed
          ? { label: "last", status: "failed", reason: "last failed" }
          : { label: "last", status: "completed", content: { summary: "last" } },
      ])
      expect(evidence.failedAgents).toEqual(failed ? [{ name: "last", reason: "last failed" }] : [])
      for (const historical of historicalVariants(store.events, evidence.tree)) {
        const upgraded = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(inMemoryEventReader(historical)), "session")
        expect(upgraded.results).toEqual(evidence.results)
      }
    } finally {
      await host.dispose()
    }
  })

  it("collapses the retries of one agent, and keeps each record that runs the same brief apart", async () => {
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      ...sequentialWorkflow,
      phases: [
        { ...sequentialWorkflow.phases[0], retry: { max: 2, stuck: false } },
        { phase: "again", runs: "work", retry: { max: 2, stuck: false } },
        sequentialWorkflow.phases[1],
      ],
    })
    const store = createMemoryStore(initialFacts(workflow))
    let calls = 0
    const host = testHost(store, {
      workflow,
      attemptRunner: {
        run: async (input, active) => {
          calls += 1
          return calls === 1 || calls === 3
            ? { kind: "handoff", attemptId: input.attemptId, conversationId: active.conversationId, reason: "missing output" }
            : { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: `answer ${calls}` }, reassessment: null }
        },
      },
    })
    try {
      expect((await host.run()).kind).toBe("completed")
      expect(calls).toBe(5)
      const evidence = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(store), "session")
      expect(evidence.results).toEqual([
        { label: "work", status: "completed", content: { summary: "answer 2" } },
        { label: "again", status: "completed", content: { summary: "answer 4" } },
        { label: "review", status: "completed", content: { summary: "answer 5" } },
      ])
      for (const historical of historicalVariants(store.events, evidence.tree)) {
        const upgraded = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(inMemoryEventReader(historical)), "session")
        expect(upgraded.results).toEqual(evidence.results)
      }
    } finally {
      await host.dispose()
    }
  })

  it.each(["while", "each"] as const)("lists every round of a repeat %s", async (loop) => {
    const items = [{ id: "one" }, { id: "two" }]
    const listOutput = {
      summary: "Result", fields: {
        items: { type: "list", max: 2, unique: "id", description: "Items", of: { type: "object", fields: { id: { type: "string", description: "Id" } } } },
      },
    }
    const source = { phase: "source", name: "Source", brief: "List items.", output: listOutput, writes: [] }
    const [work, review] = sequentialWorkflow.phases
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      ...sequentialWorkflow,
      phases: loop === "while"
        ? [{ repeat: { while: "source.items", max: 2 }, phases: [source, work] }]
        : [source, { repeat: { each: "source.items" }, phases: [work, review] }],
    })
    const store = createMemoryStore(initialFacts(workflow))
    const counts = new Map<string, number>()
    const host = testHost(store, {
      workflow,
      attemptRunner: {
        run: async (input, active) => {
          const count = (counts.get(input.definitionId) ?? 0) + 1
          counts.set(input.definitionId, count)
          return {
            kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
            handoff: { summary: `${input.definitionId} ${count}`, ...(input.definitionId === "source" ? { items: count === 1 ? items : [] } : {}) },
            reassessment: null,
          }
        },
      },
    })
    try {
      expect((await host.run()).kind).toBe("completed")
      const evidence = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(store), "session")
      const completion = workflowCompletionContent({ label: "Loop", sessionId: "session", status: "completed", ...evidence })
      expect(completion.split("\n")[0]).not.toContain('The loop "')
      expect(evidence.results?.map(({ label, status, content }) => [label, status, content?.summary])).toEqual(loop === "while"
        // Each agent names the round of the check that it leads to, and no
        // work follows the check that stopped the repeat.
        ? [
          ["source", "completed", "source 1"],
          ["work, round 2", "completed", "work 1"],
          ["source, round 2", "completed", "source 2"],
        ]
        : [
          ["source", "completed", "source 1"],
          ["work, round 1", "completed", "work 1"],
          ["review, round 1", "completed", "review 1"],
          ["work, round 2", "completed", "work 2"],
          ["review, round 2", "completed", "review 2"],
        ])
    } finally {
      await host.dispose()
    }
  })

  it("keeps an item that a reassessment replaced in graph order", async () => {
    const list = { type: "list", max: 2, unique: "id", of: { type: "object", fields: { id: { type: "string" }, goal: { type: "string" } } } }
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "completion-replaced", name: "Replaced item",
      guardrails: { max_mutations_per_attempt: 10, max_parallel: 1 },
      phases: [
        { phase: "source", name: "Source", brief: "List milestones.", output: { fields: { milestones: list } } },
        { repeat: { each: "source.milestones", reassess: "reassess" }, phases: [sequentialWorkflow.phases[0], { phase: "reassess", name: "Reassess", brief: "Reassess the milestones." }] },
        sequentialWorkflow.phases[1],
      ],
    })
    const facts = initialFacts(workflow)
    const compiled = compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: fixtureSkills }, {
      maxAttempts: 50, maxMutationsPerAttempt: 10, maxInserts: 20,
    })
    const root = buildWorkflowControlInitializedFact({ ...compiled, aggregateSeq: 1 + facts.filter((fact) => fact.type.startsWith("queue.")).length })
    const store = createMemoryStore(facts.map((fact, index) => index === 0 ? { ...fact, version: root.version, payload: root.payload } : fact))
    let changed = false
    const host = testHost(store, {
      workflow,
      attemptRunner: {
        run: async (input, active) => {
          const payload = {
            summary: "Reassessed",
            changes: input.definitionId === "reassess" && !changed
              ? [{ action: "replace" as const, item_id: "p2", item: { id: "p2", goal: "revised" } }]
              : [],
          }
          const reassessment = input.definitionId === "reassess"
            ? reassessmentProposal({ retired: false, payload }, input, replayWorkflowControl(store.events))
            : null
          if (reassessment) changed = true
          return {
            kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
            handoff: input.definitionId === "source"
              ? { summary: "Source", milestones: [{ id: "p1", goal: "first" }, { id: "p2", goal: "second" }] }
              : { summary: input.item === null || input.definitionId === "reassess" ? input.definitionId : JSON.stringify(input.item) },
            reassessment,
          }
        },
      },
    })
    try {
      expect((await host.run()).kind).toBe("completed")
      expect(changed).toBe(true)
      const evidence = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(store), "session")
      expect(evidence.results?.map(({ label, status, content }) => [label, status, content?.summary])).toEqual([
        ["source", "completed", "Source"],
        ["work, round 1", "completed", '{"id":"p1","goal":"first"}'],
        ["reassess, round 1", "completed", "reassess"],
        ["work, round 2", "completed", '{"id":"p2","goal":"revised"}'],
        ["reassess, round 2", "completed", "reassess"],
        ["review", "completed", "review"],
      ])
    } finally {
      await host.dispose()
    }
  })

  it("reports a pending dependent as skipped with its terminal reason after a prerequisite fails", async () => {
    const store = createMemoryStore(initialFacts(sequentialWorkflow))
    const host = testHost(store, {
      workflow: sequentialWorkflow,
      attemptRunner: {
        run: async (input, active) => ({
          kind: "fatal", attemptId: input.attemptId, conversationId: active.conversationId, reason: "prerequisite failed",
        }),
      },
    })
    try {
      expect((await host.run()).kind).toBe("failed")
      const evidence = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(store), "session")
      expect(evidence.results).toEqual([
        { label: "work", status: "failed", reason: "prerequisite failed" },
        { label: "review", status: "skipped", reason: "A required dependency cannot complete" },
      ])
    } finally {
      await host.dispose()
    }
  })

  it("reports both phases that a condition skipped as skipped", async () => {
    const [work, review] = sequentialWorkflow.phases
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      ...sequentialWorkflow,
      phases: [
        { phase: "investigate", name: "Investigate", brief: "Investigate.", writes: [], output: { fields: { hypothesis: { type: "string" } } } },
        { ...work, if: "investigate.hypothesis" },
        { ...review, if: "work" },
      ],
    })
    const store = createMemoryStore(initialFacts(workflow))
    const host = testHost(store, {
      workflow,
      attemptRunner: { run: async (input, active) => ({
        kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
        handoff: { summary: "No fix needed", hypothesis: "" }, reassessment: null,
      }) },
    })
    try {
      expect((await host.run()).kind).toBe("completed")
      const evidence = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(store), "session")
      expect(evidence.results.map(({ label, status }) => [label, status])).toEqual([
        ["investigate", "completed"], ["work", "skipped"], ["review", "skipped"],
      ])
      const terminal = terminalWorkflow(replayWorkflowControl(store.events), loadQueueFromEvents(store.events))!
      expect(terminal).toMatchObject({ completedAgents: 3, totalAgents: 3 })
      expect(workflowCompletionContent({ ...terminal, label: "Debug", sessionId: "session", ...evidence })).toContain("3/3 agents finished.")
    } finally {
      await host.dispose()
    }
  })

  it("names each named agent that failed, beside the result of the agent that finished", async () => {
    const [work, review] = sequentialWorkflow.phases
    const independent = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      ...sequentialWorkflow,
      phases: [{ phase: "both", agents: [{ ...work, phase: undefined, agent: "work" }, { ...review, phase: undefined, agent: "review" }].map(({ phase: _phase, ...agent }) => agent) }],
    })
    const store = createMemoryStore(initialFacts(independent))
    const host = testHost(store, {
      workflow: independent,
      attemptRunner: {
        run: async (input, active) => input.definitionId === "work"
          ? { kind: "fatal", attemptId: input.attemptId, conversationId: active.conversationId, reason: "provider refused the credentials" }
          : { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "reviewed" }, reassessment: null },
      },
    })
    try {
      const result = await host.run()
      expect(result.kind).toBe("failed")

      const evidence = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(store), "session")
      expect(evidence.failedAgents).toEqual([{ name: "Work", reason: "provider refused the credentials" }])
      const content = workflowCompletionContent({
        status: "failed", label: "Independent", sessionId: "session", ...evidence,
      })
      expect(content).toContain('1/2 agents finished. 1 agent failed: "Work" (provider refused the credentials).')
      expect(content).toContain("## work: failed (provider refused the credentials)\n\n## review: completed\n\n### Summary\nreviewed")
    } finally {
      await host.dispose()
    }
  })

  it("records a delivered handoff as a failed validation, runs on from it, and reports it as completed with its problems", async () => {
    const store = createMemoryStore(initialFacts(sequentialWorkflow))
    const issues = [{ path: "notes", message: "Expected a value with a length of at most 1" }]
    const host = testHost(store, {
      workflow: sequentialWorkflow,
      attemptRunner: {
        run: async (input, active) => input.definitionId === "work"
          ? { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "worked", notes: ["a", "b"] }, reassessment: null, issues }
          : { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "reviewed" }, reassessment: null },
      },
    })
    try {
      expect(await host.run()).toMatchObject({ kind: "completed" })
      const validated = store.events.filter(({ type }) => type === "handoff.validated").map(({ payload }) => payload)
      expect(validated).toEqual([
        expect.objectContaining({ status: "failed", issues }),
        expect.objectContaining({ status: "passed", issues: [] }),
      ])

      const evidence = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(store), "session")
      expect(evidence.failedAgents).toEqual([])
      const content = workflowCompletionContent({ status: "completed", label: "Sequential", sessionId: "session", ...evidence })
      expect(content).toContain("2/2 agents finished.")
      expect(content).toContain("## work: completed, handoff did not pass its contract\n\nProblems that remain:\n- notes: Expected a value with a length of at most 1\n\n### Summary\nworked")
      expect(content).toContain("## review: completed\n\n### Summary\nreviewed")
    } finally {
      await host.dispose()
    }
  })

  it("fans out over the salvaged list of a delivered handoff, and folds the findings of a delivered item agent into its join", async () => {
    const text = (description: string) => ({ type: "string", description })
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "salvaged-fan-out", name: "Salvaged fan-out",
      phases: [
        { phase: "find", ...record("find"), output: { summary: "The findings.", fields: { findings: { type: "list", description: "The findings.", max: 2, unique: "id", of: { type: "object", fields: { id: text("The id."), title: text("The title.") } } } } } },
        {
          phase: "check", over: "find.findings", label: "title", ...record("check"),
          output: { summary: "The check.", fields: { notes: { type: "list", description: "The notes.", max: 2, unique: "id", of: { type: "object", fields: { id: text("The id.") } } } } },
          join: { reducer: "dedupe", with: { items: "notes", by: "id" } },
        },
        { phase: "report", ...record("report") },
      ],
    })
    const store = createMemoryStore(initialFacts(workflow))
    const contextStore = createWorkflowContextStore({ sessionId: "session", reader: asAsyncEventReadSurface(store) })
    const refused = [{ path: "findings", message: "Expected a value with a length of at most 2" }]
    const checkIssues = [{ path: "summary", message: "too short" }]
    const executor = createAttemptExecutor({
      unavailableToolReason: (term) => `${term} is off`,
      earlierCheckpoint: async () => null,
      resolvedAgents: resolveWorkflowAgents(workflow),
      skills: fixtureSkills,
      context: contextStore,
      recordInvocation: async () => {},
      worker: async (attempt, brief) => {
        await brief(EVERY_CAPABILITY)
        if (attempt.definitionId === "find") {
          return {
            output: "completed", durationMs: 1, handoffIssues: refused,
            handoffContent: { summary: "Found them.", findings: [{ id: "F1", title: "One" }, { id: "F2", title: "Two" }, { title: "No id" }, { id: "F3", title: "Three" }] },
          }
        }
        if (attempt.definitionId === "check") {
          const delivered = deliveredChecks.has(attempt.id)
          return { output: "completed", durationMs: 1, handoffContent: { summary: "Checked.", notes: [{ id: delivered ? "N2" : "N1" }] }, ...(delivered ? { handoffIssues: checkIssues } : {}) }
        }
        return { output: "completed", durationMs: 1, handoffContent: { summary: "Reported." } }
      },
    })
    const checked: unknown[] = []
    // The check of F2 runs out its correction and is delivered with issues.
    const deliveredChecks = new Set<string>()
    const host = testHost(store, {
      workflow,
      contextStore,
      attemptRunner: {
        run: async (input, active) => {
          if (input.definitionId === "check") checked.push(input.item)
          if (input.definitionId === "check" && typeof input.item === "object" && input.item !== null && "id" in input.item && input.item.id === "F2") deliveredChecks.add(input.attemptId)
          return executor.run(input, active)
        },
      },
    })
    try {
      expect(await host.run()).toMatchObject({ kind: "completed" })
      // One check per kept finding: the item without an id and the item past
      // the list's max run no agent.
      expect(checked).toEqual([expect.objectContaining({ id: "F1" }), expect.objectContaining({ id: "F2" })])

      // A copy: toMatchObject in Bun writes its asymmetric matchers into the
      // object it matches, which would corrupt the stored fact.
      const validated = store.events.filter(({ type }) => type === "handoff.validated").map(({ payload }) => structuredClone(payload))
      expect(validated[0]).toMatchObject({
        status: "failed",
        issues: [
          ...refused,
          { path: "findings.2", message: expect.stringContaining("the item was left out because id: Missing key"), hint: 'item: {"title":"No id"}' },
          { path: "findings.3", message: "the item was left out because the list holds at most 2 items", hint: 'item: {"id":"F3","title":"Three"}' },
        ],
      })
      expect(validated.filter((payload) => payload.status === "failed")).toHaveLength(2)

      // The join folds the delivered check like any other completed agent.
      const settled = store.events.filter(({ type }) => type === "group.settled").map(({ payload }) => structuredClone(payload))
      expect(settled).toHaveLength(1)
      expect(settled[0]?.output).toMatchObject({
        kept: [expect.objectContaining({ id: "N1" }), expect.objectContaining({ id: "N2" })],
        failed: [],
      })
      const evidence = await readWorkflowCompletionEvidence(asAsyncEventReadSurface(store), "session")
      expect(evidence.failedAgents).toEqual([])
    } finally {
      await host.dispose()
      contextStore.dispose()
    }
  })

  it("states no failed agent when every agent finished", () => {
    const content = workflowCompletionContent({
      status: "completed", label: "Clean", sessionId: "session", results: [], handoff: null,
      tree: { nodes: ["first", "second"].flatMap((id) => [
        { id: `${id}:phase`, kind: "phase", form: "single", phaseId: id, label: id, parentId: null, disposition: "completed" },
        { id, kind: "agent", definitionId: id, label: id, parentId: `${id}:phase`, disposition: "completed", attempts: 1 },
      ] as const) },
      failedAgents: [], resumable: false,
    })
    expect(content).toBe('Workflow completed: "Clean" (workflow session). 2/2 agents finished. Review the agent results and continue the original request.')
  })

  it("keeps the latest agent results that fit its limit, lists them in graph order, and names each other one and how to read it", () => {
    const sized = (share: number) => ({ summary: "x".repeat(Math.floor(COMPLETION_AGENT_RESULTS_CAP_BYTES * share)) })
    // In graph order the lanes would fill the limit before the report.
    const content = workflowCompletionContent({
      status: "completed", label: "Large", sessionId: "session", handoff: null, tree: { nodes: [] }, failedAgents: [], resumable: false,
      results: [
        { label: "first", status: "completed", content: sized(1 / 2) },
        { label: "second", status: "completed", content: sized(1 / 4) },
        { label: "third", status: "skipped", reason: "its input failed" },
        { label: "report", status: "completed", content: sized(1 / 3) },
      ],
    })

    expect([...content.matchAll(/^## (.+)$/gmu)].map((match) => match[1])).toEqual(["second: completed", "third: skipped (its input failed)", "report: completed"])
    expect(content).toEndWith(`These agent results did not fit the ${COMPLETION_AGENT_RESULTS_CAP_BYTES}-byte limit of this message: first. Read each handoff with \`flywheel events search --session session --type handoff.written --json\`, which names the agent of each one.`)
  })
})
