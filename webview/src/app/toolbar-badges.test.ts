import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("toolbar-badges-fixture.ts", import.meta.url))],
  target: "bun",
  format: "esm",
  plugins: [{
    name: "solid-ssr",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("ssr"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (javascript === undefined) throw new Error("SSR build produced no JavaScript entry point")
const { renderToolbarBadges, syntheticBadges }: typeof import("./toolbar-badges-fixture.js") = await importBuiltModule(javascript)

const EMPTY = { papercuts: null, definitionStaleness: null, experiment_view: null, mcp: null, project_notifications: null, remote: null, "side-question": null, "side-question-request": null, workflow_detail: null, workflow_view: null, workflow_live: null }

describe("toolbar badges", () => {
  test("a synthetic module's badge renders after the kernel controls with its count, noun, tone, and action, with no host edit", () => {
    const { html, reports } = renderToolbarBadges([syntheticBadges("development").working], EMPTY)
    assert.match(html, /toolbar-badge-warning/)
    assert.match(html, /title="3 benches"/)
    assert.match(html, /<span class="toolbar-badge-count">3<\/span>/)
    assert.match(html, /benches/)
    assert.deepEqual(reports, [])
  })

  test("a selector that throws contributes no badge and is reported once naming the module", () => {
    const { html, reports } = renderToolbarBadges([syntheticBadges("development").broken, syntheticBadges("development").working], EMPTY)
    assert.match(html, /3 benches/)
    assert.deepEqual(reports, ["development: badge exploded"])
  })
})
