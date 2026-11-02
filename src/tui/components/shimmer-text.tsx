/** @jsxImportSource @opentui/solid */

import type { RGBA } from "@opentui/core"
import { useTimeline } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { blendToward } from "@tui/context/theme/color-contrast.js"
import { type Accessor, createSignal } from "solid-js"

interface ShimmerTextProps {
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
  // The text may change (e.g., elapsed time ticking); we reuse signals
  // and only render up to the current text length.
  const shimmerSignals: Accessor<number>[] = []

  const timeline = useTimeline({
    duration: DURATION,
    loop: true,
  })

  for (let i = 0; i < MAX_CHARS; i++) {
    const [shimmer, setShimmer] = createSignal(0)
    // eslint-disable-next-line solid/reactivity -- shimmer read is for timeline target initialization, not reactive tracking
    const target = { shimmer: shimmer(), setShimmer }

    timeline?.add(
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

    // eslint-disable-next-line solid/reactivity -- collecting accessor references, not reading them
    shimmerSignals.push(shimmer)
  }

  return (
    <text>
      {(() => {
        const chars = props.text.split("")
        const c = color()
        return chars.map((ch, i) => {
          const shimmer = shimmerSignals[i] ?? (() => 0)
          const t = shimmer()
          const fg = blendToward(c, themeCtx.theme.textBright, t * 0.35)
          return <span style={{ fg }}>{ch}</span>
        })
      })()}
    </text>
  )
}
