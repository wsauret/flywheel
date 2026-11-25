import { createEffect } from "solid-js"

/** Runs one owned effect when the reactive condition first becomes true. */
export function onceWhen(when: () => boolean, run: () => void): void {
  let fired = false
  createEffect(() => {
    if (fired || !when()) return
    fired = true
    run()
  })
}
