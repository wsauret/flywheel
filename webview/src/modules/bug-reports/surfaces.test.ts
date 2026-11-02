import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import type { BugReportResult } from "../../../../src/protocol/modules/bug-reports.js"
import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("surfaces-fixture.ts", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{ name: "report-memory-host", setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    builder.onLoad({ filter: /focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
    builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
  } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find(item => item.kind === "entry-point")
if (!output) throw new Error("Missing report fixture build")
const { mountReports }: typeof import("./surfaces-fixture.js") = await importBuiltModule(output)

test("the stage fallback sends once, names its surface, and shows its receipt after selection changes", async () => {
  const response = Promise.withResolvers<BugReportResult>()
  const error = new TypeError("stage broke")
  const mounted = mountReports({ kind: "crash", response: response.promise, error, surface: "phone" })
  try {
    await mounted.settle()
    assert.match(mounted.text(), /This view is unavailable\.Sending report/)
    assert.deepEqual(mounted.mutations, [{
      type: "bugReport.submit", kind: "crash", error: { name: "TypeError", message: "stage broke", stack: error.stack },
      surface: "phone", sessionId: "session-one",
    }])
    mounted.setSessionId("session-two")
    response.resolve({ ok: true, reportId: "FW-receipt" })
    await mounted.settle()
    assert.match(mounted.text(), /Report sent automatically \(FW-receipt\)\. To stop automatic reports, turn off Bug reports in Settings\./)
    assert.equal(mounted.mutations.length, 1)
  } finally { mounted.dispose() }
})

test("a refused automatic report copies the account-assembled report", async () => {
  const error = new Error("x".repeat(4100))
  error.stack = "stack".repeat(2500)
  const mounted = mountReports({ kind: "crash", error, surface: "editor", response: Promise.resolve({ ok: false, kind: "rejected", error: "receiver unavailable", reportText: "account-assembled report" }) })
  try {
    await mounted.settle()
    assert.match(mounted.text(), /Could not send report: receiver unavailable/)
    mounted.click("Copy report")
    await mounted.settle()
    assert.equal(mounted.copied.length, 1)
    assert.equal(mounted.copied[0], "account-assembled report")
    assert.deepEqual(mounted.notices, ["Report copied."])
    assert.equal(JSON.stringify(mounted.mutations).includes("x".repeat(4001)), false)
  } finally { mounted.dispose() }
})

test("a crash in a build that is not an official release says no report was sent and copies the assembled report", async () => {
  const mounted = mountReports({ kind: "crash", response: Promise.resolve({ ok: false, kind: "not-release", error: "No bug report was sent because this build is not an official Flywheel release.", reportText: "account-assembled report" }) })
  try {
    await mounted.settle()
    assert.match(mounted.text(), /No bug report was sent because this build is not an official Flywheel release\./)
    assert.doesNotMatch(mounted.text(), /Could not send/)
    mounted.click("Copy report")
    await mounted.settle()
    assert.deepEqual(mounted.copied, ["account-assembled report"])
  } finally { mounted.dispose() }
})

test("a dropped submission produces a copyable failure rather than an unhandled rejection", async () => {
  const mounted = mountReports({ kind: "crash", response: Promise.reject(new Error("EPIPE")) })
  try {
    await mounted.settle()
    assert.match(mounted.text(), /Could not send report: the connection to the runtime dropped/)
    mounted.click("Copy report")
    await mounted.settle()
    assert.match(mounted.copied[0]!, /EPIPE|connection to the runtime dropped/)
  } finally { mounted.dispose() }
})

test("a report form's optional note and nodes survive a send, failure, and retry", async () => {
  const response = Promise.withResolvers<BugReportResult>()
  const mounted = mountReports({ kind: "manual", response: response.promise })
  try {
    mounted.type("  The menu froze  ")
    const field = mounted.note()
    const send = mounted.button("Send report")
    mounted.click("Send report")
    mounted.click("Send report")
    assert.equal(mounted.mutations.length, 1)
    assert.equal(send.properties.disabled, true)
    assert.deepEqual(mounted.mutations[0], {
      type: "bugReport.submit", kind: "manual", error: { name: "", message: "", stack: "" },
      surface: "web", sessionId: "session-one", note: "The menu froze",
    })
    mounted.setSessionId("session-two")
    response.resolve({ ok: false, kind: "unavailable", error: "service unavailable" })
    await mounted.settle()
    assert.equal(mounted.note(), field)
    assert.equal(mounted.button("Send report"), send)
    assert.equal(field?.properties.value, "  The menu froze  ")
    mounted.click("Copy report")
    await mounted.settle()
    const copied = JSON.parse(mounted.copied[0]!)
    assert.equal(copied.note, "The menu froze")
    assert.equal(copied.sessionId, "session-one")
    mounted.type("")
    mounted.click("Send report")
    await mounted.settle()
    const retry = mounted.mutations[1]
    assert.equal(retry?.type, "bugReport.submit")
    if (retry?.type !== "bugReport.submit") throw new Error("Expected a report submission")
    assert.equal(retry.kind, "manual")
    assert.equal(retry.note, undefined)
    assert.equal(retry.sessionId, "session-two")
  } finally { mounted.dispose() }
})

test("runtime receipts update the same fault notice without a duplicate report and failures offer Copy", async () => {
  const mounted = mountReports({ kind: "runtime", faultReport: "retained runtime report with account diagnostics" })
  try {
    const initial = mounted.text()
    assert.match(initial, /service keeps stopping/)
    mounted.setHealth({ kind: "crash_loop", cause: "service stopped", report: { kind: "sent", reportId: "FW-runtime" } })
    assert.match(mounted.text(), /Report sent automatically \(FW-runtime\)\. To stop automatic reports, turn off Bug reports in Settings\./)
    assert.deepEqual(mounted.mutations, [])
    mounted.setHealth({ kind: "recovery_failed", cause: "recovery failed", report: { kind: "failed" } })
    assert.match(mounted.text(), /Could not send report/)
    mounted.click("Copy report")
    const button = mounted.button("Copy report")
    mounted.setHealth({ kind: "recovery_failed", cause: "recovery failed", report: { kind: "failed" } })
    assert.equal(mounted.button("Copy report"), button)
    await mounted.settle()
    assert.equal(mounted.copied[0], "retained runtime report with account diagnostics")
    assert.deepEqual(mounted.queries, [{ type: "bugReport.failed", source: "executor" }])
    mounted.setHealth({ kind: "crash_loop", cause: "service stopped", report: { kind: "not-release" } })
    assert.match(mounted.text(), /No bug report was sent because this build is not an official Flywheel release\./)
    assert.doesNotMatch(mounted.text(), /Could not send report/)
    assert.ok(mounted.button("Copy report"))
    mounted.disable()
    assert.doesNotMatch(mounted.text(), /Could not send report/)
    mounted.setHealth({ kind: "healthy" })
    assert.equal(mounted.text(), "")
  } finally { mounted.dispose() }
})

test("a disposed crash view ignores a late report receipt", async () => {
  const response = Promise.withResolvers<BugReportResult>()
  const mounted = mountReports({ kind: "crash", response: response.promise })
  await mounted.settle()
  const before = mounted.text()
  mounted.dispose()
  response.resolve({ ok: true, reportId: "FW-late" })
  await mounted.settle()
  assert.equal(mounted.text(), before)
  assert.deepEqual(mounted.notices, [])
})
