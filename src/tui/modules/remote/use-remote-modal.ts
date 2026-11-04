import { createMemo, createSignal, onCleanup, type Accessor, type JSX } from "solid-js"
import { errorMessage } from "../../../infra/error-message.js"
import type { RuntimeClient } from "../../../protocol/app-service-types.js"
import { lostWithLane } from "../../../protocol/client/connection-failures.js"
import { UNANSWERED_ACTION } from "../../../protocol/client/runtime-fault-copy.js"
import type { RuntimeRemoteView } from "../../../protocol/modules/remote.js"
import { createListModalKeys } from "../../components/modal-list-keys.js"
import { firstSelectableRow } from "../../components/modal-select-helpers.js"
import type { ModalContext, ModalHandle } from "../../components/modal-stack.js"
import { createControlledTextEditor, SINGLE_LINE_TEXT_ENTRY_POLICY, type TextEditorPresentation } from "../../keymap/text-entry.js"
import type { ToastOptions } from "../../utils/toast-presenter.js"
import { createTerminalSettingEdit } from "../../hooks/terminal-setting-edit.js"
import type { SettingsEditResult } from "../../hooks/settings-modal-types.js"

/** A device row being renamed in place: which device, and the text so far. */
export interface RemoteRenameState {
  readonly deviceId: string
  readonly presentation: TextEditorPresentation
  readonly error?: string
  readonly saving?: boolean
}

export interface RemoteModalHook {
  cursor: Accessor<number>
  /** A clock that ticks while the modal is open, so the pairing countdown moves. */
  now: Accessor<number>
  rename: Accessor<RemoteRenameState | undefined>
  renameSaving(deviceId: string): boolean
  processInitiationPending: Accessor<boolean>
  closeRemoteModal(): void
  openRemoteModal(): void
  select(index: number): void
  finishRename(): void
}

type RemoteRow =
  | { readonly kind: "device"; readonly device: RuntimeRemoteView["devices"][number] }
  | { readonly kind: "project"; readonly project: RuntimeRemoteView["projects"][number] }

/** The `/remote` modal's state and keys. `d` removes the selected device or
 *  dormant project, `r` renames a selected device, and `i` installs or removes
 *  Process initiation that lets a phone start Flywheel here. The current
 *  project remains a reading because its live runtime is still offering it.
 *  Every action is a runtime mutation; the modal holds only ephemeral input
 *  and in-flight state. */
export function useRemoteModal(deps: {
  modal: Pick<ModalContext, "replace">
  renderModal: () => JSX.Element
  view: Accessor<RuntimeRemoteView | undefined>
  currentProjectRoot: Accessor<string>
  appService: Pick<RuntimeClient, "dispatch">
  showToast: (toast: ToastOptions) => void
}): RemoteModalHook {
  const [cursor, setCursor] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const [renaming, setRenaming] = createSignal<{ deviceId: string; value: string; error?: string } | undefined>()
  const [processInitiationPending, setProcessInitiationPending] = createSignal(false)
  const devices = createMemo(() => deps.view()?.devices ?? [])
  const projects = createMemo(() => deps.view()?.projects ?? [])
  const rows = createMemo<readonly RemoteRow[]>(() => [
    ...devices().map((device) => ({ kind: "device", device }) as const),
    ...projects().map((project) => ({ kind: "project", project }) as const),
  ])
  const selectable = (row: RemoteRow): boolean => row.kind === "device" || row.project.projectRoot !== deps.currentProjectRoot()
  const clampedCursor = createMemo(() => {
    const row = rows()[cursor()]
    return row !== undefined && selectable(row) ? cursor() : firstSelectableRow(rows(), selectable)
  })
  const renameEditor = createControlledTextEditor({
    value: () => renaming()?.value ?? "",
    setValue: (value) => setRenaming((state) => state ? { deviceId: state.deviceId, value } : state),
    policy: SINGLE_LINE_TEXT_ENTRY_POLICY,
  })
  const rename = createMemo<RemoteRenameState | undefined>(() => {
    const state = renaming()
    return state ? { deviceId: state.deviceId, presentation: renameEditor.presentation(), saving: completion.saving(state.deviceId), ...(state.error === undefined ? {} : { error: state.error }) } : undefined
  })
  let active = true
  onCleanup(() => { active = false })
  let handle: ModalHandle | undefined
  const closeRemoteModal = (): void => { handle?.close(); handle = undefined; stopTicking() }
  onCleanup(closeRemoteModal)
  let ticker: ReturnType<typeof setInterval> | undefined
  const stopTicking = (): void => {
    if (ticker !== undefined) clearInterval(ticker)
    ticker = undefined
  }
  onCleanup(stopTicking)

  const report = (result: Promise<{ readonly kind: "committed" } | { readonly kind: "rejected"; readonly message: string }>, done: string, rejected?: (message: string) => string, settled?: () => void): void => {
    void result.then(
      (outcome) => {
        if (!active) return
        if (outcome.kind === "rejected") deps.showToast({ message: rejected?.(outcome.message) ?? outcome.message, variant: "error" })
        else if (done) deps.showToast({ message: done, variant: "success" })
        settled?.()
      },
      (error: unknown) => {
        if (!active) return
        // An action its lane took down did not run: the runtime does not
        // answer, which the fault notice explains in its own words.
        const message = lostWithLane(error) ? UNANSWERED_ACTION : rejected?.(errorMessage(error)) ?? errorMessage(error)
        deps.showToast({ message, variant: "error" })
        settled?.()
      },
    )
  }

  function select(index: number): void {
    completion.finish(true)
    const row = rows()[index]
    if (row !== undefined && selectable(row)) setCursor(index)
  }

  const completion = createTerminalSettingEdit({
    target: () => {
      const state = renaming()
      if (!state) return undefined
      const deviceId = state.deviceId
      const current = () => devices().find((device) => device.id === deviceId)?.label ?? ""
      return { id: deviceId, edit: {
        hint: "Enter a device name.", current, initialDraft: current,
        submit: (draft: string): SettingsEditResult | Promise<SettingsEditResult> => {
          const label = draft.trim()
          if (!label) return { ok: false, error: "Enter a device name" }
          return deps.appService.dispatch({ type: "remote.device.rename", deviceId, label }).then((result): SettingsEditResult =>
            result.kind === "committed" ? { ok: true } : { ok: false, error: result.message },
          ).catch((error: unknown): SettingsEditResult => ({ ok: false, error: lostWithLane(error) ? UNANSWERED_ACTION : errorMessage(error) }))
        },
      } }
    },
    draft: () => renaming()?.value ?? "",
    leave: () => setRenaming(undefined),
    setError: (error) => setRenaming((state) => state ? { ...state, error } : state),
    onError: (message) => { if (active) deps.showToast({ message, variant: "error" }) },
  })

  const handleKey = createListModalKeys({
    rows,
    cursor: clampedCursor,
    setCursor,
    selectable,
    onSelect: () => {},
    onClose: () => {
      stopTicking()
      closeRemoteModal()
    },
    extra: (event) => {
      if (renaming()) {
        return completion.handleKey(event, renameEditor) !== "leave" || !["up", "down"].includes(event.name)
      }
      const key = event.name.toLowerCase()
      const selected = rows()[clampedCursor()]
      if (key === "p") {
        event.preventDefault?.()
        report(deps.appService.dispatch({ type: "remote.pair.open" }), "")
        return true
      }
      if (key === "c") {
        event.preventDefault?.()
        report(deps.appService.dispatch({ type: "remote.pair.cancel" }), "Pairing window closed")
        return true
      }
      if (key === "d") {
        event.preventDefault?.()
        if (selected?.kind === "device") {
          report(deps.appService.dispatch({ type: "remote.device.revoke", deviceId: selected.device.id }), `${selected.device.label} unpaired`)
        } else if (selected?.kind === "project" && selectable(selected)) {
          report(deps.appService.dispatch({ type: "remote.project.forget", placementId: selected.project.placementId }), `${selected.project.projectLabel} is no longer offered`)
        }
        return true
      }
      if (key === "r") {
        event.preventDefault?.()
        if (selected?.kind === "device") {
          setRenaming({ deviceId: selected.device.id, value: selected.device.label })
          completion.begin()
          renameEditor.resetEphemeralState({ cursor: selected.device.label.length })
        }
        return true
      }
      if (key === "i") {
        event.preventDefault?.()
        const state = deps.view()?.processInitiation
        if (state === undefined || processInitiationPending()) return state !== undefined
        const enabled = state !== "on"
        setProcessInitiationPending(true)
        report(
          deps.appService.dispatch({ type: "remote.process_initiation.set", enabled }),
          state === "unavailable" ? "Process initiation repaired" : enabled ? "Process initiation: on" : "Process initiation: off",
          state === "unavailable"
            ? (message) => `${message}. Run \`flywheel serve install\` on this machine. If that command also fails, report a bug.`
            : undefined,
          () => setProcessInitiationPending(false),
        )
        return true
      }
      return false
    },
  })

  function openRemoteModal(): void {
    handle?.close()
    setCursor(firstSelectableRow(rows(), selectable))
    setRenaming(undefined)
    setNow(Date.now())
    stopTicking()
    ticker = setInterval(() => setNow(Date.now()), 1_000)
    handle = deps.modal.replace(deps.renderModal, {
      onKey: handleKey,
      onPaste: (text) => { const state = renaming(); if (state && !completion.saving(state.deviceId)) renameEditor.handlePaste(text) },
      onClose: () => { completion.finish(true); stopTicking() },
    })
  }

  return {
    cursor: clampedCursor,
    now,
    rename,
    renameSaving: completion.saving,
    processInitiationPending,
    closeRemoteModal,
    openRemoteModal,
    select,
    finishRename: () => completion.finish(true),
  }
}
