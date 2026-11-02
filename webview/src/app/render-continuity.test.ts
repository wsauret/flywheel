import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { mountComposerSubmission } from "./composer-submission-loader-fixture.js"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

import { workflowCard } from "../../../src/protocol/client/workflow-card.js"
import { workflowOutline } from "../../../src/protocol/client/workflow-outline.js"
import { plainAgentTree } from "../../../tests/helpers/workflow-view.js"
import { fanoutView, REVIEW_KEYS, type AgentFixture, type FanoutFixture } from "../../../tests/unit/protocol/client/_workflow-card-fixtures.js"
import type { WorkflowReading } from "../modules/workflows/inspection.js"
import type { WorkflowSurface } from "../../../src/protocol/client/workflow-surface.js"
import { mountMarkdown } from "./render-ownership-loader-fixture.js"
import { createElement, createTextNode, MemoryElement, nodes, textContent } from "./render-ownership-host-fixture.js"
import { patchMarkdownChildren } from "./markdown-dom.js"
import type { FrontendQuestionBlock } from "../client/question-answer.js"

test("replacement transfers active, inactive, and new-chat drafts without renumbering prepared files", async () => {
  const original = mountComposerSubmission()
  let checkpoint: unknown
  try {
    original.leaveSession()
    original.type("new chat")
    original.openChat("other")
    original.type("inactive")
    original.openChat("chat")
    original.type("active")
    await original.attach("first.txt")
    await original.attach("second.txt")
    original.remove("first.txt")
    checkpoint = original.capture()
  } finally { original.dispose() }
  const successor = mountComposerSubmission()
  try {
    successor.adopt(checkpoint)
    assert.equal(successor.text(), "active")
    assert.equal(successor.attachmentCount(), 1)
    assert.equal(successor.sent.length, 0)
    successor.send()
    assert.equal(successor.sent[0]?.attachments?.[0]?.marker, "[File #2 second.txt]")
    assert.equal(successor.sent[0]?.attachments?.[0]?.data, btoa("contents"))
    assert.equal(successor.sent[0]?.attachments?.[0]?.mediaType, "text/plain")
    assert.equal(successor.sent[0]?.attachments?.[0]?.name, "second.txt")
    successor.openChat("other")
    assert.equal(successor.text(), "inactive")
    successor.leaveSession()
    assert.equal(successor.text(), "new chat")
  } finally { successor.dispose() }
})

for (const attentionAtMount of [false, true]) {
  test(`the mounted question dock keeps its nodes and local choices through recovery${attentionAtMount ? " with attention at mount" : ""}`, async () => {
    const block: FrontendQuestionBlock = {
      kind: "question", toolUseId: "ask", timestamp: 1,
      questions: [{ question: "Which file?", header: "File", multiSelect: true, choices: [{ kind: "option", choiceId: "file", label: "a.ts", requiresText: true }, { kind: "freeform", label: "Other" }] }],
    }
    const mounted = mountComposerSubmission({ question: block, attentionAtMount })
    const dock = () => mounted.elements().find((node) => node.properties.class === "command-panel question-panel")
    const row = () => mounted.elements().find((node) => node.properties.class === "question-choice-row")
    const answer = () => mounted.elements().find((node) => node.tag === "button" && textContent(node) === "Answer")
    const skip = () => mounted.elements().find((node) => node.tag === "button" && textContent(node) === "Skip")
    try {
      await mounted.settle()
      const originalDock = dock()
      const originalRow = row()
      assert.ok(originalDock)
      assert.ok(originalRow)
      mounted.clickQuestion("a.ts")
      const field = mounted.elements().find((node) => node.properties["aria-label"] === "a.ts: Which file?")
      assert.ok(field)
      const input = field.properties.onInput
      assert.equal(typeof input, "function")
      if (typeof input === "function") input({ currentTarget: Object.assign(field, { value: "keep this draft" }) })
      await mounted.settle()
      const heldSkip = skip()
      assert.ok(heldSkip)
      heldSkip.focus()
      mounted.unmerged()
      assert.equal(skip(), heldSkip)
      assert.equal(heldSkip.properties.focused, true)
      assert.notEqual(heldSkip.properties.disabled, true, "holding a focused button must not natively disable it")
      assert.equal(heldSkip.properties["aria-disabled"], "true")
      mounted.merged()
      assert.equal(heldSkip.properties.focused, true)
      mounted.clickQuestion("Minimize question")
      assert.equal(originalDock.properties["data-collapsed"], "true")
      mounted.unmerged()
      assert.equal(dock(), originalDock, "recovery must not remove the question dock")
      assert.equal(row(), originalRow, "minimizing must keep the choice row mounted")
      assert.equal(answer()?.properties.disabled, false)
      assert.equal(answer()?.properties["aria-disabled"], "true")
      assert.notEqual(skip()?.properties.disabled, true)
      assert.equal(skip()?.properties["aria-disabled"], "true")
      mounted.merged()
      mounted.publishQuestionBlock(structuredClone(block))
      assert.equal(dock(), originalDock)
      assert.equal(row(), originalRow, "an equal publication must patch the choice row")
      assert.equal(originalDock.properties["data-collapsed"], "true")
      assert.equal(originalRow.properties["aria-checked"], true)
      assert.equal(mounted.elements().find((node) => node.properties["aria-label"] === "a.ts: Which file?"), field, "a re-read must keep the draft's input node")
      assert.equal(field.properties.value, "keep this draft")
      assert.equal(answer()?.properties.disabled, false)
      assert.equal(skip()?.properties["aria-disabled"], undefined)
      mounted.type("/")
      assert.equal(dock(), originalDock, "a slash panel must hide, not dispose, the dock")
      assert.deepEqual(originalDock.properties.style, { display: "none" })
      mounted.type("")
      assert.deepEqual(originalDock.properties.style, { display: undefined })
      mounted.openChat("other")
      mounted.publishQuestionBlock(undefined)
      mounted.openChat("chat")
      mounted.publishQuestionBlock(structuredClone(block))
      assert.equal(dock()?.properties["data-collapsed"], "true", "returning to a session must restore its local choices")
      assert.equal(row()?.properties["aria-checked"], true)
      assert.equal(mounted.elements().find((node) => node.properties["aria-label"] === "a.ts: Which file?")?.properties.value, "keep this draft")
      mounted.attend()
      await mounted.settle()
      assert.equal(dock()?.properties["data-collapsed"], "false", "only a new attention request expands the dock")
      mounted.clickQuestion("Minimize question")
      mounted.unmerged()
      mounted.publishQuestionBlock({ ...block, cancelled: true })
      assert.ok(dock(), "untrusted settlement must not remove the dock")
      mounted.merged()
      assert.equal(dock(), undefined, "current settlement removes the dock")
      mounted.unmerged()
      mounted.publishQuestionBlock(structuredClone(block))
      assert.equal(dock()?.properties["data-collapsed"], "false", "a stale re-read after settlement must not recover retired disclosure")
      assert.equal(row()?.properties["aria-checked"], false, "settlement retires the picks even if an old window reappears")
      assert.equal(mounted.elements().some((node) => node.properties["aria-label"] === "a.ts: Which file?"), false, "settlement retires the draft")
    } finally { mounted.dispose() }
  })
}

test("replacement adopts question text, picks, Other, and minimization without submitting or reviving a settled question", async () => {
  const block: FrontendQuestionBlock = {
    kind: "question", toolUseId: "ask", timestamp: 1,
    questions: [
      { question: "Named?", multiSelect: true, choices: [{ kind: "option", choiceId: "named", label: "Named", requiresText: true }] },
      { question: "Free?", multiSelect: false, choices: [{ kind: "freeform", label: "Other" }] },
    ],
  }
  const original = mountComposerSubmission({ question: block })
  let saved: unknown
  try {
    original.clickQuestion("Named")
    original.typeQuestion("Named: Named?", "named words")
    original.clickQuestion("Open Other: Free?")
    original.typeQuestion("Other: Free?", "free words")
    original.clickQuestion("Minimize question")
    saved = original.capture()
  } finally { original.dispose() }
  const successor = mountComposerSubmission({ question: block })
  try {
    successor.adopt(saved)
    await successor.settle()
    assert.equal(successor.elements().find((node) => node.properties.class === "command-panel question-panel")?.properties["data-collapsed"], "true")
    assert.equal(successor.elements().find((node) => node.properties["aria-label"] === "Named: Named?")?.properties.value, "named words")
    assert.equal(successor.elements().find((node) => node.tag === "textarea" && node.properties["aria-label"] === "Other: Free?")?.properties.value, "free words")
    assert.equal(successor.elements().filter((node) => node.properties["aria-checked"] === true).length, 2)
    assert.equal(successor.questionAnswers.length, 0)
    assert.equal(successor.questionSkips.length, 0)
    successor.publishQuestionBlock({ ...block, cancelled: true })
    assert.equal(successor.question(), false)
    assert.deepEqual(successor.capture().questions, {})
  } finally { successor.dispose() }
})

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../modules/workflows/activity-fixture.tsx", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{ name: "module-activity-memory-host", setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
  } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find(candidate => candidate.kind === "entry-point")
if (!output) throw new Error("Activity fixture build produced no JavaScript")
const { mountWorkflowActivity }: typeof import("../modules/workflows/activity-fixture.js") = await importBuiltModule(output)

test("a queued workflow phase retains its row and cells when its agent starts", () => {
  const card = (started: boolean) => workflowCard(workflowOutline(fanoutView({
    scout: started ? { disposition: "running", startedAt: 1 } : { disposition: "pending" },
    gates: [started ? { disposition: "running", startedAt: 1 } : { disposition: "pending" }, { disposition: "pending" }],
    report: { disposition: "pending" },
  })), { settled: false, choices: { phases: new Map([["gates", "expanded"]]), all: new Set() } })
  const block = {
    kind: "agentGroup" as const, id: "workflow", toolUseId: "workflow", containerKind: "workflow" as const,
    status: "active" as const, label: "Probe", description: "Probe", children: [], totalToolCount: 1,
    timestamp: 1000, linkUri: "flywheel://workflow/workflow", card: card(false),
  }
  const mounted = mountWorkflowActivity(block)
  try {
    const row = mounted.elements().find(node => String(node.properties.class).includes("workflow-card-phase"))
    assert.ok(row)
    const agent = mounted.elements().find(node => String(node.properties.class).includes("workflow-card-agent state-queued"))
    assert.ok(agent)
    const agentCells = [...agent.children]
    assert.equal(agent.tag, "button")
    assert.equal(agent.properties["aria-disabled"], true)
    assert.equal(agent.properties.tabindex, -1)
    const queuedClick = agent.properties.onClick
    assert.equal(typeof queuedClick, "function")
    if (typeof queuedClick === "function") queuedClick({ stopPropagation() { assert.fail("queued rows must bubble to the inline card") } })
    agent.focus()
    const cells = [...row.children]
    assert.match(String(row.properties.class), /state-queued/)
    assert.equal(row.properties["aria-disabled"], true)
    assert.equal(row.properties.tabindex, -1)
    const click = () => {
      const handler = row.properties.onClick
      assert.equal(typeof handler, "function")
      if (typeof handler === "function") handler({ stopPropagation() {} })
    }
    click()
    assert.deepEqual(mounted.selectedSessions(), [])
    mounted.setBlock({ ...block, card: card(true) })
    assert.ok(mounted.elements().includes(row), "starting the agent must not replace its phase row")
    assert.ok(mounted.elements().includes(agent), "starting the agent must not replace its own row")
    assert.ok(agentCells.every(cell => agent.children.includes(cell)), "the agent cells remain resident")
    assert.equal(agent.properties.focused, true)
    assert.equal(agent.properties["aria-disabled"], undefined)
    assert.equal(agent.properties.tabindex, 0)
    assert.ok(cells.every(cell => row.children.includes(cell)), "the phase cells remain resident")
    assert.match(String(row.properties.class), /state-running/)
    assert.equal(row.properties["aria-disabled"], undefined)
    assert.equal(row.properties.tabindex, 0)
    click()
    assert.deepEqual(mounted.openedWorkflows(), ["workflow"])
    assert.deepEqual(mounted.selectedSessions(), [], "a workflow card never selects an aggregate as a session")
  } finally { mounted.dispose() }
})

test("Markdown retains its parsed nodes across equal publications and live text growth", () => {
  const mounted = mountMarkdown("First paragraph")
  try {
    const first = mounted.children()[0]
    assert.ok(first)
    mounted.publish("First paragraph")
    assert.equal(mounted.children()[0], first)
    mounted.publish("First paragraph grows")
    assert.equal(mounted.children()[0], first)
    assert.match(mounted.text(), /First paragraph grows/)
    mounted.publish("First paragraph grows\n\nNext paragraph")
    assert.equal(mounted.children()[0], first, "settling the live paragraph keeps its node")
    const second = mounted.children()[1]
    assert.ok(second)
    mounted.publish("First paragraph grows\n\nNext paragraph grows")
    assert.equal(mounted.children()[0], first)
    assert.equal(mounted.children()[1], second)
    assert.match(mounted.text(), /Next paragraph grows/)
    mounted.publish("Revised paragraph")
    assert.equal(mounted.children()[0], first, "a source revision patches existing content")
    assert.equal(mounted.children().length, 1)
    assert.match(mounted.text(), /Revised paragraph/)
  } finally { mounted.dispose() }
})

test("Markdown retains nested elements and text while patching hand-built DOM trees", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Element")
  Object.defineProperty(globalThis, "Element", { configurable: true, value: MemoryElement })
  const tree = (text: string, code: string, inlineTag = "strong") => {
    const paragraph = createElement("p")
    const inline = createElement(inlineTag)
    inline.setAttribute("class", text === "first" ? "old" : "new")
    if (text === "first") inline.setAttribute("title", "obsolete")
    inline.append(createTextNode(text))
    paragraph.append(inline)
    const pre = createElement("pre")
    const codeElement = createElement("code")
    codeElement.append(createTextNode(code))
    pre.append(codeElement)
    const last = createElement("p")
    last.append(createTextNode("last paragraph"))
    return [paragraph, pre, last]
  }
  const root = createElement("div")
  const publish = (replacement: ReturnType<typeof tree>) => {
    patchMarkdownChildren(root, replacement)
  }
  try {
    publish(tree("first", "const a = 1"))
    const retained = nodes(root)
    const paragraph = root.children[0]!
    const inline = paragraph.children[0]!
    const text = inline.children[0]!
    const pre = root.children[1]!
    const code = pre.children[0]!
    const codeText = code.children[0]!
    publish(tree("first grows", "const a = 1"))
    assert.ok(nodes(root).every((node, index) => node === retained[index]), "growth retains every existing node")
    assert.equal(textContent(text), "first grows")
    assert.equal(inline.getAttribute("class"), "new")
    assert.equal(inline.hasAttribute("title"), false)
    publish(tree("first grows", "const a = 2"))
    assert.equal(root.children[1], pre)
    assert.equal(pre.children[0], code)
    assert.equal(code.children[0], codeText)
    assert.equal(textContent(codeText), "const a = 2")
    const settled = nodes(root)
    publish(tree("first grows", "const a = 2"))
    assert.ok(nodes(root).every((node, index) => node === settled[index]), "equal multi-paragraph publications preserve every node")
    publish(tree("first grows", "const a = 2", "em"))
    assert.equal(root.children[0], paragraph)
    assert.notEqual(paragraph.children[0], inline)
    assert.equal(paragraph.children[0]?.tag, "em")
    assert.equal(root.children[1], pre)
    assert.equal(root.children[2], retained.at(-2))
  } finally {
    if (original) Object.defineProperty(globalThis, "Element", original)
    else Reflect.deleteProperty(globalThis, "Element")
  }
})

test("workflow summary publications keep their live subscription and label nodes", () => {
  const attempts = [{ id: "draft", definitionId: "draft", briefId: "draft", name: "Draft", status: "running" as const, startedAt: 1000, sessionId: "member", history: [] }]
  const view = { name: "Probe", attempts, attemptsStatus: "loaded" as const, state: "running" as const, tree: plainAgentTree(attempts) }
  const block = {
    kind: "agentGroup" as const, id: "workflow", toolUseId: "workflow", containerKind: "workflow" as const,
    status: "active" as const, label: "Probe", description: "Probe", children: [], totalToolCount: 1,
    timestamp: 1000, linkUri: "flywheel://workflow/workflow", card: workflowCard(workflowOutline(view), { settled: false }),
  }
  let subscriptions = 0
  let releases = 0
  const updates: WorkflowSurface[] = []
  const mounted = mountWorkflowActivity(block, {
    subscribe(_id, listener) {
      subscriptions += 1
      const totals = { totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalInputTokens: 0, totalOutputTokens: 0 }
      listener({ detail: {
        workflowId: "workflow", title: "Probe", workflowDefinitionId: "probe", createdAt: "", lastUpdated: "", executionCwd: "/scratch",
        roleAssignments: { defaults: {}, overrides: {} }, launchedFrom: { parentSessionId: "chat", conversationId: "conversation", toolUseId: "call" },
        auth: null, readability: "readable", admittedActions: ["workflow.interrupt", "workflow.resume"],
        totals, policyUsage: totals, attribution: "available", durationMs: 0, streamingStartedAt: null, activeIntervals: [], totalsLoading: false,
      }, view, live: [{ attemptId: "draft", sessionId: "member", operations: 1, duration: 0, revision: 1, activity: { name: "Read", detail: "current.ts" } }] })
      return Object.assign(() => { releases += 1 }, { update(surface: WorkflowSurface) { updates.push(surface) } })
    },
  })
  try {
    assert.match(mounted.text(), /current\.ts/)
    const labels = mounted.elements().filter(node => String(node.properties.class).includes("workflow-card-bar-part") || String(node.properties.class).includes("tone-"))
    assert.ok(labels.length > 0)
    const card = mounted.elements().find(node => String(node.properties.class).split(" ").includes("workflow-card"))
    const bar = mounted.elements().find(node => node.properties.class === "workflow-card-bar")
    assert.ok(card)
    assert.ok(bar)
    for (let i = 1; i <= 3; i++) {
      mounted.setBlock({ ...block, totalTokens: i })
      assert.match(mounted.text(), /current\.ts/)
      assert.equal(subscriptions, 1)
      assert.equal(releases, 0)
      assert.ok(labels.every(node => mounted.elements().includes(node)), "existing labels update in place")
    }
    mounted.setBlock({ ...block, status: "paused", pausedBy: "person" })
    assert.equal(subscriptions, 1)
    assert.equal(releases, 0)
    assert.deepEqual(updates, [{ kind: "card", status: "paused", hasChoices: false, agentModels: true }])
    assert.ok(mounted.elements().some(node => node.properties["aria-label"] === "Resume"), "a parked card retains its admitted Resume")
    assert.ok(labels.every(node => mounted.elements().includes(node)), "changing read demand must keep the card's existing labels")
    mounted.setBlock({ ...block, status: "completed" })
    assert.equal(subscriptions, 1)
    assert.equal(releases, 0, "settlement updates the resident reading without disposing it")
    assert.deepEqual(updates.at(-1), { kind: "card", status: "completed", hasChoices: false, agentModels: true })
    assert.ok(mounted.elements().includes(card), "settlement must keep the card mounted")
    assert.ok(mounted.elements().includes(bar), "settlement must not redraw the card from the start")
    assert.equal(mounted.elements().some(node => node.properties["aria-label"] === "Resume" || node.properties["aria-label"] === "Interrupt"), false, "settlement must not offer retained controls")
  } finally { mounted.dispose() }
})

test("a live workflow card keeps its plan bar, phase rows, and cells while the run moves", () => {
  const pending: AgentFixture = { disposition: "pending" }
  const running = (startedAt: number): AgentFixture => ({ disposition: "running", startedAt })
  const done = (startedAt: number, completedAt: number): AgentFixture => ({ disposition: "completed", startedAt, completedAt })
  const waiting = { gates: [pending, pending] as const, report: pending }
  const lanesDone = [[done(184, 230), done(230, 250)], [done(184, 240), done(240, 260)], [done(184, 300), done(300, 496)]] as const
  const run = {
    launched: { scout: pending, ...waiting },
    scout: { scout: running(0), ...waiting, currentAgentNodeId: "scout" },
    lanes: { scout: done(0, 184), lanes: [[running(191), pending], [done(184, 270), running(290)], [done(184, 271), running(291)]] as const, ...waiting },
    reviews: { scout: done(0, 184), lanes: lanesDone, reviews: REVIEW_KEYS.map((_, index) => index < 3 ? done(500, 570) : running(507)), ...waiting },
    reviewsFailing: {
      scout: done(0, 184), lanes: lanesDone, ...waiting,
      reviews: REVIEW_KEYS.map((key, index) => key === "db.ts" ? { disposition: "failed" as const, startedAt: 500, completedAt: 540, reason: "Type check failed" } : index < 2 ? done(500, 560) : running(507)),
    },
  } satisfies { readonly [point: string]: FanoutFixture }
  const block = {
    kind: "agentGroup" as const, id: "workflow", toolUseId: "workflow", containerKind: "workflow" as const,
    status: "active" as const, label: "Probe", description: "Probe", children: [], totalToolCount: 1,
    timestamp: 1000, linkUri: "flywheel://workflow/workflow", card: workflowCard(workflowOutline(fanoutView(run.launched)), { settled: false }),
  }
  let publish: ((reading: WorkflowReading) => void) | undefined
  const mounted = mountWorkflowActivity(block, {
    subscribe(_id, listener) { publish = listener; listener({ detail: undefined, view: fanoutView(run.launched), live: [] }); return Object.assign(() => {}, { update() {} }) },
  })
  const withClass = (name: string) => mounted.elements().filter(node => String(node.properties.class).split(" ").includes(name))
  const scoutCall = (operations: number, name: string, detail: string) => ({ detail: undefined, view: fanoutView(run.scout), live: [{ attemptId: "scout-1", sessionId: "scout-session", operations, duration: 0, revision: operations, activity: { name, detail } }] })
  try {
    const [bar] = withClass("workflow-card-bar")
    assert.ok(bar)
    const rows = withClass("workflow-card-phase")
    assert.equal(rows.length, 6)
    const cells = rows.map(row => [...row.children])
    const steady = (step: string) => {
      assert.deepEqual(withClass("workflow-card-bar"), [bar], `${step}: the plan bar stays one mounted line`)
      assert.ok(rows.every((row, index) => withClass("workflow-card-phase")[index] === row), `${step}: every phase row keeps its node`)
      assert.ok(rows.every((row, index) => cells[index]!.every((cell, at) => row.children[at] === cell)), `${step}: every phase cell keeps its node`)
    }
    publish?.({ detail: undefined, view: fanoutView(run.scout), live: [] })
    steady("the first agent starts")
    publish?.(scoutCall(1, "Read", "a.ts"))
    steady("its first call appears")
    const [tool] = withClass("workflow-card-tool")
    assert.ok(tool)
    publish?.(scoutCall(2, "Bash", "ls"))
    steady("its next call replaces the first")
    assert.deepEqual(withClass("workflow-card-tool"), [tool], "a newer call rewrites the call's text in place")
    assert.match(mounted.text(), /Bash ls/)
    publish?.({ detail: undefined, view: fanoutView(run.lanes), live: [] })
    steady("a list reads its items and its agents run")
    const agents = withClass("workflow-card-agent")
    assert.ok(agents.length > 0)
    publish?.({ detail: undefined, view: fanoutView(run.reviews), live: [] })
    steady("the next list runs")
    publish?.({ detail: undefined, view: fanoutView(run.reviewsFailing), live: [] })
    steady("an agent fails")
  } finally { mounted.dispose() }
})
