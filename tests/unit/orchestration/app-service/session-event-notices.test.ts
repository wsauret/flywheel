import { describe, expect, it } from "bun:test"
import { createSessionEventNotices } from "../../../../src/orchestration/app-service/session-event-notices"
import type { SilentNoticeDelivery } from "../../../../src/orchestration/chat/runner-types"

type Store = Parameters<typeof createSessionEventNotices>[0]["sessionStore"]
type Entry = NonNullable<ReturnType<Store["get"]>>

/** The two store reads the service makes, over chat entries this test sets: each watcher's state and runner, and
 *  each chat's title. `set` changes an entry and tells the listeners which session changed, as the store does. */
function fakeStore() {
  const entries = new Map<string, Entry>()
  const listeners = new Set<(changed: ReadonlySet<string> | undefined) => void>()
  const store: Store = {
    get: (sessionId) => entries.get(sessionId),
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    store,
    set(sessionId: string, patch: Partial<Entry>) {
      entries.set(sessionId, { kind: "chat", runnerState: "idle", streamPhase: null, waitingOnBackgroundWork: false, description: sessionId, runner: null, ...entries.get(sessionId), ...patch })
      for (const listener of listeners) listener(new Set([sessionId]))
    },
  }
}

/** A watcher runner that answers each notice as `answers` says, in order, and records each notice it got. */
function watcherRunner(...answers: SilentNoticeDelivery[]) {
  const notices: string[] = []
  return {
    notices,
    runner: { async deliverSilentNotice(text: string) { notices.push(text); return answers[notices.length - 1] ?? "delivered" } },
  }
}

/** The watched chats a notice names, as `session_id:event`, in its order. */
function named(notice: string | undefined): string[] {
  return [...(notice ?? "").matchAll(/<session_id>(.*?)<\/session_id><title>.*?<\/title><event>(.*?)<\/event>/g)].map(([, id, kind]) => `${id}:${kind}`)
}

const settled = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe("session event notices", () => {
  it("merges a working watcher's events, the latest kind for each chat, into one notice at rest", async () => {
    const { store, set } = fakeStore()
    const watcher = watcherRunner()
    set("w", { runner: watcher.runner, runnerState: "streaming" })
    set("c", { description: "Fix the parser" })
    const notices = createSessionEventNotices({ sessionStore: store })
    notices.watch("w", "c")
    notices.watch("w", "d")

    notices.report("c", "asked")
    notices.report("d", "turn_ended")
    notices.report("c", "turn_ended")
    await settled()
    expect(watcher.notices).toEqual([])

    set("w", { runnerState: "idle" })
    await settled()
    expect(watcher.notices).toHaveLength(1)
    expect(named(watcher.notices[0])).toEqual(["c:turn_ended", "d:turn_ended"])
    expect(watcher.notices[0]).toContain("<title>Fix the parser</title>")
    expect(watcher.notices[0]).toContain("<visibility>hidden_from_user</visibility>")

    // A delivered notice clears what it named.
    set("w", { runnerState: "idle" })
    await settled()
    expect(watcher.notices).toHaveLength(1)
    notices.dispose()
  })

  it("tells a watcher that names kinds only of those kinds", async () => {
    const { store, set } = fakeStore()
    const watcher = watcherRunner()
    set("w", { runner: watcher.runner, runnerState: "idle" })
    const notices = createSessionEventNotices({ sessionStore: store })
    notices.watch("w", "c", ["asked", "failed", "cut"])
    notices.report("c", "turn_ended")
    await settled()
    expect(watcher.notices).toEqual([])
    notices.report("c", "failed")
    await settled()
    expect(named(watcher.notices[0])).toEqual(["c:failed"])
    notices.dispose()
  })

  it("waits as long as the watcher waits on its own question or its background work", async () => {
    const { store, set } = fakeStore()
    const watcher = watcherRunner()
    set("w", { runner: watcher.runner, runnerState: "awaiting_user" })
    const notices = createSessionEventNotices({ sessionStore: store })
    notices.watch("w", "c")
    notices.report("c", "failed")
    set("w", { runnerState: "idle", waitingOnBackgroundWork: true })
    await settled()
    expect(watcher.notices).toEqual([])

    set("w", { waitingOnBackgroundWork: false })
    await settled()
    expect(named(watcher.notices[0])).toEqual(["c:failed"])
    notices.dispose()
  })

  it("keeps held events and asks again only after the watcher had a turn and came to rest", async () => {
    const { store, set } = fakeStore()
    const watcher = watcherRunner("held", "delivered")
    set("w", { runner: watcher.runner })
    const notices = createSessionEventNotices({ sessionStore: store })
    notices.watch("w", "c")
    notices.watch("w", "d")

    notices.report("c", "asked")
    await settled()
    expect(watcher.notices).toHaveLength(1)

    notices.report("d", "turn_ended")
    set("w", { runnerState: "idle" })
    await settled()
    expect(watcher.notices).toHaveLength(1)

    set("w", { runnerState: "streaming" })
    set("w", { runnerState: "idle" })
    await settled()
    expect(watcher.notices).toHaveLength(2)
    expect(named(watcher.notices[1])).toEqual(["c:asked", "d:turn_ended"])
    notices.dispose()
  })

  it.each([
    ["the watcher's runner detaches and attaches again", (notices: ReturnType<typeof createSessionEventNotices>, set: ReturnType<typeof fakeStore>["set"], runner: ReturnType<typeof watcherRunner>["runner"]) => {
      set("w", { runner: null })
      set("w", { runner })
    }],
    ["the watch ends and starts again", (notices: ReturnType<typeof createSessionEventNotices>) => {
      notices.unwatch("w", "c")
      notices.watch("w", "c")
    }],
  ] as const)("forgets a held notice once its events are dropped because %s", async (_name, drop) => {
    const { store, set } = fakeStore()
    const watcher = watcherRunner("held", "delivered")
    set("w", { runner: watcher.runner })
    const notices = createSessionEventNotices({ sessionStore: store })
    notices.watch("w", "c")
    notices.report("c", "asked")
    await settled()
    expect(watcher.notices).toHaveLength(1)

    drop(notices, set, watcher.runner)
    notices.report("c", "turn_ended")
    await settled()
    expect(watcher.notices).toHaveLength(2)
    expect(named(watcher.notices[1])).toEqual(["c:turn_ended"])
    notices.dispose()
  })

  it("reads only the store entry of a changed watcher, however many watchers wait", () => {
    const { store, set } = fakeStore()
    let reads = 0
    const notices = createSessionEventNotices({ sessionStore: { ...store, get: (sessionId) => { reads += 1; return store.get(sessionId) } } })
    for (let index = 0; index < 50; index++) {
      set(`w${index}`, { runner: watcherRunner().runner, runnerState: "streaming" })
      notices.watch(`w${index}`, "c")
    }
    notices.report("c", "asked")

    reads = 0
    set("unrelated", {})
    expect(reads).toBe(0)
    set("w7", { runnerState: "streaming" })
    expect(reads).toBe(1)
    notices.dispose()
  })

  it("drops reports for a watcher with no attached runner, and a runner that attaches later gets nothing", async () => {
    const { store, set } = fakeStore()
    set("w", {})
    const notices = createSessionEventNotices({ sessionStore: store })
    notices.watch("w", "c")
    notices.report("c", "asked")
    notices.report("c", "turn_ended")

    const watcher = watcherRunner()
    set("w", { runner: watcher.runner })
    await settled()
    expect(watcher.notices).toEqual([])
    notices.dispose()
  })

  it("delivers nothing for a session that nobody watches", async () => {
    const { store, set } = fakeStore()
    const watcher = watcherRunner()
    set("w", { runner: watcher.runner })
    const notices = createSessionEventNotices({ sessionStore: store })
    notices.watch("w", "c")
    notices.report("x", "asked")
    notices.unwatch("w", "c")
    notices.report("c", "asked")
    await settled()
    expect(watcher.notices).toEqual([])
    notices.dispose()
  })
})
