import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("return-to-latest-fixture.ts", import.meta.url))],
  target: "bun",
  format: "esm",
  plugins: [{
    name: "solid-ssr",
    setup(builder) {
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("ssr"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (javascript === undefined) throw new Error("SSR build produced no JavaScript entry point")
const { renderReturnToLatest }: typeof import("./return-to-latest-fixture.js") = await importBuiltModule(javascript)

describe("return to latest", () => {
  test("shows the latest label before another message arrives", () => {
    const html = renderReturnToLatest(0)
    assert.match(html, />Latest</)
    assert.match(html, /aria-label="Jump to latest"/)
    assert.match(html, /title="Jump to latest"/)
  })

  test("shows exact singular and plural message counts accessibly", () => {
    const singular = renderReturnToLatest(1)
    assert.match(singular, />1 new message</)
    assert.match(singular, /aria-label="1 new message\. Jump to latest"/)
    assert.match(singular, /title="1 new message\. Jump to latest"/)

    const plural = renderReturnToLatest(3)
    assert.match(plural, />3 new messages</)
    assert.match(plural, /aria-label="3 new messages\. Jump to latest"/)
    assert.match(plural, /title="3 new messages\. Jump to latest"/)
  })
})
