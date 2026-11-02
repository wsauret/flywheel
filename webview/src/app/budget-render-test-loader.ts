import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"
import { fileURLToPath } from "node:url"

let loaded: Promise<typeof import("./budget-render-fixture.js")> | undefined

export function loadBudgetRenderFixture(): Promise<typeof import("./budget-render-fixture.js")> {
  loaded ??= buildMemoryHostFixture(new URL("budget-render-fixture.tsx", import.meta.url))
  return loaded
}

/** Builds a fixture entrypoint against the shared Solid memory renderer. Import failures propagate. */
export async function buildMemoryHostFixture(entrypoint: URL) {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(entrypoint)],
    target: "bun",
    conditions: ["browser"],
    format: "esm",
    plugins: [{
      name: "budget-memory-host",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
        builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
      },
    }],
  })
  if (!result.success) throw new Error(result.logs.map(String).join("\n"))
  const output = result.outputs.find((candidate) => candidate.kind === "entry-point")
  if (!output) throw new Error("Budget fixture build produced no JavaScript")
  return await importBuiltModule(output)
}
