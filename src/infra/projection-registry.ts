import { bindHeldKey } from "./event-projection.js"
import type { AsyncEventReadSurface } from "./event-store-types.js"

/** The one owner of a projection's lifetime.
 *
 *  `createEventProjection` initializes lazily on its first awaited operation.
 *  Rebuilding one discards the cursor and repeats the aggregate's history. Every
 *  factory over it looked like a cheap constructor and was called per read in
 *  eight places, which is how one background sweep came to re-read fifty-one
 *  workflow aggregates from position zero on every pass.
 *
 *  Registering here inverts that. A factory names what it builds, and the
 *  second caller gets the projection the first one built, folded forward
 *  rather than rebuilt. Holding is what happens by default and building per
 *  call is not expressible, so the next factory cannot reintroduce the bug by
 *  forgetting to hold. `bun run lint:projections` keeps it that way.
 *
 *  Freshness does not depend on who holds it: `replay()` reads through a
 *  committed position captured after its call, so a held projection folds
 *  another process's commits on the next read. In an executor that position
 *  is the head of the next state response, or of one capture shared by every
 *  replay waiting when no response is coming, and the pages after it come
 *  from the commit window when it has heard through that position and holds
 *  the facts (ARCH-SUBSTRATE-019), so an idle replay costs no page request. A push-fed owner that
 *  never wants that check keeps using `apply()` and `getState()` on the same instance; the two paths compose,
 *  because both serialize reads through the same committed position authority.
 *  Owners must await the initial replay and each apply before reading state. */

/** Projections of one family held for one reader before the least recently
 *  used is dropped.
 *
 *  Counted per family because the families are not comparable in size. Measured
 *  by holding the heaviest aggregates of a real workspace: a budget projection
 *  is 10 KB and a workflow queue 15 KB, while a tool execution projection is
 *  2.6 MB and a conversation tree 5 MB, because both hydrate tool content into
 *  their state. One count across all of them is either wasteful for the small
 *  families or, at 64 conversation trees, 317 MB of heap for the large.
 *
 *  Eviction drops only the registry's reference. A miss builds a new instance
 *  and folds the aggregate again from its start. An owner that captured the
 *  evicted instance, such as a tree storage or a budget store, keeps feeding
 *  and reading it, so after an eviction two instances of one key can be live
 *  and the aggregate is folded twice. A reader that sits beside such an owner
 *  must read the owner's state, not ask the registry again: at these low
 *  counts, many held conversations evict on almost every ask. */
const HELD_PER_FAMILY: ReadonlyMap<string, number> = new Map([
  // Matches the transcript cache's resident count: the same "sessions a user
  // switches between" working set, sized against the same kind of state.
  ["conversation-tree", 8],
  ["tool-execution", 8],
  // The children whose cards one large chat shows, each a small fold. A child
  // evicted past this bound starts again from its persisted fold, if any.
  ["subagent-measure", 256],
])
const DEFAULT_HELD_PER_FAMILY = 64

/** The family a key belongs to: everything before its first id. Keys are built
 *  as `family:id`, and a family with no id is its own. */
function familyOf(key: string): string {
  const separator = key.indexOf(":")
  return separator === -1 ? key : key.slice(0, separator)
}

interface HeldEntry {
  /** The projection the registering factory built. Its state type is recovered
   *  at the call site, where the key that found it and the factory that made
   *  it are the same expression. */
  readonly projection: unknown
}

// Keyed by reader identity, so projections die with the store they read. A
// module singleton for the same reason the log sink is one: the identity of a
// reader is process-global, and threading a registry handle through every
// projection factory would be ceremony that buys nothing.
const heldByReader = new WeakMap<AsyncEventReadSurface, Map<string, Map<string, HeldEntry>>>()
/** Each pinned key over a reader, with its count of pins. */
const pinsByReader = new WeakMap<AsyncEventReadSurface, Map<string, number>>()

/** The held projection for `key` over `reader`, built by `create` on first ask.
 *
 *  `key` must name everything that makes two projections different: the family
 *  and every id the factory closes over. Two factories that would fold
 *  different facts must not share a key, and the same factory asked twice for
 *  the same ids must reuse one. */
export function heldProjection<P extends object>(
  reader: AsyncEventReadSurface,
  key: string,
  create: () => P,
): P {
  let families = heldByReader.get(reader)
  if (!families) {
    families = new Map<string, Map<string, HeldEntry>>()
    heldByReader.set(reader, families)
  }
  const family = familyOf(key)
  let held = families.get(family)
  if (!held) {
    held = new Map<string, HeldEntry>()
    families.set(family, held)
  }

  const existing = held.get(key)
  if (existing) {
    // Re-inserting moves the entry to the end, which is what makes iteration
    // order least-recently-used order for the eviction below.
    held.delete(key)
    held.set(key, existing)
    // SAFETY: entries are only ever written by this function, under a key the
    // caller derives from the same factory it passes as `create`, so a hit
    // carries that factory's projection and therefore its state type.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a registry keyed by caller-derived strings erases the state type it stored
    return existing.projection as P
  }

  const projection = create()
  bindHeldKey(projection, key)
  held.set(key, { projection })
  if (held.size > (HELD_PER_FAMILY.get(family) ?? DEFAULT_HELD_PER_FAMILY)) {
    // The least recently used key that no owner pins. A family whose keys are
    // all pinned holds more than its bound until a pin is released.
    const pins = pinsByReader.get(reader)
    for (const candidate of held.keys()) {
      if (pins?.has(candidate)) continue
      held.delete(candidate)
      break
    }
  }
  return projection
}

/** Keeps the projection held for `key` over `reader` out of eviction until
 *  the returned release, which is idempotent. For an owner that keeps an
 *  aggregate open across many reads, such as a session whose runner is
 *  attached: its projection must not be folded again from its start because
 *  other keys of its family were asked for in between. Each pin counts, and
 *  the key is evictable again after its last release. With
 *  `dropOnLastRelease`, the last release also drops the key, for state that
 *  only its holders use. The pin holds the key, not an instance, so a key
 *  with no projection yet is pinned from its first build, and
 *  `releaseHeldProjection` still drops a pinned key. */
export function pinHeldProjection(reader: AsyncEventReadSurface, key: string, options: { readonly dropOnLastRelease?: boolean } = {}): () => void {
  let pins = pinsByReader.get(reader)
  if (!pins) {
    pins = new Map<string, number>()
    pinsByReader.set(reader, pins)
  }
  const readerPins = pins
  readerPins.set(key, (readerPins.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (readerPins.get(key) ?? 1) - 1
    if (remaining > 0) {
      readerPins.set(key, remaining)
      return
    }
    readerPins.delete(key)
    if (options.dropOnLastRelease) releaseHeldProjection(reader, key)
  }
}

/** Drops the one projection held for `key` over `reader`, if any. For an owner
 *  that knows the aggregate is no longer in use, such as a session whose runner
 *  closed. A caller that still holds the projection keeps its instance; the next
 *  `heldProjection` call for the key builds a new one. */
export function releaseHeldProjection(reader: AsyncEventReadSurface, key: string): void {
  heldByReader.get(reader)?.get(familyOf(key))?.delete(key)
}

/** Drops everything held for a reader. For a caller that knows its reader is
 *  finished, and for tests that assert on fold counts. */
export function releaseHeldProjections(reader: AsyncEventReadSurface): void {
  heldByReader.delete(reader)
}
