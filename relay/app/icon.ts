/**
 * Renders the phone app's Home Screen icon from the shared brand tile.
 *
 * The drawing lives in the client core so the launcher icon, the marketplace
 * icon, and the client's own loading screen are one image. This file only
 * rasterises it, which is the one step a browser cannot do for a launcher.
 */

import sharp from "sharp"

import { brandTileSvg, type BrandTileOptions } from "../../src/protocol/client/brand.js"

/** One tile at `size` pixels, as PNG bytes. A launcher rounds the corners
 *  itself, so the default is a full-bleed square; a surface that shows the
 *  PNG as it is, like the editor marketplace, asks for the rounding in the
 *  drawing, which the SVG clip becomes transparent alpha. */
export async function renderAppIcon(size: number, corners: BrandTileOptions["corners"] = "square"): Promise<Buffer> {
  return sharp(Buffer.from(brandTileSvg(size, { corners }))).png().toBuffer()
}
