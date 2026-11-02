import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { Redacted } from "effect"

import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import type { HostPhase } from "../runtime/host-lifecycle.js"
import { STILL_STARTING_AFTER_MS, statusPage, statusPageHtml, statusReading, stillStartingNotice } from "./status-page.js"

const unavailable = (failure: Extract<HostPhase, { readonly kind: "unavailable" }>["failure"]) => ({ kind: "unavailable", failure }) as const
const actionsOf = (phase: Exclude<HostPhase, { readonly kind: "ready" }>) => statusPage(phase).actions.map((action) => action.id)

describe("the panel while there is no client", () => {
  test("offers only the remedy for each cause", () => {
    assert.deepEqual(actionsOf(unavailable({ kind: "no_folder" })), ["openFolder"])
    assert.deepEqual(actionsOf(unavailable({ kind: "resolve", failure: { kind: "setting_unusable", executable: "/nowhere", detail: "does not exist" } })), ["executableSetting", "log"])
    assert.deepEqual(actionsOf(unavailable({ kind: "start", failure: { kind: "project_root_missing", projectRoot: "/gone" } })), ["projectRootSetting", "log"])
    // An older runtime is updated in a terminal; an older extension is
    // updated in the editor, and installing Flywheel again fixes neither.
    assert.deepEqual(actionsOf(unavailable({ kind: "start", failure: { kind: "protocol_unsupported", version: RUNTIME_PROTOCOL_VERSION - 1, required: RUNTIME_PROTOCOL_VERSION } })), ["installGuide", "retry", "log"])
    assert.deepEqual(actionsOf(unavailable({ kind: "start", failure: { kind: "protocol_unsupported", version: RUNTIME_PROTOCOL_VERSION + 1, required: RUNTIME_PROTOCOL_VERSION } })), ["showExtension", "log"])
    assert.deepEqual(actionsOf(unavailable({ kind: "install", failure: { kind: "fetch_failed", url: "https://install", detail: "offline" } })), ["retry", "installGuide", "log"])
  })

  test("says a setting starts Flywheel on change only where the page offers no retry", () => {
    for (const phase of [
      unavailable({ kind: "resolve", failure: { kind: "setting_unusable", executable: "/nowhere", detail: "does not exist" } }),
      unavailable({ kind: "start", failure: { kind: "project_root_missing", projectRoot: "/gone" } }),
    ]) {
      assert.match(statusPage(phase).body, /starts on its own once the setting changes/)
    }
    assert.doesNotMatch(statusPage(unavailable({ kind: "start", failure: { kind: "exited", code: 1, stderr: "boom" } })).body, /on its own/)
  })

  test("shows progress while the editor installs or starts Flywheel", () => {
    assert.equal(statusPage({ kind: "installing" }).busy, true)
    assert.equal(statusPage({ kind: "starting", label: "Starting account service", since: 1 }).body, "Starting account service")
    assert.match(statusPageHtml(statusPage({ kind: "installing" }), "n"), /role="progressbar"/)
    assert.doesNotMatch(statusPageHtml(statusPage(unavailable({ kind: "no_folder" })), "n"), /progressbar/)
  })

  test("says what a long start waits for and how long, and keeps waiting", () => {
    const page = statusPage({ kind: "starting", label: "Starting account service", since: 1_000 })
    assert.deepEqual(page.waiting, { since: 1_000, notice: "Flywheel is still starting after {waited}. It waits for the step above. The editor keeps waiting and does not stop the start. Show the log lists each step." })
    assert.equal(stillStartingNotice(undefined), "Flywheel is still starting after {waited}. It waits for Flywheel's background service to answer. The editor keeps waiting and does not stop the start. Show the log lists each step.")
    assert.deepEqual(page.actions.map((action) => action.id), ["log"], "nothing offers to cancel the start")
    const html = statusPageHtml(page, "n")
    assert.match(html, new RegExp(`id="waiting" hidden data-since="1000" data-after="${STILL_STARTING_AFTER_MS}"`))
    assert.equal(STILL_STARTING_AFTER_MS, 15_000)
  })

  test("names the cause of a failed start and how to start again", () => {
    assert.match(statusPage(unavailable({ kind: "start", failure: { kind: "exited", code: null, signal: "SIGTERM", stderr: "" } })).body, /^The Flywheel runtime was stopped by signal SIGTERM\.\nChoose Try again/)
    assert.equal(statusPage(unavailable({ kind: "start", failure: { kind: "exited", code: 1, stderr: "Unknown serve option: ensure" } })).body, "The Flywheel runtime exited with code 1.\nUnknown serve option: ensure\nChoose Try again to start Flywheel again. Show the log lists each step the start took.")
  })

  test("escapes the text a setting or a process wrote", () => {
    const html = statusPageHtml(statusPage(unavailable({ kind: "start", failure: { kind: "project_root_missing", projectRoot: "/<script>" } })), "n")
    assert.doesNotMatch(html, /<script>"?\s*does not exist/)
    assert.match(html, /\/&lt;script&gt;/)
  })
})

describe("the status bar reading", () => {
  const ready: HostPhase = {
    kind: "ready",
    runtime: { executable: "/installed/flywheel", version: "0.0.12", source: "launcher" },
    started: { ok: true, target: { socketPath: "/s", projectRoot: "/p", credential: Redacted.make("t") }, service: { pid: 1, lane: "installed", version: "0.0.12", protocolVersion: RUNTIME_PROTOCOL_VERSION } },
  }

  test("names the same cause as the panel", () => {
    const phase = unavailable({ kind: "start", failure: { kind: "project_root_missing", projectRoot: "/gone" } })
    assert.deepEqual(statusReading(phase, undefined), { icon: "error", sentence: statusPage(phase).title })
    assert.deepEqual(statusReading(unavailable({ kind: "no_folder" }), undefined), { icon: "circle-slash", sentence: "Open a folder to use Flywheel" })
  })

  test("stays connected through recovery and changes only for a fault", () => {
    assert.deepEqual(statusReading(ready, { kind: "healthy" }), { icon: "zap", sentence: "Connected to Flywheel 0.0.12" })
    const faulted = statusReading(ready, { kind: "faulted", since: 1, cause: "the account service stopped" })
    assert.notEqual(faulted.icon, "zap")
    assert.doesNotMatch(faulted.sentence, /Reconnecting/i)
  })
})
