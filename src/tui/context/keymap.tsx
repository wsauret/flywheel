/** @jsxImportSource solid-js */

import { createContext, createMemo, type JSX, useContext } from "solid-js"
import { createKeymap, type Keymap } from "../keymap/keymap.js"
import type { RuntimeConfigView } from "../../protocol/runtime-config-protocol-types.js"

interface KeymapContextValue {
  keymap: Keymap
  /** Rejected [keybindings] overrides; surfaced once by the shell as toasts. */
  issues: readonly string[]
}

// Default value: the default bindings with no user overrides, so components
// rendered outside the app shell (tests, isolated trees) see real chords.
const KeymapContext = createContext<KeymapContextValue>(createKeymap())

export function KeymapProvider(props: { config?: () => RuntimeConfigView | undefined; children: JSX.Element }): JSX.Element {
  const current = createMemo(() => createKeymap(props.config?.()?.values.keybindings))
  const keymap: Keymap = {
    resolve: (event) => current().keymap.resolve(event),
    chordFor: (commandId) => current().keymap.chordFor(commandId),
  }
  const value: KeymapContextValue = {
    keymap,
    get issues() { return current().issues },
  }
  return <KeymapContext.Provider value={value}>{props.children}</KeymapContext.Provider>
}

export function useKeymap(): KeymapContextValue {
  return useContext(KeymapContext)
}
