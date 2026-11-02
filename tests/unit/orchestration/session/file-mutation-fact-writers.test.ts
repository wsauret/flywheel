import { describe, expect, it } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { readSessionContentRange } from "../../../../src/infra/session-content.js"
import { asAsyncEventWriter, asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { publishFileEdits } from "../../../../src/orchestration/file-edits/file-edit-operation.js"
import { RetainedFileEditAuthority } from "../../../../src/orchestration/file-edits/retained-file-edit-host.js"
import { reconcilePendingFileMutations } from "../../../../src/orchestration/session/file-mutation-recovery.js"
import { withStore, mutationFacts, context as mutationContext } from "./file-mutation-recovery-fixture.js"
import type { ContainedFileSnapshot } from "../../../../src/infra/descriptor-directory.js"
import { computeLineStats, prepareFileMutationOperation, retireFileMutationNotApplied, settleFileMutation } from "../../../../src/orchestration/session/file-mutation-fact-writers.js"
import { createGitAiAttributionService } from "../../../../src/orchestration/agent-runtime/git-ai-attribution-service.js"
import { settleFileMutationArtifact, takeFileMutationAttribution } from "../../../../src/orchestration/agent-runtime/tools/file-mutation-artifact.js"
import { createRecordingFileMutationStore } from "../agent-runtime/tools/_fixtures.js"
import { readFileMutationOperation, snapshotToFileObjectProof } from "../../../../src/orchestration/session/file-mutation-operation.js"
import { mutationSnapshot } from "./file-mutation-proof-fixture.js"

describe("computeLineStats", () => {
  it("computes line statistics from unified diffs and omits them without evidence", () => {
    const stats = computeLineStats(
      "old 1\nold 2\nold 3\n",
      "new 1\nnew 2\nnew 3\nnew 4\nnew 5\n",
      [
        "Index: src/app.ts",
        "===================================================================",
        "--- src/app.ts",
        "+++ src/app.ts",
        "@@ -1,3 +1,5 @@",
        "-old 1",
        "-old 2",
        "-old 3",
        "+new 1",
        "+new 2",
        "+new 3",
        "+new 4",
        "+new 5",
      ].join("\n"),
    )

    expect(stats).toEqual({ added: 2, modified: 3, removed: 0 })
    expect(computeLineStats("same\n", "same\n")).toBeUndefined()
  })

  it("counts created-file lines when no diff evidence exists", () => {
    expect(computeLineStats(null, "one\ntwo\n")).toEqual({ added: 2, modified: 0, removed: 0 })
  })

  it.each([
    ["", 0],
    ["\n", 1],
    ["one", 1],
    ["one\ntwo", 2],
    ["one\r\ntwo\r\n", 2],
    ["one\rtwo", 1],
    ["\n\n\n", 3],
    ["héllo\n日本\n", 2],
  ])("counts LF-terminated lines of created-file bytes %j", (text, added) => {
    const backing = new TextEncoder().encode(`x${text}x`)
    const bytes = backing.subarray(1, -1)
    expect(computeLineStats(null, bytes)).toEqual({ added, modified: 0, removed: 0 })
  })

  it("sums line stats per hunk", () => {
    const diff = [
      "Index: file.ts",
      "===================================================================",
      "--- file.ts",
      "+++ file.ts",
      "@@ -1,2 +1,2 @@",
      "-old 1",
      "-old 2",
      "+new 1",
      "+new 2",
      "@@ -2,1 +2,4 @@",
      "-old 3",
      "+new 3",
      "+new 4",
      "+new 5",
      "+new 6",
    ].join("\n")
    expect(computeLineStats("before", "after", diff)).toEqual({ added: 3, modified: 3, removed: 0 })
  })
})

describe("file mutation operation evidence", () => {
  it.each(["string", "bytes"] as const)("redacts full %s previews before normalization and truncation without changing byte evidence", async kind => {
    const credential = `ghp_${"SyntheticCredential".repeat(3)}`
    const keyBody = "SyntheticPrivateKeyMaterial".repeat(20)
    const unchanged = `TOKEN=${credential}\n-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----\n`
    const before = `${unchanged}setting=old\n`
    const after = `${unchanged}setting=new\n`
    const store = createRecordingFileMutationStore()
    let rawCell = ""
    const context = {
      origin: { kind: "tool_call" as const, toolUseId: "secret-preview" },
      sessionEventWriter: {
        ...store.writer,
        swapInFlight: async (...args: Parameters<NonNullable<typeof store.writer.swapInFlight>>) => {
          rawCell = JSON.stringify(args[3])
          return store.writer.swapInFlight!(...args)
        },
      },
    }
    const [prepared] = await prepareFileMutationOperation(context, [{
      change: {
        path: "/repo/config.env", displayPath: "config.env", changeKind: "modified",
        beforeContent: kind === "string" ? before : Buffer.from(before),
        afterContent: kind === "string" ? after : Buffer.from(after),
        diffContent: "@@ -5 +5 @@\n-setting=old\n+setting=new\n",
      },
      evidence: { beforeSnapshot: mutationSnapshot(before) },
    }])
    await settleFileMutation(context, prepared!, snapshotToFileObjectProof(mutationSnapshot(after)))
    const evidence = (text: string) => ({
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
      preview: `TOKEN=[redacted secret] [redacted secret] setting=${text === before ? "old" : "new"}`,
    })
    expect(rawCell).not.toContain(credential)
    expect(rawCell).not.toContain("SyntheticPrivateKeyMaterial")
    expect(JSON.stringify(store.facts)).not.toContain(credential)
    expect(JSON.stringify(store.facts)).not.toContain("SyntheticPrivateKeyMaterial")
    expect(prepared!.fact.payload).toMatchObject({ before: evidence(before), after: evidence(after) })
    expect(store.changes[0]).toMatchObject({ before: evidence(before), after: evidence(after) })
    expect(store.facts).toContainEqual(expect.objectContaining({
      type: "file.artifact.recorded",
      payload: expect.objectContaining({ artifactKind: "mutation_diff", evidence: expect.objectContaining({ after: { bytes: Buffer.byteLength(after), sha256: evidence(after).sha256 } }) }),
    }))
  })

  it.each(["string", "bytes"] as const)("previews large %s content as the whole text previews, past a long key and long whitespace", async kind => {
    const credential = `ghp_${"SyntheticCredential".repeat(3)}`
    const keyed = `TOKEN=${credential}\n-----BEGIN PRIVATE KEY-----\n${"SyntheticPrivateKeyMaterial".repeat(4_000)}\n-----END PRIVATE KEY-----\n${"setting=value\n".repeat(5_000)}`
    const spaced = `${" \n".repeat(50_000)}alpha${"\t".repeat(90_000)}beta\n`
    const content = (text: string) => kind === "string" ? text : Buffer.from(text)
    const prepared = await prepareFileMutationOperation({ origin: { kind: "tool_call", toolUseId: "large-preview" } }, [keyed, spaced].map((text, index) => ({
      change: { path: `/repo/${index}`, displayPath: `${index}`, changeKind: "created" as const, beforeContent: null, afterContent: content(text) },
      evidence: { beforeSnapshot: null },
    })))
    expect(prepared.map(({ fact }) => fact.payload.after?.preview)).toEqual([
      `${`TOKEN=[redacted secret] [redacted secret] ${"setting=value ".repeat(20)}`.slice(0, 240)}...`,
      "alpha beta",
    ])
  })

  it("uses the admitted snapshot without reopening the mutation pathname", async () => {
    const prepared: unknown[] = []
    const writer = {
      stageSessionContentNodes: async () => {},
      record: async () => null,
      transaction: async (run: () => void) => { run() },
      swapInFlight: async (_kind: string, _key: string, _expected: string | null, payload: unknown) => {
        prepared.push(payload)
        return true
      },
    }
    const snapshot: ContainedFileSnapshot = {
      content: Buffer.from("before"),
      identity: "held-object",
      linkCount: 1,
      executable: true,
      metadata: { kind: "posix", mode: 0o754 },
    }

    const mutations = await prepareFileMutationOperation(
      { sessionEventWriter: writer, origin: { kind: "tool_call", toolUseId: "edit-proof" } },
      [{
        change: { path: "not-an-absolute-path", displayPath: "file.txt", changeKind: "modified", beforeContent: "before", afterContent: "after" },
        evidence: { beforeSnapshot: snapshot, postconditionAccess: snapshot.metadata },
      }],
    )

    expect(mutations[0]?.state).toMatchObject({
      items: [{
        precondition: { identity: "held-object", sha256: expect.any(String), access: { kind: "posix", mode: 0o754 } },
        postcondition: { identity: { kind: "new", replaced: "held-object" }, access: { kind: "posix", mode: 0o754 } },
      }],
    })
  })

  it("derives executable state from publication access instead of the replaced destination", async () => {
    const prepared: unknown[] = []
    const writer = {
      stageSessionContentNodes: async () => {},
      record: async () => null,
      transaction: async (run: () => void) => { run() },
      swapInFlight: async (_kind: string, _key: string, _expected: string | null, payload: unknown) => {
        prepared.push(payload)
        return true
      },
    }
    const destinationSnapshot: ContainedFileSnapshot = {
      content: Buffer.from("destination"),
      identity: "destination-object",
      linkCount: 1,
      executable: false,
      metadata: { kind: "posix", mode: 0o600 },
    }

    const mutations = await prepareFileMutationOperation(
      { sessionEventWriter: writer, origin: { kind: "tool_call", toolUseId: "move-proof" } },
      [{
        change: { path: "/physical/destination", displayPath: "destination", changeKind: "modified", beforeContent: "destination", afterContent: "source" },
        evidence: { beforeSnapshot: destinationSnapshot, postconditionAccess: { kind: "posix", mode: 0o754 } },
      }],
    )

    expect(mutations[0]?.state).toMatchObject({
      items: [{
        postcondition: {
          identity: { kind: "new", replaced: "destination-object" },
          linkCount: 1,
          executable: true,
          access: { kind: "posix", mode: 0o754 },
        },
      }],
    })
  })
})

describe("batch mutation preparation", () => {
  it("stages operator evidence before preparation and settles its reference without inline cell content", async () => {
    const content = createRecordingFileMutationStore()
    const transactions: unknown[][] = []
    let active: unknown[] = []
    const writer = {
      stageSessionContentNodes: content.writer.stageSessionContentNodes,
      record: async (fact: unknown, _rows?: undefined, inFlight?: readonly unknown[]) => { active.push({ fact, inFlight }); return null },
      transaction: async (run: () => void) => { active = []; run(); transactions.push(active) },
      swapInFlight: async () => true,
    }
    const origin = { kind: "user_undo" as const, reviewRevision: 7, scope: "session" as const, fileId: "file-a", sourceMutationIds: Array.from({ length: 2_000 }, () => randomUUID()) }
    const context = { sessionEventWriter: writer, origin }
    const [prepared] = await prepareFileMutationOperation(context, [{
      change: { path: "/repo/a", displayPath: "a", changeKind: "modified", beforeContent: "new\n", afterContent: "old\n" },
      evidence: { beforeSnapshot: mutationSnapshot("new\n") },
    }])
    expect(prepared!.fact).toMatchObject({ version: 2, payload: { origin } })
    expect(prepared!.fact.payload).not.toHaveProperty("toolUseId")
    expect(prepared!.operationId).not.toBe("source-a")
    expect(prepared!.state.header).toMatchObject({ version: 3 })
    const hydrated = await readFileMutationOperation(prepared!.state.header!, content.readContentNode)
    expect(hydrated.items[0]?.evidence).toEqual(prepared!.fact.payload)
    expect(Buffer.byteLength(JSON.stringify(prepared!.state.header))).toBeLessThan(4096)
    expect(prepared!.state.items[0]).not.toHaveProperty("mutationDiff")
    expect(prepared!.evidence).toMatchObject({ mutationId: prepared!.mutationId, path: "/repo/a", displayPath: "a", patch: { kind: "retained" } })
    await settleFileMutation(context, prepared!, snapshotToFileObjectProof(mutationSnapshot("old\n")))
    expect(transactions).toHaveLength(1)
    expect(transactions[0]).toEqual([
      expect.objectContaining({ fact: expect.objectContaining({ type: "file.changed", version: 4, payload: expect.objectContaining({ origin, beforeAccess: { kind: "posix", mode: 0o640 }, afterAccess: { kind: "posix", mode: 0o640 } }) }) }),
      expect.objectContaining({
        fact: expect.objectContaining({ type: "file.artifact.recorded", payload: expect.objectContaining({
          mutationId: prepared!.mutationId, ownerKind: "runtime", ownerId: prepared!.operationId, artifactKind: "mutation_diff",
          evidence: prepared!.evidence,
        }) }),
        inFlight: [expect.objectContaining({ op: "swap", payload: null })],
      }),
    ])
  })

  it("stores the complete ordered operation in one guarded preparation", async () => {
    const swaps: unknown[] = []
    const writer = {
      stageSessionContentNodes: async () => {},
      record: async () => null,
      transaction: async (run: () => void) => { run() },
      swapInFlight: async (_kind: string, _key: string, expected: string | null, payload: unknown) => {
        swaps.push({ expected, payload })
        return true
      },
    }

    const prepared = await prepareFileMutationOperation(
      { sessionEventWriter: writer, origin: { kind: "tool_call", toolUseId: "operation" } },
      [
        { change: { path: "/repo/destination", displayPath: "destination", changeKind: "created", beforeContent: null, afterContent: "bytes" }, evidence: { beforeSnapshot: null } },
        { change: { path: "/repo/source", displayPath: "source", changeKind: "deleted", beforeContent: "bytes", afterContent: null }, evidence: { beforeSnapshot: mutationSnapshot("bytes") } },
      ],
    )

    expect(prepared).toHaveLength(2)
    expect(swaps).toHaveLength(1)
    expect(swaps[0]).toMatchObject({ expected: null, payload: { version: 3, cursor: 0, plan: { root: expect.any(String), entries: 2 } } })
    expect(swaps[0]).not.toHaveProperty("payload.items")
  })
})

describe("publication-owned mutation evidence", () => {
  it.each(["creation", "edit", "deletion", "move"] as const)("settles each %s item with its evidence, endpoint access and cursor together", async kind => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const source = join(root, "source.txt")
      if (kind !== "creation") writeFileSync(source, "before\n")
      const paths = kind === "move" ? ["destination.txt", "source.txt"] : ["source.txt"]
      let settled = 0
      const outcome = await publishFileEdits({ ...mutationContext(writer), executionCwd: root }, {
        paths,
        admit: path => RetainedFileEditAuthority.admitWritable(path),
        plan: admitted => admitted.map(entry => ({ admitted: entry, after: kind === "deletion" || (kind === "move" && entry.path === "source.txt") ? undefined : "after\n" })),
        onSettled: publication => {
          settled += 1
          const facts = mutationFacts(store, sessionId)
          expect(facts).toHaveLength(settled * 2)
          const changed = facts.at(-2)!
          expect(changed).toMatchObject({ type: "file.changed", version: 4, payload: { mutationId: publication.mutation!.mutationId } })
          expect(changed.payload).toHaveProperty("beforeAccess")
          expect(changed.payload).toHaveProperty("afterAccess")
          expect(facts.at(-1)).toMatchObject({ type: "file.artifact.recorded", version: 4, payload: {
            mutationId: publication.mutation!.mutationId, evidence: publication.mutation!.evidence,
          } })
          const rows = store.readInFlight(sessionId, "file.mutation")
          if (settled === paths.length) expect(rows).toEqual([])
          else expect(rows[0]?.payload).toMatchObject({ version: 3, cursor: settled })
        },
      })
      expect(outcome.status).toBe("completed")
      expect(settled).toBe(paths.length)
      expect(existsSync(source)).toBe(kind !== "deletion" && kind !== "move")
    })
  })

  it.each(["missing", "failed"] as const)("refuses %s evidence staging before changing any file or recovery cell", async failure => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "target.txt")
      writeFileSync(path, "before")
      const sessionEventWriter = {
        ...writer,
        stageSessionContentNodes: failure === "missing" ? undefined : async () => { throw new Error("staging failed") },
      }
      await expect(publishFileEdits({ ...mutationContext(sessionEventWriter), executionCwd: root }, {
        paths: ["target.txt"],
        admit: target => RetainedFileEditAuthority.admit(target),
        plan: admitted => admitted.map(entry => ({ admitted: entry, after: "after" })),
      })).rejects.toThrow(failure === "missing" ? "staging is unavailable" : "staging failed")
      expect(readFileSync(path, "utf8")).toBe("before")
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
      expect(mutationFacts(store, sessionId)).toEqual([])
    })
  })

  it("keeps the settled prefix and settles the unproven item as indeterminate when a later settlement fails", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      for (const name of ["first", "second", "third"]) writeFileSync(join(root, name), "before")
      let transactions = 0
      const sessionEventWriter = { ...writer, transaction: async (run: () => void) => {
        if (++transactions === 2) throw new Error("settlement failed")
        await writer.transaction(run)
      } }
      const outcome = await publishFileEdits({ ...mutationContext(sessionEventWriter), executionCwd: root }, {
        paths: ["first", "second", "third"],
        admit: path => RetainedFileEditAuthority.admit(path),
        plan: admitted => admitted.map(entry => ({ admitted: entry, after: "after" })),
      })
      expect(outcome).toMatchObject({ status: "uncertain", stage: "settlement", publication: "applied", settlement: "pending" })
      expect(outcome.committedPrefix).toHaveLength(1)
      expect(["first", "second", "third"].map(name => readFileSync(join(root, name), "utf8"))).toEqual(["after", "after", "before"])
      expect(mutationFacts(store, sessionId)).toHaveLength(2)
      expect(mutationFacts(store, sessionId)[1]).toMatchObject({ version: 4, payload: { evidence: outcome.committedPrefix[0]!.mutation!.evidence } })
      expect(await reconcilePendingFileMutations({ store: asAsyncEventReadSurface(store), sessionId, writer: asAsyncEventWriter(store) })).toEqual([])
      expect(mutationFacts(store, sessionId)).toHaveLength(3)
      expect(mutationFacts(store, sessionId)[2]).toMatchObject({ type: "file.mutation.settled", payload: { outcome: "indeterminate" } })
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it("stages every retained byte of a single long line and verifies the readback identity before settlement", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const before = "a".repeat(150_000)
      const after = "b".repeat(150_000)
      const path = join(root, "long.txt")
      writeFileSync(path, before)
      const prepared = await prepareFileMutationOperation(mutationContext(writer), [{
        change: { path, displayPath: "long.txt", changeKind: "modified", beforeContent: before, afterContent: after },
        evidence: { beforeSnapshot: mutationSnapshot(before) },
      }])
      const mutation = prepared[0]!
      expect(JSON.stringify(mutation.state.header).length).toBeLessThan(4096)
      await expect(settleFileMutation(mutationContext(writer), mutation, snapshotToFileObjectProof(mutationSnapshot("wrong")))).rejects.toThrow("readback does not match")
      expect(mutationFacts(store, sessionId)).toEqual([])
      await settleFileMutation(mutationContext(writer), mutation, snapshotToFileObjectProof(mutationSnapshot(after)))
      const artifact = mutationFacts(store, sessionId)[1]!
      if (artifact.type !== "file.artifact.recorded" || artifact.version !== 4 || artifact.payload.evidence.patch.kind !== "retained") throw new Error("expected retained artifact")
      const reference = artifact.payload.evidence.patch.reference
      expect(artifact.payload.evidence).toMatchObject({ retainedLines: 2, omittedLines: 0 })
      const parts: Buffer[] = []
      let offset = 0
      do {
        const window = await readSessionContentRange(reference, offset, 64 * 1024, async hash => store.readSessionContentNode!(sessionId, hash))
        if (window.kind !== "available") throw new Error("expected available content")
        parts.push(Buffer.from(window.base64, "base64"))
        offset = window.nextOffset ?? reference.bytes
      } while (offset < reference.bytes)
      expect(parts.length).toBeGreaterThan(1)
      const patch = Buffer.concat(parts)
      expect(createHash("sha256").update(patch).digest("hex")).toBe(reference.sha256)
      expect(patch.toString("utf8")).toContain(`-${before}\n`)
      expect(patch.toString("utf8")).toContain(`+${after}\n`)
    })
  })

  it("settles invalid UTF-8 bytes with unavailable evidence instead of a fabricated text inverse", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const outcome = await publishFileEdits({ ...mutationContext(writer), executionCwd: root }, {
        paths: ["binary"],
        admit: path => RetainedFileEditAuthority.admitWritable(path),
        plan: admitted => admitted.map(entry => ({ admitted: entry, after: Buffer.from([0xff, 0x00]) })),
      })
      expect(outcome.status).toBe("completed")
      expect(mutationFacts(store, sessionId)[1]).toMatchObject({ type: "file.artifact.recorded", version: 4, payload: { evidence: {
        before: null, after: { bytes: 2 }, patch: { kind: "unavailable" },
      } } })
      expect(readFileSync(join(root, "binary"))).toEqual(Buffer.from([0xff, 0x00]))
    })
  })
})

describe("not-applied mutation retirement", () => {
  it.each(["operation", "item"] as const)("atomically records a refusal with %s retirement without staging the plan again", async scope => {
    const facts: unknown[] = []
    const swaps: unknown[] = []
    let stages = 0
    const writer = {
      stageSessionContentNodes: async () => { stages++ },
      record: async (fact: unknown, _contentRows?: undefined, inFlight?: readonly unknown[]) => { facts.push(fact); if (inFlight) swaps.push(...inFlight); return null },
      transaction: async (run: () => void) => { run() },
      swapInFlight: async () => true,
    }
    const context = { sessionEventWriter: writer, origin: { kind: "tool_call" as const, toolUseId: "operation" } }
    const [current, last] = await prepareFileMutationOperation(context, [
      { change: { path: "/repo/a", displayPath: "a", changeKind: "modified", beforeContent: "old", afterContent: "new" }, evidence: { beforeSnapshot: mutationSnapshot("old") } },
      { change: { path: "/repo/b", displayPath: "b", changeKind: "created", beforeContent: null, afterContent: "new" }, evidence: { beforeSnapshot: null } },
    ])
    if (!current) throw new Error("expected current mutation")

    const staged = stages
    const root = current.state.header!.plan.root
    await retireFileMutationNotApplied(context, current, scope)

    expect(facts).toEqual([expect.objectContaining({ type: "file.mutation.settled", payload: { mutationId: current.mutationId, outcome: "not_applied" } })])
    expect(swaps).toEqual([expect.objectContaining({ op: "swap", key: "operation", payload: scope === "operation" ? null : expect.objectContaining({ cursor: 1, plan: expect.objectContaining({ root }) }) })])
    if (scope === "item") {
      await settleFileMutation(context, last!, snapshotToFileObjectProof(mutationSnapshot("new")))
      expect(facts).toHaveLength(3)
      expect(swaps[1]).toMatchObject({ op: "swap", payload: null })
    }
    expect(current.state.header).toBeNull()
    expect(stages).toBe(staged)
  })
})

describe("direct mutation attribution", () => {
  it("offers only the durably settled publication prefix", async () => {
    const service = createGitAiAttributionService({
      canonicalRepositoryRoot: "/repo",
      runOwnedCommand: async () => ({ exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "" }),
    })
    const writer = {
      stageSessionContentNodes: async () => {},
      record: async () => null,
      transaction: async (run: () => void) => { run() },
      swapInFlight: async () => true,
    }
    const registration = service.registerRequest({ requestId: "request-1", model: "model-1", conversationId: "conversation-1", transcriptBytes: 0, transcript: () => ({ messages: [] }) })!
    const identity = Object.freeze({ ...registration, service, repositoryRoot: "/repo", profileId: "work", enabled: true as const })
    const context = {
      sessionEventWriter: writer,
      toolUseId: "tool-1",
      origin: { kind: "tool_call" as const, toolUseId: "tool-1" },
      gitAiAttribution: service,
      attributionIdentity: identity,
    }
    const [first] = await prepareFileMutationOperation(context, [
      { change: { path: "/repo/a.ts", displayPath: "a.ts", changeKind: "created", beforeContent: null, afterContent: "b" }, evidence: { beforeSnapshot: null } },
      { change: { path: "/repo/b.ts", displayPath: "b.ts", changeKind: "modified", beforeContent: "a", afterContent: "b" }, evidence: { beforeSnapshot: mutationSnapshot("a") } },
    ])
    if (!first) throw new Error("expected first mutation")
    expect(takeFileMutationAttribution(context)).toBeUndefined()
    await settleFileMutation(context, first, snapshotToFileObjectProof(mutationSnapshot("b")))
    settleFileMutationArtifact(context, { path: "/repo/a.ts", beforeContent: "", afterContent: "b" })

    expect(takeFileMutationAttribution(context)).toEqual({
      identity,
      files: [{ path: "/repo/a.ts", beforeContent: "", afterContent: "b" }],
    })
    expect(takeFileMutationAttribution(context)).toBeUndefined()
    await service.dispose()
  })
})
