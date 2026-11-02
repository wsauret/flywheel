import assert from "node:assert/strict"
import { test } from "node:test"

import { loadBudgetRenderFixture } from "../budget-render-test-loader.js"

test("Status retains its focused Runtime button and reconnects only while currently eligible", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusBudget()
  try {
    await mounted.settle()
    assert.match(mounted.runtimeText(), /answering/)
    const row = mounted.runtimeRow()
    assert.equal(row?.tag, "button")
    assert.ok(row)
    row.focus()
    const click = row?.properties.onClick
    assert.equal(typeof click, "function")
    let expected = 0
    for (const health of [
      { kind: "healthy" },
      { kind: "faulted", since: 1 },
      { kind: "healthy" },
      { kind: "restarting", since: 1, cause: "replacement" },
      { kind: "recovery_failed" },
      { kind: "crash_loop", cause: "hub stopped" },
    ] as const) {
      mounted.setHealth(health)
      assert.equal(mounted.runtimeRow(), row)
      assert.equal(row.ownerDocument.activeElement, row)
      assert.equal(row.properties["aria-disabled"], health.kind !== "faulted" || undefined)
      if (typeof click === "function") click()
      if (health.kind === "faulted") expected++
      assert.equal(mounted.reconnects(), expected)
    }
  } finally {
    mounted.dispose()
  }
})

test("Status gives a lost runtime and a failed recovery the same fault tone, and a restart a warning", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusBudget()
  try {
    await mounted.settle()
    assert.equal(mounted.runtimeTone(), "ok")
    mounted.setHealth({ kind: "faulted", since: 1 })
    const lost = mounted.runtimeTone()
    mounted.setHealth({ kind: "recovery_failed" })
    assert.equal(mounted.runtimeTone(), lost)
    assert.equal(lost, "error")
    mounted.setHealth({ kind: "restarting", since: 1, cause: "stopped by signal SIGKILL" })
    assert.equal(mounted.runtimeTone(), "warn")
  } finally {
    mounted.dispose()
  }
})

test("Status shows a runtime restarting its process as answering, with a plain note and nothing to click", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusBudget()
  try {
    await mounted.settle()
    mounted.setHealth({ kind: "restarting", since: 1, cause: "stopped by signal SIGKILL" })
    assert.doesNotMatch(mounted.runtimeText(), /not answering/)
    assert.match(mounted.runtimeText(), /answering/)
    assert.match(mounted.runtimeText(), /Restarting this project's process/)
    assert.equal(mounted.runtimeRow()?.properties["aria-disabled"], true)

    mounted.setHealth({ kind: "recovery_failed", cause: "some commands it started did not stop" })
    assert.doesNotMatch(mounted.runtimeText(), /not answering/)
    assert.match(mounted.runtimeText(), /Could not restore this project's sessions/)
    assert.equal(mounted.runtimeRow()?.properties["aria-disabled"], true)
  } finally {
    mounted.dispose()
  }
})

test("Status shows a background service that keeps stopping as answering, with a warning, a plain note, and nothing to click", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusBudget()
  try {
    await mounted.settle()
    mounted.setHealth({ kind: "crash_loop", cause: "the hub stopped" })
    assert.doesNotMatch(mounted.runtimeText(), /not answering/)
    assert.match(mounted.runtimeText(), /The background service keeps stopping soon after it starts/)
    assert.equal(mounted.runtimeTone(), "warn")
    assert.equal(mounted.runtimeRow()?.properties["aria-disabled"], true)
  } finally {
    mounted.dispose()
  }
})

test("Status lists each role with its assigned model", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusBudget()
  try {
    await mounted.settle()
    assert.match(mounted.rolesText(), /chat: chat-model/)
    assert.doesNotMatch(mounted.rolesText(), /undefined/)
  } finally {
    mounted.dispose()
  }
})

test("Status names one version, the runtime's, because the runtime serves this client", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusBudget()
  try {
    await mounted.settle()
    assert.match(mounted.text(), /VersionFlywheel test/)
    assert.doesNotMatch(mounted.text(), /Client version|Runtime version/)
  } finally {
    mounted.dispose()
  }
})
