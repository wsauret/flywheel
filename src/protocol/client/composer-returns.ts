import type { AttachedRuntimeClient, FrontendMutation } from "../app-service-types.js"
import { returnedInputSubmissionId, type ComposerReturn, type ClaimComposerReturnsResult } from "../composer-returns.js"
import type { TranscriptChange } from "./transcript-store.js"
import { lostWithLane } from "./connection-failures.js"
import { adoptedBlocks } from "./chat-submissions.js"

/** Returns input only to its sending window, then retires its sender ownership
 * after a successful claim response, including an empty or unmatched claim. */
export function createComposerReturns(deps: {
  readonly client: Pick<AttachedRuntimeClient, "onLane"> & { dispatch(mutation: Extract<FrontendMutation, { type: "session.claim_composer_returns" }>): Promise<ClaimComposerReturnsResult> }
  readonly ownsSubmission: (id: string) => boolean
  readonly settled: (submissionIds: readonly string[]) => void
  readonly append: (sessionId: string, item: ComposerReturn) => void
  readonly report: (message: string) => void
}) {
  const owners = new Set<string>()
  const returns = new Map<string, Set<string>>()
  const pending = new Map<string, { again: boolean }>()
  let disposed = false
  function trigger(sessionId: string): void {
    if (disposed || !owners.has(sessionId) || !returns.get(sessionId)?.size) return
    const current = pending.get(sessionId)
    if (current) { current.again = true; return }
    const work = { again: false }
    pending.set(sessionId, work)
    queueMicrotask(() => { void drain(sessionId, work) })
  }
  async function drain(sessionId: string, work: { again: boolean }): Promise<void> {
    try {
      do {
        work.again = false
        if (disposed || !owners.has(sessionId)) return
        const ids = [...returns.get(sessionId) ?? []]
        if (ids.length === 0) return
        const result = await deps.client.dispatch({ type: "session.claim_composer_returns", sessionId, submissionIds: ids })
        if (disposed) return
        if (!result.ok) { deps.report(result.error); return }
        deps.settled(ids)
        const held = returns.get(sessionId)
        for (const id of ids) held?.delete(id)
        if (held?.size === 0) returns.delete(sessionId)
        if (result.kind === "claimed") for (const item of result.items) deps.append(sessionId, item)
      } while (work.again)
    } catch (error) {
      if (!disposed && !lostWithLane(error)) deps.report("The returned message is kept in the parent transcript. Its composer copy could not be loaded.")
    } finally { pending.delete(sessionId) }
  }
  const off = deps.client.onLane(() => { for (const id of owners) trigger(id) })
  return {
    own(ids: readonly string[]): void {
      const next = new Set(ids)
      for (const id of owners) if (!next.has(id)) owners.delete(id)
      for (const id of next) if (!owners.has(id)) { owners.add(id); trigger(id) }
    },
    observe(sessionId: string, change: TranscriptChange): void {
      if (disposed) return
      let matched = false
      for (const block of adoptedBlocks(change)) {
        const id = block.kind === "system" ? returnedInputSubmissionId(block.id) : undefined
        if (id === undefined || !deps.ownsSubmission(id)) continue
        let ids = returns.get(sessionId)
        if (!ids) { ids = new Set(); returns.set(sessionId, ids) }
        ids.add(id)
        matched = true
      }
      if (matched || (change.kind === "window" && (change.reason === "install" || change.reason === "merge"))) trigger(sessionId)
    },
    dispose(): void { disposed = true; owners.clear(); returns.clear(); off() },
  }
}
