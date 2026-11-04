import { createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import type { RuntimeAuthProfileView } from "../../../../src/protocol/auth-status-protocol-types.js"
import type { RuntimeAuthProfileDeletionPreview, RuntimeAuthProfileMutation } from "../../../../src/protocol/auth-profile-selection-protocol-types.js"
import { actionKey } from "../../client/action-key.js"
import { describeFailure } from "../../client/failure-message.js"
import { useClient } from "../client-context.js"
import { Sheet, SheetLoading, SheetRow } from "./sheet.js"
import { SheetField } from "./controls.js"
import { KERNEL_COMMAND_NAMES } from "../../../../src/protocol/command-names.js"

/** Auth profiles: which set of credentials this project uses.
 *
 *  Credentials are stored per profile and account-global, so signing in once
 *  covers every project. A profile is how someone keeps a work account and a
 *  personal one apart, and binding one to a project is how they stop choosing
 *  between them by hand every time they open it. All six operations live in
 *  one sheet: they are one small domain, and a person managing profiles is
 *  usually doing more than one of them in a sitting. */

const DEFAULTS = { kind: "defaults" } as const

type DeletionConfirmation = { id: string; displayName: string } & (
  | { phase: "loading"; preview?: never; successorId?: never; error?: never }
  | { phase: "preview-error"; error: string; preview?: never; successorId?: never }
  | { phase: "ready" | "deleting"; preview: RuntimeAuthProfileDeletionPreview; successorId?: string; error?: string }
)

function describeSource(source: string): string {
  switch (source) {
    case "environment":
      return "selected by an environment variable"
    case "project":
      return "pinned to this project"
    case "sticky":
      return "last used here"
    default:
      return "the account default"
  }
}

export function ProfilesSheet() {
  const client = useClient()
  const profile = (): RuntimeAuthProfileView | undefined => client.state().authStatus?.auth.profile
  /** Which profile to delete is a second list, shown in place of the first. */
  const [deleting, setDeleting] = createSignal(false)
  const [confirmation, setConfirmation] = createSignal<DeletionConfirmation>()
  // Cancel takes focus when the confirmation changes phase. Choosing a
  // successor rewrites the confirmation in the same phase, and `on` would
  // rerun for it and pull focus off the choice; the memo passes on only a
  // new phase.
  const confirmationPhase = createMemo(() => confirmation()?.phase)
  const pending = () => confirmation()?.phase === "deleting"
  let attempt = 0
  onCleanup(() => { attempt++ })

  const failed = (verb: string) => (cause: unknown) => client.report("warning", `Flywheel could not ${verb}: ${describeFailure(cause)}`)
  const mutate = async (command: RuntimeAuthProfileMutation, success?: string) => {
    const result = await client.connection.dispatch(command)
    if ("ok" in result && !result.ok) throw new Error(result.error)
    const warning = "warning" in result ? result.warning : undefined
    if (warning !== undefined) client.report("warning", warning)
    else if (success !== undefined) client.report("info", success)
  }
  const deletionDetail = () => {
    const preview = confirmation()?.preview
    const destination = preview?.kind === "automatic" ? `Sessions will move to ${preview.successor.displayName}. ` : preview?.kind === "fresh-default" ? "A fresh Default will be created. Sessions will move to it. " : ""
    return `${destination}Credentials and profile settings will be removed.`
  }
  const deletionCandidates = () => {
    const preview = confirmation()?.preview
    return preview?.kind === "choose" ? preview.candidates : undefined
  }

  // Each row works from its tap, or from its dialog's answer, until the
  // runtime answers the change.
  const selectKey = (id: string) => actionKey("profile-select", id)
  const pinKey = actionKey("profile-pin")
  const createKey = actionKey("profile-create")
  const renameKey = (id: string) => actionKey("profile-rename", id)

  const select = (id: string, displayName: string) => {
    void client.actions.run(selectKey(id), () => mutate({ type: "auth.profile.select", scope: DEFAULTS, id }, `Flywheel is using the ${displayName} profile.`), failed("switch profiles"))
  }
  // `/profile <name>` switches to the profile of that name, as in the
  // terminal; a name no profile has leaves the sheet open to choose from.
  createEffect(on(client.sheetFocus, (intent) => {
    if (intent?.kind !== "switch-profile") return
    const current = untrack(profile)
    const wanted = intent.name.trim().toLowerCase()
    const match = current?.availableProfiles.find((available) => available.displayName.toLowerCase() === wanted)
    if (current === undefined || match === undefined) return
    if (match.id === current.id) client.report("info", `${match.displayName} is already the active profile`)
    else select(match.id, match.displayName)
  }))

  const togglePin = (current: RuntimeAuthProfileView) => {
    void client.actions.run(pinKey, () => current.projectBinding === undefined
      ? mutate({ type: "auth.profile.bind_current_project", scope: DEFAULTS, id: current.id }, `This project now always uses ${current.displayName}.`)
      : mutate({ type: "auth.profile.unbind_current_project", scope: DEFAULTS }, "This project follows the selected profile again."), failed("change the project's profile"))
  }

  const create = () => {
    const run = async () => {
      const name = await client.prompt({ title: "New auth profile", detail: "A separate set of credentials, such as a work account beside a personal one.", placeholder: "Name", confirmLabel: "Create", validate: (value) => (value.trim().length === 0 ? "A profile needs a name." : undefined) })
      if (name === undefined) return
      await client.actions.run(createKey, () => mutate({ type: "auth.profile.create", scope: DEFAULTS, displayName: name.trim() }, `Created the ${name.trim()} profile. Connect a provider to it next.`), failed("create the profile"))
    }
    void run().catch(failed("create the profile"))
  }

  const remove = (id: string, displayName: string) => {
    if (pending() || profile()?.source === "environment") return
    const owner = ++attempt
    setConfirmation({ id, displayName, phase: "loading" })
    const run = async () => {
      try {
        const preview = await client.connection.query({ type: "authProfileDeletionPreview", id })
        if (owner === attempt) setConfirmation({ id, displayName, phase: "ready", preview })
      } catch (cause) {
        if (owner === attempt) setConfirmation({ id, displayName, phase: "preview-error", error: describeFailure(cause) })
      }
    }
    void run()
  }
  const cancelDelete = () => {
    if (pending()) return
    attempt++
    setConfirmation(undefined)
    setDeleting(false)
  }
  const submitDelete = async () => {
    const current = confirmation()
    if (current?.phase !== "ready") return
    const preview = current.preview
    const successorId = preview.kind === "fresh-default" ? null : preview.kind === "automatic" ? preview.successor.id : current.successorId
    if (successorId === undefined) return
    setConfirmation({ ...current, phase: "deleting" })
    try {
      await mutate({ type: "auth.profile.delete", scope: DEFAULTS, id: current.id, successorId })
      setConfirmation(undefined)
      setDeleting(false)
    } catch (cause) {
      setConfirmation({ ...current, error: describeFailure(cause) })
    }
  }

  return (
    <Sheet
      title={confirmation() ? "Delete profile" : deleting() ? "Delete which profile?" : KERNEL_COMMAND_NAMES.profile}
      onClose={() => confirmation() ? cancelDelete() : client.closeSheet()}
      tools={<Show when={deleting() && !confirmation()}><button class="ghost-text" onClick={() => setDeleting(false)}>Back</button></Show>}
    >
      <Show when={confirmation()} fallback={
      <Show when={profile()} fallback={<SheetLoading />}>
        {(current) => (
          <Show when={deleting()} fallback={
            <>
              <Show when={current().source === "environment"}>
                <SheetRow label="Profile changes are locked" detail="Unset FLYWHEEL_AUTH_PROFILE to create, switch, rename, or delete profiles." />
              </Show>
              <Show when={current().availableProfiles.length > 1}>
                <div class="sheet-section">Switch to</div>
                <Key each={current().availableProfiles} by="id">
                  {(candidate) => (
                    <SheetRow
                      label={<>{candidate().id === current().id ? "✓ " : ""}{candidate().displayName}</>}
                      detail={candidate().id === current().id ? describeSource(current().source) : undefined}
                      working={client.actions.working(selectKey(candidate().id))}
                      onClick={candidate().id === current().id ? undefined : () => select(candidate().id, candidate().displayName)}
                    />
                  )}
                </Key>
              </Show>
              <div class="sheet-section">{current().displayName}</div>
              <SheetRow
                label={current().projectBinding === undefined ? "Always use this profile for this project" : "Stop pinning a profile to this project"}
                detail={current().projectBinding === undefined ? "This project follows whichever profile is selected. Pin it to stop choosing." : `This project is pinned to ${current().projectBinding}.`}
                working={client.actions.working(pinKey)}
                onClick={() => togglePin(current())}
              />
              <SheetRow label="New profile…" detail="A separate set of credentials, such as a work account beside a personal one" working={client.actions.working(createKey)} onClick={create} />
              <Key each={[current()]} by="id">{(owner) => <SheetRow label="Profile name">
                <SheetField label="Profile name" value={owner().displayName}
                  working={client.actions.working(renameKey(owner().id))}
                  validate={(value) => value.trim() ? undefined : "A profile needs a name."}
                  onCommit={(name) => { const id = owner().id; return client.actions.run(renameKey(id), () => mutate({ type: "auth.profile.rename", scope: DEFAULTS, id, displayName: name.trim() }), failed("rename the profile")) }} />
              </SheetRow>}</Key>
              <Show when={current().source !== "environment"}>
                <SheetRow label="Delete a profile…" detail="Its stored credentials go with it" tone="warn" onClick={() => setDeleting(true)} />
              </Show>
              <div class="sheet-section">Credentials are stored per profile and shared across projects</div>
            </>
          }>
            <Key each={current().availableProfiles} by="id">
              {(candidate) => <SheetRow label={candidate().displayName} onClick={() => remove(candidate().id, candidate().displayName)} />}
            </Key>
          </Show>
        )}
      </Show>
      }>
        {(current) => <>
          <SheetRow label={`Delete ${current().displayName}?`} detail={deletionDetail()} />
          <Show when={deletionCandidates()}>{(candidates) =>
            <label class="sheet-section">Move sessions to
              <select class="sheet-input" required disabled={pending()} value={current().successorId ?? ""} onChange={(event) => {
                const view = confirmation()
                if (view?.phase === "ready") setConfirmation({ ...view, successorId: event.currentTarget.value })
              }}>
                <option value="" disabled>Choose a profile</option>
                <Key each={candidates()} by="id">{(candidate) => <option value={candidate().id}>{candidate().displayName}</option>}</Key>
              </select>
            </label>
          }</Show>
          <Show when={current().phase === "loading"}><SheetLoading /></Show>
          <Show when={current().error}><SheetRow label={current().error} tone="error" /></Show>
          <Show when={!pending()} fallback={<div class="sheet-section" role="status">Deleting...</div>}>
            <button class="ghost-text" ref={(button) => createEffect(on(confirmationPhase, () => button.focus()))} onClick={cancelDelete}>Cancel</button>
            <Show when={current().phase !== "preview-error"} fallback={<button class="ghost-text" onClick={() => remove(current().id, current().displayName)}>Retry</button>}>
              <button class="ghost-text" disabled={current().phase !== "ready" || (current().preview?.kind === "choose" && !current().successorId)} onClick={() => { void submitDelete() }}>Delete</button>
            </Show>
          </Show>
        </>}
      </Show>
    </Sheet>
  )
}
