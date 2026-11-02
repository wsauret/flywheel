import assert from "node:assert/strict"
import { test } from "node:test"

import { buildMemoryHostFixture } from "../budget-render-test-loader.js"

const { mountShortcutsSheet }: typeof import("./shortcuts-sheet-fixture.js") = await buildMemoryHostFixture(new URL("shortcuts-sheet-fixture.tsx", import.meta.url))

test("the shortcuts sheet that Mod+/ opens says that Escape skips the question at the prompt", () => {
  const sheet = mountShortcutsSheet()
  try {
    assert.equal(sheet.rowText("Skip the question at the prompt"), "Skip the question at the promptEsc")
  } finally { sheet.dispose() }
})
