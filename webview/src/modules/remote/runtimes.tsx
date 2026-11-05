import { createSignal, onCleanup, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import { lingerNotice } from "../../../../src/protocol/client/process-initiation-copy.js"
import { canCreateProject, creationDetail, creationOn, machineStatus, projectPlacements, projectStatus, type RemoteRuntimeSummary } from "../../../../src/protocol/modules/remote/machine-picker.js"
import type { Placement } from "../../../../src/protocol/modules/remote/relay-protocol.js"
import type { RemoteHostCapability, RemoteHostSnapshot } from "../../host.js"
import { useClient } from "../../app/client-context.js"
import { actionKey } from "../../client/action-key.js"
import { InstallGuide } from "./install-guide.js"
import { Icon, ICONS, Mark } from "../../app/icons.js"
import { Sheet, SheetEmpty } from "../../app/sheets/sheet.js"
import { SheetField } from "../../app/sheets/controls.js"
import "./runtimes.css"

/** The machines this device can reach, and how to add one.
 *
 *  Present only under a host with the `remote` capability: the phone. The
 *  editor has one runtime and no pairing, so it never renders this. The stage
 *  takes the whole surface while nothing is selected or the selected machine is
 *  asleep, because until a runtime answers there is nothing behind it a person
 *  could use; the sheet is the same list reached from the command panel once
 *  one is. */

/** The capability's snapshot as a Solid signal for the life of the component. */
function useRemoteSnapshot(remote: RemoteHostCapability) {
  const [snapshot, setSnapshot] = createSignal<RemoteHostSnapshot>(remote.snapshot())
  onCleanup(remote.onChange(setSnapshot))
  return snapshot
}

function presenceLabel(runtime: RemoteRuntimeSummary): string {
  const status = machineStatus(runtime)
  if (status.kind === "checking") return "checking"
  if (status.kind === "offline") return "asleep"
  if (status.open === 0) return "awake, nothing open"
  return status.open === 1 ? "1 project open" : `${status.open} projects open`
}

/** What a placement row says under its name: where it runs when a runtime
 *  serves it, otherwise what the machine's remote host is doing about it. */
function placementDetail(placement: Placement, snapshot: RemoteHostSnapshot, runtimeId: string) {
  switch (projectStatus(snapshot, runtimeId, placement)) {
    case "open": return { text: "Open", warn: false }
    case "starting": return { text: "Starting Flywheel on the machine...", warn: false }
    case "failed": return { text: "Could not start Flywheel on the machine. Tap to try again.", warn: true }
    case "asleep": return { text: "Asleep. Tap to start.", warn: false }
  }
}

/** Creating a project on a machine from a repository (PI-REMOTE-021): the
 *  row of the project being created, and the form that names a repository.
 *  The machine clones it with its own git access and derives the folder, so
 *  the person names only the repository. */
function NewProject(props: { readonly remote: RemoteHostCapability; readonly snapshot: RemoteHostSnapshot; readonly runtime: RemoteRuntimeSummary; readonly onSelected?: () => void }) {
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const [open, setOpen] = createSignal(false)
  const [repository, setRepository] = createSignal("")
  const creation = () => creationOn(props.snapshot, props.runtime.runtimeId)
  const working = () => {
    const current = creation()
    return current !== undefined && current.status !== "failed"
  }
  const create = async () => {
    const text = repository().trim()
    if (text.length === 0 || working()) return
    try {
      await props.remote.createProject(props.runtime.runtimeId, text)
    } catch {
      // The row under the form says why; the form keeps the text to correct.
      return
    }
    if (controller.signal.aborted) return
    setRepository("")
    setOpen(false)
    props.onSelected?.()
  }
  return (
    <>
      <Show when={creation()}>
        {(current) => {
          const detail = () => creationDetail(current())
          return (
            <div class="placement creating" role="status">
              <span class="placement-name">{detail().name}</span>
              <span class="placement-detail plain" classList={{ warn: detail().warn }}>{detail().text}</span>
            </div>
          )
        }}
      </Show>
      <Show when={open()} fallback={<button class="ghost-text new-project-open" onClick={() => setOpen(true)}>New project from repository</button>}>
        <form class="new-project-form" onSubmit={(event) => { event.preventDefault(); void create() }}>
          <input class="pair-input" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck={false} enterkeyhint="go" placeholder="owner/repo or a git URL" aria-label={`Repository to clone on ${props.runtime.label}`} value={repository()} onInput={(event) => setRepository(event.currentTarget.value)} />
          <button class="secondary" type="submit" disabled={working() || repository().trim().length === 0} aria-busy={working() || undefined}>Clone</button>
          <button class="ghost-text" type="button" onClick={() => setOpen(false)}>Cancel</button>
        </form>
      </Show>
    </>
  )
}

function RuntimeList(props: { readonly remote: RemoteHostCapability; readonly snapshot: RemoteHostSnapshot; readonly onSelected?: () => void }) {
  const client = useClient()
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  // Forgetting works from the confirmation until the machine or the runtime answers.
  const forgetKey = (runtime: RemoteRuntimeSummary) => actionKey("remote.forget-machine", runtime.runtimeId)
  const forgetProjectKey = (placement: Placement) => actionKey("remote.forget-project", placement.id)
  const forget = async (runtime: RemoteRuntimeSummary) => {
    const confirmed = await client.confirm({ title: `Forget ${runtime.label}?`, detail: "This phone will no longer be able to reach it. Pair again from the machine to restore access.", confirmLabel: "Forget", destructive: true }, controller.signal)
    if (confirmed && !controller.signal.aborted) await client.actions.run(forgetKey(runtime), () => props.remote.forget(runtime.runtimeId))
  }
  // The runtime this phone is attached to speaks for its machine: its remote
  // view says whether that machine starts runtimes for phones, and it takes the
  // request to stop offering one of that machine's projects.
  const attachedTo = (runtime: RemoteRuntimeSummary) => props.snapshot.selected?.runtimeId === runtime.runtimeId ? client.state().modules.remote : undefined
  const forgetProject = async (placement: Placement) => {
    const confirmed = await client.confirm({ title: `Stop offering ${placement.projectLabel}?`, detail: "Phones will no longer be able to start Flywheel for this project. Opening it on the machine while paired offers it again.", confirmLabel: "Stop offering", destructive: true }, controller.signal)
    if (!confirmed || controller.signal.aborted) return
    await client.actions.run(forgetProjectKey(placement), async () => {
      const result = await client.connection.dispatch({ type: "remote.project.forget", placementId: placement.id })
      if (!controller.signal.aborted && result.kind === "rejected") client.report("warning", result.message)
    })
  }
  return (
    <div class="runtime-list" role="list">
      <Key each={props.snapshot.runtimes} by="runtimeId">
        {(runtime) => (
          <div class="runtime" role="listitem">
            <div class="runtime-head">
              <span class="runtime-name">{runtime().label}</span>
              <span class="runtime-presence" classList={{ online: machineStatus(runtime()).kind === "awake" }}>{presenceLabel(runtime())}</span>
              <button class="row-action" title={`Forget ${runtime().label}`} aria-label={`Forget ${runtime().label}`} aria-busy={client.actions.working(forgetKey(runtime())) || undefined} onClick={() => { void forget(runtime()) }}>
                <Icon path={ICONS.close} size={13} />
              </button>
            </div>
            <Show when={runtime().placements.length > 0} fallback={<p class="runtime-note">Wake the machine, or open Flywheel on it, and it appears here. With Remote process initiation on in Flywheel's Remote view, an awake machine lists its projects here even when Flywheel is closed.</p>}>
              <div class="placement-list">
                <Key each={projectPlacements(runtime())} by="id">
                  {(placement) => {
                    const selected = () => props.snapshot.selected?.runtimeId === runtime().runtimeId && props.snapshot.selected.placementId === placement().id
                    const detail = () => placementDetail(placement(), props.snapshot, runtime().runtimeId)
                    return (
                      <div class="placement-row">
                        <button class="placement" classList={{ selected: selected(), dormant: placement().state === "dormant" }} onClick={() => { props.remote.select({ runtimeId: runtime().runtimeId, placementId: placement().id }); props.onSelected?.() }}>
                          <span class="placement-name">{placement().projectLabel}</span>
                          <span class="placement-detail" classList={{ warn: detail().warn, plain: placement().state === "dormant" }}>{detail().text}</span>
                          <span class="placement-version">{placement().state === "live" ? placement().version : "asleep"}</span>
                        </button>
                        <Show when={placement().state === "dormant" && attachedTo(runtime()) !== undefined}>
                          <button class="row-action" title={`Stop offering ${placement().projectLabel}`} aria-label={`Stop offering ${placement().projectLabel}`} aria-busy={client.actions.working(forgetProjectKey(placement())) || undefined} onClick={() => { void forgetProject(placement()) }}>
                            <Icon path={ICONS.close} size={13} />
                          </button>
                        </Show>
                      </div>
                    )
                  }}
                </Key>
                <Show when={canCreateProject(runtime())}>
                  <NewProject remote={props.remote} snapshot={props.snapshot} runtime={runtime()} {...(props.onSelected === undefined ? {} : { onSelected: props.onSelected })} />
                </Show>
              </div>
            </Show>
            <Show when={attachedTo(runtime())}>
              {(remote) => <Show when={remote().processInitiation}>{(state) => <>
                <p class="runtime-note">{state() === "unavailable" ? "Process initiation is unavailable. Open this machine's Remote view to repair it." : state() === "on" ? "Process initiation: on. This machine starts Flywheel for a project you tap while it is awake." : "Process initiation: off. Turn it on with /remote in Flywheel, or `flywheel serve install`."}</p>
                <Show when={remote().lingerOffFor}>{(user) => <p class="runtime-note warn">{lingerNotice(user())}</p>}</Show>
              </>}</Show>}
            </Show>
          </div>
        )}
      </Key>
    </div>
  )
}

function PairPanel(props: { readonly remote: RemoteHostCapability; readonly snapshot: RemoteHostSnapshot }) {
  const client = useClient()
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const [code, setCode] = createSignal("")
  const pairing = () => props.snapshot.pairing
  const failure = () => {
    const current = pairing()
    return current.status === "failed" ? current.message : undefined
  }
  const pair = async (text: string) => {
    if (text.trim().length === 0 || controller.signal.aborted) return
    try {
      await props.remote.pair(text.trim())
      if (controller.signal.aborted) return
      setCode("")
      client.report("info", "Paired.")
    } catch (cause) {
      if (!controller.signal.aborted) client.report("warning", cause instanceof Error ? cause.message : String(cause))
    }
  }
  const scan = async () => {
    const read = await props.remote.scan?.()
    if (read !== undefined) await pair(read)
  }
  return (
    <div class="pair-panel">
      <p class="pair-lead">On the machine, run <code>flywheel remote pair</code> or type <code>/remote</code> in Flywheel, then scan the code it shows.</p>
      <div class="pair-name">
        <span>This phone's name, as the machine will list it</span>
        <SheetField label="This phone's name" value={props.snapshot.deviceLabel} fullWidth
          working={client.actions.working(actionKey("remote.phone-label"))}
          onCommit={(label) => client.actions.run(actionKey("remote.phone-label"), () => props.remote.setLabel(label), (cause) => client.report("warning", `Flywheel could not name this phone: ${cause instanceof Error ? cause.message : String(cause)}`))} />
      </div>
      <div class="pair-actions">
        <Show when={props.remote.scan}>
          <button class="primary" disabled={pairing().status === "pairing"} onClick={() => { void scan() }}>Scan a code</button>
        </Show>
        <form class="pair-form" onSubmit={(event) => { event.preventDefault(); void pair(code()) }}>
          <input class="pair-input" type="text" inputmode="url" autocomplete="off" placeholder="or paste the link from the code" aria-label="Pairing link" value={code()} onInput={(event) => setCode(event.currentTarget.value)} />
          <button class="secondary" type="submit" disabled={pairing().status === "pairing" || code().trim().length === 0}>Pair</button>
        </form>
      </div>
      <Show when={pairing().status === "pairing"}><p class="pair-status">Pairing with the machine...</p></Show>
      <Show when={failure()}>{(message) => <p class="pair-status warn">{message()}</p>}</Show>
    </div>
  )
}

/** The surface while there is no runtime to show. */
export function RuntimesStage(props: { readonly remote: RemoteHostCapability }) {
  const snapshot = useRemoteSnapshot(props.remote)
  return (
    <div class="stage stage-runtimes">
      <Mark />
      <div class="stage-title">{snapshot().runtimes.length === 0 ? "Pair this phone with a machine" : "Choose a project"}</div>
      <Show when={snapshot().runtimes.length > 0 ? snapshot().install : undefined}>
        {(guide) => <InstallGuide guide={guide()} onPrompt={props.remote.promptInstall} />}
      </Show>
      <Show when={snapshot().runtimes.length > 0}>
        <RuntimeList remote={props.remote} snapshot={snapshot()} />
      </Show>
      <PairPanel remote={props.remote} snapshot={snapshot()} />
      <p class="stage-note">The machine lists this phone under Remote as <strong>{snapshot().deviceLabel}</strong> and can unpair it at any time.</p>
    </div>
  )
}

/** The same list as a sheet, once a runtime is open. */
export function RuntimesSheet(props: { readonly remote: RemoteHostCapability }) {
  const client = useClient()
  const snapshot = useRemoteSnapshot(props.remote)
  return (
    <Sheet title="Machines" onClose={client.closeSheet}>
      <Show when={snapshot().runtimes.length > 0 ? snapshot().install : undefined}>
        {(guide) => <InstallGuide guide={guide()} onPrompt={props.remote.promptInstall} />}
      </Show>
      <Show when={snapshot().runtimes.length > 0} fallback={<SheetEmpty>No machine is paired with this phone.</SheetEmpty>}>
        <RuntimeList remote={props.remote} snapshot={snapshot()} onSelected={client.closeSheet} />
      </Show>
      <PairPanel remote={props.remote} snapshot={snapshot()} />
    </Sheet>
  )
}
