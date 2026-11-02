import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"
import type { LoadedWorkflowView } from "../../../src/protocol/workflow-view-protocol-types.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../modules/workflows/card-screen-fixture.tsx", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{ name: "workflow-card-memory-host", setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
  } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find((candidate) => candidate.kind === "entry-point")
if (!output) throw new Error("Card fixture build produced no JavaScript")
const fixture: typeof import("../modules/workflows/card-screen-fixture.js") = await importBuiltModule(output)

/** The agent of item `a` (1) or `b` (2) in the draft (first) or review
 *  (second) phase of a stream, after a plan phase of one agent. */
function agent(definitionId: "draft" | "review", ordinal: number, disposition: "pending" | "running" | "completed") {
  const position = definitionId === "draft" ? 1 : 2
  const id = `map:item:${ordinal}:phase:${position}`
  const key = ordinal === 1 ? "a" : "b"
  return {
    id, kind: "agent", definitionId, label: definitionId === "draft" ? "Draft" : "Review", parentId: `map:phase:${position}`, disposition, attempts: disposition === "pending" ? 0 : 1,
    ...(disposition === "pending" ? {} : { currentAttemptId: `${id}:attempt:1` }),
    item: { nodeId: `map:item:${ordinal}`, key, label: `Item ${key}`, ordinal, text: key },
  } as const
}

const VIEW: LoadedWorkflowView = {
  name: "Map Run",
  attemptsStatus: "loaded", state: "running",
  attempts: [
    { id: "plan:attempt:1", definitionId: "plan", briefId: "plan", name: "Plan", status: "completed", startedAt: 1_000, completedAt: 2_000, history: [] },
    { id: "map:item:1:phase:1:attempt:1", definitionId: "draft", briefId: "draft", name: "Draft", status: "completed", startedAt: 2_000, completedAt: 3_000, history: [] },
    { id: "map:item:1:phase:2:attempt:1", definitionId: "review", briefId: "review", name: "Review", status: "running", startedAt: 3_000, history: [] },
  ],
  tree: {
    nodes: [
      { id: "plan:phase", kind: "phase", form: "single", phaseId: "plan", label: "Plan", parentId: null, disposition: "completed" },
      { id: "plan", kind: "agent", definitionId: "plan", label: "Plan", parentId: "plan:phase", disposition: "completed", attempts: 1, currentAttemptId: "plan:attempt:1" },
      { id: "map:phase:1", kind: "phase", form: "list", phaseId: "draft", label: "Draft", parentId: null, disposition: "running", list: { id: "map", expanded: true } },
      agent("draft", 1, "completed"), agent("draft", 2, "pending"),
      { id: "map:phase:2", kind: "phase", form: "list", phaseId: "review", label: "Review", parentId: null, disposition: "running", list: { id: "map", expanded: true } },
      agent("review", 1, "running"), agent("review", 2, "pending"),
    ],
    currentAgentNodeId: "map:item:1:phase:2",
  },
}

test("the full-size card names the run as its inline card does, lists every phase, moves its selection with the keys, opens a started agent and the agent of a phase of one agent, and folds and expands a phase", () => {
  const mounted = fixture.mountCardScreen(VIEW)
  try {
    // The run's one name is its record's, never the workflow session's own title.
    assert.match(mounted.text(), /^Back to chatMap Run/)
    assert.match(mounted.text(), /plan[\s\S]*draft[\s\S]*review/)
    assert.deepEqual(mounted.labels(), ["Interrupt", "Stop"])
    // The selection starts on the first phase that runs.
    assert.match(mounted.selected()[0] ?? "", /draft/)
    mounted.key("ArrowDown")
    assert.match(mounted.selected()[0] ?? "", /a/)
    // A settled agent opens pinned.
    mounted.key("Enter")
    // An agent that has not started opens nothing.
    mounted.key("ArrowDown")
    mounted.key("Enter")
    assert.deepEqual(mounted.opened, [{ kind: "agent", agentNodeId: "map:item:1:phase:1", follow: false }])
    // Left moves from an agent to its phase, then folds the phase; Right
    // expands it again.
    mounted.key("ArrowLeft")
    assert.match(mounted.selected()[0] ?? "", /draft ▾/)
    mounted.key("ArrowLeft")
    assert.match(mounted.selected()[0] ?? "", /draft ▸/)
    mounted.key("ArrowRight")
    assert.match(mounted.selected()[0] ?? "", /draft ▾/)
    // Enter on a phase of one agent opens its agent.
    mounted.key("Home")
    assert.match(mounted.selected()[0] ?? "", /plan/)
    mounted.key("Enter")
    assert.deepEqual(mounted.opened.at(-1), { kind: "agent", agentNodeId: "plan", follow: false })
    // A running agent opens following its item.
    mounted.key("End")
    mounted.key("ArrowUp")
    mounted.key("Enter")
    assert.deepEqual(mounted.opened.at(-1), { kind: "agent", agentNodeId: "map:item:1:phase:2", follow: true })
    mounted.click("Interrupt")
    assert.deepEqual(mounted.controls, [{ workflowId: "workflow", control: "interrupt" }])
  } finally { mounted.dispose() }
})

test("the full-size card says why a changed definition stops the run and offers Resume, and offers Restart for saved progress that cannot run", () => {
  const drifted = fixture.mountCardScreen({ ...VIEW, state: "paused" }, {
    admittedActions: ["workflow.resume", "workflow.delete"],
    definitionDrift: { workflowDefinitionId: "implement", changes: [{ component: "graph" }] },
  })
  try {
    assert.match(drifted.text(), /The implement workflow cannot continue because its definition changed after it started\. These parts changed: the order of its phases\. Restore them, then press Resume, or start a new workflow\./)
    assert.deepEqual(drifted.labels(), ["Resume"])
  } finally { drifted.dispose() }
  const damaged = fixture.mountCardScreen({ ...VIEW, state: "paused" }, { admittedActions: ["workflow.restart", "workflow.delete"] })
  try {
    assert.match(damaged.text(), /Restart runs it again from its recorded request\./)
    damaged.click("Restart")
    assert.deepEqual(damaged.controls, [{ workflowId: "workflow", control: "restart" }])
  } finally { damaged.dispose() }
})

test("the full-size card's header counts the time the workflow worked, not the time an interrupt held it, and names saved progress that cannot run as interrupted", () => {
  // The phases started at the epoch, so a wall-clock span would read years.
  const interrupted = fixture.mountCardScreen(VIEW, {
    admittedActions: ["workflow.resume", "workflow.stop"], durationMs: 51_400,
    totals: { totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalInputTokens: 9000, totalOutputTokens: 1000 },
  })
  try {
    assert.match(interrupted.text(), /Interrupted · 51s/)
    assert.doesNotMatch(interrupted.text(), /tokens|10k/)
  } finally { interrupted.dispose() }
  const damaged = fixture.mountCardScreen(VIEW, { admittedActions: ["workflow.restart", "workflow.stop"], durationMs: 51_400 })
  try {
    assert.match(damaged.text(), /Interrupted · 51s/)
  } finally { damaged.dispose() }
  // A stopped run has no runner to report active time, so the header reads
  // the duration its row recorded.
  const stopped = fixture.mountCardScreen(VIEW, { stoppedBy: "person", admittedActions: [], durationMs: 103_600 })
  try {
    assert.match(stopped.text(), /Stopped · 1m 43s/)
  } finally { stopped.dispose() }
})

test("the full-size card of saved progress that cannot be read keeps its header, its notice, and Restart in place of the plan", () => {
  const damaged = fixture.mountCardScreen(undefined, { admittedActions: ["workflow.restart", "workflow.stop"], durationMs: 17_300 })
  try {
    assert.match(damaged.text(), /Interrupted · 17s/)
    assert.match(damaged.text(), /This workflow's saved progress cannot run\. Restart runs it again from its recorded request\./)
    assert.match(damaged.text(), /This workflow's plan is unavailable\./)
    assert.deepEqual(damaged.labels(), ["Restart", "Stop"])
  } finally { damaged.dispose() }
})
