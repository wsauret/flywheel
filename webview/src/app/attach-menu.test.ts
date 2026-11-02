import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("attach-menu-fixture.tsx", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{ name: "attach-menu-memory-host", setup(builder) { builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host")) } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Attachment menu fixture build produced no JavaScript")
const { mountAttachMenu }: typeof import("./attach-menu-fixture.js") = await importBuiltModule(javascript)

test("attachment menu presses retain focus and run each action only on click", () => {
  const mounted = mountAttachMenu()
  try {
    for (const [index, action] of ["files", "mention"].entries()) {
      mounted.open()
      assert.equal(mounted.press(index, "onPointerDown"), true)
      assert.equal(mounted.press(index, "onMouseDown"), true)
      assert.equal(mounted.isOpen(), true)
      assert.equal(mounted.ran.length, index)
      mounted.press(index, "onClick")
      assert.equal(mounted.isOpen(), false)
      assert.equal(mounted.ran[index], action)
    }
  } finally { mounted.dispose() }
})

test("Enter, Space and Tab activate the selected attachment menu row", () => {
  const mounted = mountAttachMenu()
  try {
    for (const key of ["Enter", " ", "Tab"]) {
      mounted.open()
      assert.equal(mounted.key("ArrowDown"), true)
      assert.equal(mounted.key(key), true)
      assert.equal(mounted.isOpen(), false)
    }
    assert.deepEqual(mounted.ran, ["mention", "mention", "mention"])
  } finally { mounted.dispose() }
})

test("focused attachment rows own Enter and Space, and navigation stays inside the menu", () => {
  const mounted = mountAttachMenu()
  try {
    for (const key of ["Enter", " "]) {
      mounted.open()
      mounted.press(1, "onFocus")
      assert.equal(mounted.key(key), true)
      assert.equal(mounted.isOpen(), false)
    }
    assert.deepEqual(mounted.ran, ["mention", "mention"])
    mounted.open()
    assert.equal(mounted.key("ArrowUp"), true)
    assert.equal(mounted.key("Escape"), true)
    assert.equal(mounted.isOpen(), false)
    assert.equal(mounted.key("Enter"), false)
  } finally { mounted.dispose() }
})
