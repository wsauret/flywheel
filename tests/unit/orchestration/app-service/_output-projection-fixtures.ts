import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedRuntime } from "effect"
import { EventStoreLive } from "../../../../src/infra/event-store-effect.js"
import { isVisibleMessageBlock, type AnyBlock } from "../../../../src/infra/output-blocks.js"
import { NO_CHANGED_TOOLS, type OutputBlockChange, type OutputChangeBatch } from "../../../../src/infra/output/output-block-delta.js"
import type { SessionEntry, SessionStore } from "../../../../src/orchestration/session-store/types.js"
import { chatEntry, fakeSessionStore } from "./app-service-doubles.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createShippedOutput } from "../../../../src/orchestration/app-service/shipped-output.js"
import type { OutputDelta } from "../../../../src/protocol/output-protocol-types.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"

export const tailRequest = { anchor: { kind: "tail" as const }, maxBlocks: 50, maxBytes: 1024 * 1024 }

export function outputProjectionRuntime() {
  const dbDirectory = mkdtempSync(join(tmpdir(), "fw-output-projection-"))
  const runtime = ManagedRuntime.make(EventStoreLive(join(dbDirectory, "flywheel.sqlite")))
  afterAll(async () => {
    await runtime.dispose()
    rmSync(dbDirectory, { recursive: true, force: true })
  })
  return runtime
}

/** Mints through a real sequencer so positions chain exactly as the app-service
 *  single publish path would. */
export function sink() {
  const sequencer = createRuntimeUiPatchSequencer()
  const patches: RuntimeUiPatch[] = []
  const publish = (input: RuntimeUiPatchInput): RuntimeUiPatch => {
    const patch = sequencer.publish(input)
    patches.push(patch)
    return patch
  }
  return { patches, publish, shipped: createShippedOutput({ publish }) }
}

export function textBlock(content: string): Extract<AnyBlock, { kind: "text" }> {
  return { kind: "text", id: `t-${content}`, content, timestamp: 1 }
}

export function deltas(patches: RuntimeUiPatch[], sessionId: string): OutputDelta[] {
  return patches.flatMap((patch) =>
    patch.cursor.scope === "session" && patch.cursor.sessionId === sessionId && patch.payload.kind === "output.delta"
      ? [patch.payload.delta]
      : [],
  )
}

/** The real write site (StructuredOutputBuilder/OutputSession) always sends
 *  `outputBlocks` (the full current view) alongside `outputChanges` (the
 *  minted batch); these helpers build both halves of that patch the way
 *  runner/output-session.ts's syncStore() does. */
export function upsertChange(index: number, block: AnyBlock): OutputBlockChange {
  return { kind: "upsert", index, block }
}

export function batch(changes: OutputBlockChange[], fullResync = false): OutputChangeBatch {
  return { changes, fullResync, changedTools: NO_CHANGED_TOOLS }
}

export function insertChange(index: number, block: AnyBlock): OutputBlockChange {
  return { kind: "insert", index, block }
}
export function appendChange(index: number, id: string, contentOffset: number, text: string): OutputBlockChange {
  return { kind: "append-content", index, identity: { kind: "text", id }, contentOffset, text }
}

/** Narrows a key a Proxy trap receives to a property of its target, which
 *  includes inherited members such as array methods and symbols. */
function hasKey<T extends object>(target: T, key: PropertyKey): key is keyof T {
  return key in target
}

/** A session store whose one chat names its write-site changes as the real
 *  store does, so a test drives each kind of drain directly. */
export function fakeOutputStore(blocks: AnyBlock[], options: { sequenceStart?: number; streamingToolText?: SessionEntry["streamingToolText"] } = {}) {
  let current = blocks
  let revision = 1
  let indexReads = 0
  let pendingChanges: OutputChangeBatch = batch([])
  const listeners = new Set<(changed: ReadonlySet<string> | undefined) => void>()
  let entry = chatEntry({
    entryEpoch: 1,
    outputBlocks: () => new Proxy(current, {
      get(target, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) indexReads += 1
        return hasKey(target, property) ? target[property] : undefined
      },
    }),
    streamPhase: "generating",
    streamingOutputChars: 0,
    streamingToolText: options.streamingToolText ?? {},
    outputSequenceStart: options.sequenceStart ?? 0,
    visibleMessageCountPrefix: 0,
    visibleMessageCountSuffix: blocks.filter(isVisibleMessageBlock).length,
  })
  const sessionStore = fakeSessionStore(new Map([["chat-long", entry]]))
  const store: SessionStore = {
    ...sessionStore,
    allIds: () => ["chat-long"],
    get: () => entry,
    revision: () => revision,
    drainOutputChanges: () => {
      const drained = pendingChanges
      pendingChanges = batch([])
      return drained
    },
    onChange(listener: (changed: ReadonlySet<string> | undefined) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    store,
    mutateLast(content: string) {
      const lastIndex = current.length - 1
      const last = current[lastIndex]
      if (last?.kind !== "text") throw new Error("Expected the final block to contain text")
      current = [...current]
      current[lastIndex] = { ...last, content }
      pendingChanges = batch([appendChange(lastIndex, last.id, last.content.length, content.slice(last.content.length))])
      revision += 1
      for (const listener of listeners) listener(undefined)
    },
    rewrite(nextBlocks: AnyBlock[], streamingToolText = entry.streamingToolText) {
      current = nextBlocks
      entry.streamingToolText = streamingToolText
      pendingChanges = batch([], true)
      revision += 1
      for (const listener of listeners) listener(undefined)
    },
    /** The throttled character count of the runner's stream, which names no
     *  block or tool. */
    streamChars(chars: number) {
      entry.streamingOutputChars = chars
      revision += 1
      for (const listener of listeners) listener(undefined)
    },
    /** The write site names the tools it changed, as StreamingToolTextStore does. */
    changeStreamingToolText(streamingToolText: SessionEntry["streamingToolText"], changed: readonly string[]) {
      entry.streamingToolText = streamingToolText
      pendingChanges = { ...pendingChanges, changedTools: new Set([...pendingChanges.changedTools, ...changed]) }
      revision += 1
      for (const listener of listeners) listener(undefined)
    },
    changeBlocks(nextBlocks: AnyBlock[], changes: OutputBlockChange[]) {
      current = nextBlocks
      pendingChanges = { ...batch(changes), changedTools: pendingChanges.changedTools }
      revision += 1
      for (const listener of listeners) listener(undefined)
    },
    /** A new shell under the same id and revision, as a remove and a reopen
     *  inside one coalesced store notification leave it. */
    reopen(changes: OutputBlockChange[]) {
      entry = { ...entry, entryEpoch: entry.entryEpoch + 1 }
      pendingChanges = batch(changes)
      for (const listener of listeners) listener(undefined)
    },
    resetReads: () => { indexReads = 0 },
    indexReads: () => indexReads,
  }
}
