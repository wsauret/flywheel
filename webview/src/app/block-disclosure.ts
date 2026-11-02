import { type Accessor, createSignal } from "solid-js"

import type { FileDiffFile } from "../../../src/protocol/client/file-change-body.js"

interface BlockDisclosureState {
  readonly open: boolean
  /** A person set `open`. Without a choice a row shows how it arrived. */
  readonly chosen: boolean
}

/** Which rows and which files inside them a person has opened or closed. Only
 *  a person's choices land here, and each one is absolute: a row arrives
 *  collapsed and nothing in the client opens one on its own. The one arrival
 *  that is not collapsed is a finished turn whose work the window opened
 *  inside, which the reader has already seen; its fold arrives open, and a
 *  person's close holds against that arrival. The one carried choice is a
 *  command row the reader holds open when it becomes an edit card, whose
 *  output fold opens with it. A reload onto a new client build hands those
 *  choices back, and nothing else. */
export interface BlockDisclosure {
  state(sessionId: string, blockId: string): Accessor<BlockDisclosureState>
  setOpen(sessionId: string, blockId: string, open: boolean): void
  /** The first of `keys` that holds a person's choice in a session. It reads
   *  only keys a choice or a render already named, so it creates nothing. */
  chosenKey(sessionId: string, keys: Iterable<string>): string | undefined
  fileExpanded(sessionId: string, blockId: string, file: Pick<FileDiffFile, "id" | "path">, singleFile?: boolean): boolean
  setFileExpanded(sessionId: string, blockId: string, file: Pick<FileDiffFile, "id" | "path">, expanded: boolean, singleFile?: boolean): void
  /** Every row and file key the reader chose open or closed in a session,
   *  which a reload saves and hands back to `setOpen`. */
  choices(sessionId: string): { readonly open: readonly string[]; readonly closed: readonly string[] }
}

const initialState: BlockDisclosureState = { open: false, chosen: false }

/** Owns row disclosure and file choice for the lifetime of one transcript. */
export function createBlockDisclosure(): BlockDisclosure {
  const states = new Map<string, ReturnType<typeof createSignal<BlockDisclosureState>>>()
  const fileKeys = new Map<string, string>()
  const keyOf = (sessionId: string, blockId: string) => `${sessionId}\u0000${blockId}`
  const fileKey = (sessionId: string, blockId: string, file: Pick<FileDiffFile, "id" | "path">, singleFile = false) => {
    const provisional = `${blockId}#diff:id:${singleFile ? "file-0" : file.id}`
    const path = file.path === undefined || file.path === "" ? undefined : `${blockId}#diff:path:${file.path}`
    const key = (path === undefined ? undefined : fileKeys.get(keyOf(sessionId, path)))
      ?? fileKeys.get(keyOf(sessionId, provisional)) ?? path ?? provisional
    fileKeys.set(keyOf(sessionId, provisional), key)
    if (path !== undefined) fileKeys.set(keyOf(sessionId, path), key)
    return key
  }
  const entry = (sessionId: string, blockId: string) => {
    const key = keyOf(sessionId, blockId)
    const current = states.get(key)
    if (current !== undefined) return current
    const created = createSignal(initialState)
    states.set(key, created)
    return created
  }

  return {
    fileExpanded: (sessionId, blockId, file, singleFile) => entry(sessionId, fileKey(sessionId, blockId, file, singleFile))[0]().open,
    setFileExpanded: (sessionId, blockId, file, expanded, singleFile) => {
      entry(sessionId, fileKey(sessionId, blockId, file, singleFile))[1]({ open: expanded, chosen: true })
    },
    state: (sessionId, blockId) => entry(sessionId, blockId)[0],
    setOpen: (sessionId, blockId, open) => {
      entry(sessionId, blockId)[1]({ open, chosen: true })
    },
    chosenKey: (sessionId, keys) => {
      for (const key of keys) {
        if (states.get(keyOf(sessionId, key))?.[0]().chosen === true) return key
      }
      return undefined
    },
    choices: (sessionId) => {
      const prefix = keyOf(sessionId, "")
      const chosen = [...states].flatMap(([key, [state]]) => key.startsWith(prefix) && state().chosen ? [{ key: key.slice(prefix.length), open: state().open }] : [])
      return { open: chosen.flatMap(choice => choice.open ? [choice.key] : []), closed: chosen.flatMap(choice => choice.open ? [] : [choice.key]) }
    },
  }
}
