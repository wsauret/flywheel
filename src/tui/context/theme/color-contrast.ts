import { RGBA } from "@opentui/core"
import type { RgbColor } from "./oklab.js"

export const TEXT_MINIMUM_CONTRAST = 4.5

function luminance({ r, g, b }: RgbColor, scale: number, cutoff: number): number {
  const linear = (channel: number) => {
    const value = channel / scale
    return value <= cutoff ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** Relative luminance of normalized OpenTUI channels, using the named-theme cutoff. */
function relativeLuminance(color: RGBA): number {
  return luminance(color, 1, 0.03928)
}

function ratio(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** Contrast of opaque OpenTUI colors. Alpha is not composited. */
export function contrastRatio(foreground: RGBA, background: RGBA): number {
  return ratio(relativeLuminance(foreground), relativeLuminance(background))
}

/** WCAG 2 contrast of opaque sRGB channels in 0..255, including fractional channels. */
export function rgbContrastRatio(first: RgbColor, second: RgbColor): number {
  // System uses the current sRGB cutoff; named themes retain their existing cutoff.
  return ratio(luminance(first, 255, 0.04045), luminance(second, 255, 0.04045))
}

/** Mix normalized channels by `amount` (0..1) and round to opaque byte RGB. */
export function blendToward(color: RGBA, target: RGBA, amount: number): RGBA {
  return RGBA.fromInts(
    Math.round((color.r + (target.r - color.r) * amount) * 255),
    Math.round((color.g + (target.g - color.g) * amount) * 255),
    Math.round((color.b + (target.b - color.b) * amount) * 255),
  )
}

/**
 * Preserve a color that meets the caller's contrast policy; otherwise bisect its paint path 20 times.
 * The path must move monotonically from `start` toward a readable `end`. The caller owns gamut and hue constraints.
 */
export function correctContrast<Color>(
  color: Color,
  meets: (candidate: Color) => boolean,
  paint: (position: number) => Color,
  start: number,
  end: number,
): Color {
  if (meets(color)) return color
  let [low, high] = [start, end]
  for (let index = 0; index < 20; index++) {
    const middle = (low + high) / 2
    if (meets(paint(middle))) high = middle
    else low = middle
  }
  return paint(high)
}
