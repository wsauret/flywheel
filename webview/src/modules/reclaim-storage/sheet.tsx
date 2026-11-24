import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { describeReclaimOutcome, previewShowsView, RECLAIM_STORAGE_COMMAND_NAME, reclaimOutcomeLabel, storageDomain, type StorageReclaimResult } from "../../../../src/protocol/modules/reclaim-storage.js"
import { formatStorageBytes, type StorageReclaimPreview } from "../../../../src/protocol/store-reclaim.js"
import { useClient } from "../../app/client-context.js"
import { Sheet, SheetEmpty, SheetLoading, SheetRow } from "../../app/sheets/sheet.js"
import { describeFailure } from "../../client/format/failure-message.js"
import "./sheet.css"

type PreviewRead =
  | { readonly kind: "read"; readonly preview: StorageReclaimPreview }
  | { readonly kind: "failed"; readonly message: string }

const NO_STORE = "This project holds no Flywheel store, or no Flywheel service serves it."
const CLOSES = "The project closes while its store is rebuilt, for minutes on a large store. Its sessions pause and continue on their next message."
const STARTED = "Reclaiming storage. The project opens again when it is done."

/** Reclaim storage: what the rebuild gives back and needs, read when the
 *  sheet opens and again whenever the live view moves past it, and the one
 *  confirmation that starts it. A started run closes the project, so the
 *  connection drops and reattaches after the answer, and the run's outcome
 *  then reaches the view. */
export function ReclaimStorageSheet() {
  const client = useClient()
  const [read, setRead] = createSignal<PreviewRead>()
  const [pending, setPending] = createSignal(false)
  const [started, setStarted] = createSignal(false)
  const [failure, setFailure] = createSignal("")
  let disposed = false
  onCleanup(() => { disposed = true })
  const live = () => !disposed && !client.signal.aborted

  const view = () => client.state().modules[storageDomain.domain] ?? undefined
  const preview = () => {
    const current = read()
    return current?.kind === "read" ? current.preview : null
  }
  // One read at a time; a view that moves during it is compared once it answers.
  let querying = false
  let moved = false
  let lastRunAtRead: number | null = null
  const follow = () => {
    if (querying) {
      moved = true
      return
    }
    if (!previewShowsView(read() === undefined ? undefined : preview(), lastRunAtRead, view())) readPreview()
  }
  const readPreview = () => {
    querying = true
    moved = false
    lastRunAtRead = view()?.lastReclaim?.at ?? null
    const answer = (next: PreviewRead) => {
      if (!live()) return
      querying = false
      setRead(next)
      if (moved) follow()
    }
    client.connection.query({ type: "storage.reclaimPreview" }).then(
      (answered) => { answer({ kind: "read", preview: answered }) },
      (cause: unknown) => { answer({ kind: "failed", message: `Flywheel could not read the store size: ${describeFailure(cause)}` }) },
    )
  }
  readPreview()
  // A maintenance job's report or a run's end moves the view. A run this
  // sheet started is over then, and the preview reads again.
  const liveSizes = createMemo(() => { const current = view(); return current === undefined ? "" : `${current.usage?.storeBytes}/${current.usage?.reclaimableBytes}/${current.lastReclaim?.at}` })
  createEffect(on(liveSizes, () => {
    if ((view()?.lastReclaim?.at ?? null) !== lastRunAtRead && started()) setStarted(false)
    follow()
  }, { defer: true }))
  const unavailable = () => {
    const current = read()
    return current?.kind === "failed" ? current.message : NO_STORE
  }
  const lastReclaim = () => view()?.lastReclaim ?? null
  const confirmable = () => {
    const current = preview()
    return current !== null && current.refusal === undefined
  }

  const reclaim = async () => {
    if (pending() || started()) return
    setPending(true)
    setFailure("")
    let result: StorageReclaimResult
    try {
      result = await client.connection.dispatch({ type: "storage.reclaim" })
    } catch (cause) {
      result = { ok: false, error: describeFailure(cause) }
    }
    if (!live()) return
    setPending(false)
    setStarted(result.ok)
    setFailure(result.ok ? "" : result.error)
  }

  // Built once, so the footer keeps this node while its state changes.
  const confirm = <button class="primary" disabled={pending() || started()} aria-busy={pending() || undefined} onClick={() => { void reclaim() }}>{RECLAIM_STORAGE_COMMAND_NAME}</button>

  return (
    <Sheet title={RECLAIM_STORAGE_COMMAND_NAME} onClose={client.closeSheet} footer={confirmable() ? confirm : undefined}>
      <div class="reclaim-storage">
        <Show when={read()} fallback={<SheetLoading />}>
          <Show when={preview()} fallback={<SheetEmpty>{unavailable()}</SheetEmpty>}>{(shown) => <>
            <div>
              <SheetRow label="Store" value={formatStorageBytes(shown().storeBytes)} />
              <SheetRow label="Reclaimable" value={formatStorageBytes(shown().reclaimableBytes)} />
              <SheetRow label="Free disk" value={`${formatStorageBytes(shown().freeBytes)} (needs ${formatStorageBytes(shown().neededBytes)})`} />
              <Show when={lastReclaim()}>{(last) => <SheetRow label="Last run" value={reclaimOutcomeLabel(last().outcome)} detail={describeReclaimOutcome(last().outcome)} />}</Show>
            </div>
            <p class={shown().refusal === undefined ? undefined : "reclaim-storage-warning"}>{shown().refusal ?? CLOSES}</p>
          </>}</Show>
        </Show>
        <p class="reclaim-storage-status" role="status" aria-live="polite" aria-busy={pending() || undefined}>{started() ? STARTED : ""}</p>
        <Show when={failure()}><p class="reclaim-storage-status reclaim-storage-error" role="alert">{failure()}</p></Show>
      </div>
    </Sheet>
  )
}
