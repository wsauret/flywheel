import { forgetReadingState, saveReadingState, takeReadingState, type ReadingState } from "../../../src/protocol/client/reading-state.js"

/** One mount's hold on the reader's place across a reload
 *  (`src/protocol/client/reading-state.ts`): the place the previous page
 *  saved, which this mount restores once, and the transcript's way of reading
 *  the place now, which the mount saves whenever the page may go away. */
export interface ReadingPlace {
  /** What the reload saved, or nothing on an ordinary load. */
  readonly restored: ReadingState | undefined
  /** Registers how the reader's place is read; returns the unregistration. */
  track(read: () => ReadingState | undefined): () => void
}

export interface MountReadingPlace extends ReadingPlace {
  capture(shown?: string): ReadingState | undefined
  /** Saves the place as the tracker reads it, for a reload that may follow.
   *  With no transcript on screen to read, such as before the first attach
   *  or while a workflow's card shows, the place is `shown`: the session the
   *  page shows, or the one its address opens. */
  save(shown?: string): void
  /** Drops the saved place, because the page came back without a reload. */
  forget(): void
}

/** The page's session storage, or none where the browser refuses it. */
function pageSessionStorage(): Storage | undefined {
  try {
    return sessionStorage
  } catch {
    return undefined
  }
}

export function createReadingPlace(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = pageSessionStorage(), adopted?: ReadingState): MountReadingPlace {
  const legacy = takeReadingState(storage)
  const restored = adopted ?? legacy
  let read: (() => ReadingState | undefined) | undefined
  const capture = (shown?: string) => read?.() ?? (shown === restored?.sessionId ? restored : shown === undefined ? undefined : { sessionId: shown, following: true, open: [] })
  return {
    capture,
    restored,
    track(next) {
      read = next
      return () => {
        if (read === next) read = undefined
      }
    },
    save(shown) {
      const place = capture(shown)
      if (place !== undefined) saveReadingState(storage, place)
    },
    forget() {
      forgetReadingState(storage)
    },
  }
}
