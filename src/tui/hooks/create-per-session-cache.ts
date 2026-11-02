import { onCleanup, untrack } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { RuntimeUiPatchPayload } from "../../protocol/runtime-ui-protocol-types.js"
import { createSessionReadingFamily, type SessionReadingFamilyOptions } from "../../protocol/client/session-reading-family.js"

/** The terminal's per-session runtime cache: one session-scoped domain's
 *  views (budget, status, workflow view, question, roles, a module's session
 *  domain) in a Solid store keyed by sessionId. Which sessions are read, and
 *  when, is the shared reading family's decision; this adapter only gives its
 *  views a reactive home and ties its life to the Solid owner. */
export interface PerSessionCache<View> {
  /** Reads the session once on each lane, even when a live patch already
   *  delivered its view. */
  ensure(sessionId: string): void
  /** Reads every session not read yet, in one read. One catalog sweep must
   *  not fan out into N runtime RPCs. */
  ensureMany(sessionIds: readonly string[]): void
  view(sessionId: string): View | undefined
}

interface PerSessionViewCache<View> {
  [sessionId: string]: View
}

type PerSessionCacheConfig<Domain extends string, Payload extends RuntimeUiPatchPayload, View> =
  Omit<SessionReadingFamilyOptions<Domain, Payload, View>, "views" | "changed" | "admits">

export function createPerSessionCache<Domain extends string, Payload extends RuntimeUiPatchPayload, View>(
  config: PerSessionCacheConfig<Domain, Payload, View>,
): PerSessionCache<View> {
  const [cache, setCache] = createStore<PerSessionViewCache<View>>({})
  const family = createSessionReadingFamily({
    ...config,
    views: {
      get: (sessionId) => untrack(() => unwrap(cache)[sessionId]),
      set: (sessionId, view) => setCache(produce((state) => { state[sessionId] = view })),
      delete: (sessionId) => setCache(produce((state) => { Reflect.deleteProperty(state, sessionId) })),
      keys: () => Object.keys(untrack(() => unwrap(cache))),
    },
  })
  onCleanup(family.dispose)
  return {
    ensure: (sessionId) => { family.ensure([sessionId]) },
    ensureMany: (sessionIds) => { family.ensure(sessionIds) },
    view: (sessionId) => cache[sessionId],
  }
}
