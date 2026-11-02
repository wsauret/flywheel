/**
 * Writes the checked-in icons from the shared brand drawing: the editor's
 * activity bar glyph as an SVG asset, the editor's marketplace tile as a PNG,
 * and the website's favicon as the same tile the web client shows in its tab.
 *
 * They are checked in because the extension manifest and the website name
 * files, and they are generated because a drawing copied by hand drifts. The
 * marketplace shows its PNG as it is, so that one carries its rounding in its
 * own alpha.
 */

import { join, resolve } from "node:path"

import { renderAppIcon } from "../../relay/app/icon.js"
import { brandTileSvg, flywheelMarkSvg } from "../../src/protocol/client/brand.js"

const ROOT = resolve(import.meta.dir, "..")
const SIZE = 128
const FAVICON_SIZE = 64

await Bun.write(join(ROOT, "assets", "flywheel.svg"), flywheelMarkSvg())
await Bun.write(join(ROOT, "assets", "icon.png"), await renderAppIcon(SIZE, "rounded"))
await Bun.write(join(ROOT, "..", "website", "public", "favicon.svg"), brandTileSvg(FAVICON_SIZE, { corners: "rounded" }))
console.log(`wrote assets/flywheel.svg and assets/icon.png at ${SIZE}x${SIZE}, and website/public/favicon.svg at ${FAVICON_SIZE}x${FAVICON_SIZE}`)
