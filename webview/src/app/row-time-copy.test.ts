import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { transformSolidFixture } from "../test-support/solid-transform.js"

// The build adds the Solid root, the signal, and the memory host to the row-time
// module, so that the test and the component share one Solid runtime.
const rowTime = fileURLToPath(new URL("row-time.tsx", import.meta.url))
const build = await Bun.build({
  entrypoints: [rowTime],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "row-time-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
        const source = await Bun.file(path).text()
        const additions = path === rowTime
          ? '\nexport { createComponent, createRoot, createSignal } from "solid-js"\nexport { createElement, insert, nodes } from "./render-ownership-host-fixture.js"\n'
          : ""
        return { contents: await transformSolidFixture(source + additions, path, "memory-host"), loader: "js" }
      })
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Row time build produced no JavaScript")
const harness: typeof import("./row-time.js")
  & Pick<typeof import("solid-js"), "createComponent" | "createRoot" | "createSignal">
  & Pick<typeof import("./render-ownership-host-fixture.js"), "createElement" | "insert" | "nodes"> =
  await importBuiltModule(javascript)

function message(content: string): FrontendOutputBlock {
  return { kind: "text", id: "answer", content, timestamp: 1_000 }
}

test("a Copy click adds no work to later changes of the row's block", () => {
  const writes: string[] = []
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  // The clipboard write never settles, so copyFrom starts no "Copied" timer.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => { writes.push(text); return new Promise<void>(() => {}) } },
  })
  const mounted = harness.createRoot((dispose) => {
    const [block, setBlock] = harness.createSignal(message("first"))
    let reads = 0
    const root = harness.createElement("root")
    harness.insert(root, harness.createComponent(harness.BlockTime, { get block() { reads += 1; return block() } }))
    const button = harness.nodes(root).find((node) => node.properties["aria-label"] === "Copy message")
    if (button === undefined) throw new Error("Missing Copy button")
    return {
      dispose,
      // A delegated click runs its handler outside every Solid owner, as this call does.
      copy() {
        const click = button.properties.onClick
        if (typeof click !== "function") throw new Error("Missing Copy handler")
        click({ currentTarget: button })
      },
      readsForChange(content: string) {
        const before = reads
        setBlock(message(content))
        return reads - before
      },
    }
  })
  try {
    const baseline = mounted.readsForChange("second")
    for (let click = 0; click < 5; click += 1) mounted.copy()
    assert.deepEqual(writes, ["second", "second", "second", "second", "second"])
    assert.equal(mounted.readsForChange("third"), baseline)
  } finally {
    mounted.dispose()
    if (clipboard === undefined) Reflect.deleteProperty(navigator, "clipboard")
    else Object.defineProperty(navigator, "clipboard", clipboard)
  }
})
