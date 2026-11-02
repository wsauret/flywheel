import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { transformSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("render-ownership-fixture.ts", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "reactive-solid-with-memory-host",
    setup(builder) {
      // Focus trapping belongs to the browser host, not render ownership.
      builder.onLoad({ filter: /[\\/]focus-trap\.ts$/ }, () => ({
        contents: "export function trapFocus() {}",
        loader: "js",
      }))
      builder.onResolve({ filter: /\/markdown\.ts$/ }, () => ({
        path: new URL("markdown.ts", import.meta.url).href,
        external: true,
      }))
      builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
        const source = (await Bun.file(path).text()).replace(/"(\.\.?\/)+markdown\.js"/g, JSON.stringify(new URL("markdown.ts", import.meta.url).href))
        return { contents: await transformSolidFixture(source, path, "memory-host"), loader: "js" }
      })
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Reactive fixture build produced no JavaScript")
export const { reviewWindow, mountToolGroup, mountTurnChanges, mountTimedRows, mountUserMessage, mountTool, mountActivityStatus, mountAgentGroup, mountMarkdown, mountFileDiff, mountChanges, mountReview }: typeof import("./render-ownership-fixture.js") =
  await importBuiltModule(javascript)
