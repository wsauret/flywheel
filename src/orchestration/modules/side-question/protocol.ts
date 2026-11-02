import { sideQuestionCursor, sideQuestionRequestCursor, sideQuestionProtocol, type SideQuestionResult, type SideQuestionView } from "../../../protocol/modules/side-question.js"
import type { ModuleProtocolRuntime, ModuleProtocolServices } from "../../app-service/module-protocol-host.js"
import type { ChatRunner } from "../../chat/runner-types.js"
import type { ConversationSessionEntry, SessionStore } from "../../session-store/types.js"
import { sideQuestionHost, type SideQuestionHost } from "./host.js"

/** Both clients lend the same session host. The wire carries whole views, never source context.
 *  Side history lives only in the attached runner, so a read answers from the
 *  resident host and never attaches one; only a person's mutation opens the
 *  chat runner. The runtime follows the store to publish whichever host a
 *  session holds, including one that `/btw` reaches through the command path. */
export function createSideQuestionProtocol(services: Pick<ModuleProtocolServices, "enabled" | "publish" | "snapshotPosition" | "manager"> & {
  readonly sessionStore: Pick<SessionStore, "onChange" | "allIds"> & {
    get(sessionId: string): { readonly kind: ConversationSessionEntry["kind"]; readonly runner: Pick<ChatRunner, "chatModuleHosts"> | null } | undefined
  }
  readonly openChatRunner?: (sessionId: string) => Promise<Pick<ChatRunner, "chatModuleHosts"> | undefined>
}): ModuleProtocolRuntime<typeof sideQuestionProtocol> {
  const subscriptions = new Map<string, { host: SideQuestionHost; unsubscribe: () => void }>()
  function publish(sessionId: string, view: SideQuestionView | null, change: "control" | "request"): void {
    if (change === "control") services.publish({ cursor: sideQuestionCursor(sessionId), payload: {
      kind: "side-question.changed", view: view ? { revision: view.revision, exchanges: view.exchanges } : null,
    } })
    services.publish({ cursor: sideQuestionRequestCursor(sessionId), payload: { kind: "side-question-request.changed", view: view ? { current: view.current } : null } })
  }
  /** Subscribes to the host the session holds now and publishes its view when that host changed. */
  function follow(sessionId: string): SideQuestionHost | undefined {
    const entry = services.sessionStore.get(sessionId)
    // The lookup itself retires a host the module selection dropped, so it runs even while disabled.
    const admitted = entry?.kind === "chat" ? entry.runner?.chatModuleHosts.get(sideQuestionHost) : undefined
    const current = services.enabled() ? admitted : undefined
    const prior = subscriptions.get(sessionId)
    if (prior?.host === current) return current
    prior?.unsubscribe()
    subscriptions.delete(sessionId)
    if (current) subscriptions.set(sessionId, { host: current, unsubscribe: current.subscribe((view, change) => {
      publish(sessionId, services.enabled() ? view : null, change)
      if (view === null && subscriptions.get(sessionId)?.host === current) subscriptions.delete(sessionId)
    }) })
    publish(sessionId, current?.snapshot() ?? null, "control")
    return current
  }
  const offStore = services.sessionStore.onChange((changed) => {
    for (const sessionId of changed ?? new Set([...services.sessionStore.allIds(), ...subscriptions.keys()])) follow(sessionId)
  }, "side-question-protocol")
  async function mutate(sessionId: string, run: (current: SideQuestionHost) => Promise<SideQuestionResult>): Promise<SideQuestionResult> {
    // Side questions are a chat's: a subagent or workflow agent has no chat runner to open.
    const chat = (services.sessionStore.get(sessionId)?.kind ?? (await services.manager.read(sessionId))?.kind) === "chat"
    if (chat && services.enabled()) await services.openChatRunner?.(sessionId)
    const current = follow(sessionId)
    if (!current) return { ok: false, error: "Side questions are unavailable for this chat" }
    try { return await run(current) }
    catch { return { ok: false, error: "The side-question action failed. Try again." } }
  }
  return {
    serve: {
      sideQuestionSnapshot: async ({ sessionId }) => {
        const snapshotPosition = services.snapshotPosition({ kind: "cursor", cursor: sideQuestionCursor(sessionId) })
        const view = follow(sessionId)?.snapshot()
        return { view: view ? { revision: view.revision, exchanges: view.exchanges } : null, snapshotPosition }
      },
      sideQuestionRequestSnapshot: async ({ sessionId }) => {
        const snapshotPosition = services.snapshotPosition({ kind: "cursor", cursor: sideQuestionRequestCursor(sessionId) })
        const view = follow(sessionId)?.snapshot()
        return { view: view ? { current: view.current } : null, snapshotPosition }
      },
    },
    mutate: {
      "side-question.ask": ({ sessionId, question }) => mutate(sessionId, async (current) => ({ ok: true, requestId: await current.ask(question) })),
      "side-question.stop": ({ sessionId, requestId }) => mutate(sessionId, async (current) =>
        await current.stop(requestId) ? { ok: true } : { ok: false, error: "This side request is no longer running" }),
      "side-question.clear": ({ sessionId, revision }) => mutate(sessionId, async (current) =>
        await current.clear(revision) ? { ok: true } : { ok: false, error: "Side history changed. Review it before clearing." }),
      "side-question.keep": ({ sessionId, exchangeId }) => mutate(sessionId, async (current) => {
        const messages = current.promotion(exchangeId)
        if (!messages) return { ok: false, error: "This answer is no longer available" }
        return { ok: true, destinationSessionId: await services.manager.createChatFromContext(sessionId, messages) }
      }),
    },
    dispose() { offStore(); for (const { unsubscribe } of subscriptions.values()) unsubscribe(); subscriptions.clear() },
  }
}
