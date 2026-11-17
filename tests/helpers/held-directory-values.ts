import { spyOn } from "bun:test"

/** Whether a confirmed directory watch holds derived values on this platform.
 *  Windows computes every read until a native run proves its watch, so a case
 *  there asserts that every request reads and that nothing is held. */
export const HOLDS_DIRECTORY_VALUES = process.platform !== "win32"

/** Captures the periodic callbacks that watches schedule, so a case runs each revalidation itself. */
export function capturedIntervals() {
  const revalidations: Array<Parameters<typeof setInterval>[0]> = []
  // A real handle, already cleared, stands in for each captured interval, so a watch still unrefs and clears it.
  const inert = setInterval(() => {}, 1_000_000)
  clearInterval(inert)
  const spy = spyOn(globalThis, "setInterval").mockImplementation(new Proxy(globalThis.setInterval, {
    apply(_target, _receiver, [revalidation]: Parameters<typeof setInterval>) {
      revalidations.push(revalidation)
      return inert
    },
  }))
  return {
    revalidate: () => { for (const revalidation of revalidations) if (typeof revalidation === "function") revalidation() },
    restore: () => { spy.mockRestore() },
  }
}
