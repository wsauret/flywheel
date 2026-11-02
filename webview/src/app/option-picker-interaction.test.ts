import assert from "node:assert/strict"
import { test } from "node:test"
import { jest } from "bun:test"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("option-picker-interaction-fixture.tsx", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{
    name: "option-picker-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]client-context\.ts$/ }, () => ({
        contents: "export function useClient() { return Reflect.get(globalThis, '__flywheelOptionPickerClient') }", loader: "js",
      }))
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find(candidate => candidate.kind === "entry-point")
if (!output) throw new Error("Option picker fixture build produced no JavaScript")
const { mountOptionPickers }: typeof import("./option-picker-interaction-fixture.js") = await importBuiltModule(output)

test("find, more and mention preserve focus on press and perform their action on click", async () => {
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver")
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
    observe() {}
    disconnect() {}
  } })
  jest.useFakeTimers()
  const mounted = mountOptionPickers()
  const flush = async () => {
    jest.runOnlyPendingTimers()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  }
  try {
    mounted.query()
    await flush()
    for (const surface of ["mention", "find", "more"] as const) {
      assert.equal(mounted.press(surface, "onPointerDown"), true)
      assert.equal(mounted.press(surface, "onMouseDown"), true)
      assert.deepEqual(mounted.opened, surface === "more" ? ["entry-1"] : [])
      assert.deepEqual(mounted.pages, [1])
      mounted.press(surface, "onClick")
      await flush()
    }
    assert.deepEqual(mounted.picked, [{ path: "src/app.ts", directory: false }])
    assert.deepEqual(mounted.opened, ["entry-1"])
    assert.deepEqual(mounted.pages, [1, 2])
  } finally {
    mounted.dispose()
    jest.useRealTimers()
    if (originalObserver) Object.defineProperty(globalThis, "ResizeObserver", originalObserver)
    else Reflect.deleteProperty(globalThis, "ResizeObserver")
  }
})
