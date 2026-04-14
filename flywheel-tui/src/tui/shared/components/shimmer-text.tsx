/** @jsxImportSource @opentui/solid */

import { RGBA } from "@opentui/core"
import { useTimeline } from "@opentui/solid"
import { createSignal, type Accessor } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"

export interface ShimmerTextProps {
  text: string
  color?: RGBA
}

const DURATION = 2_500
const WAVE_STEP_MS = 60    // ms between consecutive chars lighting up (wave speed)
const CHAR_ANIM_MS = 100   // how long each character's brightness pulse lasts
const MAX_CHARS = 32

export function ShimmerText(props: ShimmerTextProps) {
  const themeCtx = useTheme()

  const color = () => props.color ?? themeCtx.theme.info

  // Pre-allocate shimmer signals for the max length we'll see.
  // The text may change (e.g., elapsed time ticking) — we reuse signals
  // and only render up to the current text length.
  const shimmerSignals: Accessor<number>[] = []

  const timeline = useTimeline({
    duration: DURATION,
    loop: true,
  })

  for (let i = 0; i < MAX_CHARS; i++) {
    const [shimmer, setShimmer] = createSignal(0)
    const target = { shimmer: shimmer(), setShimmer }

    timeline!.add(
      target,
      {
        shimmer: 1,
        duration: CHAR_ANIM_MS,
        ease: "linear",
        alternate: true,
        loop: 2,
        onUpdate: () => { target.setShimmer(target.shimmer) },
      },
      i * WAVE_STEP_MS,
    )

    shimmerSignals.push(shimmer)
  }

  return (
    <text>
      {(() => {
        const chars = props.text.split("")
        const c = color()
        const baseR = c.r * 255
        const baseG = c.g * 255
        const baseB = c.b * 255
        const DIM = 0.7   // base brightness multiplier
        const BRIGHT = 1.15 // peak brightness (lerps toward white)
        return chars.map((ch, i) => {
          const shimmer = shimmerSignals[i] ?? (() => 0)
          const t = shimmer()
          const scale = DIM + t * (BRIGHT - DIM)
          const r = Math.min(255, baseR * scale)
          const g = Math.min(255, baseG * scale)
          const b = Math.min(255, baseB * scale)
          const fg = RGBA.fromInts(r, g, b, 255)
          return <span style={{ fg }}>{ch}</span>
        })
      })()}
    </text>
  )
}
