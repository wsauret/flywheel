import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("sheet-field-fixture.ts", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "sheet-field-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]client-context\.ts$/ }, () => ({
        contents: "export function useClient() { return Reflect.get(globalThis, '__flywheelSheetFieldTestClient') }",
        loader: "js",
      }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Sheet field fixture build produced no JavaScript")
const { mountSheetField }: typeof import("./sheet-field-fixture.js") = await importBuiltModule(javascript)

// A field that unmounts mid-edit still settles the draft. Its teardown reads no
// props: Solid answers a read of a pending memo by first running the memo's
// stale owners, and in a teardown one of them can be the owner disposing the field.
test("a field that unmounts mid-edit saves the typed draft without reading its props", async () => {
  const mounted = mountSheetField()
  mounted.open()
  await mounted.ready()
  mounted.type("New")
  mounted.dispose()
  assert.deepEqual(mounted.commits, ["New"])
  assert.deepEqual(mounted.teardownReads, [])
})

test("a field that unmounts with an invalid draft reports it without reading its props", async () => {
  const mounted = mountSheetField()
  mounted.open()
  await mounted.ready()
  mounted.type(" ")
  mounted.dispose()
  assert.deepEqual(mounted.commits, [])
  assert.deepEqual(mounted.reports, ["Name: Enter a name."])
  assert.deepEqual(mounted.teardownReads, [])
})
