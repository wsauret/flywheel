/** @jsxImportSource @opentui/solid */
/**
 * Shimmer Text Component
 * Ported from: src/ui/components/ShimmerText.tsx
 *
 * Animated shimmer text with wave effect using OpenTUI's useTimeline
 */

import { RGBA } from "@opentui/core"
import { useTimeline } from "@opentui/solid"
import { createSignal, type Accessor } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"

export interface ShimmerTextProps {
  text: string
  color?: RGBA
}

const DURATION = 2_500

export function ShimmerText(props: ShimmerTextProps) {
  const themeCtx = useTheme()

  // Use provided color or default to theme info color (matches status messages)
  const color = () => props.color ?? themeCtx.theme.info

  // Pre-allocate shimmer signals for the max length we'll see.
  // The text may change (e.g., elapsed time ticking) — we reuse signals
  // and only render up to the current text length.
  const MAX_CHARS = 64
  const shimmerSignals: Accessor<number>[] = []

  const timeline = useTimeline({
    duration: DURATION,
    loop: true,
  })

  for (let i = 0; i < MAX_CHARS; i++) {
    const [shimmer, setShimmer] = createSignal(0.4)
    const target = { shimmer: shimmer(), setShimmer }

    timeline!.add(
      target,
      {
        shimmer: 1,
        duration: DURATION / (MAX_CHARS + 1),
        ease: "linear",
        alternate: true,
        loop: 2,
        onUpdate: () => { target.setShimmer(target.shimmer) },
      },
      (i * (DURATION / (MAX_CHARS + 1))) / 2,
    )

    shimmerSignals.push(shimmer)
  }

  return (
    <text>
      {(() => {
        const chars = props.text.split("")
        const c = color()
        return chars.map((ch, i) => {
          const shimmer = shimmerSignals[i] ?? (() => 0.8)
          const fg = RGBA.fromInts(c.r * 255, c.g * 255, c.b * 255, shimmer() * 255)
          return <span style={{ fg }}>{ch}</span>
        })
      })()}
    </text>
  )
}
