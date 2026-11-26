import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { AUTOMATIC_REPORTS_OFF_STATUS, type BugReportResult } from "../../../../src/protocol/modules/bug-reports.js"
import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"
import { nodes, textContent } from "../../test-support/render-ownership-host-fixture.js"

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
    assert.match(mounted.text(), /Report sent automatically \(FW-receipt\)\. To stop automatic reports, turn off Automatic crash reports in Settings\./)
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
    assert.match(mounted.text(), /Report sent automatically \(FW-runtime\)\. To stop automatic reports, turn off Automatic crash reports in Settings\./)
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
    mounted.setHealth({ kind: "crash_loop", cause: "service stopped", report: { kind: "not-allowed" } })
    assert.match(mounted.text(), /No bug report was sent because automatic crash reports are off\./)
    mounted.setHealth({ kind: "crash_loop", cause: "service stopped", report: { kind: "do-not-track" } })
    assert.match(mounted.text(), /No bug report was sent because DO_NOT_TRACK is set\./)
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

test("the first crash view asks once, and a yes saves the answer and sends this report", async () => {
  const error = new TypeError("stage broke")
  const mounted = mountReports({ kind: "crash", error, surface: "phone", response: Promise.resolve({ ok: false, kind: "consent-needed", error: AUTOMATIC_REPORTS_OFF_STATUS, reportText: "account-assembled report" }), afterConsent: { ok: true, reportId: "FW-yes" } })
  try {
    await mounted.settle()
    assert.match(mounted.text(), /Send this crash report to Flywheel/)
    assert.doesNotMatch(mounted.text(), /automatic crash reports are off/)
    mounted.click("Send reports")
    await mounted.settle()
    assert.deepEqual(mounted.mutations.map(mutation => mutation.type), ["bugReport.submit", "bugReport.consent", "bugReport.submit"])
    assert.deepEqual(mounted.mutations[1], { type: "bugReport.consent", allow: true })
    assert.match(mounted.text(), /Report sent automatically \(FW-yes\)/)
    assert.doesNotMatch(mounted.text(), /Send this crash report/)
  } finally { mounted.dispose() }
})

test("a no on the crash view saves the answer, sends nothing, says why, and keeps Copy", async () => {
  const mounted = mountReports({ kind: "crash", response: Promise.resolve({ ok: false, kind: "consent-needed", error: AUTOMATIC_REPORTS_OFF_STATUS, reportText: "account-assembled report" }) })
  try {
    await mounted.settle()
    mounted.click("Don't send")
    await mounted.settle()
    assert.deepEqual(mounted.mutations.map(mutation => mutation.type), ["bugReport.submit", "bugReport.consent"])
    assert.deepEqual(mounted.mutations[1], { type: "bugReport.consent", allow: false })
    assert.match(mounted.text(), /No bug report was sent because automatic crash reports are off\./)
    assert.doesNotMatch(mounted.text(), /Could not send|Send this crash report/)
    mounted.click("Copy report")
    await mounted.settle()
    assert.deepEqual(mounted.copied, ["account-assembled report"])
  } finally { mounted.dispose() }
})

test("a crash view with no project connection, such as the phone's machine picker, offers Copy at once and sends nothing", async () => {
  const mounted = mountReports({ kind: "crash", surface: "phone", connected: false })
  try {
    await mounted.settle()
    assert.deepEqual(mounted.mutations, [])
    assert.match(mounted.text(), /Could not send report: This page is not connected to a project\./)
    assert.doesNotMatch(mounted.text(), /Send this crash report/)
    mounted.click("Copy report")
    await mounted.settle()
    assert.match(mounted.copied[0] ?? "", /stage broke/)
  } finally { mounted.dispose() }
})

test("the question is the live status, a save in progress says so, and a failed save keeps the question open", async () => {
  const saving = Promise.withResolvers<{ ok: false; error: string }>()
  const mounted = mountReports({ kind: "crash", response: Promise.resolve({ ok: false, kind: "consent-needed", error: AUTOMATIC_REPORTS_OFF_STATUS, reportText: "account-assembled report" }), consent: () => saving.promise })
  try {
    await mounted.settle()
    const status = () => textContent(nodes(mounted.root).find(node => node.properties.role === "status")!)
    assert.match(status(), /^Send this crash report to Flywheel/)
    mounted.click("Don't send")
    await mounted.settle()
    assert.equal(status(), "Saving your answer…")
    assert.deepEqual(nodes(mounted.root).find(node => node.properties.role === "status")!.properties.classList, { "bug-report-question": true })
    assert.equal(mounted.button("Send reports").properties.disabled, true)
    saving.resolve({ ok: false, error: "the file is locked" })
    await mounted.settle()
    assert.equal(status(), "Could not save your answer: the file is locked")
    assert.match(mounted.text(), /Send this crash report to Flywheel/)
    assert.equal(mounted.button("Send reports").properties.disabled, false)
    assert.deepEqual(mounted.mutations.map(mutation => mutation.type), ["bugReport.submit", "bugReport.consent"])
  } finally { mounted.dispose() }
})

test("a stale question follows the answer another surface saved first", async () => {
  const mounted = mountReports({ kind: "crash", response: Promise.resolve({ ok: false, kind: "consent-needed", error: AUTOMATIC_REPORTS_OFF_STATUS, reportText: "account-assembled report" }), consent: () => ({ ok: true, automatic: false }) })
  try {
    await mounted.settle()
    mounted.click("Send reports")
    await mounted.settle()
    assert.deepEqual(mounted.mutations.map(mutation => mutation.type), ["bugReport.submit", "bugReport.consent"])
    assert.match(mounted.text(), /No bug report was sent because automatic crash reports are off\./)
  } finally { mounted.dispose() }
})
