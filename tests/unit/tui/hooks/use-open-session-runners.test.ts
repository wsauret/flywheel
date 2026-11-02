import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { TabInfo } from "../../../../src/tui/hooks/create-tabs.js"
import { createFocusedSessionReadiness, useOpenSessionRunners } from "../../../../src/tui/hooks/use-open-session-runners.js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { createOpenSessionKeeper } from "../../../../src/protocol/client/open-session-keeper.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { recordedDispatch, runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

function sessionTab(id: string): TabInfo {
  return { kind: "session", id, title: id, isForeground: false, isBusy: false, isBlocked: false }
}

const pendingTab: TabInfo = { kind: "pending", id: "p", title: "Opening", isForeground: false, isBusy: false, isBlocked: false }

describe("useOpenSessionRunners", () => {
  it("focuses the visible tab first on startup and reattach, and promotes a waiting tab on switch", async () => {
    const calls: string[] = []
    const lanes = fakeLanes()
    const [viewReady, setViewReady] = createSignal(false)
    const client = {
        dispatch: recordedDispatch((mutation: FrontendMutation) => {
          if ("sessionId" in mutation) calls.push(`${mutation.type}:${mutation.sessionId}`)
        }, runtimeDispatch({
          "session.activate": async () => ({ ok: true }),
          "session.release": async () => ({ ok: true }),
        })),
        subscribe: () => () => {},
        onLane: lanes.onLane,
    }
    const [tabs, setTabs] = createSignal<readonly TabInfo[]>([
      sessionTab("chat-1"), { ...sessionTab("chat-2"), isForeground: true }, sessionTab("chat-3"),
    ])
    const stop = createRoot((dispose) => {
      const keeper = createOpenSessionKeeper({ client, focusReady: createFocusedSessionReadiness(viewReady) })
      useOpenSessionRunners({ tabs, ready: () => true, keeper })
      return dispose
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(calls).toEqual(["session.activate:chat-2"])
      calls.length = 0
      lanes.open()
      expect(calls).toEqual(["session.activate:chat-2"])
      setTabs([sessionTab("chat-1"), sessionTab("chat-2"), { ...sessionTab("chat-3"), isForeground: true }])
      expect(calls).toEqual(["session.activate:chat-2", "session.activate:chat-3"])
      setTabs([...tabs()])
      expect(calls).toEqual(["session.activate:chat-2", "session.activate:chat-3"])
      setViewReady(true)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(calls).toEqual(["session.activate:chat-2", "session.activate:chat-3", "session.activate:chat-1"])
    } finally {
      setViewReady(true)
      stop()
      expect(lanes.listeners).toBe(0)
    }
  })

  it("opens a keeper claim for every chat tab and releases it when the tab closes", () => {
    const calls: string[] = []
    const keeper = { open: (id: string) => calls.push(`open:${id}`), close: (id: string) => calls.push(`close:${id}`), focus: () => {}, dispose: () => calls.push("dispose") }
    const [tabs, setTabs] = createSignal<readonly TabInfo[]>([sessionTab("chat-1"), pendingTab])
    const [ready, setReady] = createSignal(false)
    // Effects run once the root has settled, so the assertions sit outside it.
    const stop = createRoot((disposeRoot) => {
      useOpenSessionRunners({ tabs, ready, keeper })
      return disposeRoot
    })

    // Nothing is claimed before the shell is ready: attaching never competes with the first frame.
    expect(calls).toEqual([])
    setReady(true)
    expect(calls).toEqual(["open:chat-1"])
    setTabs([sessionTab("chat-2")])
    expect(calls).toEqual(["open:chat-1", "close:chat-1", "open:chat-2"])
    stop()
    expect(calls.at(-1)).toBe("dispose")
  })
})
