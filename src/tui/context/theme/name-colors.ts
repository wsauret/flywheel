import { RGBA } from "@opentui/core"
import { oklchToRgb, rgbToOklch } from "./oklch.js"

/** Below this gap in perceptual hue, a name reads as the colour of a state. */
const NAME_HUE_GAP = 40
/** Below this perceptual chroma, a colour reads as a gray and has no hue. */
const GRAY_CHROMA = 0.03
/** The least chroma that a derived name colour takes, so that it reads as a
 *  colour and not as muted text. */
const NAME_CHROMA = 0.1
/** The hues that a derived name colour starts from: violet for a phase and
 *  teal for an agent, as the web client draws them. */
const PHASE_NAME_HUE = 305
const AGENT_NAME_HUE = 185

/** The theme colours that the name colours derive from. */
interface NameSources {
  readonly secondary: RGBA
  readonly accent: RGBA
  readonly primary: RGBA
  readonly success: RGBA
  readonly error: RGBA
  readonly warning: RGBA
}

/** The colours of a phase's name and an agent's name. */
interface WorkflowNameColors {
  readonly phaseName: RGBA
  readonly agentName: RGBA
}

/** The two colours of the names on a workflow surface: `phaseName` for a
 *  phase and `agentName` for an agent. Each is the theme's own colour,
 *  `secondary` and `accent`, while its hue reads apart from every state of
 *  an agent (running `primary`, done `success`, failed `error`, and
 *  interrupted `warning`) and from the other name. Otherwise it takes the
 *  lightness of the theme's own colour at the hue nearest violet or teal
 *  that reads apart from them. */
export function workflowNameColors(theme: NameSources): WorkflowNameColors {
  const states = [theme.primary, theme.success, theme.error, theme.warning]
  const phaseName = nameColor(theme.secondary, PHASE_NAME_HUE, states)
  return { phaseName, agentName: nameColor(theme.accent, AGENT_NAME_HUE, [...states, phaseName]) }
}

function perceptual(color: RGBA) {
  return rgbToOklch({ r: color.r * 255, g: color.g * 255, b: color.b * 255 })
}

function hueGap(a: number, b: number): number {
  const gap = Math.abs(a - b) % 360
  return Math.min(gap, 360 - gap)
}

function nameColor(own: RGBA, home: number, avoid: readonly RGBA[]): RGBA {
  const hues = avoid.map(perceptual).filter(({ c }) => c >= GRAY_CHROMA).map(({ h }) => h)
  const apart = (hue: number) => hues.every((other) => hueGap(hue, other) >= NAME_HUE_GAP)
  const source = perceptual(own)
  if (source.c >= GRAY_CHROMA && apart(source.h)) return own
  // The nearest hue to `home` that reads apart, searched outward on both
  // sides. When no hue reads apart from all of them, the name keeps `home`.
  for (let step = 0; step <= 180; step += 5) {
    for (const hue of [home + step, home - step]) {
      const at = (hue + 360) % 360
      if (apart(at)) return paint({ l: source.l, c: Math.max(source.c, NAME_CHROMA), h: at })
    }
  }
  return paint({ l: source.l, c: Math.max(source.c, NAME_CHROMA), h: home })
}

function paint(channels: { readonly l: number; readonly c: number; readonly h: number }): RGBA {
  const rgb = oklchToRgb(channels)
  return RGBA.fromInts(Math.round(rgb.r), Math.round(rgb.g), Math.round(rgb.b))
}
