import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

import { WEB_MODULES } from "../modules.js"
import { experimentsWeb } from "../modules/experiments/index.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("module-strips-fixture.tsx", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "reactive-solid-with-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Reactive fixture build produced no JavaScript")
const { mountModuleStrips, syntheticStrips }: typeof import("./module-strips-fixture.js") =
  await importBuiltModule(javascript)

describe("module strips", () => {
  test("a strip that throws renders nothing, leaves the composer mounted, and is reported once naming the module", () => {
    const mounted = mountModuleStrips([syntheticStrips("development").broken, syntheticStrips("development").working])
    assert.equal(mounted.text(), "strip for chat-1composer")
    assert.deepEqual(mounted.reports, ["development: strip exploded"])
    mounted.dispose()
  })
})

describe("web module registry", () => {
  test("the experiments home registers its strip and the dashboard surface", () => {
    assert.ok(WEB_MODULES.includes(experimentsWeb))
    assert.equal(typeof experimentsWeb.strip, "function")
    assert.deepEqual(experimentsWeb.surfaces.map((surface) => surface.id), ["experiment-dashboard"])
  })
})
