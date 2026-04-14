/** @jsxImportSource @opentui/solid */

import { createSignal, onMount, onCleanup } from "solid-js"
import type { RGBA } from "@opentui/core"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_INTERVAL = 80

interface SpinnerProps {
  color?: RGBA
  interval?: number
}

export function Spinner(props: SpinnerProps) {
  const [frame, setFrame] = createSignal(0)

  onMount(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    }, props.interval ?? SPINNER_INTERVAL)
    onCleanup(() => clearInterval(id))
  })

  return <text fg={props.color}>{SPINNER_FRAMES[frame()]}</text>
}
