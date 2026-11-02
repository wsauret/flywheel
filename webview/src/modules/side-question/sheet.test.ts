import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"
import type { SideQuestionView } from "../../../../src/protocol/modules/side-question.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("sheet-fixture.ts", import.meta.url))], target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{ name: "side-question-memory", setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    builder.onLoad({ filter: /focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
    builder.onLoad({ filter: /client-context\.ts$/ }, () => ({ contents: "export function useClient() { return Reflect.get(globalThis, '__sideQuestionClient') }", loader: "js" }))
    builder.onLoad({ filter: /markdown-view\.tsx$/ }, () => ({ contents: "export function Markdown(props) { return () => props.source }", loader: "js" }))
    builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
  } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find((item) => item.kind === "entry-point")
if (!output) throw new Error("Missing fixture build")
const { mountSideQuestion }: typeof import("./sheet-fixture.js") = await importBuiltModule(output)
const running: SideQuestionView = { revision: 2, exchanges: [{ id: "old", question: "Earlier", answer: "Prior answer" }], current: { id: "live", question: "Now?", answer: "Partial", state: "running" } }

test("side question: an empty surface stays open with unknown selection and asks trimmed questions without parent sends", async () => {
  const mounted = mountSideQuestion(null, undefined, { selection: "unknown" })
  try {
    await mounted.ready()
    assert.match(mounted.text(), /Temporary · no tools/)
    assert.match(mounted.text(), /Ask a side question/)
    assert.equal(mounted.closed(), 0)
    assert.deepEqual(mounted.mutations, [])
    mounted.ask("   ")
    await mounted.ready()
    assert.deepEqual(mounted.mutations, [])
    mounted.ask("  Why?  ")
    await mounted.ready()
    assert.deepEqual(mounted.mutations, [{ type: "side-question.ask", sessionId: "parent", question: "Why?" }])
  } finally { mounted.dispose() }
})

test("side question: streaming preserves an earlier selection and scroll; actions address selected IDs and shown revision", async () => {
  const mounted = mountSideQuestion(running)
  try {
    await mounted.ready()
    assert.match(mounted.text(), /Now\?/)
    for (const label of ["Copy", "Keep as fork", "Clear", "Stop"]) assert.equal(mounted.inFooter("button", label), true)
    mounted.publish({ ...running, current: { ...running.current!, answer: "Partial grows" } })
    await mounted.ready()
    assert.match(mounted.text(), /Partial grows/)
    mounted.click("Previous")
    mounted.scroll(42)
    mounted.publish({ ...running, revision: 3, current: { ...running.current!, answer: "Partial grows" } })
    await mounted.ready()
    assert.match(mounted.text(), /Prior answer/)
    assert.equal(mounted.inFooter("p", "Answering…"), true)
    assert.equal(mounted.inFooter("button", "Stop"), true)
    assert.equal(mounted.offset(), 42)
    mounted.click("Copy")
    await mounted.ready()
    assert.deepEqual(mounted.copied, ["Prior answer"])
    mounted.click("Keep as fork")
    await mounted.ready()
    assert.deepEqual(mounted.opened, ["kept"])
    assert.equal(mounted.closed(), 1)
    assert.deepEqual(mounted.mutations[0], { type: "side-question.keep", sessionId: "parent", exchangeId: "old" })
  } finally { mounted.dispose() }
  const clear = mountSideQuestion({ ...running, current: null })
  try {
    clear.click("Clear")
    await clear.ready()
    assert.deepEqual(clear.mutations, [{ type: "side-question.clear", sessionId: "parent", revision: 2 }])
  } finally { clear.dispose() }
})

test("side question: waiting, done, error and stopped publications retain truthful visible states", async () => {
  const mounted = mountSideQuestion({ ...running, current: { ...running.current!, answer: "" } })
  try {
    await mounted.ready()
    assert.match(mounted.text(), /Waiting for answer/)
    mounted.publish({ ...running, current: { ...running.current!, state: "done" } })
    await mounted.ready()
    assert.match(mounted.text(), /Answered/)
    assert.equal(mounted.disabled("Keep as fork"), true)
    mounted.publish({ ...running, current: { ...running.current!, state: "error", error: "Provider refused" } })
    await mounted.ready()
    assert.match(mounted.text(), /Provider refused/)
    assert.equal(mounted.disabled("Keep as fork"), true)
    mounted.click("Keep as fork")
    assert.deepEqual(mounted.mutations, [])
    mounted.publish({ ...running, current: { ...running.current!, state: "stopped" } })
    await mounted.ready()
    assert.match(mounted.text(), /Stopped/)
    mounted.click("Copy")
    await mounted.ready()
    assert.deepEqual(mounted.copied, ["Partial"])
    assert.equal(mounted.disabled("Keep as fork"), true)
    mounted.click("Keep as fork")
    assert.deepEqual(mounted.mutations, [])
    mounted.click("Close")
    await mounted.ready()
    assert.deepEqual(mounted.mutations, [])
  } finally { mounted.dispose() }
})

test("side question: explicit close and scope changes stop only the held request; retirement does not stop", async () => {
  for (const action of ["Stop", "Escape", "dispose", "leave", "disable"] as const) {
    const mounted = mountSideQuestion(running)
    await mounted.ready()
    if (action === "Escape" || action === "Stop") mounted.click("Previous")
    if (action === "Escape") mounted.escape()
    else if (action === "dispose") mounted.dispose()
    else if (action === "leave") mounted.leave()
    else if (action === "disable") mounted.disable()
    else mounted.click(action)
    await mounted.ready()
    assert.deepEqual(mounted.mutations, action === "dispose" || action === "disable" ? [] : [{ type: "side-question.stop", sessionId: "parent", requestId: "live" }])
    if (action === "Escape") { assert.equal(mounted.closed(), 1); assert.equal(mounted.focused(), 1) }
    if (action !== "dispose") mounted.dispose()
  }
})

test("side question: a pending ask accepted after close stops only its returned request", async () => {
  const result = Promise.withResolvers<import("../../../../src/protocol/modules/side-question.js").SideQuestionResult>()
  const mounted = mountSideQuestion(null, result.promise)
  try {
    mounted.ask("Explain")
    assert.notEqual(mounted.inputDisabled(), true)
    assert.equal(mounted.inputFocusRequested(), true)
    mounted.click("Close")
    result.resolve({ ok: true, requestId: "late" })
    await mounted.ready()
    assert.deepEqual(mounted.mutations, [
      { type: "side-question.ask", sessionId: "parent", question: "Explain" },
      { type: "side-question.stop", sessionId: "parent", requestId: "late" },
    ])
  } finally { mounted.dispose() }
})

test("side question: module retirement does not cancel an ask admitted after its surface disappears", async () => {
  for (const action of ["disable", "dispose"] as const) {
    const result = Promise.withResolvers<import("../../../../src/protocol/modules/side-question.js").SideQuestionResult>()
    const mounted = mountSideQuestion(null, result.promise)
    try {
      mounted.ask("Explain")
      if (action === "disable") mounted.disable()
      else mounted.dispose()
      result.resolve({ ok: true, requestId: "late" })
      await mounted.ready()
      assert.deepEqual(mounted.mutations, [{ type: "side-question.ask", sessionId: "parent", question: "Explain" }])
    } finally { if (action !== "dispose") mounted.dispose() }
  }
})

test("side question: Enter submits the follow-up and Shift Enter leaves editing native", async () => {
  const mounted = mountSideQuestion(null)
  try {
    mounted.type("Explain")
    mounted.key("Enter", true)
    assert.deepEqual(mounted.mutations, [])
    mounted.key("Enter")
    await mounted.ready()
    assert.deepEqual(mounted.mutations, [{ type: "side-question.ask", sessionId: "parent", question: "Explain" }])
  } finally { mounted.dispose() }
})

test("side question: a refused action shows the runtime error and keeps the question draft", async () => {
  const mounted = mountSideQuestion(null, Promise.resolve({ ok: false, error: "Busy" }))
  try {
    mounted.ask("Explain")
    await mounted.ready()
    assert.match(mounted.text(), /Busy/)
    assert.equal(mounted.draft(), "Explain")
    mounted.ask("Explain")
    await mounted.ready()
    assert.equal(mounted.mutations.length, 2)
  } finally { mounted.dispose() }
})
