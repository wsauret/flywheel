import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"

import type { UnsentChatSubmission } from "../../../../src/protocol/client/chat-submissions.js"
import type { LaunchState } from "../../../../src/infra/launch-state.js"
import { leaveTerminal, setRendererHandoff } from "../../../../src/tui/exit.js"
import { createDraftCache } from "../../../../src/tui/hooks/create-draft-cache.js"
import { createLaunchState } from "../../../../src/tui/hooks/create-launch-state.js"
import type { TabInfo } from "../../../../src/tui/hooks/create-tabs.js"
import type { TranscriptLayoutSlot } from "../../../../src/tui/output-window/output-window-scroll.js"
import { catalogRow } from "../../../helpers/session-catalog.js"

function tab(id: string, kind: "session" | "pending" = "session"): TabInfo {
  return { kind, id, title: id, isForeground: false, isBusy: false, isBlocked: false }
}

function fixture(handed: LaunchState | undefined) {
  const events: string[] = []
  const slots = new Map<string, TranscriptLayoutSlot>()
  const disclosed = new Map<string, { [key: string]: boolean }>()
  const [foreground, setForeground] = createSignal<string | undefined>()
  const [tabs, setTabs] = createSignal<readonly TabInfo[]>([])
  const [catalogReady, setCatalogReady] = createSignal(true)
  const draftCache = createDraftCache(handed)
  let route: LaunchState["modal"] = { kind: "none" }
  let unsent: readonly UnsentChatSubmission[] = []
  const laneListeners = new Set<(lane: number) => void>()
  let currentLane = 0
  const deps = {
    projectRoot: "/work/project",
    handed,
    catalogReady,
    signals: { foregroundId: foreground },
    tabs,
    openSessionTab: (sessionId: string) => { events.push(`open ${sessionId}`) },
    draftCache,
    outbox: { unsent: () => unsent },
    composer: () => ({ persistDraft: () => { events.push("persist draft"); draftCache.set("b", { text: "typed", pastes: [], attachments: [] }) } }),
    transcripts: {
      visibleRange: () => undefined,
      disclosures: (sessionId: string) => disclosed.get(sessionId) ?? {},
      setDisclosure: (sessionId: string, key: string, expanded: boolean) => { disclosed.set(sessionId, { ...disclosed.get(sessionId), [key]: expanded }) },
    },
    layout: (sessionId: string) => {
      const slot = slots.get(sessionId) ?? {}
      slots.set(sessionId, slot)
      return slot
    },
    overlay: { route: () => route },
    resolveSessionRoute: async (sessionId: string) => ({ root: catalogRow(sessionId, sessionId), children: [] }),
    activateSessionById: async (sessionId: string) => {
      events.push(`activate ${sessionId}`)
      setForeground(sessionId)
    },
    restoreModule: async () => true,
    reopen: {
      sessions: () => { events.push("reopen sessions") },
      theme: () => { events.push("reopen theme") },
    },
    startChat: async () => {
      events.push("start chat")
      return true
    },
    // Like the connection, a new listener hears the lane already open at once.
    lanes: { onLane: (listener: (lane: number) => void) => {
      laneListeners.add(listener)
      if (currentLane !== 0) listener(currentLane)
      return () => { laneListeners.delete(listener) }
    } },
  }
  const openLane = (lane: number): void => {
    currentLane = lane
    for (const listener of laneListeners) listener(lane)
  }
  return { deps, events, slots, disclosed, setForeground, setTabs, setCatalogReady, openLane, laneListeners, setRoute: (next: LaunchState["modal"]) => { route = next }, setUnsent: (next: readonly UnsentChatSubmission[]) => { unsent = next } }
}

const HANDED: LaunchState = {
  version: 3,
  projectRoot: "/work/project",
  foreground: "b",
  tabs: ["a", "b"],
  scroll: { a: { tail: true }, b: { blockIndex: 4, rowOffsetWithinBlock: 2 } },
  disclosure: { b: { "tool:t1": true } },
  drafts: { a: { text: "draft a", pastes: [], attachments: [], caret: 3 } },
  questionDrafts: {},
  modal: { kind: "child", sessionId: "child" },
}

describe("the terminal's place", () => {
  for (const foreground of ["chat", "workflow"]) {
    it(`normalizes saved workflow tabs without reopening background viewers when foreground is ${foreground}`, async () => {
      await createRoot(async (dispose) => {
        const handed: LaunchState = { ...HANDED, foreground, tabs: ["chat", "workflow", "other"], modal: { kind: "none" } }
        const { deps, events } = fixture(handed)
        await createLaunchState({
          ...deps,
          resolveSessionRoute: async (id) => ({ root: catalogRow(id === "workflow" ? "chat" : id, id), children: id === "workflow" ? [{ id: "workflow", kind: "workflow-agent" as const }] : [] }),
        }).restore()
        expect(events).toEqual(["open chat", "open other", `activate ${foreground}`])
        dispose()
      })
    })
  }
  it("waits for the first catalog snapshot before activating the saved foreground, but restores only once", async () => {
    await createRoot(async (dispose) => {
      const { deps, events, setCatalogReady } = fixture(HANDED)
      setCatalogReady(false)
      const place = createLaunchState(deps)
      const restoring = place.restore()
      await Promise.resolve()
      expect(events).toEqual([])
      setCatalogReady(true)
      await restoring
      expect(events).toEqual(["open a", "open b", "activate child"])
      setCatalogReady(false)
      setCatalogReady(true)
      await Promise.resolve()
      expect(events).toHaveLength(3)
      dispose()
    })
  })

  it("seeds expanded rows and held scroll places at once, then opens the tabs, the foreground, and the modal it was handed", async () => {
    await createRoot(async (dispose) => {
      const { deps, events, slots, disclosed } = fixture(HANDED)
      const place = createLaunchState(deps)

      expect(disclosed.get("b")).toEqual({ "tool:t1": true })
      expect(slots.get("b")?.restoreAnchor).toEqual({ blockIndex: 4, rowOffsetWithinBlock: 2 })
      // Following the live end is what a fresh transcript does already.
      expect(slots.get("a")?.restoreAnchor).toBeUndefined()
      expect(deps.draftCache.get("a")).toEqual({ text: "draft a", pastes: [], attachments: [], caret: 3 })

      await place.restore()
      expect(events).toEqual(["open a", "open b", "activate child"])
      dispose()
    })
  })

  it("skips a saved tab whose lookup fails and restores the rest", async () => {
    await createRoot(async (dispose) => {
      const handed: LaunchState = { ...HANDED, tabs: ["a", "lost", "b"], modal: { kind: "none" } }
      const { deps, events } = fixture(handed)
      await createLaunchState({
        ...deps,
        resolveSessionRoute: async (id) => {
          if (id === "lost") throw new Error("detail read timed out")
          return { root: catalogRow(id, id), children: [] }
        },
      }).restore()
      expect(events).toEqual(["open a", "open b", "activate b"])
      dispose()
    })
  })

  it("opens a new chat and reports the failure when the saved foreground cannot be read", async () => {
    await createRoot(async (dispose) => {
      const { deps, events } = fixture({ ...HANDED, modal: { kind: "none" } })
      const restoring = createLaunchState({ ...deps, activateSessionById: async () => { throw new Error("detail read timed out") } }).restore()
      await expect(restoring).rejects.toThrow("detail read timed out")
      expect(events).toEqual(["open a", "open b", "start chat"])
      dispose()
    })
  })

  it("restores a module's route through its registered reader rather than a session alias", async () => {
    await createRoot(async (dispose) => {
      const opened: string[] = []
      const modal: LaunchState["modal"] = { kind: "module", moduleId: "workflows", route: { workflowId: "workflow", agentNodeId: "lanes:1:probe", follow: true } }
      const { deps } = fixture({ ...HANDED, modal })
      await createLaunchState({ ...deps, restoreModule: async (route) => { opened.push(JSON.stringify(route)); return true } }).restore()
      expect(opened).toEqual([JSON.stringify(modal)])
      dispose()
    })
  })

  it("opens a new chat when the foreground it was handed is gone", async () => {
    await createRoot(async (dispose) => {
      const { deps, events } = fixture(HANDED)
      await createLaunchState({ ...deps, activateSessionById: async (sessionId) => { events.push(`activate ${sessionId}`) } }).restore()
      expect(events).toEqual(["open a", "open b", "activate child", "start chat"])
      dispose()
    })
  })

  it("opens a new chat when it was handed nothing", async () => {
    await createRoot(async (dispose) => {
      const { deps, events, setCatalogReady } = fixture(undefined)
      setCatalogReady(false)
      await createLaunchState(deps).restore()
      expect(events).toEqual(["start chat"])
      dispose()
    })
  })

  it("opens its first chat again when the next lane opens after the first attempt failed", async () => {
    // The runtime start failed, so the first chat failed with it; the
    // connection then attached on its own, and the terminal must not stay on
    // its load screen with nothing left to wait for.
    await createRoot(async (dispose) => {
      const { deps, events, openLane, laneListeners, setForeground } = fixture(undefined)
      let attempts = 0
      const restoring = createLaunchState({
        ...deps,
        startChat: async () => {
          attempts += 1
          events.push(`start chat ${attempts}`)
          if (attempts === 1) return false
          setForeground("new")
          return true
        },
      }).restore()
      for (let turn = 0; turn < 20 && laneListeners.size === 0; turn++) await Promise.resolve()
      expect(events).toEqual(["start chat 1"])
      expect(laneListeners.size).toBe(1)
      openLane(1)
      await restoring
      expect(events).toEqual(["start chat 1", "start chat 2"])
      expect(laneListeners.size).toBe(0)
      dispose()
    })
  })

  it("does not retry a failed first chat on the lane it failed on", async () => {
    await createRoot(async (dispose) => {
      const { deps, events, openLane, laneListeners, setForeground } = fixture(undefined)
      openLane(1)
      let attempts = 0
      const restoring = createLaunchState({
        ...deps,
        startChat: async () => {
          attempts += 1
          events.push(`start chat ${attempts}`)
          if (attempts === 1) return false
          setForeground("new")
          return true
        },
      }).restore()
      for (let turn = 0; turn < 20 && laneListeners.size === 0; turn++) await Promise.resolve()
      expect(events).toEqual(["start chat 1"])
      expect(laneListeners.size).toBe(1)
      openLane(2)
      await restoring
      expect(events).toEqual(["start chat 1", "start chat 2"])
      dispose()
    })
  })

  it("stops waiting for a lane to reopen its first chat when its shell closes", async () => {
    let dispose!: () => void
    let listeners!: Set<(lane: number) => void>
    let events!: string[]
    const restoring = createRoot((stop) => {
      dispose = stop
      const setup = fixture(undefined)
      listeners = setup.laneListeners
      events = setup.events
      return createLaunchState({ ...setup.deps, startChat: async () => { events.push("start chat"); return false } }).restore()
    })
    for (let turn = 0; turn < 20 && listeners.size === 0; turn++) await Promise.resolve()
    expect(listeners.size).toBe(1)
    dispose()
    await restoring
    expect(events).toEqual(["start chat"])
    expect(listeners.size).toBe(0)
  })

  it("opens a new chat before catalog readiness when handed no session ids", async () => {
    await createRoot(async (dispose) => {
      const handed = { ...HANDED, foreground: null, tabs: [], modal: { kind: "none" as const } }
      const { deps, events, setCatalogReady } = fixture(handed)
      setCatalogReady(false)
      await createLaunchState(deps).restore()
      expect(events).toEqual(["start chat"])
      dispose()
    })
  })

  it("waits for catalog readiness when handed tabs need lookup without a foreground", async () => {
    await createRoot(async (dispose) => {
      const handed = { ...HANDED, foreground: null, tabs: ["a"], modal: { kind: "none" as const } }
      const { deps, events, setCatalogReady } = fixture(handed)
      setCatalogReady(false)
      const restoring = createLaunchState(deps).restore()
      await Promise.resolve()
      expect(events).toEqual([])
      setCatalogReady(true)
      await restoring
      expect(events).toEqual(["open a", "start chat"])
      dispose()
    })
  })

  for (const becomesReady of [false, true]) {
    it(`cancels a waiting restore when its shell closes${becomesReady ? " as the snapshot arrives" : ""}`, async () => {
      let dispose!: () => void
      let setReady!: (ready: boolean) => boolean
      let events!: string[]
      const restoring = createRoot((stop) => {
        dispose = stop
        const setup = fixture(HANDED)
        events = setup.events
        setReady = setup.setCatalogReady
        setReady(false)
        return createLaunchState(setup.deps).restore()
      })
      if (becomesReady) setReady(true)
      dispose()
      await restoring
      expect(events).toEqual([])
    })
  }

  it("does not reopen a modal when its shell closes during foreground activation", async () => {
    await createRoot(async (dispose) => {
      const { deps, events } = fixture(HANDED)
      await createLaunchState({ ...deps, activateSessionById: async (sessionId) => { events.push(`activate ${sessionId}`); dispose() } }).restore()
      expect(events).toEqual(["open a", "open b", "activate child"])
    })
  })

  it("states the place for a successor, after the composer writes its live buffer, when the terminal is left", async () => {
    await createRoot(async (dispose) => {
      const { deps, events, setForeground, setTabs, setRoute, setUnsent, disclosed } = fixture(HANDED)
      createLaunchState(deps)
      setUnsent([{ sessionId: "b", id: "submission-1", input: { text: "lost words", submissionIds: ["submission-1"] }, timestamp: 9 }])
      setTabs([tab("a"), tab("pending-1", "pending"), tab("b")])
      setForeground("b")
      setRoute({ kind: "theme" })
      disclosed.set("a", { "tool:t9": false, "tool:t8#diff:id:file-0": true, "tool:t8#diff:path:src/a.ts": true })
      setRendererHandoff({ suspend: async () => { events.push("suspend") }, resume: async () => {}, destroy: async () => {} })

      const left = await leaveTerminal()

      expect(events).toEqual(["persist draft", "suspend"])
      expect(left.state).toEqual({
        version: 3,
        projectRoot: "/work/project",
        foreground: "b",
        tabs: ["a", "b"],
        // Session b has not been shown, so the place it was handed goes on.
        scroll: { b: { blockIndex: 4, rowOffsetWithinBlock: 2 } },
        disclosure: { a: { "tool:t9": false, "tool:t8#diff:path:src/a.ts": true }, b: { "tool:t1": true } },
        drafts: { a: { text: "draft a", pastes: [], attachments: [], caret: 3 }, b: { text: "typed", pastes: [], attachments: [], caret: 5 } },
        questionDrafts: {},
        modal: { kind: "theme" },
        outbox: [{ sessionId: "b", id: "submission-1", input: { text: "lost words", submissionIds: ["submission-1"] }, timestamp: 9 }],
      })
      left.resume()
      setRendererHandoff(null)
      dispose()
    })
  })
})
