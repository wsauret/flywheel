import { type Accessor, createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import type { HydratedOutputBlockBody } from "../../../src/protocol/transcript-protocol-types.js"
import type { FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import type { MutationEvidenceHandle, MutationEvidenceReader, MutationFilesView } from "../../../src/protocol/client/mutation-evidence.js"
import { turnCalls, turnChangedFiles, type TurnFold } from "../client/turn-folds.js"
import type { BlockDisclosure } from "./block-disclosure.js"
import { FileDiff } from "./file-diff.js"
import "../styles/turn-changes.css"

function mutationInputs(calls: Accessor<readonly FrontendToolEntry[]>, bodies: Accessor<{ readonly [id: string]: HydratedOutputBlockBody }>) {
  return createMemo(() => calls().map(call => ({ call, body: bodies()[call.id] })), undefined, {
    equals: (previous, next) => previous.length === next.length && previous.every((entry, index) => {
      const other = next[index]
      return other !== undefined && entry.call === other.call && entry.body === other.body
    }),
  })
}

/** Hold passive file-index handles. The visible turn acquires their bounded pages. */
export function createTurnMutationMetadata(
  calls: Accessor<readonly FrontendToolEntry[]>,
  reader: Accessor<MutationEvidenceReader | undefined>,
  bodies: Accessor<{ readonly [id: string]: HydratedOutputBlockBody }>,
) {
  const [revision, setRevision] = createSignal(0)
  let owned = new Map<string, { reader: MutationEvidenceReader; handle: MutationEvidenceHandle }>()
  const inputs = mutationInputs(calls, bodies)
  const handles = createMemo(() => {
    const source = reader()
    const next = new Map<string, { reader: MutationEvidenceReader; handle: MutationEvidenceHandle }>()
    for (const { call, body } of inputs()) {
      const evidence = body?.mutationEvidence ?? call.mutationEvidence
      if (source && evidence) next.set(call.id, { reader: source, handle: source.open(`tool:${call.id}`, evidence.manifest) })
    }
    for (const [id, previous] of owned) if (next.get(id)?.reader !== previous.reader) previous.reader.release(`tool:${id}`)
    owned = next
    return next
  })
  onCleanup(() => { for (const [id, owner] of owned) owner.reader.release(`tool:${id}`) })
  createEffect(() => {
    const source = reader()
    if (source) onCleanup(source.onChange(() => setRevision(value => value + 1)))
  })
  const metadata = createMemo(() => {
    revision()
    return new Map([...handles()].map(([id, owner]) => [id, owner.handle.files]))
  }, undefined, { equals: (a, b) => a.size === b.size && [...a].every(([id, view]) => b.get(id) === view) })
  return metadata
}

/** Ordered call diffs for one settled turn, independent of the session's net review. */
export function TurnChanges(props: {
  fold: TurnFold
  sessionId: string
  disclosure: BlockDisclosure
  bodies: { readonly [id: string]: HydratedOutputBlockBody }
  onHydrate: (blockId: string) => void
  projectRoot: string
  executionCwd: string
  evidenceReader?: MutationEvidenceReader | undefined
  metadata?: ReadonlyMap<string, MutationFilesView>
}) {
  const inputs = mutationInputs(() => turnCalls(props.fold), () => props.bodies)
  const localMetadata = createTurnMutationMetadata(
    () => props.metadata === undefined ? inputs().map(entry => entry.call) : [],
    () => props.evidenceReader,
    () => props.bodies,
  )
  const metadata = () => props.metadata ?? localMetadata()
  const references = createMemo(() => inputs().flatMap(({ call, body }) => {
    const evidence = body?.mutationEvidence ?? call.mutationEvidence
    return evidence ? [{ call, evidence, view: metadata().get(call.id) }] : []
  }))
  const incomplete = () => references().some(({ view }) => view?.status !== "ready" || view.nextOffset !== null)
  const load = (callId: string) => {
    const source = references().find(({ call }) => call.id === callId)
    if (source) void props.evidenceReader?.open(`tool:${callId}`, source.evidence.manifest).loadFiles()
  }
  const [visible, setVisible] = createSignal(false)
  let root!: HTMLElement
  onMount(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)))
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })
  createEffect(on([visible, references], ([shown, sources]) => {
    if (shown) untrack(() => { for (const source of sources) if (source.view?.status === "idle") load(source.call.id) })
  }))
  const files = createMemo(() => {
    const entries = inputs()
    return turnChangedFiles({ rows: entries.map(entry => entry.call) }, Object.fromEntries(entries.flatMap(entry => entry.body ? [[entry.call.id, entry.body]] : [])), { projectRoot: props.projectRoot, executionCwd: props.executionCwd }, metadata())
  })
  return <section ref={element => { root = element }} class="turn-changes" aria-label="Files changed in this turn">
    <Show when={files().length > 0 || references().length > 0}>
      <div class="turn-changes-title">Changed {files().length} {files().length === 1 ? "file" : "files"}{incomplete() ? " (incomplete)" : ""}</div>
      <Key each={files()} by="path">{file => {
        const key = () => `${props.fold.id}:changes:${file().path}`
        const open = () => props.disclosure.state(props.sessionId, key())().open
        const segments = () => file().path.split(/[\\/]/)
        const basename = () => segments().at(-1)
        return <div>
          <button type="button" class="turn-change-file" aria-expanded={open()} onClick={() => props.disclosure.setOpen(props.sessionId, key(), !open())}>
            <span class="chevron">{open() ? "▾" : "▸"}</span>
            <span class="turn-change-name">{basename()}<span class="turn-change-directory">{segments().slice(0, -1).join("/")}</span></span>
            <span class="turn-change-counts">
              <Show when={file().added > 0}><span class="turn-change-added">+{file().added}</span></Show>
              <Show when={file().removed > 0}><span class="turn-change-removed">-{file().removed}</span></Show>
              <Show when={(file().partial || incomplete()) && file().edits.length > 0}><span title="Counts include acquired retained lines only">partial</span></Show>
              <Show when={file().edits.length === 0}><span>not shown: {file().omissions.join(", ")}</span></Show>
            </span>
          </button>
          <Show when={open()}>
            <div class="turn-change-edits">
            <Index each={file().edits}>{edit => {
              const owner = () => `tool:${edit().callId}`
              return <FileDiff body={{ kind: "actual", mutationEvidence: edit().evidence }} evidenceReader={props.evidenceReader}
                  evidenceFile={{ entry: edit().entry, owner: owner(), handle: props.evidenceReader?.open(owner(), edit().evidence.manifest) }}
                  hideHeading fileExpanded={() => true} />
            }}</Index>
            <For each={file().omissions}>{reason => <div class="mutation-omitted">Diff not shown ({reason})</div>}</For>
            </div>
          </Show>
        </div>
      }}</Key>
      <For each={references()}>{source => <div class="omitted">
        <Show when={source.view === undefined || source.view.status === "unavailable"}>Change evidence is unavailable ({source.call.id})</Show>
        <Show when={source.view?.status === "idle" || source.view?.status === "loading"}>Loading... ({source.call.id})</Show>
        <Show when={source.view?.status === "error"}>Could not load change evidence ({source.call.id}). <button onClick={() => load(source.call.id)}>Retry</button></Show>
        <Show when={source.view?.status === "ready" && source.view.nextOffset !== null}><button onClick={() => load(source.call.id)}>More files...</button></Show>
      </div>}</For>
  </Show></section>
}
