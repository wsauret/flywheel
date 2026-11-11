/**
 * Builds the hosted phone page into app/dist: the bootstrap, the Web Push
 * service worker, the page, and the icons. The manifest is not a file: the
 * bootstrap builds it at each load (`install-carry.ts`). Wrangler publishes
 * the directory as static assets, so nothing here runs at the edge.
 *
 * No client is built here. The page loads the phone shell and the client from
 * the machine it is paired with, through the relay, under the identity that
 * machine's build states; every release archive carries that shell beside the
 * editor's and the local page's (`webview/build.ts`).
 */

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { buildWebview } from "../../webview/build.js"
import { stageLegalPayload } from "../../scripts/legal-payload.js"
import { renderAppIcon } from "./icon.js"

const APP = import.meta.dir
const REPO = join(APP, "..", "..")
export const DIST = join(APP, "dist")

export function buildBootstrapBundles(minify: boolean) {
  return buildWebview({
    entrypoints: [join(APP, "bootstrap.ts"), join(APP, "sw", "sw.ts")],
    naming: { entry: "[name].[ext]", asset: "[name].[ext]" },
    outdir: DIST,
    sourcemap: "linked",
    minify,
  })
}

export async function buildApp(options: { readonly version: string; readonly minify?: boolean }): Promise<void> {
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(DIST, { recursive: true })
  await stageLegalPayload(REPO, DIST)
  const built = await buildBootstrapBundles(options.minify ?? false)
  if (!built.success) {
    for (const log of built.logs) process.stderr.write(`${String(log)}\n`)
    throw new Error("the hosted phone page did not build")
  }
  const page = (await Bun.file(join(APP, "index.html")).text()).replace("__VERSION__", options.version)
  await Bun.write(join(DIST, "index.html"), page)
  // `/local` is a page of its own, not a redirect rule: the asset host admits
  // only https targets in a rule, and the hop is to the machine's loopback.
  await Bun.write(join(DIST, "local", "index.html"), Bun.file(join(APP, "local.html")))
  // 180 is what iOS puts on the Home Screen; 192 and 512 are the manifest's.
  for (const size of [180, 192, 512]) {
    await Bun.write(join(DIST, `icon-${size}.png`), await renderAppIcon(size))
  }
}

if (import.meta.main) {
  const version = process.env.FLYWHEEL_APP_VERSION ?? (await Bun.file(join(REPO, "package.json")).json()).version ?? "dev"
  await buildApp({ version, minify: process.argv.includes("--minify") })
  process.stdout.write(`built the hosted phone page into ${DIST}\n`)
}
