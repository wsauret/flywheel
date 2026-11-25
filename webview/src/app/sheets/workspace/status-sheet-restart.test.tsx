import assert from "node:assert/strict"
import { test } from "node:test"

import { RESTART_CONFIRMATION, RESTART_NO_STARTER_REASON, restartReadinessUnknownReason } from "../../../../../src/protocol/client/runtime/service-restart-copy.js"
import { loadBudgetRenderFixture } from "../../../test-support/budget-render-test-loader.js"

const READY = { kind: "ready", serviceStart: "start-1" } as const

test("Restart, a row of its own, asks once, stays Restarting through a reattach to the same service, and settles on the successor", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusRestart(READY)
  try {
    await mounted.settle()
    // The client has no update view yet, and the row is still there.
    const row = mounted.row()
    const status = mounted.statusNode()
    assert.equal(row?.tag, "button")
    assert.equal(row?.properties["aria-disabled"], undefined)
    // Restart and Updates are two controls, and neither holds another.
    assert.equal(mounted.updatesRow()?.tag, "button")
    assert.notEqual(mounted.updatesRow(), row)
    assert.deepEqual(mounted.nestedControls(), [])

    mounted.tap()
    await mounted.settle()
    assert.deepEqual(mounted.confirmations, [RESTART_CONFIRMATION])
    assert.equal(mounted.restarts(), 1)
    assert.match(mounted.status(), /^Restarting/)
    assert.equal(row?.properties["aria-busy"], true)

    mounted.answer({ ok: true })
    await mounted.settle()
    // A network drop while running work still holds the restart reattaches
    // to the same service, which is not its successor.
    mounted.setConnection("recovering")
    mounted.setConnection("connected")
    await mounted.settle()
    assert.match(mounted.status(), /^Restarting/)

    mounted.setConnection("recovering")
    mounted.setReadiness({ kind: "ready", serviceStart: "start-2" })
    mounted.setConnection("connected")
    await mounted.settle()
    assert.doesNotMatch(mounted.status(), /Restarting|Could not/)
    assert.equal(row?.properties["aria-busy"], undefined)
    // One row and one status line through every state.
    assert.equal(mounted.row(), row)
    assert.equal(mounted.statusNode(), status)
  } finally {
    mounted.dispose()
  }
})

test("Restart that the runtime refuses keeps the client and says why in the same row", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusRestart(READY)
  try {
    await mounted.settle()
    const status = mounted.statusNode()
    mounted.tap()
    await mounted.settle()
    mounted.answer({ ok: false, error: "the service is shutting down" })
    await mounted.settle()
    assert.equal(mounted.statusNode(), status)
    assert.equal(mounted.status(), "Could not restart: the service is shutting down")
    assert.equal(mounted.row()?.properties["aria-disabled"], undefined)
  } finally {
    mounted.dispose()
  }
})

test("Restart refused because the service lost its starter while the sheet was open becomes unavailable with the reason", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusRestart(READY)
  try {
    await mounted.settle()
    mounted.tap()
    await mounted.settle()
    mounted.setReadiness({ kind: "unavailable", reason: RESTART_NO_STARTER_REASON, serviceStart: "start-1" })
    mounted.answer({ ok: false, error: RESTART_NO_STARTER_REASON })
    await mounted.settle()
    assert.equal(mounted.status(), RESTART_NO_STARTER_REASON)
    assert.equal(mounted.row()?.properties["aria-disabled"], true)
    mounted.tap()
    await mounted.settle()
    assert.equal(mounted.confirmations.length, 1)
  } finally {
    mounted.dispose()
  }
})

test("Restart that the person declines sends nothing", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusRestart(READY)
  try {
    await mounted.settle()
    mounted.decline()
    mounted.tap()
    await mounted.settle()
    assert.equal(mounted.confirmations.length, 1)
    assert.equal(mounted.restarts(), 0)
  } finally {
    mounted.dispose()
  }
})

test("Restart is shown but unavailable, with the reason, when nothing would start the service again", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusRestart({ kind: "unavailable", reason: RESTART_NO_STARTER_REASON, serviceStart: "start-1" })
  try {
    await mounted.settle()
    assert.equal(mounted.row()?.tag, "button")
    assert.equal(mounted.row()?.properties["aria-disabled"], true)
    assert.deepEqual(mounted.nestedControls(), [])
    assert.equal(mounted.status(), RESTART_NO_STARTER_REASON)
    mounted.tap()
    await mounted.settle()
    assert.equal(mounted.confirmations.length, 0)
    assert.equal(mounted.restarts(), 0)
  } finally {
    mounted.dispose()
  }
})

test("Restart is unavailable, with the cause, when the sheet could not read whether a restart would work", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusRestart(new Error("the runtime did not answer"))
  try {
    await mounted.settle()
    assert.equal(mounted.row()?.properties["aria-disabled"], true)
    assert.equal(mounted.status(), restartReadinessUnknownReason("the runtime did not answer"))
  } finally {
    mounted.dispose()
  }
})

test("The Updates row holds its value and its automatic-updates line before the update view arrives, so the view only rewrites them", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusRestart(READY)
  try {
    await mounted.settle()
    const value = mounted.valueNode()
    const autoUpdate = mounted.autoUpdateNode()
    const status = mounted.statusNode()
    assert.ok(value)
    assert.ok(autoUpdate)
    // Before the view arrives, the row claims no update state it does not know.
    assert.equal(mounted.text(value), "")
    mounted.setUpdate({ revision: 1, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "installed", version: "1.5.0" } })
    await mounted.settle()
    assert.equal(mounted.valueNode(), value)
    assert.equal(mounted.autoUpdateNode(), autoUpdate)
    assert.equal(mounted.statusNode(), status)
    assert.equal(mounted.text(value), "1.5.0 installed, restart to use it")
    assert.equal(mounted.text(autoUpdate), "Automatic updates on")
  } finally {
    mounted.dispose()
  }
})
