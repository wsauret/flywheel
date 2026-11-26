import { createEffect, onCleanup, untrack } from "solid-js"
import type { MountedTranscript, OutputTranscriptCache, TranscriptMount } from "./output-transcript-cache-types.js"

/** How a mounted surface keeps the transcript of the session it shows
 *  resident and current; `TranscriptResidency.mount` states the contract.
 *  Creates its effects under the caller's Solid owner. */
export function mountTranscript(
  transcripts: Pick<OutputTranscriptCache, "retain" | "open" | "ensure" | "refresh" | "bindSession" | "view" | "streamingOutputChars">,
  session: TranscriptMount,
): MountedTranscript {
  const { sessionId } = session
  createEffect(() => {
    const id = sessionId()
    if (!id) return
    const retention = transcripts.retain(id)
    let mounted = true
    onCleanup(() => {
      mounted = false
      retention.release()
    })
    untrack(() => {
      void transcripts.open(id)
        .then(() => mounted ? session.hydrateToHead(id, () => mounted && untrack(sessionId) === id) : undefined)
        .catch((cause: unknown) => { if (mounted) session.onFailure(id, cause) })
    })
  })

  createEffect(() => {
    const id = sessionId()
    if (id && session.live()) untrack(() => { transcripts.ensure(id) })
  })

  let reactivationBaseline: { id: string; wasActive: boolean } | undefined
  createEffect(() => {
    const id = sessionId()
    if (!id) { reactivationBaseline = undefined; return }
    const isActive = session.lifecycleActive()
    const wasActive = reactivationBaseline?.id === id ? reactivationBaseline.wasActive : isActive
    reactivationBaseline = { id, wasActive: isActive }
    if (wasActive !== isActive && isActive) untrack(() => { void transcripts.refresh(id) })
  })

  const bound = <T>(read: (id: string) => T | undefined) => (): T | undefined => {
    const id = sessionId()
    return id ? read(id) : undefined
  }
  return {
    view: transcripts.bindSession(sessionId),
    outputView: bound(transcripts.view),
    streamingOutputChars: bound(transcripts.streamingOutputChars),
  }
}
