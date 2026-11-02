import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

import type { ModuleRow } from "../../../src/protocol/protocol-module.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("module-rows-fixture.ts", import.meta.url))],
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
const { renderIntroCard, renderRowHosts }: typeof import("./module-rows-fixture.js") = await importBuiltModule(javascript)

/** The rows the terminal card and modal tests render, so both clients are
 *  checked against one description. */
const ROWS: readonly ModuleRow[] = [
  { id: "papercuts", label: "papercuts", value: "10 logged", action: { kind: "command", id: "papercuts" } },
  { id: "definition-overrides", label: "overrides", value: "2 with upstream updates", hint: "ask to review them" },
  { id: "synthetic", label: "bench", value: "1 failing", tone: "warning" },
]

describe("web row hosts", () => {
  test("the intro card renders the registry's rows after the kernel rows from the frame's module views", () => {
    const { html } = renderIntroCard({
      papercuts: { undisposedCount: 12 },
      definitionStaleness: { overrides: [], diagnostics: [], reviewCount: 1 },
      experiment_view: null, mcp: null,
      project_notifications: [], remote: null, "side-question": null, "side-question-request": null,
      workflow_detail: null, workflow_live: null, workflow_view: null,
    })
    assert.match(html, /<dt>papercuts<\/dt>/)
    assert.match(html, /12 logged/)
    assert.match(html, /\/papercuts/)
    assert.match(html, /<dt>overrides<\/dt>/)
    assert.match(html, /1 with upstream updates/)
    assert.match(html, /ask to review them/)
    assert.ok(html.indexOf("Flywheel") < html.indexOf("papercuts"))
  })

  test("the intro card names the connected backend, and its build only when Show build is on", () => {
    const empty = { papercuts: null, definitionStaleness: null, experiment_view: null, mcp: null, project_notifications: null, remote: null, "side-question": null, "side-question-request": null, workflow_detail: null, workflow_live: null, workflow_view: null }
    assert.doesNotMatch(renderIntroCard(empty).html, /1\.0\.0|\(v/)
    assert.match(renderIntroCard(empty, { runtimeVersion: "0.0.10", runtimeBuildId: "3029f1abdeadbeef" }).html, /\(v0\.0\.10\)/)
    assert.match(renderIntroCard(empty, { runtimeVersion: "0.0.10", runtimeBuildId: "3029f1abdeadbeef", showBuild: true }).html, /\(v0\.0\.10 build 3029f1ab\)/)
    assert.match(renderIntroCard(empty, { runtimeVersion: "0.0.10", runtimeBuildId: null, showBuild: true }).html, /\(v0\.0\.10 build unavailable\)/)
  })

  test("a view that has not landed contributes no row", () => {
    const { html } = renderIntroCard({ papercuts: null, definitionStaleness: null, experiment_view: null, mcp: null, project_notifications: null, remote: null, "side-question": null, "side-question-request": null, workflow_detail: null, workflow_live: null, workflow_view: null })
    assert.doesNotMatch(html, /papercuts/)
    assert.doesNotMatch(html, /overrides/)
  })

  test("both hosts render one row description with the same labels, values, and actions", () => {
    const { intro, status } = renderRowHosts(ROWS)
    for (const row of ROWS) {
      assert.match(intro, new RegExp(row.label))
      assert.match(status, new RegExp(row.label))
      assert.match(intro, new RegExp(row.value))
      assert.match(status, new RegExp(row.value))
    }
    assert.match(intro, /\/papercuts/)
    assert.match(status, /sheet-row-button/, "the actionable row is a button in the sheet")
    assert.match(intro, /tone-warn/)
    assert.match(status, /tone-warn/)
    assert.match(intro, /ask to review them/)
    assert.match(status, /sheet-row-detail[^>]*>ask to review them/)
  })
})
