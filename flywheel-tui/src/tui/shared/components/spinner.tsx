/** @jsxImportSource @opentui/solid */
/**
 * Animated Spinner Component
 * Braille dot pattern spinner.
 */

import { createSignal, onMount, onCleanup } from "solid-js"
import type { RGBA } from "@opentui/core"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

interface SpinnerProps {
  color?: RGBA
  interval?: number
}

export function Spinner(props: SpinnerProps) {
  const [frame, setFrame] = createSignal(0)

  onMount(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length)
    }, props.interval ?? 80)
    onCleanup(() => clearInterval(id))
  })

  return <text fg={props.color}>{FRAMES[frame()]}</text>
}
