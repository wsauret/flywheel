import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ContainedFileMetadata, ContainedFileSnapshot, FileMutationAttemptResult } from "../../../../../src/infra/descriptor-directory.js"
import { type FileEditAuthority, FileEditRefusal, publishFileEdits as publishSharedFileEdits } from "../../../../../src/orchestration/file-edits/file-edit-operation.js"
import { type ExpectedFileState, observeFileState } from "../../../../../src/orchestration/file-edits/file-state.js"
import { RetainedFileEditAuthority } from "../../../../../src/orchestration/file-edits/retained-file-edit-host.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { publishToolFileEdits as publishFileEdits } from "../../../../../src/orchestration/agent-runtime/tools/file-edit-tool-adapter.js"
import { createRecordingFileMutationStore, makeContext } from "./_fixtures.js"
import { asAsyncEventReadSurface, PersistenceWriteRefused } from "../../../../../src/infra/event-store-types.js"
import { readMutationEvidenceFiles } from "../../../../../src/infra/mutation-evidence.js"
import { MutationEvidenceSchema } from "../../../../../src/infra/mutation-evidence-schema.js"
import { readSessionContentRange } from "../../../../../src/infra/session-content.js"
import { Schema } from "effect"
import { asRecord } from "../../../../../src/infra/record.js"
import { withStore } from "../../session/file-mutation-recovery-fixture.js"

interface FakeAuthorityOptions {
  readonly canonicalPath?: string
  readonly publish?: (path: string) => FileMutationAttemptResult
  readonly onSettle?: (path: string) => void
}

const POSIX_METADATA: ContainedFileMetadata = { kind: "posix", mode: 0o644 }
const ROOT = resolve("/repo")
const rooted = (name: string): string => resolve(ROOT, name)
const createDirectory = temporaryDirectories()

function fakeAuthority(path: string, events: string[], options: FakeAuthorityOptions = {}): FileEditAuthority {
  const snapshot: ContainedFileSnapshot = { content: Buffer.from("before"), identity: `id:${path}`, linkCount: 1, executable: false, metadata: POSIX_METADATA }
  return {
    canonicalPath: options.canonicalPath ?? path,
    snapshot,
    text: "before",
    mayCreateMissingParents: false,
    encode: (content) => Buffer.from(content),
    verifyPrecondition: () => {},
    publish: () => {
      events.push(`publish:${path}`)
      return options.publish?.(path) ?? { status: "published" }
    },
    delete: () => ({ status: "published" }),
    readBackAndVerify: (bytes) => {
      events.push(`readback:${path}`)
      return { ...snapshot, content: Buffer.from(bytes) }
    },
    verifyAbsent: () => {},
    defaultPublicationMetadata: () => POSIX_METADATA,
    close: () => { events.push(`close:${path}`) },
  }
}

describe("shared file edit publication", () => {
  it("completes an empty plan after admission without publication or mutation facts", async () => {
    const events: string[] = []
    const recorder = createRecordingFileMutationStore()
    const result = await publishSharedFileEdits({ executionCwd: ROOT, sessionEventWriter: recorder.writer, origin: { kind: "tool_call", toolUseId: "unchanged" } }, {
      paths: ["a"],
      admit: path => fakeAuthority(path, events),
      plan: () => [],
    })
    expect(result).toEqual({ status: "completed", committedPrefix: [], untouchedSuffix: [], conflicts: [] })
    expect(events).toEqual([`close:${rooted("a")}`])
    expect(recorder.facts).toEqual([])
    expect(recorder.prepared).toEqual([])
  })
  it("lets pending client reads run between a large operation's admissions", async () => {
    const events: string[] = []
    let admitted = 0
    const tick = new Promise<number>(done => setImmediate(() => done(admitted)))
    const outcome = await publishSharedFileEdits({ executionCwd: ROOT }, {
      paths: ["a", "b", "c"],
      admit(path) {
        const started = performance.now()
        while (performance.now() - started < 10) { /* One native admission can spend a task slice. */ }
        admitted++
        return fakeAuthority(path, events)
      },
      plan: entries => entries.map(entry => ({ admitted: entry, after: "after" })),
    })
    expect(outcome.status).toBe("completed")
    const beforeTick = await tick
    expect(beforeTick).toBeLessThan(3)
    expect(admitted).toBe(3)
  })

  it("bounds a long single-line model preview and retains all patch bytes beside SQLite before returning its reference", async () => {
    await withStore(async fixture => {
      const before = '"\\雪'.repeat(30_000)
      const after = "replacement\n"
      const target = join(fixture.root, "long.txt")
      writeFileSync(target, before)
      const result = await publishFileEdits(makeContext({
        executionCwd: fixture.root, sessionId: fixture.sessionId, toolUseId: "long-edit",
        sessionEventWriter: fixture.writer, projectionReader: asAsyncEventReadSurface(fixture.store),
      }), {
        label: "Edit", paths: ["long.txt"],
        admit: path => RetainedFileEditAuthority.admitWritable(path, fixture.root, Number.POSITIVE_INFINITY),
        plan: admitted => admitted.map(entry => ({ admitted: entry, after })),
      })
      expect(result.outcome).toBe("ok")
      expect(Buffer.byteLength(JSON.stringify({ content: result.content }))).toBeLessThanOrEqual(16 * 1024)
      expect(result.content).toContain("Open Session Changes")
      const details = asRecord(result.details)
      expect(details?.mutation).toBeUndefined()
      const evidence = Schema.decodeUnknownSync(MutationEvidenceSchema)(details?.mutationEvidence)
      const read = async (sha256: string) => fixture.store.readSessionContentNode!(fixture.sessionId, sha256)
      const page = await readMutationEvidenceFiles(evidence, 0, 1, read)
      if (page.kind !== "available" || page.files[0]?.kind !== "applied" || page.files[0].file.patch.kind !== "retained") throw new Error("missing patch")
      const file = page.files[0].file
      if (file.patch.kind !== "retained") throw new Error("missing retained patch")
      const windows: Buffer[] = []
      let offset: number | null = 0
      while (offset !== null) {
        const window = await readSessionContentRange(file.patch.reference, offset, 16 * 1024, read)
        if (window.kind !== "available") throw new Error("missing patch bytes")
        windows.push(Buffer.from(window.base64, "base64"))
        offset = window.nextOffset
      }
      expect(windows.length).toBeGreaterThan(1)
      const patch = Buffer.concat(windows)
      expect(createHash("sha256").update(patch).digest("hex")).toBe(file.patch.reference.sha256)
      expect(patch.toString("utf8")).toContain(`-${before}\n`)
      expect(patch.toString("utf8")).toContain("+replacement\n")
      expect(readFileSync(target, "utf8")).toBe(after)
    })
  })

  it.each(["preparation", "publication"] as const)("preserves the typed persistence refusal at %s", async (stage) => {
    const events: string[] = []
    const store = createRecordingFileMutationStore()
    const refusal = new PersistenceWriteRefused(129, 128)
    const publishing = publishSharedFileEdits({
      executionCwd: ROOT,
      origin: { kind: "tool_call", toolUseId: "save" },
      sessionEventWriter: {
        ...store.writer,
        ...(stage === "preparation"
          ? { swapInFlight: async () => { throw refusal } }
          : { transaction: async () => { throw refusal } }),
      },
    }, {
      paths: ["a", "b"],
      admit: path => fakeAuthority(path, events),
      plan: admitted => admitted.map(entry => ({ admitted: entry, after: "after" })),
    })
    await expect(publishing).rejects.toBe(refusal)
    expect(refusal.stage).toBe(stage)
    expect(events.filter(event => event.startsWith("publish:"))).toEqual(stage === "preparation" ? [] : [`publish:${rooted("a")}`])
    expect(store.changes).toHaveLength(0)
  })
  it("classifies a failed final manifest as a final-result refusal and preserves its settled artifacts", async () => {
    const store = createRecordingFileMutationStore()
    const refusal = new PersistenceWriteRefused(129, 128)
    const events: string[] = []
    const publishing = publishFileEdits(makeContext({
      executionCwd: ROOT, toolUseId: "manifest-failure",
      sessionEventWriter: {
        ...store.writer,
        stageSessionContentNodes: async nodes => {
          if (store.changes.length > 0 && nodes.some(row => row.node.kind === "records")) throw refusal
          await store.writer.stageSessionContentNodes!(nodes)
        },
      },
    }), {
      label: "Edit", paths: ["a"],
      admit: path => fakeAuthority(path, events),
      plan: admitted => admitted.map(entry => ({ admitted: entry, after: "after" })),
    })
    await expect(publishing).rejects.toBe(refusal)
    expect(refusal.stage).toBe("final-result")
    expect(store.changes).toHaveLength(1)
    expect(store.facts).toContainEqual(expect.objectContaining({ type: "file.artifact.recorded", version: 4, payload: expect.objectContaining({ evidence: expect.objectContaining({ displayPath: "a" }) }) }))
  })
  it("retains original access and actual readback access rather than planned metadata", async () => {
    const store = createRecordingFileMutationStore()
    const result = await publishSharedFileEdits({
      executionCwd: ROOT, origin: { kind: "tool_call", toolUseId: "access" }, sessionEventWriter: store.writer,
    }, {
      paths: ["a"],
      admit: path => {
        const authority = fakeAuthority(path, [])
        return {
          ...authority,
          snapshot: { ...authority.snapshot!, metadata: { kind: "posix" as const, mode: 0o4754 } },
          readBackAndVerify: bytes => ({ ...authority.snapshot!, content: Buffer.from(bytes), metadata: { kind: "posix", mode: 0o754 } }),
        }
      },
      plan: admitted => admitted.map(entry => ({ admitted: entry, after: "after", metadata: { kind: "posix" as const, mode: 0o4754 } })),
    })
    expect(result.status).toBe("completed")
    expect(store.facts[0]).toMatchObject({
      type: "file.changed", version: 4,
      payload: { beforeAccess: { kind: "posix", mode: 0o4754 }, afterAccess: { kind: "posix", mode: 0o754 } },
    })
  })

  it("encodes every output before durable preparation and publishes those exact buffers", async () => {
    const store = createRecordingFileMutationStore()
    const buffers = new Map<string, Buffer>()
    let encodes = 0
    const result = await publishSharedFileEdits({
      executionCwd: ROOT, origin: { kind: "tool_call", toolUseId: "encoded" },
      sessionEventWriter: {
        ...store.writer,
        swapInFlight: async (...args) => {
          expect(encodes).toBe(2)
          return store.writer.swapInFlight!(...args)
        },
      },
    }, {
      paths: ["a", "b"],
      admit: path => ({
        ...fakeAuthority(path, []),
        encode: content => {
          encodes += 1
          const bytes = Buffer.from(content)
          buffers.set(path, bytes)
          return bytes
        },
        publish: bytes => {
          expect(bytes).toBe(buffers.get(path)!)
          return { status: "published" }
        },
      }),
      plan: admitted => admitted.map(entry => ({ admitted: entry, after: "after" })),
      withQueues: async (_keys, run) => {
        expect(store.prepared).toHaveLength(1)
        return run()
      },
    })
    expect(result.status).toBe("completed")
    expect(encodes).toBe(2)
  })

  it("rechecks operator preflight after async preparation and queue wait, retiring every prepared item on refusal", async () => {
    const events: string[] = []
    const store = createRecordingFileMutationStore()
    const prepared = Promise.withResolvers<void>()
    const queue = Promise.withResolvers<void>()
    const enteredQueue = Promise.withResolvers<void>()
    let revision = 1
    let plans = 0
    const running = publishSharedFileEdits({
      executionCwd: ROOT,
      origin: { kind: "user_undo", reviewRevision: 1, scope: "session", fileId: "a", sourceMutationIds: ["source-a"] },
      sessionEventWriter: {
        ...store.writer,
        swapInFlight: async (...args) => {
          const stored = await store.writer.swapInFlight!(...args)
          await prepared.promise
          events.push("prepared")
          return stored
        },
      },
    }, {
      paths: ["a", "b"],
      admit: path => fakeAuthority(path, events),
      plan: admitted => { plans += 1; return admitted.map(entry => ({ admitted: entry, after: "after" })) },
      withQueues: async (keys, run) => {
        expect(keys).toEqual([rooted("a"), rooted("b")])
        events.push("queued")
        enteredQueue.resolve()
        await queue.promise
        return run()
      },
      preflight: publications => {
        events.push("preflight")
        expect(publications).toHaveLength(2)
        if (revision !== 1) throw new Error("review changed")
      },
    })
    expect(events).toEqual([])
    prepared.resolve()
    await enteredQueue.promise
    revision = 2
    queue.resolve()
    const result = await running
    expect(plans).toBe(1)
    expect(result).toMatchObject({ status: "not_applied", reason: "preflight", committedPrefix: [], current: { plan: { admitted: { path: "a" } } }, untouchedSuffix: [{ plan: { admitted: { path: "b" } } }] })
    expect(events).toEqual(["prepared", "queued", "preflight", `close:${rooted("b")}`, `close:${rooted("a")}`])
    expect(store.changes).toEqual([])
    expect(store.prepared.at(-1)?.payload).toBeNull()
  })

  it("keeps applied bytes separate from a failed settlement and the untouched suffix", async () => {
    const events: string[] = []
    const store = createRecordingFileMutationStore()
    let settlements = 0
    const result = await publishSharedFileEdits({
      executionCwd: ROOT,
      origin: { kind: "user_undo", reviewRevision: 1, scope: "lastTurn", fileId: "a", sourceMutationIds: ["source-a"] },
      sessionEventWriter: {
        ...store.writer,
        transaction: async run => {
          if (++settlements === 2) throw new Error("settlement failed")
          await store.writer.transaction(run)
        },
      },
    }, {
      paths: ["a", "b", "c"],
      admit: path => fakeAuthority(path, events),
      plan: admitted => admitted.map(entry => ({ admitted: entry, after: "after" })),
    })
    expect(result).toMatchObject({
      status: "uncertain", stage: "settlement", publication: "applied", settlement: "pending",
      committedPrefix: [{ plan: { admitted: { path: "a" } } }],
      current: { plan: { admitted: { path: "b" } } },
      untouchedSuffix: [{ plan: { admitted: { path: "c" } } }],
    })
    expect(store.changes).toHaveLength(1)
    expect(events.filter(event => event.startsWith("publish:"))).toEqual([`publish:${rooted("a")}`, `publish:${rooted("b")}`])
    expect(store.prepared.at(-1)?.payload).toMatchObject({ cursor: 1 })
  })

  it("retains non-publication proof even when cancellation retirement fails", async () => {
    const events: string[] = []
    const controller = new AbortController()
    const store = createRecordingFileMutationStore()
    const result = await publishSharedFileEdits({
      executionCwd: ROOT, signal: controller.signal,
      origin: { kind: "user_undo", reviewRevision: 1, scope: "session", fileId: "a", sourceMutationIds: ["source-a"] },
      sessionEventWriter: { ...store.writer, transaction: async () => { throw new Error("retirement failed") } },
    }, {
      paths: ["a", "b"],
      admit: path => fakeAuthority(path, events),
      plan: admitted => admitted.map(entry => ({ admitted: entry, after: "after" })),
      withQueues: async (_keys, run) => { controller.abort(); return run() },
      preflight: () => { throw new Error("must not preflight cancelled publication") },
    })
    expect(result).toMatchObject({ status: "not_applied", reason: "cancelled", committedPrefix: [], retirementError: expect.objectContaining({ message: "retirement failed" }) })
    expect(events.filter(event => event.startsWith("publish:"))).toEqual([])
    expect(store.prepared.at(-1)?.payload).toMatchObject({ cursor: 0 })
  })

  it("does not invent mutation facts for standalone publications", async () => {
    const result = await publishSharedFileEdits({ executionCwd: ROOT }, {
      paths: ["a"], admit: path => fakeAuthority(path, []),
      plan: admitted => admitted.map(entry => ({ admitted: entry, after: "after" })),
    })
    expect(result.status).toBe("completed")
    expect(result.committedPrefix[0]?.mutation).toBeUndefined()
  })

  it("plans before entering one deduplicated sorted queue and publishes the exact settled prefix", async () => {
    const events: string[] = []
    const result = await publishFileEdits(makeContext({ executionCwd: ROOT }), {
      label: "Patch",
      paths: ["b.ts", "alias.ts", "a.ts"],
      admit: (resolvedPath) => {
        events.push(`admit:${resolvedPath}`)
        return fakeAuthority(resolvedPath, events, {
          canonicalPath: resolvedPath === rooted("alias.ts") ? rooted("a.ts") : resolvedPath,
          publish: (path) => path === rooted("b.ts") ? { status: "not_applied", error: new Error("stale") } : { status: "published" },
        })
      },
      withQueues: async (keys, run) => {
        events.push(`queue:${keys.join(",")}`)
        return run()
      },
      plan: (admitted) => {
        events.push(`plan:${admitted.map(entry => entry.path).join(",")}`)
        return [admitted[0]!, admitted[2]!, admitted[1]!].map(entry => ({ admitted: entry, after: `after:${entry.path}` }))
      },
    })

    expect(result.outcome).toBe("error")
    expect(result.content).toBe("Patch failed at b.ts: the change was not applied: stale\nDurably committed: none\nUntouched: a.ts, alias.ts")
    expect(result.details).toEqual({
      changedFiles: { total: 0, samples: [] }, indeterminateFiles: { total: 0, samples: [] }, remainingFiles: { total: 2, samples: ["a.ts", "alias.ts"] },
      current: { path: "b.ts", status: "not_applied", reason: "publication", error: "stale" },
    })
    expect(events).toEqual([
      `admit:${rooted("b.ts")}`, `admit:${rooted("alias.ts")}`, `admit:${rooted("a.ts")}`,
      "plan:b.ts,alias.ts,a.ts",
      `queue:${rooted("a.ts")},${rooted("b.ts")}`,
      `publish:${rooted("b.ts")}`,
      `close:${rooted("a.ts")}`, `close:${rooted("alias.ts")}`, `close:${rooted("b.ts")}`,
    ])
  })

  it("keeps an indeterminate current publication separate from its untouched suffix", async () => {
    const events: string[] = []
    const result = await publishFileEdits(makeContext({ executionCwd: ROOT }), {
      label: "Patch",
      paths: ["a", "b"],
      admit: (resolvedPath) => fakeAuthority(resolvedPath, events, {
        publish: (path) => path === rooted("a") ? { status: "indeterminate", error: new Error("directory fsync failed") } : { status: "published" },
      }),
      plan: (admitted) => admitted.map(entry => ({ admitted: entry, after: "after" })),
    })

    expect(result.outcome).toBe("error")
    expect(result.content).toBe("Patch failed at a: the file may have changed: directory fsync failed\nDurably committed: none\nUntouched: b")
    expect(result.details).toEqual({
      changedFiles: { total: 0, samples: [] }, indeterminateFiles: { total: 1, samples: ["a"] }, remainingFiles: { total: 1, samples: ["b"] },
      current: { path: "a", status: "uncertain", stage: "publication", publication: "unknown", settlement: "pending", error: "directory fsync failed" },
    })
  })

  it("interrupts before the next publication when cancellation lands between items", async () => {
    const controller = new AbortController()
    const events: string[] = []
    const result = await publishFileEdits(makeContext({ executionCwd: ROOT, signal: controller.signal }), {
      label: "Patch",
      paths: ["a", "b", "c"],
      admit: (resolvedPath) => {
        const authority = fakeAuthority(resolvedPath, events)
        return {
          ...authority,
          readBackAndVerify: (bytes, metadata) => {
            if (resolvedPath === rooted("a")) controller.abort()
            return authority.readBackAndVerify(bytes, metadata)
          },
        }
      },
      plan: (admitted) => admitted.map(entry => ({ admitted: entry, after: "after" })),
    })

    expect(result.outcome).toBe("interrupted")
    expect(result.content).toBe("Patch interrupted before b was published: the file was not changed\nDurably committed: a\nUntouched: c")
    expect(result.details).toEqual({
      changedFiles: { total: 1, samples: ["a"] }, indeterminateFiles: { total: 0, samples: [] }, remainingFiles: { total: 1, samples: ["c"] },
      current: { path: "b", status: "not_applied", reason: "cancelled" },
    })
    expect(events.filter(event => event.startsWith("publish:"))).toEqual([`publish:${rooted("a")}`])
  })

  it("does not replan while a prepared operation waits in the queue", async () => {
    let plans = 0
    let releaseQueue!: () => void
    const waiting = new Promise<void>(release => { releaseQueue = release })
    const publishing = publishFileEdits(makeContext({ executionCwd: ROOT }), {
      label: "Edit",
      paths: ["a"],
      admit: (resolvedPath) => fakeAuthority(resolvedPath, []),
      withQueues: async (_keys, run) => { await waiting; return run() },
      plan: (admitted) => {
        plans += 1
        return admitted.map(entry => ({ admitted: entry, after: "after" }))
      },
    })
    await Bun.sleep(1)
    expect(plans).toBe(1)
    releaseQueue()
    const result = await publishing
    expect(result.outcome).toBe("ok")
    expect(result.content).toBe("Updated a\n@@ -1,1 +1,1 @@\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file")
    expect(plans).toBe(1)
  })

  it("reports a refusal verbatim and names authored paths in other failures", async () => {
    const refused = await publishFileEdits(makeContext({ executionCwd: ROOT }), {
      label: "Edit",
      paths: ["a"],
      admit: (resolvedPath) => fakeAuthority(resolvedPath, []),
      plan: () => { throw new FileEditRefusal("caller refused the edit") },
    })
    expect(refused).toEqual({ content: "caller refused the edit", outcome: "error" })

    const failed = await publishFileEdits(makeContext({ executionCwd: ROOT }), {
      label: "Edit",
      paths: ["a"],
      admit: (resolvedPath) => { throw new Error(`${resolvedPath} is not valid UTF-8`) },
      plan: () => [],
    })
    expect(failed).toEqual({ content: "Edit failed: a is not valid UTF-8", outcome: "error" })
  })

  it("publishes exact bytes and excludes every target whose state left the caller's expected state", async () => {
    const dir = createDirectory("file-edit-expected-")
    const at = (name: string) => join(dir, name)
    writeFileSync(at("binary.bin"), Buffer.from([0, 1, 2]))
    writeFileSync(at("raced.txt"), "old")
    writeFileSync(at("pinned.txt"), "pin")
    symlinkSync(createDirectory("file-edit-outside-"), at("link"))
    const expectedFile = (name: string) => {
      const state = observeFileState(at(name))
      if (state.kind !== "file") throw new Error(`${name} is not a file`)
      return { ...state, sha256: createHash("sha256").update(readFileSync(at(name))).digest("hex") }
    }
    const expected = new Map<string, ExpectedFileState>([
      ["binary.bin", expectedFile("binary.bin")],
      ["raced.txt", expectedFile("raced.txt")],
      ["pinned.txt", { ...expectedFile("pinned.txt"), sha256: "0".repeat(64) }],
      ["created.bin", { kind: "absent" }],
      ["taken.txt", { kind: "absent" }],
      // Absent through the link, but admission below the root follows no link, so it is no target this operation owns.
      [join("link", "planted.txt"), { kind: "absent" }],
    ])
    writeFileSync(at("raced.txt"), "new")
    writeFileSync(at("taken.txt"), "someone else")
    const planned: string[] = []
    const result = await publishSharedFileEdits({ executionCwd: dir }, {
      paths: [...expected.keys()],
      expected,
      admit: path => RetainedFileEditAuthority.admitWritable(path, dir, Number.POSITIVE_INFINITY),
      plan: admitted => admitted.map(entry => {
        planned.push(entry.path)
        return { admitted: entry, after: new Uint8Array([0xff, 0x00, 0x0d, 0x0a]) }
      }),
    })

    expect(result.status).toBe("completed")
    expect(result.conflicts).toEqual(["raced.txt", "pinned.txt", "taken.txt", join("link", "planted.txt")])
    expect(planned).toEqual(["binary.bin", "created.bin"])
    expect([...readFileSync(at("binary.bin"))]).toEqual([0xff, 0x00, 0x0d, 0x0a])
    expect([...readFileSync(at("created.bin"))]).toEqual([0xff, 0x00, 0x0d, 0x0a])
    expect(readFileSync(at("raced.txt"), "utf8")).toBe("new")
    expect(readFileSync(at("pinned.txt"), "utf8")).toBe("pin")
    expect(readFileSync(at("taken.txt"), "utf8")).toBe("someone else")
    expect(existsSync(at(join("link", "planted.txt")))).toBe(false)
  })

  it("settles a target another writer changed after admission as a conflict alone and still publishes the rest", async () => {
    const dir = createDirectory("file-edit-late-conflict-")
    const at = (name: string) => join(dir, name)
    writeFileSync(at("a.txt"), "a")
    writeFileSync(at("b.txt"), "b")
    const store = createRecordingFileMutationStore()
    const fingerprint = (name: string) => {
      const state = observeFileState(at(name))
      if (state.kind !== "file") throw new Error(`${name} is not a file`)
      return state
    }
    const expected = new Map<string, ExpectedFileState>([["a.txt", fingerprint("a.txt")], ["b.txt", fingerprint("b.txt")]])
    const queued = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const running = publishSharedFileEdits({ executionCwd: dir, origin: { kind: "tool_call", toolUseId: "late" }, sessionEventWriter: store.writer }, {
      paths: ["a.txt", "b.txt"],
      expected,
      admit: path => RetainedFileEditAuthority.admitWritable(path, dir, Number.POSITIVE_INFINITY),
      plan: admitted => admitted.map(entry => ({ admitted: entry, after: new TextEncoder().encode(`${entry.path} landed`) })),
      withQueues: async (_keys, run) => {
        queued.resolve()
        await release.promise
        return run()
      },
    })
    await queued.promise
    writeFileSync(at("a.txt"), "another writer")
    release.resolve()
    const result = await running

    expect(result).toMatchObject({ status: "completed", conflicts: ["a.txt"] })
    expect(result.committedPrefix.map(publication => publication.plan.admitted.path)).toEqual(["b.txt"])
    expect(readFileSync(at("a.txt"), "utf8")).toBe("another writer")
    expect(readFileSync(at("b.txt"), "utf8")).toBe("b.txt landed")
    expect(store.changes).toHaveLength(1)
    expect(store.prepared.at(-1)?.payload).toBeNull()
  })
})
