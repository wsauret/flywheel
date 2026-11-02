import { createContext, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import type { FileDiffFile } from "../../protocol/client/file-change-body.js"

// Disclosure state for collapsible transcript blocks, keyed by durable block
// identity (blockIdentity, suffixed `#<facet>` when one block has more than
// one collapsible region). It lives in the transcript cache, not in the row
// components, because virtualization unmounts rows outside the viewport
// neighborhood: a remounted row must restore the state the user left it in.
// `undefined` means untouched; each component resolves its own default and
// may seed the key at first mount when that default must survive the block
// turning historical.
export interface BlockDisclosureChannel {
  /** The stored disclosure override, or undefined when never written. */
  readonly disclosure: (key: string) => boolean | undefined
  readonly setDisclosure: (key: string, expanded: boolean) => void
}

/** A self-contained reactive channel for renders that have no transcript cache
 *  (the session preview pane, component tests). The owner decides the
 *  channel's lifetime; creating one per preview target or per test render
 *  keeps disclosure from leaking across mounts. */
export function createBlockDisclosureChannel(): BlockDisclosureChannel {
  const [state, setState] = createStore<{ [key: string]: boolean }>({})
  return { disclosure: (key) => state[key], setDisclosure: (key, expanded) => setState(key, expanded) }
}

const fileKeys = new WeakMap<BlockDisclosureChannel["setDisclosure"], Map<string, string>>()

/** Binds a newly known path to the existing disclosure cell, without copying its boolean. */
export function fileDisclosureKey(channel: BlockDisclosureChannel, toolId: string, file: Pick<FileDiffFile, "id" | "path">, singleFile = false): string {
  let keys = fileKeys.get(channel.setDisclosure)
  if (keys === undefined) {
    keys = new Map()
    fileKeys.set(channel.setDisclosure, keys)
  }
  const provisional = `${toolId}#diff:id:${singleFile ? "file-0" : file.id}`
  const path = file.path === undefined || file.path === "" ? undefined : `${toolId}#diff:path:${file.path}`
  const key = (path === undefined ? undefined : keys.get(path)) ?? keys.get(provisional) ?? path ?? provisional
  keys.set(provisional, key)
  if (path !== undefined) keys.set(path, key)
  return key
}

// The provider-less default is inert, never a shared mutable store: reads
// report untouched (components fall back to their defaults) and writes drop,
// so nothing can leak across unrelated mounts through the context default.
const inertChannel: BlockDisclosureChannel = { disclosure: () => undefined, setDisclosure: () => {} }

const BlockDisclosureContext = createContext<BlockDisclosureChannel>(inertChannel)

export const BlockDisclosureProvider = BlockDisclosureContext.Provider

export function useBlockDisclosure(): BlockDisclosureChannel {
  return useContext(BlockDisclosureContext)
}
