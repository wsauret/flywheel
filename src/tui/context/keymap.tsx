/** @jsxImportSource solid-js */

import { createContext, createEffect, createMemo, type JSX, on, useContext } from "solid-js"
import { createKeymap, type Keymap } from "../terminal/keymap/keymap.js"
import type { createToastPresenter } from "./toast-presenter.js"
import type { RuntimeConfigView } from "../../protocol/settings/runtime-config-protocol-types.js"

type KeybindingRecords = RuntimeConfigView["values"]["keybindings"]

interface KeymapContextValue {
  keymap: Keymap
  /** Rejected [keybindings] overrides of the current keymap; `presentKeymapIssues` shows them. */
  issues: readonly string[]
}

// Default value: the default bindings with no user overrides, so components
// rendered outside the app shell (tests, isolated trees) see real chords.
const KeymapContext = createContext<KeymapContextValue>(createKeymap())

export function KeymapProvider(props: { config?: () => RuntimeConfigView | undefined; children: JSX.Element }): JSX.Element {
  // Every config publication carries a fresh view, so only a changed binding
  // rebuilds the keymap and every chord reader behind it.
  const keybindings = createMemo(() => props.config?.()?.values.keybindings ?? {}, undefined, { equals: sameKeybindings })
  const current = createMemo(() => createKeymap(keybindings()))
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

function sameKeybindings(left: KeybindingRecords, right: KeybindingRecords): boolean {
  const commandIds = Object.keys(left)
  return commandIds.length === Object.keys(right).length && commandIds.every((commandId) => left[commandId] === right[commandId])
}

export function useKeymap(): KeymapContextValue {
  return useContext(KeymapContext)
}

/** Shows each rejected [keybindings] override as a `config.invalid` toast when
 *  a keymap rebuild first reports it, at startup or in any later config
 *  publication. An issue that the previous keymap also reported is not news
 *  and shows nothing. Call it inside a `KeymapProvider`; the effect lives as
 *  long as the calling owner. */
export function presentKeymapIssues(presenter: Pick<ReturnType<typeof createToastPresenter>, "present">): void {
  const context = useKeymap()
  let rebuilds = 0
  createEffect(on(() => context.issues, (issues, previous) => {
    rebuilds += 1
    for (const issue of issues) {
      if (previous?.includes(issue)) continue
      // The family remembers only its last shown key, so a key per rebuild
      // keeps a mistake that was fixed and then made again from reading as a repeat.
      presenter.present("config.invalid", { message: issue, variant: "error", duration: 10000, dedupeKey: `keybindings ${rebuilds}\0${issue}` })
    }
  }))
}
