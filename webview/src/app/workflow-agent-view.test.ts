import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"
import type { LoadedWorkflowView } from "../../../src/protocol/workflow-view-protocol-types.js"
import { controlActionKey } from "../client/action-key.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../modules/workflows/agent-header-fixture.tsx", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{ name: "workflow-agent-memory-host", setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
  } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find((candidate) => candidate.kind === "entry-point")
if (!output) throw new Error("Agent fixture build produced no JavaScript")
const fixture: typeof import("../modules/workflows/agent-header-fixture.js") = await importBuiltModule(output)

const VIEW: LoadedWorkflowView = {
  attemptsStatus: "loaded", state: "running",
  attempts: ["json", "yaml"].map((id) => ({ id, definitionId: id, briefId: id, name: id, status: "running", startedAt: 1_000, sessionId: `member-${id}`, history: [] })),
  tree: { nodes: [
    { id: "formats", kind: "phase", form: "parallel", phaseId: "formats", label: "Formats", parentId: null, disposition: "running" },
    ...["json", "yaml"].map((id) => ({ id, kind: "agent" as const, definitionId: id, label: id, parentId: "formats", disposition: "running" as const, attempts: 1, currentAttemptId: id })),
  ], currentAgentNodeId: "yaml" },
}

test("the real agent view scopes controls and busy state to the open agent and freezes its parked clock", async () => {
  const real = { now: Date.now, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  let now = 10_000
  const ticks = new Map<number, () => void>()
  let next = 0
  Date.now = () => now
  Object.assign(globalThis, { setInterval: (run: () => void) => { ticks.set(++next, run); return next }, clearInterval: (id: number) => ticks.delete(id) })
  const mounted = fixture.mountAgentView(VIEW, "json")
  try {
    assert.deepEqual(mounted.labels(), ["Interrupt"])
    mounted.setBusyKey(controlActionKey("interrupt", "member-yaml"))
    assert.deepEqual(mounted.busy(), [undefined])
    mounted.setBusyKey(controlActionKey("interrupt", "member-json"))
    assert.deepEqual(mounted.busy(), [true])
    await mounted.click("Interrupt")
    assert.deepEqual(mounted.sent, [{ type: "chat.interrupt", sessionId: "member-json" }])
    // The agent's session worked 4s before the interrupt; the wait adds none.
    mounted.setLive([{ attemptId: "json", sessionId: "member-json", operations: 0, interruptedAt: 5_000, duration: 4_000, revision: 0 }])
    assert.deepEqual(mounted.labels(), ["Resume"])
    assert.match(mounted.text(), /json\s*interrupted.*4s/)
    assert.equal(ticks.size, 0)
    now += 10_000
    for (const tick of ticks.values()) tick()
    assert.match(mounted.text(), /json\s*interrupted.*4s/)
    await mounted.click("Resume")
    assert.deepEqual(mounted.sent[1], { type: "chat.resume", sessionId: "member-json" })
    mounted.setLeaf("yaml")
    assert.deepEqual(mounted.labels(), ["Interrupt"])
    assert.equal(ticks.size, 1)
    mounted.setRow((row) => ({ ...row, lifecycleState: "inactive", active: false, working: false }))
    mounted.setInterruptible(false)
    assert.deepEqual(mounted.labels(), ["Resume"])
    mounted.setView({ ...VIEW, tree: { ...VIEW.tree, nodes: VIEW.tree.nodes.map((node) => node.id === "yaml" ? { ...node, disposition: "completed" } : node) } })
    mounted.setRow(row => ({ ...row, admittedActions: [] }))
    assert.deepEqual(mounted.labels(), [])
  } finally {
    mounted.dispose()
    Object.assign(globalThis, { setInterval: real.setInterval, clearInterval: real.clearInterval })
    Date.now = real.now
  }
})

test("the agent view's band names the way back and the whole workflow's progress, one agent line names the phase and the agent, Next agent shows the agent's place, and the prompt shows as one closed row", async () => {
  const prompt = { kind: "userMessage" as const, id: "prompt", content: "Format the json files.\nKeep the keys sorted.", timestamp: 0, pending: false, injected: false }
  const mounted = fixture.mountAgentView(VIEW, "json", [prompt, { kind: "text", id: "answer", content: "Formatted.", timestamp: 1 }])
  try {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // The band is the whole workflow's; the agent line is the agent's. The
    // way back from the full-size card names the card, and the workflow's
    // name stands apart from it. The count keeps its full words at every
    // width: a narrow band gives up the word and the chits instead, and
    // each separator leads its own part, so a wrapped row never starts
    // with one.
    assert.equal(mounted.band(), "‹ All agents\u2699\uFE0E Workflowworkflow0/2 done·2 running")
    assert.deepEqual(mounted.names(), { phase: "formats", agent: "json" })
    assert.match(mounted.line() ?? "", /^formats›json.*running/)
    assert.doesNotMatch(mounted.text(), /chip|phase formats/)
    assert.equal(mounted.next(), "Next agent 1/2")
    assert.equal(mounted.pressNext(), 1)
    assert.equal(mounted.brief(), "▸Brief · agent json · 2 lines")
    assert.doesNotMatch(mounted.text(), /Keep the keys sorted/)
  } finally {
    mounted.dispose()
  }
})

test("the band names the chat by the title its row shows and the run by the one name its record carries", async () => {
  const mounted = fixture.mountAgentView({ ...VIEW, name: "Run follow workflow" }, "json", [], {
    origin: "chat", runTitle: "Run Workflow with Supplied Inputs", chat: { title: "Run Workflow", subtitle: "Launch Workflow with One Input" },
  })
  try {
    assert.match(mounted.band() ?? "", /^‹ Run Workflow\u2699\uFE0E Run follow workflowworkflow/)
  } finally {
    mounted.dispose()
  }
})

test("a narrow agent line drops its operations, as the terminal's does, and keeps the phase, the agent, and its state", async () => {
  const mounted = fixture.mountAgentView(VIEW, "json")
  try {
    mounted.setLive([{ attemptId: "json", sessionId: "member-json", operations: 3, duration: 0, revision: 0 }])
    assert.match(mounted.line() ?? "", /^formats›jsonrunning.*·3 ops$/)
    const state = mounted.elements().find(node => String(node.properties.class).includes("part-state"))
    const operations = mounted.elements().find(node => String(node.properties.class).includes("part-operations"))
    const name = mounted.elements().find(node => String(node.properties.class).includes("workflow-agent-name"))
    assert.ok(state && name && operations)
    // The host draws 8 pixels for each character and a separator's column
    // of two characters: `formats › json` takes 13 characters and
    // `running · 4 ops` 15, so 25 characters leave no room for the
    // operations.
    mounted.setLineWidth(8 * 25)
    mounted.setLive([{ attemptId: "json", sessionId: "member-json", operations: 4, duration: 0, revision: 1 }])
    assert.match(mounted.line() ?? "", /^formats›jsonrunning(·\S+)?$/)
    assert.doesNotMatch(mounted.line() ?? "", /ops/)
    assert.ok(mounted.elements().includes(state))
    assert.ok(mounted.elements().includes(name))
    assert.ok(!mounted.elements().includes(operations))
  } finally {
    mounted.dispose()
  }
})

test("history and semantic header facts stay resident across live view publications", () => {
  const real = { now: Date.now, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  let now = 10_000
  const ticks = new Map<number, () => void>()
  let next = 0
  Date.now = () => now
  Object.assign(globalThis, { setInterval: (run: () => void) => { ticks.set(++next, run); return next }, clearInterval: (id: number) => ticks.delete(id) })
  const view = { ...VIEW, attempts: VIEW.attempts.map(attempt => ({ ...attempt, history: [{ sessionId: "earlier", conversationId: "conversation" }] })) }
  const mounted = fixture.mountAgentView(view, "json")
  try {
    mounted.setLive([{ attemptId: "json", sessionId: "member-json", operations: 0, duration: 0, activeStartedAt: 1_000, revision: 0 }])
    const state = mounted.elements().find(node => String(node.properties.class).includes("part-state"))
    const time = mounted.elements().find(node => String(node.properties.class).includes("part-time"))
    assert.ok(state && time)
    assert.match(mounted.line() ?? "", /9s/)
    const past = mounted.elements().filter(node => node.tag === "button" && node.properties.class === "workflow-agent-next").at(-1)
    assert.ok(past)
    past.focus()
    mounted.setView(structuredClone(view))
    assert.ok(mounted.elements().includes(past))
    assert.equal(past.ownerDocument.activeElement, past)
    assert.ok(mounted.elements().includes(state))
    mounted.setLive([{ attemptId: "json", sessionId: "member-json", operations: 9, duration: 0, activeStartedAt: 1_000, revision: 1 }])
    assert.ok(mounted.elements().includes(state))
    assert.match(mounted.line() ?? "", /9 ops/)
    now += 5_000
    for (const tick of ticks.values()) tick()
    assert.ok(mounted.elements().includes(time))
    assert.match(mounted.line() ?? "", /14s/)
    const click = past.properties.onClick
    assert.equal(typeof click, "function")
    if (typeof click === "function") click()
    assert.deepEqual(mounted.histories, ["earlier"])
  } finally {
    mounted.dispose()
    Object.assign(globalThis, { setInterval: real.setInterval, clearInterval: real.clearInterval })
    Date.now = real.now
  }
})
