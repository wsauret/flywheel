import { createMemo, createSignal, type Accessor, type JSX } from "solid-js"
import { AUTH_PROFILE_PENDING, type AuthProfileSelection } from "./auth-profile-selection.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { createListModalKeys } from "../components/modal-list-keys.js"
import { filterOptions, flattenWithCategories } from "../components/modal-select-helpers.js"
import type { FilteredResult } from "../components/modal-select-types.js"
import type { ModalContext, ModalHandle } from "../components/modal-stack.js"
import type { ShellServices } from "./shell-state.js"

interface ProfileModalDeps {
  /** The runtime's effective-profile projection; the modal holds no selection of its own. */
  auth: Accessor<RuntimeAuthView | undefined>
  authProfileSelection: AuthProfileSelection
  modal: ModalContext
  renderModal: () => JSX.Element
  showToast: ShellServices["showToast"]
}

export interface ProfileModalHook {
  profileModalResult: Accessor<FilteredResult<string>>
  profileModalCursor: Accessor<number>
  /** The active profile id; the modal marks its row as current. */
  profileModalCurrent: Accessor<string | undefined>
  /** `/profile [name]`: an exact case-insensitive display-name match switches
   *  immediately; no argument or a miss opens the selection modal. */
  openProfileSwitcher: (arg?: string) => void
  selectProfileRow: (rowIndex: number) => void
}

export function useProfileModal(deps: ProfileModalDeps): ProfileModalHook {
  const [cursor, setCursor] = createSignal(0)
  let entry: ModalHandle | undefined

  const result = createMemo<FilteredResult<string>>(() => {
    const profiles = deps.auth()?.profile.availableProfiles ?? []
    const options = profiles.map((profile) => ({ id: profile.id, title: profile.displayName, value: profile.id }))
    return flattenWithCategories(filterOptions(options, ""), false)
  })

  /** Detach only this entry: with the settings root underneath, a selection
   *  or the left arrow lands back on settings. */
  function close(): void {
    entry?.close()
  }

  function switchProfile(id: string, displayName: string): void {
    void deps.authProfileSelection.select(id, displayName)
  }

  function openProfileModal(currentId: string): void {
    setCursor(result().rows.find((row) => row.kind === "option" && row.option.value === currentId)?.rowIndex ?? 0)
    entry = deps.modal.replace(deps.renderModal, { onKey: handleKey })
  }

  function openProfileSwitcher(arg?: string): void {
    const profile = deps.auth()?.profile
    if (!profile) {
      deps.showToast({ message: AUTH_PROFILE_PENDING, variant: "error" })
      return
    }
    const wanted = arg?.trim().toLowerCase()
    const match = wanted ? profile.availableProfiles.find((available) => available.displayName.toLowerCase() === wanted) : undefined
    if (!match) {
      openProfileModal(profile.id)
      return
    }
    if (match.id === profile.id) {
      deps.showToast({ message: `${match.displayName} is already the active profile`, variant: "info" })
      return
    }
    switchProfile(match.id, match.displayName)
  }

  function selectProfileRow(rowIndex: number): void {
    const row = result().rows[rowIndex]
    if (row?.kind !== "option") return
    setCursor(rowIndex)
    close()
    // Re-selecting the active profile is a plain dismissal, not a switch.
    if (row.option.value !== deps.auth()?.profile.id) switchProfile(row.option.value, row.option.title)
  }

  const handleKey = createListModalKeys({
    rows: () => result().rows,
    cursor,
    setCursor,
    onSelect: selectProfileRow,
    onClose: () => deps.modal.clear(),
    extra: (evt) => {
      if (evt.name.toLowerCase() !== "left") return false
      evt.preventDefault?.()
      close()
      return true
    },
  })

  return {
    profileModalResult: result,
    profileModalCursor: cursor,
    profileModalCurrent: () => deps.auth()?.profile.id,
    openProfileSwitcher,
    selectProfileRow,
  }
}
