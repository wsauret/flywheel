import { join } from "node:path"
import solidPlugin from "@opentui/solid/bun-plugin"
import { platformArchForTarget } from "./binary-native-assets.js"
import { patchOpenTuiNativePackageImportFiles, restorePatchedFiles } from "./opentui-native-package-patch.js"

const ROOT = join(import.meta.dir, "..")
const DIST = join(ROOT, "dist")
const platformArch = platformArchForTarget(undefined)

console.log("Patching opentui native-package import...")
const opentuiPatchOriginals = await patchOpenTuiNativePackageImportFiles(ROOT, platformArch)
console.log(`  patched ${opentuiPatchOriginals.size} file(s)`)

const result = await (async () => {
  try {
    return await Bun.build({
      entrypoints: [join(ROOT, "src", "cli", "index.ts")],
      outdir: DIST,
      target: "bun",
      plugins: [solidPlugin],
      conditions: ["browser"],
    })
  } finally {
    await restorePatchedFiles(opentuiPatchOriginals)
  }
})()

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log(`Build complete: ${result.outputs.length} file(s)`)
