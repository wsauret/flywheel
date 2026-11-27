import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"
import { createModal, mockClipboardCopy, pressCtrl, rowLabels, session } from "../../../_session-modal-fixtures.js"

describe("useSessionModal search by what was said", () => {
  const sessions = [session({ id: "alpha", title: "Kafka pipeline" }), session({ id: "beta", title: "Other work" }), session({ id: "gamma", title: "Third" })]
  const found = (sessionId: string) => ({ sessionId, entryId: `entry-${sessionId}`, snippet: "the [kafka] lag" })
  const pause = () => new Promise((resolve) => setTimeout(resolve, 1))
  const type = (modals: ReturnType<typeof createModal>["modals"], text: string) => { for (const name of text) modals.input({ name, raw: name }) }

  it("shows title matches at once and, after the pause, chats found by their messages below them", async () => {
    await createRoot(async (dispose) => {
      const chatSearch = mock(async () => ({ chats: [found("beta"), found("alpha"), found("gamma")] }))
      const { hook, modals } = createModal({ sessions, chatSearch })
      hook.openSessionsModal()
      // Opening catches up the message index with a blank search, which finds nothing.
      expect(chatSearch).toHaveBeenCalledTimes(1)
      expect(chatSearch).toHaveBeenCalledWith({ type: "chatSearch", request: { query: "", exclude: [] } })

      type(modals, "kafka")
      expect(rowLabels(hook)).toEqual(["alpha"])
      expect(chatSearch).toHaveBeenCalledTimes(1)
      await pause()

      expect(chatSearch).toHaveBeenCalledTimes(2)
      expect(chatSearch).toHaveBeenLastCalledWith({ type: "chatSearch", request: { query: "kafka", exclude: ["alpha"] } })
      expect(rowLabels(hook)).toEqual(["alpha", "In messages", "found:beta", "found:gamma"])
      expect(hook.modalCursor()).toBe(0)
      dispose()
    })
  })

  it("cancels a search that a later query replaced, and drops its answer", async () => {
    await createRoot(async (dispose) => {
      const answers = new Map<string, PromiseWithResolvers<{ chats: ReturnType<typeof found>[] }>>()
      const chatSearch = mock(({ request }: { request: { query: string } }) => {
        const answer = Promise.withResolvers<{ chats: ReturnType<typeof found>[] }>()
        answers.set(request.query, answer)
        return answer.promise
      })
      const { hook, modals, querySignals } = createModal({ sessions, chatSearch })
      hook.openSessionsModal()

      type(modals, "kaf")
      await pause()
      type(modals, "k")
      await pause()
      const [replaced, current] = querySignals.slice(-2)
      expect(replaced?.aborted).toBe(true)
      expect(current?.aborted).toBe(false)
      answers.get("kafk")?.resolve({ chats: [found("gamma")] })
      await pause()
      answers.get("kaf")?.resolve({ chats: [found("beta")] })
      await pause()

      expect(rowLabels(hook)).toEqual(["alpha", "In messages", "found:gamma"])
      dispose()
    })
  })

  it("keeps the last answer's rows and selection while a newer query waits, says it searches only with nothing to show, and clears on failure", async () => {
    await createRoot(async (dispose) => {
      const answers = new Map<string, PromiseWithResolvers<{ chats: ReturnType<typeof found>[] }>>()
      const chatSearch = mock(({ request }: { request: { query: string } }) => {
        const answer = Promise.withResolvers<{ chats: ReturnType<typeof found>[] }>()
        answers.set(request.query, answer)
        return answer.promise
      })
      const { hook, modals } = createModal({ sessions, chatSearch })
      hook.openSessionsModal()

      type(modals, "lags")
      expect(rowLabels(hook)).toEqual([])
      expect(hook.sessionModalResult().searchingMessages).toBe(true)
      await pause()
      answers.get("lags")?.resolve({ chats: [found("beta")] })
      await pause()
      expect(rowLabels(hook)).toEqual(["In messages", "found:beta"])
      expect(hook.sessionModalResult().searchingMessages).toBe(false)

      modals.input({ name: "backspace" })
      expect(rowLabels(hook)).toEqual(["In messages", "found:beta"])
      expect(hook.sessionModalResult().rows[hook.modalCursor()]?.id).toBe("found:beta")
      await pause()
      answers.get("lag")?.resolve({ chats: [found("gamma"), found("beta")] })
      await pause()
      expect(rowLabels(hook)).toEqual(["In messages", "found:gamma", "found:beta"])
      expect(hook.sessionModalResult().rows[hook.modalCursor()]?.id).toBe("found:beta")

      type(modals, "x")
      expect(rowLabels(hook)).toEqual(["In messages", "found:gamma", "found:beta"])
      await pause()
      answers.get("lagx")?.reject(new Error("index closed"))
      await pause()
      expect(rowLabels(hook)).toEqual([])
      expect(hook.sessionModalResult().searchingMessages).toBe(false)

      // The same words, asked again after a failure, search again.
      type(modals, " ")
      await pause()
      answers.get("lagx")?.resolve({ chats: [found("beta")] })
      await pause()
      expect(rowLabels(hook)).toEqual(["In messages", "found:beta"])

      for (let left = 5; left > 0; left--) modals.input({ name: "backspace" })
      expect(rowLabels(hook)).not.toContain("In messages")
      expect(hook.sessionModalResult().searchingMessages).toBe(false)
      dispose()
    })
  })

  it("keeps found rows while the query goes on with a word too short to search, and drops them for a new short query", async () => {
    await createRoot(async (dispose) => {
      const { hook, modals } = createModal({ sessions, chatSearch: async ({ request }: { request: { query: string } }) => ({ chats: request.query === "lags" ? [found("beta")] : [] }) })
      hook.openSessionsModal()
      type(modals, "lags")
      await pause()
      expect(rowLabels(hook)).toEqual(["In messages", "found:beta"])
      hook.handleSessionFilter("lags x")
      expect(rowLabels(hook)).toEqual(["In messages", "found:beta"])
      hook.handleSessionFilter("zz")
      expect(rowLabels(hook)).toEqual([])
      dispose()
    })
  })

  it("opens a found chat on its best match, and leaves Backspace to the query", async () => {
    await createRoot(async (dispose) => {
      const { hook, modals, activateSession, landOnEntry } = createModal({ sessions, chatSearch: async () => ({ chats: [found("beta")] }) })
      hook.openSessionsModal()
      type(modals, "kafka")
      await pause()
      modals.input({ name: "down" })
      expect(hook.sessionModalResult().rows[hook.modalCursor()]?.kind).toBe("found")

      modals.input({ name: "backspace" })
      expect(hook.filterQuery()).toBe("kafk")
      modals.input({ name: "k", raw: "k" })
      await pause()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      await pause()

      expect(activateSession).toHaveBeenCalledWith(sessions[1])
      expect(landOnEntry).toHaveBeenCalledWith("entry-beta")
      dispose()
    })
  })

  it("offers a found chat the actions of its session", async () => {
    await createRoot(async (dispose) => {
      mockClipboardCopy.mockClear()
      const { hook, modals } = createModal({ sessions, chatSearch: async () => ({ chats: [found("beta")] }) })
      hook.openSessionsModal()
      type(modals, "kafka")
      await pause()
      modals.input({ name: "down" })
      expect(hook.sessionModalResult().rows[hook.modalCursor()]?.kind).toBe("found")
      expect(hook.sessionModalActions().map((action) => action.label)).toEqual(["delete", "rename", "copy session ID", "mark unread"])

      pressCtrl(modals, "y")
      expect(mockClipboardCopy).toHaveBeenCalledWith("beta")
      dispose()
    })
  })
})
