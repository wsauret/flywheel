import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"

/** One session's reading that a mounted surface follows, such as the role
 *  assignment or the status of a child that a card shows. */
export interface SessionReadingSource<View> {
  get(sessionId: string): View | undefined
  subscribe(sessionId: string, listener: (view: View | undefined) => void): () => void
}

/** A session-keyed reading signal. Its source owns ordered recovery; Solid
 *  owns only this mounted surface's derived reactive reading and releases it
 *  on unmount. */
export function createSessionReading<View>(sessionId: Accessor<string | undefined>, source: SessionReadingSource<View>): Accessor<View | undefined> {
  // `on` reruns for every publish of what the id derives from, even when the
  // id stays the same; each rerun would release the reading and start it
  // again from nothing. The memo passes on only a change of session.
  const followed = createMemo(sessionId)
  const initialSessionId = followed()
  const [view, setView] = createSignal<View | undefined>(initialSessionId === undefined ? undefined : source.get(initialSessionId))
  createEffect(on(followed, (current) => {
    if (current === undefined) {
      setView(undefined)
      return
    }
    setView(() => source.get(current))
    onCleanup(source.subscribe(current, (next) => setView(() => next)))
  }))
  return view
}
