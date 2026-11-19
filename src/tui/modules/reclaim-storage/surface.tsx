/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createRoot, createSignal, on, onCleanup, Show } from "solid-js"
import { errorMessage } from "../../../infra/error-message.js"
import { describeReclaimOutcome, previewShowsView, RECLAIM_STORAGE_COMMAND_NAME, storageDomain } from "../../../protocol/modules/reclaim-storage.js"
import { formatStorageBytes, type StorageReclaimPreview } from "../../../protocol/store-reclaim.js"
import { Button } from "../../components/button.js"
import type { ListModalKeyEvent } from "../../components/modal-list-keys.js"
import { ModalFrame } from "../../components/modal-frame.js"
import type { ModalHandle } from "../../components/modal-stack.js"
import { useTheme } from "../../context/theme.js"
import { useModalDimensions } from "../../hooks/use-modal-dimensions.js"
import type { TuiControllerHost } from "../../tui-module.js"

type Host = Pick<TuiControllerHost, "client" | "read" | "modal">

/** The preview as the opening read it: undefined while the query runs. */
type PreviewReading = { readonly preview: StorageReclaimPreview } | { readonly error: string }
type Run = { readonly kind: "sending" } | { readonly kind: "started" } | { readonly kind: "failed"; readonly error: string }

/** One opening: it reads the preview when it opens and again whenever the
 *  live view moves past it, and Enter sends the run only while the preview
 *  allows one and no run is under way. */
function createReclaimModel(host: Host, close: () => void) {
  const [reading, setReading] = createSignal<PreviewReading>()
  const [run, setRun] = createSignal<Run>()
  let active = true
  // One read at a time; a view that moves during it is compared once it answers.
  let querying = false
  let moved = false
  let lastRunAtRead: number | null = null
  onCleanup(() => { active = false })
  const view = () => host.read(storageDomain)
  const preview = () => { const current = reading(); return current && "preview" in current ? current.preview : undefined }
  const follow = () => {
    if (querying) {
      moved = true
      return
    }
    if (!previewShowsView(preview(), lastRunAtRead, view())) readPreview()
  }
  const readPreview = () => {
    querying = true
    moved = false
    lastRunAtRead = view()?.lastReclaim?.at ?? null
    const answer = (next: PreviewReading) => {
      if (!active) return
      querying = false
      setReading(next)
      if (moved) follow()
    }
    host.client.query({ type: "storage.reclaimPreview" }).then(
      (answered) => { answer({ preview: answered }) },
      (cause: unknown) => { answer({ error: errorMessage(cause) }) },
    )
  }
  readPreview()
  // A maintenance job's report or a run's end moves the view. A run this
  // opening started is over then, and the preview reads again.
  const live = createMemo(() => { const current = view(); return current === undefined ? "" : `${current.usage?.storeBytes}/${current.usage?.reclaimableBytes}/${current.lastReclaim?.at}` })
  createEffect(on(live, () => {
    if ((view()?.lastReclaim?.at ?? null) !== lastRunAtRead && run()?.kind === "started") setRun(undefined)
    follow()
  }, { defer: true }))
  const canConfirm = () => { const current = preview(); return current != null && current.refusal === undefined && (run() === undefined || run()?.kind === "failed") }
  const confirm = () => {
    if (!canConfirm()) return
    setRun({ kind: "sending" })
    host.client.dispatch({ type: "storage.reclaim" }).then(
      (result) => { if (active) setRun(result.ok ? { kind: "started" } : { kind: "failed", error: result.error }) },
      (cause: unknown) => { if (active) setRun({ kind: "failed", error: errorMessage(cause) }) },
    )
  }
  const lastRun = () => { const last = view()?.lastReclaim; return last ? describeReclaimOutcome(last.outcome) : undefined }
  const key = (event: ListModalKeyEvent) => {
    const name = event.name.toLowerCase()
    if (name === "escape") close()
    else if (name === "return" || name === "enter") confirm()
    else return
    event.preventDefault?.()
  }
  return { reading, preview, run, canConfirm, confirm, lastRun, key, close }
}

type ReclaimModel = ReturnType<typeof createReclaimModel>

function runText(run: Run): string {
  switch (run.kind) {
    case "sending": return "Starting..."
    case "started": return "Reclaiming storage. The project opens again when it is done."
    case "failed": return run.error
  }
}

function ReclaimStorageModal(props: { model: ReclaimModel }) {
  const { theme } = useTheme()
  const { modalWidth } = useModalDimensions(72)
  const runColor = (run: Run) => run.kind === "sending" ? theme.textMuted : run.kind === "started" ? theme.success : theme.error
  const readError = () => { const current = props.model.reading(); return current && "error" in current ? current.error : undefined }
  return <ModalFrame title={RECLAIM_STORAGE_COMMAND_NAME} width={modalWidth()} onClose={props.model.close} gap={1}>
    <Show when={props.model.reading()} fallback={<text fg={theme.textMuted}>Reading storage...</text>}>
      <Show when={readError()}>{(error) => <text fg={theme.error}>{`Could not read storage: ${error()}`}</text>}</Show>
      <Show when={readError() === undefined}>
        <Show when={props.model.preview()} fallback={<text fg={theme.textMuted}>This project holds no Flywheel store, or no Flywheel service serves it.</text>}>{(preview) => <>
          <box flexDirection="column">
            <text fg={theme.text}>{`Store: ${formatStorageBytes(preview().storeBytes)}`}</text>
            <text fg={theme.text}>{`Reclaimable: ${formatStorageBytes(preview().reclaimableBytes)}`}</text>
            <text fg={theme.text}>{`Free disk: ${formatStorageBytes(preview().freeBytes)} (needs ${formatStorageBytes(preview().neededBytes)})`}</text>
            <Show when={props.model.lastRun()}>{(last) => <text fg={theme.textMuted}>{`Last run: ${last()}`}</text>}</Show>
          </box>
          <Show when={preview().refusal} fallback={
            <text fg={theme.textMuted}>The project closes while its store is rebuilt, for minutes on a large store. Its sessions pause and continue on their next message.</text>
          }>{(refusal) => <text fg={theme.warning}>{refusal()}</text>}</Show>
        </>}</Show>
      </Show>
    </Show>
    <Show when={props.model.run()}>{(run) => <text fg={runColor(run())}>{runText(run())}</text>}</Show>
    <box flexDirection="row" gap={1}>
      <Show when={props.model.canConfirm()}><Button label="Reclaim storage" hotkey="enter" onPress={props.model.confirm} /></Show>
      <Button label="Close" hotkey="esc" muted onPress={props.model.close} />
    </box>
  </ModalFrame>
}

/** The cached opener gives each modal a fresh owner and releases it on close. */
export function createReclaimStorageSurface(host: Host): () => void {
  let handle: ModalHandle | undefined
  onCleanup(() => handle?.close())
  return () => {
    handle?.close()
    createRoot((dispose) => {
      const model = createReclaimModel(host, () => opening.close())
      const opening = host.modal.replace(() => <ReclaimStorageModal model={model} />, { onKey: model.key, onClose: dispose })
      handle = opening
    })
  }
}
