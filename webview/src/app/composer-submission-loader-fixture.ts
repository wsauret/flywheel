import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("composer-submission-fixture.tsx", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{
    name: "composer-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Composer fixture build produced no JavaScript")
export const { mountComposerSubmission }: typeof import("./composer-submission-fixture.js") = await importBuiltModule(javascript)
