import type { AttachedRuntimeClient, FrontendEvent } from "../../src/protocol/app-service-types.js"

/** The event a connection publishes when its lane breaks. */
export const LANE_BREAK: FrontendEvent = {
  type: "patch",
  patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 0, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "reconnect_required" } },
}

/** The lane half of an attached runtime client, for a fake client: its lanes
 *  and the output watches taken on them, which end with their lane as the
 *  real connection's do. The first lane is open from the start unless `open`
 *  is false. */
export function fakeLanes(options: { readonly open?: boolean } = {}) {
  const listeners = new Set<(lane: number) => void>()
  const watches = new Map<string, number>()
  let opened = options.open === false ? 0 : 1
  let lane = opened
  const onLane: AttachedRuntimeClient["onLane"] = (listener) => {
    listeners.add(listener)
    if (lane !== 0) listener(lane)
    return () => { listeners.delete(listener) }
  }
  const watchOutput: AttachedRuntimeClient["watchOutput"] = (sessionId) => {
    const watchedOn = lane
    watches.set(sessionId, (watches.get(sessionId) ?? 0) + 1)
    let released = false
    return () => {
      if (released || watchedOn !== lane) return
      released = true
      const count = (watches.get(sessionId) ?? 1) - 1
      if (count === 0) watches.delete(sessionId)
      else watches.set(sessionId, count)
    }
  }
  return {
    onLane,
    watchOutput,
    /** The members a fake client spreads in. */
    client: { onLane, watchOutput },
    /** Whether any receiver watches `sessionId` on the open lane. */
    watching: (sessionId: string): boolean => lane !== 0 && watches.has(sessionId),
    /** Opens the next lane and tells every listener. */
    open(): void {
      lane = ++opened
      watches.clear()
      for (const listener of [...listeners]) listener(lane)
    },
    /** Ends the open lane. The fake's owner publishes `LANE_BREAK`. */
    end(): void {
      lane = 0
      watches.clear()
    },
    get lane() { return lane },
    get listeners() { return listeners.size },
  }
}
