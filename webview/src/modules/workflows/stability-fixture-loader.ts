import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"

/** Compiles the stability fixtures with the client's browser Solid exports and a memory host. */
export async function loadStabilityFixture(): Promise<typeof import("./stability-fixture.js")> {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("stability-fixture.tsx", import.meta.url))],
    target: "bun",
    conditions: ["browser"],
    format: "esm",
    plugins: [{
      name: "stability-memory-host",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
        builder.onLoad({ filter: /[\\/]client-context\.ts$/ }, () => ({
          contents: "export function useClient() { return Reflect.get(globalThis, '__flywheelStabilityTestClient') }",
          loader: "js",
        }))
        builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
      },
    }],
  })
  if (!build.success) throw new Error(build.logs.map(String).join("\n"))
  const output = build.outputs.find((candidate) => candidate.kind === "entry-point")
  if (!output) throw new Error("Stability fixture build produced no JavaScript")
  return importBuiltModule(output)
}
