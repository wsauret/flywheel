import assert from "node:assert/strict"
import { test } from "node:test"
import { jest } from "bun:test"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { settle } from "../../../tests/unit/protocol/client/_session-changes-fixtures.js"
import { mountAgentGroup } from "./render-ownership-loader-fixture.js"

const group: Extract<FrontendOutputBlock, { kind: "agentGroup" }> = {
  kind: "agentGroup", id: "controlled-agent", toolUseId: "dispatch", containerKind: "subagent",
  label: "Explorer", description: "Inspect files", model: "test high", duration: 2000,
  status: "active", children: [], totalToolCount: 1, timestamp: 0, linkUri: "flywheel://session/child",
}

test("subagent controls use child admission and dispatch its interrupt, resume, and parent-call Stop", async () => {
  const mounted = mountAgentGroup(group, undefined, ["subagent.interrupt", "subagent.resume"])
  try {
    await settle()
    assert.match(mounted.text(), /OpenInterruptStop/)
    const buttons = mounted.elements().filter(node => node.properties["aria-label"] === "Interrupt" || node.properties["aria-label"] === "Stop")
    assert.equal(buttons.length, 2)
    assert.equal(buttons[0]!.parentNode, buttons[1]!.parentNode)
    mounted.click("Actions")
    assert.deepEqual(mounted.elements().filter(node => node.properties.role === "menuitem").map(node => node.properties["aria-label"]), ["Interrupt", "Stop"])
    assert.match(mounted.text(), /Cut it now\. Resume continues it\./)
    assert.match(mounted.text(), /End this run\./)
    const menu = mounted.elements().find(node => node.properties.role === "menu")
    mounted.setBlock({ ...group, totalTokens: 50 })
    assert.equal(mounted.elements().find(node => node.properties.role === "menu"), menu, "a publication keeps the open menu")
    mounted.click("Interrupt", true)
    assert.equal(mounted.elements().some(node => node.properties.role === "menu"), false)
    mounted.click("Actions")
    mounted.click("Stop", true)
    await settle()
    assert.deepEqual(mounted.mutations, [{ type: "subagent.interrupt", sessionId: "child" }])
    assert.deepEqual(mounted.terminated, ["dispatch"])
    mounted.setBlock({ ...group, status: "paused", pausedBy: "person" })
    await settle()
    assert.match(mounted.text(), /OpenResume/)
    assert.doesNotMatch(mounted.text(), /Stop/)
    mounted.click("Actions")
    assert.deepEqual(mounted.elements().filter(node => node.properties.role === "menuitem").map(node => node.properties["aria-label"]), ["Resume"])
    assert.match(mounted.text(), /Continue it\./)
    mounted.click("Resume", true)
    await settle()
    assert.deepEqual(mounted.mutations.at(-1), { type: "subagent.resume", sessionId: "child" })
    assert.deepEqual(mounted.failures, [])
    const reads = mounted.detailReads.length
    mounted.setBlock({ ...group, status: "paused", pausedBy: "person", totalTokens: 200 })
    await settle()
    assert.equal(mounted.detailReads.length, reads, "token updates do not reread admission")
  } finally { mounted.dispose() }
  const noAdmission = mountAgentGroup(group)
  try {
    await settle()
    assert.doesNotMatch(noAdmission.text(), /Interrupt|Resume/)
    assert.match(noAdmission.text(), /Stop/)
  } finally { noAdmission.dispose() }
})

test("a linked child group selects its ordinary session instead of expanding inline", () => {
  const mounted = mountAgentGroup(group)
  try {
    mounted.open()
    assert.deepEqual(mounted.selectedSessions(), ["child"])
    assert.equal(mounted.hydrationRequests(), 0)
  } finally { mounted.dispose() }
})

test("header actions open on a held press or right-click, suppress Open, and close on Escape, outside press, or completion", async () => {
  const mounted = mountAgentGroup(group, undefined, ["subagent.interrupt"])
  const header = mounted.elements().find(node => String(node.properties.class).split(" ").includes("subagent-head"))!
  const disclosure = mounted.elements().find(node => node.properties.class === "disclosure")!
  const document = header.ownerDocument
  const originals = ["Element", "HTMLElement", "Node"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  for (const [name] of originals) Object.defineProperty(globalThis, name, { configurable: true, value: Object.getPrototypeOf(header).constructor })
  const point = { target: disclosure, button: 0, isPrimary: true, clientX: 20, clientY: 20, pointerId: 1 }
  const expanded = () => mounted.elements().find(node => node.properties["aria-label"] === "Actions")?.properties["aria-expanded"]
  try {
    await settle()
    // The press timers are the only timers from here until the card reopens.
    jest.useFakeTimers()
    header.dispatch("pointerdown", point)
    jest.runOnlyPendingTimers()
    assert.equal(expanded(), true)
    document.dispatch("keydown", { key: "ArrowDown", preventDefault() {}, stopPropagation() {} })
    assert.equal(document.activeElement?.properties["aria-label"], "Stop")
    document.dispatch("keydown", { key: "ArrowUp", preventDefault() {}, stopPropagation() {} })
    assert.equal(document.activeElement?.properties["aria-label"], "Interrupt")
    let stopped = false
    header.dispatch("click", { preventDefault() {}, stopImmediatePropagation() { stopped = true } })
    assert.equal(stopped, true, "the compatibility click must not reach Open")
    assert.deepEqual(mounted.selectedSessions(), [])
    document.dispatch("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} })
    assert.equal(expanded(), false)
    header.dispatch("contextmenu", { preventDefault() {} })
    assert.equal(expanded(), true)
    document.dispatch("pointerdown", { target: null })
    assert.equal(expanded(), false)
    header.dispatch("pointerdown", point)
    document.dispatch("pointermove", { ...point, clientY: 31 })
    assert.equal(jest.getTimerCount(), 0)
    assert.equal(expanded(), false)
    header.dispatch("pointerdown", point)
    document.dispatch("scroll", { target: document })
    assert.equal(jest.getTimerCount(), 0)
    header.dispatch("pointerdown", point)
    document.dispatch("pointercancel", {})
    assert.equal(jest.getTimerCount(), 0)
    mounted.click("Actions")
    assert.equal(expanded(), true)
    mounted.setBlock({ ...group, status: "completed" })
    assert.equal(mounted.elements().some(node => node.properties.role === "menu"), false)
    const swallowed: string[] = []
    for (const key of ["Escape", "ArrowDown", "ArrowUp", "Home", "End"]) {
      document.dispatch("keydown", { key, preventDefault() { swallowed.push(key) }, stopPropagation() {} })
    }
    assert.deepEqual(swallowed, [], "a completed card must release the document keyboard")
    jest.useRealTimers()
    mounted.setBlock(group)
    await settle()
    assert.equal(expanded(), false, "newly admitted actions must not reopen the menu")
  } finally {
    mounted.dispose()
    jest.useRealTimers()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

test("a running child card shows its reply wait, and a settled card does not", () => {
  const mounted = mountAgentGroup(group)
  try {
    mounted.setChildStatus("child", { waitingOnBackgroundWork: true, replyWaits: [{ sessionId: "render-ownership", name: "Design chat" }], activeBackgroundCommands: [], activeForegroundBashToolCallIds: [] })
    assert.match(mounted.text(), /Waiting on parent/)
    mounted.setChildStatus("child", { waitingOnBackgroundWork: true, replyWaits: [{ sessionId: "sibling", name: "Spec review" }], activeBackgroundCommands: [], activeForegroundBashToolCallIds: [] })
    assert.match(mounted.text(), /Waiting for message response/)
    mounted.setBlock({ ...group, status: "completed" })
    assert.doesNotMatch(mounted.text(), /Waiting/)
  } finally { mounted.dispose() }
})

test("a narrow header drops operations while keeping the model, persona, controls, and row time", () => {
  const card = { ...group, totalToolCount: 3, totalTokens: 900 }
  const mounted = mountAgentGroup(card)
  const part = (kind: string) => mounted.elements().find(node => String(node.properties.class).split(" ").includes(`subagent-header-${kind}`))
  const dropped = (kind: string) => {
    const classes = part(kind)?.properties.classList
    return typeof classes === "object" && classes !== null && "subagent-header-dropped" in classes && classes["subagent-header-dropped"] === true
  }
  try {
    const header = mounted.elements().find(node => String(node.properties.class).includes("subagent-header-parts"))
    assert.ok(header)
    assert.match(mounted.text(), /Explorer · Inspect files · test high · 3 operations/)
    assert.doesNotMatch(mounted.text(), /tokens/)
    assert.equal(part("tokens"), undefined)
    assert.equal(mounted.elements().some(node => node.properties.class === "workflow-card-time"), false)
    assert.equal(header.properties["style:--subagent-identity-width"], "160px", "the natural persona and model widths reserve identity space before controls")
    header.clientWidth = 440
    mounted.setBlock({ ...card, totalToolCount: 4 })
    assert.equal(dropped("operations"), false)
    header.clientWidth = 300
    mounted.setBlock({ ...card, totalToolCount: 5 })
    assert.equal(dropped("operations"), true)
    assert.equal(dropped("persona"), false)
    assert.equal(dropped("model"), false)
    assert.match(mounted.text(), /OpenStop/)
    assert.match(mounted.text(), /2s/)
  } finally { mounted.dispose() }
})

test("activity-only publications do not measure the header", () => {
  const mounted = mountAgentGroup({ ...group, totalTokens: 900 })
  const reads = () => mounted.elements().reduce((sum, node) => sum + Number(node.properties.widthReads ?? 0), 0)
  try {
    const before = reads()
    assert.ok(before > 0, "the mounted header measured its initial parts")
    mounted.setBlock({ ...group, totalTokens: 900, activity: { name: "Read", detail: "another file" } })
    assert.equal(reads(), before)
  } finally { mounted.dispose() }
})

test("a failed held-detail read retries and restores Resume without a per-card notice", async () => {
  // Fake timers also hold Bun.sleep, so these turns settle with microtasks alone.
  const turns = async () => { for (let turn = 0; turn < 40; turn += 1) await Promise.resolve() }
  jest.useFakeTimers()
  const mounted = mountAgentGroup({ ...group, status: "paused", pausedBy: "person" }, undefined, ["subagent.resume"], true)
  try {
    await turns()
    assert.doesNotMatch(mounted.text(), /Resume/)
    assert.deepEqual(mounted.failures, [])
    assert.equal(mounted.detailReads.length, 1)
    assert.ok(jest.getTimerCount())
    jest.runOnlyPendingTimers()
    await turns()
    assert.match(mounted.text(), /Resume/)
    assert.deepEqual(mounted.failures, [])
    assert.equal(mounted.detailReads.length, 2)
  } finally { mounted.dispose(); jest.useRealTimers() }
})

test("detail replacements remove stale Resume and completed cards release detail", async () => {
  const mounted = mountAgentGroup({ ...group, status: "paused", pausedBy: "person" }, undefined, ["subagent.resume"])
  try {
    await settle()
    assert.match(mounted.text(), /Resume/)
    mounted.replaceAdmission(["subagent.interrupt"])
    assert.doesNotMatch(mounted.text(), /Resume/)
    mounted.setBlock({ ...group, status: "completed" })
    assert.equal(mounted.heldDetails(), 0)
  } finally { mounted.dispose() }
  const complete = mountAgentGroup({ ...group, status: "completed" })
  try {
    await settle()
    assert.deepEqual(complete.detailReads, [])
    assert.equal(complete.elements().some(node => node.properties["aria-label"] === "Actions"), false)
  } finally { complete.dispose() }
})
