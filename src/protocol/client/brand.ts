/**
 * Flywheel's mark and the tile it sits on, as one drawing every surface shares.
 *
 * The mark is a spiral spinning up from its hub, which is what a flywheel
 * does. It is drawn once here in a 24-unit box; the editor's activity bar
 * takes it as a hairline glyph in the theme's colour, the web client draws it
 * inline, and the tile below re-weights it for an icon. Two drawings that
 * drift apart is a small thing that reads as carelessness, so nothing else
 * holds the geometry.
 *
 * The tile is the Home Screen icon, the marketplace icon, and the client's
 * loading screen: a lit indigo square with the mark raised off it. A launcher
 * rounds the corners itself, and a surface that shows the drawing as it is
 * asks for the rounding in the drawing.
 */

/** The mark's paths, without a size or a colour: stroke and fill come from
 *  whatever wraps them. The hub is the one filled shape. */
export const FLYWHEEL_MARK_PATHS = `<path d="M12 3.4a8.6 8.6 0 1 1 -8.6 8.6"/>
<path d="M12 7.6a4.4 4.4 0 1 1 -4.4 4.4" opacity="0.7"/>
<circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>`

/** The standalone hairline glyph the editor's activity bar shows: it inherits
 *  its colour and sits at 24 pixels. */
export function flywheelMarkSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
${FLYWHEEL_MARK_PATHS}
</svg>
`
}

/** The share of the tile the mark's 24-unit drawing box spans. The spiral's
 *  outer arc, stroke included, reaches 20.2 of those units, so at this scale
 *  it covers about 74% of the tile: the margin the ChatGPT and Claude marks
 *  keep from their edges, with a little more because an open arc reads
 *  smaller than the closed shapes beside it. */
const MARK_SCALE = 0.88

/** Indigo: distinct from the blue tiles a Home Screen collects, and the
 *  client's accent blue sits comfortably inside the same family. */
const GROUND = { from: "#6f66e6", to: "#2b2680" }

/** The corner radius iOS applies, as a share of the tile. */
const CORNER_RADIUS = 0.2237

export interface BrandTileOptions {
  /** `square` for a launcher that rounds the tile itself; `rounded` for a
   *  surface that shows the drawing as it is. */
  readonly corners?: "square" | "rounded"
  /** A class for the group that carries the mark and its shadow, so a
   *  stylesheet can set the mark turning while the tile stays still. */
  readonly markClass?: string
}

/** One tile at `size` pixels, as an SVG document.
 *
 *  Light falls from above: a sheen across the top, shade gathering at the
 *  bottom, a rim that is bright where it faces the light and dark where it
 *  turns away with its own shadow just inside it, and the mark raised off the
 *  ground by a blur beneath it. Everything is a gradient or a blur, never a
 *  hard edge, because the launcher's corner mask does not follow a crisp inset
 *  frame. */
export function brandTileSvg(size: number, options: BrandTileOptions = {}): string {
  const markSize = size * MARK_SCALE
  const offset = (size - markSize) / 2
  const unit = size / 100
  const radius = size * CORNER_RADIUS
  const markClass = options.markClass === undefined ? "" : ` class="${options.markClass}"`
  const glyph = FLYWHEEL_MARK_PATHS.replaceAll('fill="currentColor"', 'fill="url(#glyph)"')
  const shadow = FLYWHEEL_MARK_PATHS.replaceAll('fill="currentColor"', 'fill="#000000" fill-opacity="0.35"')
  const clip = options.corners === "rounded" ? ` clip-path="url(#corners)"` : ""
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${GROUND.from}"/>
      <stop offset="1" stop-color="${GROUND.to}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.3"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.45" r="0.75">
      <stop offset="0.6" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.22"/>
    </radialGradient>
    <linearGradient id="glyph" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#dcd9ff"/>
    </linearGradient>
    <linearGradient id="rim-light" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.14"/>
    </linearGradient>
    <linearGradient id="rim-dark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000" stop-opacity="0.04"/>
      <stop offset="0.6" stop-color="#000000" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.5"/>
    </linearGradient>
    <filter id="rim" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="${unit * 0.35}"/>
    </filter>
    <filter id="rim-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="${unit * 1.1}"/>
    </filter>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="160%">
      <feGaussianBlur stdDeviation="${unit * 2.2}"/>
    </filter>
    <clipPath id="corners"><rect width="${size}" height="${size}" rx="${radius}"/></clipPath>
  </defs>
  <g${clip}>
    <rect width="${size}" height="${size}" fill="url(#ground)"/>
    <rect width="${size}" height="${size}" fill="url(#vignette)"/>
    <rect width="${size}" height="${size}" fill="url(#sheen)"/>
    <rect width="${size}" height="${size}" fill="url(#shade)"/>
    <rect x="${unit * 3}" y="${unit * 3}" width="${size - unit * 6}" height="${size - unit * 6}" rx="${radius - unit * 2}" fill="none" stroke="url(#rim-dark)" stroke-width="${unit * 2.4}" filter="url(#rim-shadow)"/>
    <rect x="${unit * 0.9}" y="${unit * 0.9}" width="${size - unit * 1.8}" height="${size - unit * 1.8}" rx="${radius}" fill="none" stroke="url(#rim-light)" stroke-width="${unit * 1.8}" filter="url(#rim)"/>
    <g${markClass}>
      <g transform="translate(${offset} ${offset + unit * 2.5}) scale(${markSize / 24})" fill="none" stroke="#000000" stroke-opacity="0.35" stroke-width="3" stroke-linecap="round" filter="url(#lift)">
        ${shadow}
      </g>
      <g transform="translate(${offset} ${offset}) scale(${markSize / 24})" fill="none" stroke="url(#glyph)" stroke-width="3" stroke-linecap="round">
        ${glyph}
      </g>
    </g>
  </g>
</svg>`
}
