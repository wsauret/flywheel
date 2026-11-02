import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

/** Compiles mounted row fixtures with the client's browser Solid exports. */
export async function loadSemanticRows(): Promise<typeof import("./semantic-rows-fixture.js")> {
  return loadSemanticRowsFixture(new URL("semantic-rows-fixture.tsx", import.meta.url))
}

/** Compiles a module-owned fixture with the same client and memory-host boundary. */
export async function loadSemanticRowsFixture<T>(entrypoint: URL): Promise<T> {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(entrypoint)],
    target: "bun", conditions: ["browser"], format: "esm",
    plugins: [{
      name: "semantic-row-memory-host",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]client-context\.ts$/ }, () => ({ contents: "export function useClient() { return Reflect.get(globalThis, '__flywheelSemanticRowsClient') }", loader: "js" }))
        builder.onLoad({ filter: /webview[\\/]src[\\/]modules\.ts$/ }, () => ({ contents: "export const WEB_MODULES = []", loader: "js" }))
        builder.onLoad({ filter: /[\\/]focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
        builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
      },
    }],
  })
  if (!build.success) throw new Error(build.logs.map(String).join("\n"))
  const output = build.outputs.find(entry => entry.kind === "entry-point")
  if (!output) throw new Error("Missing semantic row fixture")
  return importBuiltModule(output)
}
