import type { Accessor } from "solid-js"
import { useTickPool } from "../../context/tick-pool-context.js"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_INTERVAL = 80

export function useSpinnerFrame(isActive: Accessor<boolean>): Accessor<string> {
  const pool = useTickPool()
  const tick = pool.createSharedTick(SPINNER_INTERVAL, isActive)
  // SAFETY: SPINNER_FRAMES is a non-empty constant, so `tick() % length` is always
  // an in-bounds index; the modulo cannot produce length itself.
  return () => SPINNER_FRAMES[tick() % SPINNER_FRAMES.length]!
}
