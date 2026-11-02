import type { SessionChangeDiffResult } from "../../../src/protocol/session-changes-protocol-types.js"
import { retainedDiff } from "../../../tests/unit/protocol/client/_session-changes-fixtures.js"
import { reviewWindow } from "./render-ownership-loader-fixture.js"

/** The review lays out after a frame, and the test host has no frame clock. */
export function manualFrames() {
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  const originalRequest = reviewWindow.requestAnimationFrame
  const originalCancel = reviewWindow.cancelAnimationFrame
  reviewWindow.requestAnimationFrame = callback => { const id = nextFrame++; callbacks.set(id, callback); return id }
  reviewWindow.cancelAnimationFrame = id => { callbacks.delete(id) }
  return {
    run() {
      const due = Array.from(callbacks.values())
      callbacks.clear()
      for (const frame of due) frame(0)
    },
    restore() { reviewWindow.requestAnimationFrame = originalRequest; reviewWindow.cancelAnimationFrame = originalCancel },
  }
}

/** A retained net diff larger than the collapsed 20-row preview. */
export function longDiff(path: string, revision = 7): SessionChangeDiffResult {
  const body = Array.from({ length: 45 }, (_, index) => `+net line ${index}`).join("\n")
  return retainedDiff(path, `@@ -0,0 +1,45 @@\n${body}\n`, 45, 0, revision)
}
