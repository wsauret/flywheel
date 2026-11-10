import { createContext, createEffect, createMemo, createSelector, createSignal, on, onCleanup, Show, useContext, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

import { formatElapsed } from "../../../src/protocol/client/format.js"
import { formatClockParts } from "../client/format-time.js"
import { copyFrom } from "./copy.js"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import { toolActivity, toolProcess } from "../../../src/protocol/client/transcript-model.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"

/** Keeps a block's time inputs scalar while its body streams. */
export function BlockTime(props: {
  block: FrontendOutputBlock
  processStatus?: Pick<StatusView, "activeBackgroundCommands" | "activeForegroundBashToolCallIds"> | undefined
  inline?: boolean | undefined
}) {
  const running = createMemo(() => {
    const block = props.block
    return block.kind === "tool" ? toolActivity(block, toolProcess(props.processStatus, block.id)).active : block.kind === "thinking" && block.status === "streaming"
  })
  // Persisted assistant parts carry their entry's append time after streaming, not stream start.
  const timestamp = createMemo(() => props.block.timestamp)
  const identity = createMemo(() => blockIdentity(props.block))
  return <RowTime timestamp={timestamp()} id={identity()} running={running()} inline={props.inline}
    text={props.block.kind === "userMessage" || props.block.kind === "text" ? props.block.content : undefined} />
}

/** Publishes only changed temporal meanings, not fresh transcript objects. */
export function createTranscriptTiming(clockRunning: Accessor<boolean>) {
  const [now, setNow] = createSignal(Date.now())
  createEffect(on(clockRunning, running => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  }))
  const [ends, setEnds] = createStore<{ [id: string]: number | undefined }>({})
  const [runningIds, setRunningIds] = createSignal<ReadonlySet<string>>(new Set(), {
    equals: (left, right) => left.size === right.size && [...left].every(id => right.has(id)),
  })
  const running = createSelector(runningIds, (id: string, ids) => ids.has(id))
  return {
    now,
    end: (id: string) => ends[id],
    running,
    publish(endTimes: ReadonlyMap<string, number | undefined>, ids: ReadonlySet<string>) {
      setEnds(reconcile(Object.fromEntries(endTimes)))
      setRunningIds(ids)
    },
  }
}

/** The transcript owns one clock. Only running time labels subscribe to it. */
export const TranscriptClock = createContext<{
  now: Accessor<number>
  end: (id: string) => number | undefined
  running?: (id: string) => boolean
}>()

/** Absolute start and wire-derived duration, without a layout row of its own. */
export function RowTime(props: { timestamp: number; end?: number | undefined; id?: string; running?: boolean; always?: boolean; inline?: boolean | undefined; text?: string | undefined; duration?: string | undefined }) {
  const clock = useContext(TranscriptClock)
  // A caller's conditional prop compiles to a getter that creates a memo on each read.
  // The Copy handler runs with no owner, so it reads this owned memo, never the prop.
  const text = createMemo(() => props.text)
  const start = createMemo(() => formatClockParts(props.timestamp))
  const duration = createMemo(() => {
    if (props.duration !== undefined) return props.duration
    const running = props.running || (props.id !== undefined && clock?.running?.(props.id))
    const end = running ? (clock?.now() ?? Date.now()) : props.end ?? (props.id === undefined ? undefined : clock?.end(props.id))
    return end === undefined || end <= props.timestamp ? undefined : formatElapsed(end - props.timestamp)
  })
  return <span class="row-meta" classList={{ "live-time": props.always === true, "inline-time": props.inline === true }}>
    <time class="row-time" dateTime={new Date(props.timestamp).toISOString()}>
      <Show when={start().date}>{date => <><span class="row-date">{date()}</span><span class="row-date-separator">{" · "}</span></>}</Show>
      <span class="row-clock">{start().time}<Show when={duration() !== undefined}><span class="row-duration"><span class="row-time-separator">{" · "}</span>{duration()}</span></Show></span>
    </time>
    <Show when={text() !== undefined}>
      <button type="button" class="ghost-text message-copy" aria-label="Copy message" onClick={(event) => { void copyFrom(event.currentTarget, text()!) }}>Copy</button>
    </Show>
  </span>
}
