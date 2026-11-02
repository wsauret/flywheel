import { linearSrgbToRgb, oklabToLinearSrgb, rgbToOklab, type RgbColor } from "./oklab.js"

interface OklchChannels { l: number; c: number; h: number }

function isInSrgbGamut(linear: number[]): boolean {
  const epsilon = 1e-7
  return linear.every((channel) => channel >= -epsilon && channel <= 1 + epsilon)
}

export function oklchToRgb({ l, c, h }: OklchChannels): RgbColor {
  // Gamut mapping keeps the hue fixed, so its direction is computed once and scaled by chroma.
  const radians = (h * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const atChroma = (chroma: number) => oklabToLinearSrgb([l, chroma * cos, chroma * sin])

  const direct = atChroma(c)
  if (isInSrgbGamut(direct)) return linearSrgbToRgb(direct)

  // Reduce chroma until the color fits. The achromatic color is always in gamut, so it is the
  // fallback when no bisection step fits, e.g. `oklch(100% 0.3 150)` must map to white.
  let linear = atChroma(0)
  let low = 0
  let high = c
  for (let index = 0; index < 20; index++) {
    const chroma = (low + high) / 2
    const candidate = atChroma(chroma)
    if (isInSrgbGamut(candidate)) {
      low = chroma
      linear = candidate
    } else {
      high = chroma
    }
  }
  return linearSrgbToRgb(linear)
}


export function rgbToOklch(color: RgbColor): OklchChannels {
 const [l, a, b] = rgbToOklab(color)
 return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }
}
