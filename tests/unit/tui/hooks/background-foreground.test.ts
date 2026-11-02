import { describe, expect, it, mock } from "bun:test"
import type { FrontendMutation, MutationResult } from "../../../../src/protocol/app-service-types.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"
import {
  discardIfTransientForeground,
} from "../../../../src/tui/hooks/background-foreground.js"
import { createDraftCache } from "../../../../src/tui/hooks/create-draft-cache.js"
import { createForegroundSwitcher } from "../../../../src/tui/hooks/create-foreground-switcher.js"
import type { ForegroundTarget } from "../../../../src/tui/hooks/shell-state.js"

/** A runtime dispatch that answers a transient discard with `result` and records each command. */
function fakeDispatch(result: MutationResult) {
  const commands = mock(async (_command: FrontendMutation): Promise<MutationResult> => result)
  return { dispatch: runtimeDispatch({ "session.discard_transient": commands }), commands }
}

async function discardRequestSent(withDraft = false): Promise<boolean> {
  const { dispatch, commands } = fakeDispatch({ ok: true, sessionRemoved: true })
  const draftCache = createDraftCache()
  if (withDraft) draftCache.set("chat-1", { text: "hi", pastes: [], attachments: [] })
  await discardIfTransientForeground({
    draftCache,
    appService: { dispatch },
    showToast: mock(() => {}),
    closeSessionTab: mock(() => {}),
    isTransientSessionTab: () => true,
  }, "chat-1")
  return commands.mock.calls.length > 0
}

describe("background foreground policy", () => {
  it("ignores a removed pending key and switches existing local pending rows without durable selection", async () => {
    const setForegroundId = mock(() => {})
    const setForegroundTarget = mock((_value: ForegroundTarget | undefined) => {})
    const switchForeground = createForegroundSwitcher({
      signals: { setForegroundId, setForegroundTarget },
      sessions: () => [],
      tabs: () => [{ kind: "pending", id: "local", title: "Opening", isForeground: false, isBusy: false, isBlocked: false }],
    })
    await switchForeground("removed")
    expect(setForegroundTarget).not.toHaveBeenCalled()
    await switchForeground("local")
    expect(setForegroundTarget).toHaveBeenCalledWith({ kind: "pending", key: "local" })
    expect(setForegroundId).not.toHaveBeenCalled()
  })

  it("keeps foreground sessions with unsaved prompt drafts", async () => {
    expect(await discardRequestSent(true)).toBe(false)
    expect(await discardRequestSent()).toBe(true)
  })

  // The deps hold no foreground signals, so the caller keeps navigation.
  it("discards the transient chat and closes its local tab", async () => {
    const { dispatch, commands } = fakeDispatch({ ok: true, sessionRemoved: true })
    const closeSessionTab = mock((_sessionId: string) => {})

    await discardIfTransientForeground({
      draftCache: createDraftCache(),
      appService: { dispatch },
      showToast: mock(() => {}),
      closeSessionTab,
      isTransientSessionTab: () => true,
    }, "startup-chat")

    expect(commands).toHaveBeenCalledWith({ type: "session.discard_transient", sessionId: "startup-chat" })
    expect(closeSessionTab).toHaveBeenCalledWith("startup-chat")
  })

  it("keeps the local tab when the foreground is not a transient chat", async () => {
    const closeSessionTab = mock(() => {})

    await discardIfTransientForeground({
      draftCache: createDraftCache(),
      appService: fakeDispatch({ ok: true, sessionRemoved: true }),
      showToast: mock(() => {}),
      closeSessionTab,
      isTransientSessionTab: () => false,
    }, "chat-with-history")

    expect(closeSessionTab).not.toHaveBeenCalled()
  })

  it("keeps the local tab when the runtime keeps the transient", async () => {
    const closeSessionTab = mock(() => {})

    await discardIfTransientForeground({
      draftCache: createDraftCache(),
      appService: fakeDispatch({ ok: true, sessionRemoved: false }),
      showToast: mock(() => {}),
      closeSessionTab,
      isTransientSessionTab: () => true,
    }, "startup-chat")

    expect(closeSessionTab).not.toHaveBeenCalled()
  })

  it("surfaces a toast when the close dispatch fails", async () => {
    const showToast = mock(() => {})

    await discardIfTransientForeground({
      draftCache: createDraftCache(),
      appService: fakeDispatch({ ok: false, error: "boom" }),
      showToast,
      closeSessionTab: mock(() => {}),
      isTransientSessionTab: () => true,
    }, "startup-chat")

    expect(showToast).toHaveBeenCalledWith({ message: "boom", variant: "error" })
  })
})
