import { expect, it, mock } from "bun:test"
import { createComponent, createEffect, createRoot, createSignal } from "solid-js"
import type { RuntimeQuery } from "../../../../src/protocol/app-service-types.js"
import { createMutationEvidenceReader, type MutationEvidenceReader } from "../../../../src/protocol/client/mutation-evidence.js"
import { MutationEvidenceProvider, useMutationEvidence, type OpenMutationEvidence } from "../../../../src/tui/context/mutation-evidence.js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import { fakeRuntimeClient } from "../hooks/_output-transcript-cache-fixtures.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

const manifest = { version: 1 as const, root: "a".repeat(64), bytes: 0, entries: 0 }

function evidence(sessionId: string) {
  const queries: RuntimeQuery[] = []
  const connection = { query: runtimeQuery({ mutationFiles: async (query) => {
    queries.push(query)
    return { kind: "available", sessionId, manifest: query.manifest, requestedOffset: query.offset, offset: 0, totalFiles: 0, totalBytes: 0, files: [], nextOffset: null }
  } }) }
  const reader = createMutationEvidenceReader({ connection, sessionId })
  let listeners = 0
  const onChange = reader.onChange
  reader.onChange = (listener) => {
    listeners++
    const unsubscribe = onChange(listener)
    return () => { listeners--; unsubscribe() }
  }
  const release = mock(reader.release)
  reader.release = release
  return { reader, queries, release, listeners: () => listeners }
}

it("binds session publications without read loops and unsubscribes without releasing resident evidence", async () => {
  const first = evidence("first")
  const second = evidence("second")
  const [source, setSource] = createSignal<{ reader: MutationEvidenceReader | undefined }>({ reader: first.reader })
  let context!: OpenMutationEvidence
  let dispose!: () => void
  const states: string[] = []
  createRoot((cleanup) => {
    dispose = cleanup
    createComponent(MutationEvidenceProvider, {
      reader: () => source().reader,
      get children() {
        context = useMutationEvidence()
        createEffect(() => {
          states.push(context("tool", manifest)?.files.status ?? "absent")
        })
        return null
      },
    })
  })
  try {
    expect(context("tool", manifest)).toBe(first.reader.open("tool", manifest))
    expect(states).toEqual(["idle"])
    expect(first.listeners()).toBe(1)
    expect(first.queries).toEqual([])
    setSource({ reader: first.reader })
    expect(states).toEqual(["idle"])
    expect(first.listeners()).toBe(1)
    const handle = first.reader.open("tool", manifest)
    await handle.loadFiles()
    expect(states).toEqual(["idle", "loading", "ready"])
    expect(first.queries.map(query => query.type)).toEqual(["mutationFiles"])
    const heldBytes = first.reader.heldBytes

    setSource({ reader: second.reader })
    expect(context("tool", manifest)).toBe(second.reader.open("tool", manifest))
    expect(first.listeners()).toBe(0)
    expect(second.listeners()).toBe(1)
    expect(second.queries).toEqual([])
    expect(first.reader.heldBytes).toBe(heldBytes)
    expect(first.reader.open("tool", manifest)).toBe(handle)
    expect(first.release).not.toHaveBeenCalled()

    setSource({ reader: undefined })
    expect(context("tool", manifest)).toBeUndefined()
    expect(second.listeners()).toBe(0)
    expect(states).toEqual(["idle", "loading", "ready", "idle", "absent"])
    setSource({ reader: first.reader })
    expect(states.at(-1)).toBe("ready")
    dispose()
    expect(first.listeners()).toBe(0)
    expect(first.reader.heldBytes).toBe(heldBytes)
    expect(first.release).not.toHaveBeenCalled()
    expect(first.queries).toHaveLength(1)
  } finally {
    dispose()
    first.reader.dispose()
    second.reader.dispose()
  }
})

it("re-runs only the observers of the owner whose evidence changed, so work per publication does not grow with observers", async () => {
  const { reader } = evidence("session")
  const owners = Array.from({ length: 16 }, (_owner, index) => `tool:${index}`)
  const runs = new Map(owners.map(owner => [owner, 0]))
  let dispose!: () => void
  createRoot((cleanup) => {
    dispose = cleanup
    createComponent(MutationEvidenceProvider, {
      reader: () => reader,
      get children() {
        const open = useMutationEvidence()
        for (const owner of owners) createEffect(() => {
          open(owner, manifest)
          runs.set(owner, (runs.get(owner) ?? 0) + 1)
        })
        return null
      },
    })
  })
  try {
    const [changed, ...others] = owners
    for (let publication = 0; publication < 3; publication++) await reader.open(changed!, manifest).loadFiles()
    // Each page publishes at its start and at its end; the reader serves only the first page.
    expect(runs.get(changed!)).toBe(1 + 2)
    expect(others.map(owner => runs.get(owner))).toEqual(others.map(() => 1))
    reader.release()
    expect(owners.map(owner => runs.get(owner))).toEqual([4, ...others.map(() => 2)])
  } finally {
    dispose()
    reader.dispose()
  }
})

it("exposes only the existing resident session reader and retires it with the cache", () => {
  const fake = fakeRuntimeClient()
  let dispose!: () => void
  let cache!: ReturnType<typeof createOutputTranscriptCache>
  let observed: MutationEvidenceReader | undefined
  createRoot((cleanup) => {
    dispose = cleanup
    cache = createOutputTranscriptCache({ appService: fake.client, maxSessions: 1 })
    createEffect(() => { observed = cache.mutationEvidence("first") })
  })
  try {
    expect(observed).toBeUndefined()
    expect(cache.residentSessionIds()).toEqual([])
    cache.startKnownEmpty("first")
    const reader = cache.mutationEvidence("first")
    expect(reader).toBeDefined()
    expect(observed).toBe(reader)
    cache.ensure("first")
    expect(cache.mutationEvidence("first")).toBe(reader)
    cache.startKnownEmpty("second")
    expect(observed).toBeUndefined()
    expect(cache.mutationEvidence("first")).toBeUndefined()
    expect(cache.mutationEvidence("second")).not.toBe(reader)
  } finally {
    dispose()
  }
})
