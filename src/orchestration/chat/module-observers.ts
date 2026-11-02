import { Log } from "../../infra/log.js"
import { errorMessage } from "../../infra/error-message.js"
import type { FirstPartyModuleComposition } from "../modules.js"
import type { ModuleChatObserver, ModuleChatObserverContext } from "../module-seams.js"

const log = Log.create({ service: "chat-module-observers" })

/** One owned set of selected observers. A failed contribution cannot stop
 *  another contribution, and disposal joins every admitted async hook. */
export function createModuleChatObservers(selection: () => FirstPartyModuleComposition, context: ModuleChatObserverContext): Required<ModuleChatObserver> {
  type Declaration = Extract<FirstPartyModuleComposition["observers"][number], { seam: "chat" }>
  const active = new Map<Declaration, ModuleChatObserver>()
  const pending = new Set<Promise<void>>()
  const failed = new Set<Declaration>()
  let disposed = false
  const report = (id: Declaration, error: unknown): void => { log.warn("module observer failed", { observer: id.observer.name, error: errorMessage(error) }) }
  function track(id: Declaration, run: () => void | Promise<void>): Promise<void> {
    let promise: Promise<void>
    try { promise = Promise.resolve(run()).catch((error: unknown) => { report(id, error) }) }
    catch (error) { report(id, error); return Promise.resolve() }
    pending.add(promise)
    void promise.then(() => { pending.delete(promise) })
    return promise
  }
  function retire(id: Declaration, observer: ModuleChatObserver): void {
    const admitted = [...pending]
    void track(id, async () => { await Promise.all(admitted); await observer.dispose?.() })
  }
  // A module selection applies from the next request, so the observer set is
  // reconciled once here and at every turn boundary. The stream events between
  // them, one per token in every session, are delivered to the set as it stands.
  function current(): ReadonlyMap<Declaration, ModuleChatObserver> {
    if (disposed) return active
    const selected = selection().observers.filter((entry) => entry.seam === "chat")
    const ids = new Set(selected)
    for (const id of failed) if (!ids.has(id)) failed.delete(id)
    for (const [id, observer] of active) {
      if (ids.has(id)) continue
      active.delete(id)
      retire(id, observer)
    }
    for (const entry of selected) {
      if (active.has(entry) || failed.has(entry)) continue
      try { active.set(entry, entry.observer(context)) }
      catch (error) { failed.add(entry); report(entry, error) }
    }
    return active
  }
  current()
  return {
    onEvent(event) {
      for (const [id, observer] of active) {
        try { observer.onEvent?.(event) } catch (error) { report(id, error) }
      }
    },
    async onTurnComplete(reason) {
      await Promise.all([...current()].map(([id, observer]) => track(id, () => observer.onTurnComplete?.(reason))))
    },
    async onCompactionContinuation() {
      await Promise.all([...current()].map(([id, observer]) => track(id, () => observer.onCompactionContinuation?.())))
    },
    async dispose() {
      if (!disposed) {
        disposed = true
        for (const [id, observer] of active) retire(id, observer)
        active.clear()
      }
      await Promise.all(pending)
    },
  }
}
