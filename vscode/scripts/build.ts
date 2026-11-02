/**
 * Builds the extension bundle with Bun.build.
 *
 * One bundle: the extension host, which runs in the editor's Node process and
 * gets `vscode` from the host rather than from a bundle. The client it mounts
 * is not built here. The editor shell lives at `webview/editor/`, the
 * runtime's own build (`bun run --cwd webview build`) compiles it beside the
 * binary, and the extension loads it from the runtime's directory at run time,
 * so a package never carries a client that could disagree with the runtime.
 *
 * Usage:
 *   bun run scripts/build.ts                # development build with sourcemaps
 *   bun run scripts/build.ts --production   # minified, no sourcemaps
 */

import { join } from "node:path"
import { releaseRepository } from "../../scripts/release-contract.js"

const ROOT = join(import.meta.dir, "..")
const OUT = join(ROOT, "out")
export async function buildExtension(production: boolean): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", "extension.ts")],
    naming: { entry: "extension.[ext]" },
    target: "node",
    format: "cjs",
    external: ["vscode"],
    outdir: OUT,
    minify: production,
    sourcemap: production ? "none" : "linked",
    // The extension installs Flywheel from this repository: PUBLIC_REPO when
    // the build machine names one, as a fork does, otherwise the official one.
    // It is an installer like install.sh, so every build names a repository.
    define: { "process.env.FLYWHEEL_UPDATE_REPOSITORY": JSON.stringify(releaseRepository(process.env)) },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  for (const output of result.outputs) {
    console.log(`built ${output.path}`)
  }
}

if (import.meta.main) await buildExtension(process.argv.includes("--production"))
