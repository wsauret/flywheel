import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("session-copy-interaction-fixture.ts", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "session-copy-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]client-context\.ts$/ }, () => ({
        contents: "export function useClient() { return Reflect.get(globalThis, '__flywheelSessionCopyTestClient') }",
        loader: "js",
      }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Session copy fixture build produced no JavaScript")
const { mountSessionCopyActions }: typeof import("./session-copy-interaction-fixture.js") =
  await importBuiltModule(javascript)

test("session list and command menu copy the exact ID without selecting the row", async () => {
  const mounted = mountSessionCopyActions()
  try {
    mounted.copyRow()
    await mounted.ready()
    mounted.copyCurrent()
    await mounted.ready()

    assert.deepEqual(mounted.writes(), ["session-full-id", "session-full-id"])
    assert.deepEqual(mounted.selected(), [])
    assert.deepEqual(mounted.reports(), [
      { severity: "info", message: "Session ID copied." },
      { severity: "info", message: "Session ID copied." },
    ])
  } finally {
    mounted.dispose()
  }
})

test("the command menu omits current-session copy when no chat is open", () => {
  const mounted = mountSessionCopyActions(null)
  try {
    assert.equal(mounted.hasCurrentCommand(), false)
  } finally {
    mounted.dispose()
  }
})
