import { type Accessor, type JSX, batch, createContext, createEffect, createMemo, createSignal, on, onCleanup, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionContentManifestReference } from "../../infra/session-content.js"
import type { MutationEvidenceHandle, MutationEvidenceReader } from "../../protocol/client/mutation-evidence.js"

/** Open one owner's evidence handle and observe only that owner's publications.
 * Every terminal surface renders collapsed diffs, so its pages carry file previews. */
export type OpenMutationEvidence = (ownerId: string, manifest: SessionContentManifestReference) => MutationEvidenceHandle | undefined

const MutationEvidenceContext = createContext<OpenMutationEvidence>(() => undefined)

/** Bind the resident session reader without acquiring or releasing evidence.
 * A descendant that opens an owner inside a reactive scope re-runs when that owner's
 * evidence changes, when every owner changes, or when the reader changes. A publication
 * for another owner does not re-run it, so work per publication does not grow with the
 * number of mounted previews. */
export function MutationEvidenceProvider(props: { reader: Accessor<MutationEvidenceReader | undefined>; children: JSX.Element }) {
  const reader = createMemo(() => props.reader())
  // A store tracks each property on its own, so an owner's readers subscribe to its key alone.
  const [revisions, setRevisions] = createStore<{ [ownerId: string]: number }>({})
  const [everyOwner, setEveryOwner] = createSignal(0)
  createEffect(on(reader, (current) => {
    if (current) onCleanup(current.onChange((owners) => {
      if (owners === undefined) setEveryOwner(value => value + 1)
      else batch(() => { for (const owner of owners) setRevisions(owner, value => (value ?? 0) + 1) })
    }))
  }))
  return MutationEvidenceContext.Provider({
    value: (ownerId, manifest) => {
      everyOwner()
      void revisions[ownerId]
      return reader()?.open(ownerId, manifest, { previews: true })
    },
    get children() { return props.children },
  })
}

/** Open an owner's evidence from the resident reader. No provider means no reader. */
export function useMutationEvidence(): OpenMutationEvidence {
  return useContext(MutationEvidenceContext)
}
