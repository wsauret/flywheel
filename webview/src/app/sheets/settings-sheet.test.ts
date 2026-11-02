import assert from "node:assert/strict"
import { test } from "node:test"
import { SETTING_ROWS, shownOn } from "../../../../src/protocol/setting-catalog.js"
import { loadStabilityFixture } from "../../modules/workflows/stability-fixture-loader.js"

const fixture = await loadStabilityFixture()

test("Settings shows every catalog row the browser shows, by its catalog name and in catalog order", async () => {
  const mounted = fixture.mountModuleSheetIdentity("settings", { ids: ["remote", "mcp"], views: { mcp: [] } })
  try {
    await mounted.ready()
    const catalog: readonly string[] = SETTING_ROWS.filter((row) => shownOn(row, "browser")).map((row) => row.label)
    const shown = mounted.rowLabels()
    assert.deepEqual(shown.filter((label) => catalog.includes(label)), catalog)
    for (const terminalOnly of SETTING_ROWS.filter((row) => !shownOn(row, "browser"))) assert.ok(!shown.includes(terminalOnly.label))
  } finally {
    mounted.dispose()
  }
})
