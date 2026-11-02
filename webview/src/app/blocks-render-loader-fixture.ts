import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../../test-support/web-blocks-render.ts", import.meta.url))],
  target: "bun",
  format: "esm",
  plugins: [{ name: "solid-ssr", setup(builder) { builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("ssr")) } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (javascript === undefined) throw new Error("SSR build produced no JavaScript entry point")
export const rendered: typeof import("../../test-support/web-blocks-render.js") = await importBuiltModule(javascript)
