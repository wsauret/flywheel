import { expect, test } from "bun:test"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import type { LoadedWorkflowView } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { fakeRuntimeConnection } from "../../client/runtime-connection-fixture.js"
import { plainAgentTree } from "../../../../tests/helpers/workflow-view.js"
import { createWorkflowInspections, type WorkflowReading } from "./inspection.js"
import { workflowCardControls } from "../../../../src/protocol/client/session-controls.js"
import type { WorkflowDetail } from "../../../../src/protocol/modules/workflows.js"
import assert from "node:assert/strict"
import { rendered } from "../../app/blocks-render-loader-fixture.js"
import { loadSemanticRowsFixture } from "../../app/semantic-rows-loader-fixture.js"
import { REVIEW_KEYS } from "../../../../tests/unit/protocol/client/_workflow-card-fixtures.js"
import { fileURLToPath } from "node:url"
import { loadSolidFixture } from "../../test-support/solid-transform.js"
import { importBuiltModule } from "../../test-support/import-built-module.js"

const settle = () => new Promise<void>(resolve => { setImmediate(resolve) })

test("a workflow card draws its phases with their chits, the agents of a running phase as a tree, and the plan bar, and names no model and no operations", async () => {
  const { renderBlock, tool } = rendered
  const workflowCard = {
    done: 6, total: 21, failed: 1, finishedFailed: 0, running: 11, parked: 0, before: 0, after: 0,
    phases: [
      { key: "scout", phaseId: "scout", name: "Scout", form: "single" as const, state: "done" as const, done: 1, total: 1, failed: 0, startedAt: 0, completedAt: 5_000,
        detail: { text: "Gate scout present; changed no files", tone: "muted" as const }, agents: [{ agentNodeId: "scout:agent", attemptId: "scout:1", label: "scout", state: "done" as const }] },
      {
        key: "reviews", phaseId: "reviews", name: "Review", form: "list" as const, state: "running" as const, done: 2, total: 14, failed: 1, agentCount: 14,
        units: { done: 2, failed: 1, running: 11, parked: 0 }, startedAt: 500_000,
        agentNames: REVIEW_KEYS,
        agents: [
          { agentNodeId: "reviews:db", attemptId: "db:1", label: "db.ts", state: "failed" as const, detail: "Type check failed: db.ts:42 expects a Pool" },
          { agentNodeId: "reviews:config", attemptId: "config:1", label: "config.ts", state: "running" as const, startedAt: 507_000 },
        ],
        agentsMore: { count: 12, done: 2, running: 10, parked: 0, failed: 0, waiting: 0, skipped: 0 },
      },
      { key: "gates", phaseId: "gates", name: "gates", form: "parallel" as const, state: "queued" as const, done: 0, total: 2, failed: 0, agentCount: 2, units: { done: 0, failed: 0, running: 0, parked: 0 }, agentNames: ["lint", "typecheck"] },
      { key: "report", phaseId: "report", name: "Report", form: "single" as const, state: "queued" as const, done: 0, total: 1, failed: 0 },
    ],
  }
  const card = {
    kind: "agentGroup" as const, id: "workflow-1", toolUseId: "tu-workflow", containerKind: "workflow" as const,
    label: "Review Ui", description: "Review UI", status: "active" as const, children: [tool({ id: "inner", name: "bash", presentation: { name: "Bash", detail: "inner-call" }, fileChangeKind: undefined })],
    totalToolCount: 50, totalTokens: 104_200, linkUri: "flywheel://workflow/workflow", timestamp: Date.now(), card: workflowCard,
  }
  const html = renderBlock(card, { roles: { assignments: { chat: { model: "claude-opus-5.5", effort: "medium" } } } })
  // The glyph asks for its text form, which iOS Safari otherwise draws as a colour emoji.
  assert.match(html, /<span class="tool-title"><span class="workflow-glyph">\u2699\uFE0E <\/span>Review Ui<\/span>/)
  assert.match(html, /<span class="tool-detail workflow-header-parts"><span[^>]*>0s<\/span><\/span>/)
  assert.doesNotMatch(html, /tokens/)
  assert.match(html, /class="workflow-card +opens *"/)
  assert.match(html, /class="workflow-card-id">reviews</)
  // One chit for each unit up to the slots, then the slots in proportion:
  // the plan bar holds 21 of 40 on a desktop and 20 on a phone, reviews 12
  // and 8, and gates 2 and 2. The one failed reviewer keeps a red chit.
  assert.equal(html.match(/class="workflow-chit /g)?.length, 21 + 20 + 12 + 8 + 2 + 2)
  assert.match(html, /workflow-chit tone-failed/)
  // A running phase shows its agents as a tree: the failed one first, then
  // the running one, then one counted line for the rest by state.
  const { mountWorkflowTree } = await loadSemanticRowsFixture<typeof import("./semantic-rows-fixture.js")>(new URL("semantic-rows-fixture.tsx", import.meta.url))
  const mounted = mountWorkflowTree(workflowCard)
  try {
    assert.match(mounted.text(), /db\.ts.*Type check failed: db\.ts:42 expects a Pool.*config\.ts.*\+12 more · 2 done · 10 running/)
    assert.ok(mounted.elements().some(node => String(node.properties.class).startsWith("workflow-card-agent state-failed")))
    assert.ok(mounted.elements().some(node => String(node.properties.class).startsWith("workflow-card-agent state-running")))
  } finally { mounted.dispose() }
  // The line of a phase of one agent opens that agent, as an agent line does.
  assert.match(html, /<button type="button" class="workflow-card-phase state-done[^"]*"[^>]*>[\s\S]*?scout/)
  assert.match(html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, ""), /reviews2\/14 · agents\.ts · auth\.ts/)
  assert.ok(html.indexOf('class="workflow-card-bar"') < html.indexOf('class="workflow-card-phase'))
  assert.match(html, /<button type="button" class="workflow-card-phase state-queued[^"]*"[^>]*aria-disabled="true"[^>]*tabindex="-1"[^>]*>[\s\S]*?class="workflow-card-id">report</)
  // A phase of named agents that has not started names each agent in the
  // colour of an agent's name, with dots between them.
  assert.match(html, /<span class="workflow-card-agent-name">lint<\/span> · <span class="workflow-card-agent-name">typecheck<\/span>/)
  assert.match(html, /6\/21 done/)
  // A phone reads the short count, and drops the running part first when the label does not fit.
  assert.match(html, /bar-label phone-only"><span class="workflow-card-bar-part tone-plain ">6\/21<\/span><span class="workflow-card-bar-part tone-plain active"> \u00b7 11 running<\/span><span class="workflow-card-bar-part tone-failed "> \u00b7 1 failed</)
  assert.match(html, />Stop</)
  for (const absent of [/operations/, /claude-opus-5\.5/, /inner-call/, /agent-activity-preview/]) assert.doesNotMatch(html, absent)
  const settled = renderBlock({ ...card, status: "completed", duration: 686_000, card: {
    ...workflowCard, done: 21, running: 0,
    phases: [{ ...workflowCard.phases[0]!, detail: { text: "The scout gate exists", tone: "muted" as const } }],
  } })
  assert.match(settled, /class="workflow-card settled opens *"/)
  assert.match(settled, /The scout gate exists</)
  assert.match(settled, /Completed/)
  assert.doesNotMatch(settled, />Stop</)
  assert.match(renderBlock({ ...card, status: "completed", card: undefined }), /This workflow&#39;s plan is unavailable\.|This workflow's plan is unavailable\./)
})
const view = (state: LoadedWorkflowView["state"]): LoadedWorkflowView => ({ attemptsStatus: "loaded", state, attempts: [], tree: plainAgentTree([]) })
const totals = { totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalInputTokens: 0, totalOutputTokens: 0 }
const detail: WorkflowDetail = {
  workflowId: "run", title: "Run", workflowDefinitionId: "probe", createdAt: "", lastUpdated: "", executionCwd: "/scratch",
  roleAssignments: { defaults: {}, overrides: {} }, launchedFrom: { parentSessionId: "chat", conversationId: "conversation", toolUseId: "call" },
  auth: null, workflowState: "failed", readability: "readable", admittedActions: ["workflow.resume", "workflow.delete"],
  totals, policyUsage: totals, attribution: "available", durationMs: 0, streamingStartedAt: null, activeIntervals: [], totalsLoading: false,
}

test("inline workflow menus keep admitted controls and dispatch the selected action or parent-call Stop", async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("activity-fixture.tsx", import.meta.url))],
    target: "bun", conditions: ["browser"], format: "esm",
    plugins: [{ name: "workflow-menu-memory-host", setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    } }],
  })
  if (!build.success) throw new Error(build.logs.map(String).join("\n"))
  const output = build.outputs.find(candidate => candidate.kind === "entry-point")
  if (!output) throw new Error("Activity fixture build produced no JavaScript")
  const { mountWorkflowActivity }: typeof import("./activity-fixture.js") = await importBuiltModule(output)
  const sent: string[] = []
  let publish: ((reading: WorkflowReading) => void) | undefined
  const block = {
    kind: "agentGroup" as const, id: "workflow-menu", toolUseId: "workflow-call", containerKind: "workflow" as const,
    status: "active" as const, label: "Review", description: "Review files", children: [], totalToolCount: 1,
    timestamp: 0, linkUri: "flywheel://workflow/run",
  }
  const mounted = mountWorkflowActivity(block, {
    control: (id, kind) => { sent.push(`${id}:${kind}`) },
    subscribe: (_id, notify) => {
      publish = notify
      notify({ detail: { ...detail, workflowState: "running", admittedActions: ["workflow.interrupt"] }, view: undefined, live: [] })
      return Object.assign(() => {}, { update() {} })
    },
  })
  const menuWords = () => mounted.elements().filter(node => node.properties.role === "menuitem").map(node => node.properties["aria-label"])
  try {
    mounted.click("Actions")
    assert.deepEqual(menuWords(), ["Interrupt", "Stop"])
    mounted.click("Interrupt", true)
    assert.deepEqual(sent, ["run:interrupt"])
    assert.deepEqual(menuWords(), [])
    mounted.click("Actions")
    mounted.click("Stop", true)
    assert.deepEqual(mounted.terminated, ["workflow-call"])
    mounted.setBlock({ ...block, status: "paused", pausedBy: "person" })
    publish?.({ detail: { ...detail, workflowState: "paused", admittedActions: ["workflow.resume"] }, view: undefined, live: [] })
    mounted.click("Actions")
    assert.deepEqual(menuWords(), ["Resume"])
    mounted.click("Resume", true)
    assert.deepEqual(sent.at(-1), "run:resume")
    mounted.setBlock({ ...block, status: "error", failure: { title: "Failed", message: "The run failed.", guidance: "" } })
    publish?.({ detail: { ...detail, admittedActions: ["workflow.restart"] }, view: undefined, live: [] })
    mounted.click("Actions")
    assert.deepEqual(menuWords(), ["Restart"])
    assert.match(mounted.text(), /Run it again from its request\./)
    mounted.click("Restart", true)
    assert.deepEqual(sent.at(-1), "run:restart")
  } finally { mounted.dispose() }
})

test("a resident transcript card retains detail across demand changes and releases only unneeded domains", async () => {
  const reads: string[] = []
  const populated = view("running")
  const agents = [{ sessionId: "agent", attemptId: "attempt", operations: 1, duration: 0, revision: 1 }]
  /** Answers a deferred read at `snapshotPosition`, with its domain's view or with none. */
  const resumed = new Map<string, (snapshotPosition: number, present: boolean) => void>()
  let defer = false
  const listeners = new Set<(event: FrontendEvent) => void>()
  const snapshot = <View>(type: string, held: View): { snapshotPosition: number; view: View | null } | Promise<{ snapshotPosition: number; view: View | null }> => {
    if (!defer) return { snapshotPosition: 1, view: held }
    const answer = Promise.withResolvers<{ snapshotPosition: number; view: View | null }>()
    resumed.set(type, (snapshotPosition, present) => answer.resolve({ snapshotPosition, view: present ? held : null }))
    return answer.promise
  }
  const connection = fakeRuntimeConnection({
    onQuery: query => { reads.push(query.type) },
    queries: {
      workflowDetail: () => snapshot("workflowDetail", detail),
      workflowViewSnapshot: () => snapshot("workflowViewSnapshot", populated),
      workflowLiveSnapshot: () => snapshot("workflowLiveSnapshot", { agents }),
    },
  }, { subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } })
  const inspections = createWorkflowInspections(connection)
  try {
    const publications: WorkflowReading[] = []
    const card = inspections.subscribe("run", reading => { publications.push(reading) }, { kind: "card", status: "active", hasChoices: false })
    await settle()
    expect(reads).toEqual(["workflowDetail", "workflowViewSnapshot", "workflowLiveSnapshot"])
    expect(publications.at(-1)).toEqual({ detail, view: populated, live: agents })
    const beforePause = publications.length
    card.update({ kind: "card", status: "paused", hasChoices: false })
    await settle()
    expect(publications.slice(beforePause)).toEqual([{ detail, view: populated, live: agents }])
    expect(reads).toEqual(["workflowDetail", "workflowViewSnapshot", "workflowLiveSnapshot"])
    expect(listeners.size).toBe(1)
    defer = true
    for (const first of ["workflowLiveSnapshot", "workflowViewSnapshot"]) {
      const beforeResume = publications.length
      card.update({ kind: "card", status: "active", hasChoices: false })
      await settle()
      resumed.get(first)?.(2, true)
      await settle()
      expect(publications.slice(beforeResume)).toEqual(Array.from({ length: publications.length - beforeResume }, () => ({ detail, view: populated, live: agents })))
      const second = first === "workflowViewSnapshot" ? "workflowLiveSnapshot" : "workflowViewSnapshot"
      resumed.get(second)?.(2, true)
      await settle()
      expect(publications.at(-1)).toEqual({ detail, view: populated, live: agents })
      card.update({ kind: "card", status: "paused", hasChoices: false })
    }
    card.update({ kind: "card", status: "active", hasChoices: false })
    await settle()
    resumed.get("workflowViewSnapshot")?.(3, false)
    await settle()
    expect(publications.at(-1)).toEqual({ detail, view: undefined, live: agents })
    resumed.get("workflowLiveSnapshot")?.(3, false)
    await settle()
    expect(publications.at(-1)).toEqual({ detail, view: undefined, live: [] })
    card()
    expect(listeners.size).toBe(0)
  } finally { inspections.dispose() }
})

test("a cold failed transcript card reads detail and offers Resume without opening view or live", async () => {
  const reads: string[] = []
  const connection = fakeRuntimeConnection({
    onQuery: query => { reads.push(query.type) },
    queries: { workflowDetail: () => ({ snapshotPosition: 1, view: detail }) },
  })
  const inspections = createWorkflowInspections(connection)
  let controls = workflowCardControls(undefined, false, false)
  try {
    const release = inspections.subscribe("run", reading => { controls = workflowCardControls(reading.detail, false, false) }, { kind: "card", status: "error", hasChoices: false })
    await settle()
    expect(reads).toEqual(["workflowDetail"])
    expect(controls).toEqual({ primary: "resume", stop: false })
    release()
  } finally { inspections.dispose() }
})
