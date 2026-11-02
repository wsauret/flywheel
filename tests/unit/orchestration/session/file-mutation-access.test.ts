import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { readSessionContentRange } from "../../../../src/infra/session-content.js"
import { publishFileEdits } from "../../../../src/orchestration/file-edits/file-edit-operation.js"
import { RetainedFileEditAuthority } from "../../../../src/orchestration/file-edits/retained-file-edit-host.js"
import { prepareFileMutationOperation, settleFileMutation } from "../../../../src/orchestration/session/file-mutation-fact-writers.js"
import { parseFileMutationFact, type FileMutationOrigin } from "../../../../src/orchestration/session/file-mutation-facts.js"
import { parseFileAccessProof } from "../../../../src/orchestration/session/file-mutation-access.js"
import { snapshotToFileObjectProof } from "../../../../src/orchestration/session/file-mutation-operation.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { createRecordingFileMutationStore } from "../agent-runtime/tools/_fixtures.js"
import { mutationSnapshot } from "./file-mutation-proof-fixture.js"
import { mutationFacts, withStore } from "./file-mutation-recovery-fixture.js"

describe("durable file access evidence", () => {
  it.skipIf(process.platform === "win32").each(["tool_call", "user_undo"] as const)("retains actual create, modify and delete access after SQLite reopen for %s", async kind => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-access-evidence-")))
    const sessionId = "access-session"
    const dbFile = resolveEventStoreDbFile(root)
    const origin: FileMutationOrigin = kind === "tool_call"
      ? { kind, toolUseId: "access-tool" }
      : { kind, reviewRevision: 3, scope: "session", fileId: "file", sourceMutationIds: ["source"] }
    let createdMode = 0
    try {
      const store = createSqliteEventStore(dbFile)
      const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
      const path = join(root, "file.txt")
      try {
        const publish = (after: string | undefined) => publishFileEdits({ executionCwd: root, sessionEventWriter: writer, origin }, {
          paths: ["file.txt"],
          admit: target => RetainedFileEditAuthority.admitWritable(target),
          plan: admitted => admitted.map(entry => ({ admitted: entry, after })),
        })
        expect((await publish("\uFEFFbefore\r\n")).status).toBe("completed")
        createdMode = statSync(path).mode & 0o777
        chmodSync(path, 0o640)
        expect((await publish("\uFEFFafter\r\n")).status).toBe("completed")
        expect(readFileSync(path)).toEqual(Buffer.from("\uFEFFafter\r\n"))
        expect(statSync(path).mode & 0o777).toBe(0o640)
        chmodSync(path, 0o751)
        expect((await publish(undefined)).status).toBe("completed")
        expect(existsSync(path)).toBe(false)
        expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
      } finally {
        writer.dispose()
        store.close()
      }
      const reopened = createSqliteEventStore(dbFile)
      try {
        const facts = mutationFacts(reopened, sessionId)
        const changes = facts.filter(fact => fact.type === "file.changed")
        expect(changes).toMatchObject([
          { version: 4, payload: { changeKind: "created", origin, before: null, beforeAccess: null, afterAccess: { kind: "posix", mode: createdMode } } },
          { version: 4, payload: { changeKind: "modified", origin, beforeAccess: { kind: "posix", mode: 0o640 }, afterAccess: { kind: "posix", mode: 0o640 } } },
          { version: 4, payload: { changeKind: "deleted", origin, beforeAccess: { kind: "posix", mode: 0o751 }, afterAccess: null, after: null } },
        ])
        const evidence = (text: string) => ({ bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") })
        expect(changes[1]?.payload).toMatchObject({ before: evidence("\uFEFFbefore\r\n"), after: evidence("\uFEFFafter\r\n") })
        expect(changes[2]?.payload).toMatchObject({ before: evidence("\uFEFFafter\r\n") })
        expect(reopened.readInFlight(sessionId, "file.mutation")).toEqual([])
        const artifacts = facts.filter(fact => fact.type === "file.artifact.recorded")
        expect(JSON.stringify(artifacts)).not.toContain("Access")
        if (kind === "user_undo") {
          const artifact = artifacts[2]
          expect(artifact).toMatchObject({ version: 4, payload: { artifactKind: "mutation_diff", evidence: { change: "removed", patch: { kind: "retained" } } } })
          if (artifact?.version !== 4 || artifact.payload.evidence.patch.kind !== "retained") throw new Error("Expected retained Undo evidence")
          const readNode = reopened.readSessionContentNode
          if (!readNode) throw new Error("Expected session content storage")
          const window = await readSessionContentRange(artifact.payload.evidence.patch.reference, 0, 65536,
            async hash => readNode(sessionId, hash))
          expect(window.kind).toBe("available")
          if (window.kind !== "available") throw new Error("Expected stored Undo evidence")
          expect(window.nextOffset).toBeNull()
          expect(Buffer.from(window.base64, "base64").toString("utf8")).toContain("-\uFEFFafter")
        }
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === "win32")("records destination and source endpoint access for a move", async () => {
    await withStore(async ({ root, writer, store, sessionId }) => {
      writeFileSync(join(root, "source"), "\uFEFFsource\n")
      chmodSync(join(root, "source"), 0o751)
      writeFileSync(join(root, "destination"), "destination\n")
      chmodSync(join(root, "destination"), 0o600)
      const result = await publishFileEdits({ executionCwd: root, sessionEventWriter: writer, origin: { kind: "tool_call", toolUseId: "move" } }, {
        paths: ["source", "destination"],
        admit: path => RetainedFileEditAuthority.admit(path),
        plan: admitted => [
          { admitted: admitted[1]!, after: admitted[0]!.authority.text, metadata: admitted[0]!.authority.snapshot!.metadata },
          { admitted: admitted[0]!, after: undefined },
        ],
      })
      expect(result.status).toBe("completed")
      expect(mutationFacts(store, sessionId).filter(fact => fact.type === "file.changed")).toMatchObject([
        { version: 4, payload: { displayPath: "destination", beforeAccess: { kind: "posix", mode: 0o600 }, afterAccess: { kind: "posix", mode: 0o751 } } },
        { version: 4, payload: { displayPath: "source", beforeAccess: { kind: "posix", mode: 0o751 }, afterAccess: null } },
      ])
      expect(readFileSync(join(root, "destination"))).toEqual(Buffer.from("\uFEFFsource\n"))
      expect(existsSync(join(root, "source"))).toBe(false)
    })
  })

  it("round trips captured Windows DACL bytes through the completed fact codec", async () => {
    const store = createRecordingFileMutationStore()
    const beforeDacl = Buffer.from([0, 255, 128, 3, 7])
    const afterDacl = Buffer.from([4, 0, 129, 255])
    const before = mutationSnapshot("before", { kind: "win32", dacl: beforeDacl })
    const after = mutationSnapshot("after", { kind: "win32", dacl: afterDacl })
    const context = { sessionEventWriter: store.writer, origin: { kind: "tool_call" as const, toolUseId: "dacl" } }
    const [prepared] = await prepareFileMutationOperation(context, [{
      change: { path: "/file", displayPath: "file", changeKind: "modified", beforeContent: before.content, afterContent: after.content },
      evidence: { beforeSnapshot: before, postconditionAccess: before.metadata },
    }])
    await settleFileMutation(context, prepared!, snapshotToFileObjectProof(after))
    const fact = parseFileMutationFact(JSON.parse(JSON.stringify(store.facts[0])))
    if (fact.type !== "file.changed" || fact.version !== 4) throw new Error("Expected current changed fact")
    expect(fact.payload.beforeAccess).toEqual({ kind: "win32", daclBase64: beforeDacl.toString("base64") })
    expect(fact.payload.afterAccess).toEqual({ kind: "win32", daclBase64: afterDacl.toString("base64") })
    if (fact.payload.beforeAccess?.kind !== "win32" || fact.payload.afterAccess?.kind !== "win32") throw new Error("Expected Windows access")
    expect(Buffer.from(fact.payload.beforeAccess.daclBase64, "base64")).toEqual(beforeDacl)
    expect(Buffer.from(fact.payload.afterAccess.daclBase64, "base64")).toEqual(afterDacl)
    expect(() => parseFileMutationFact({ ...fact, payload: { ...fact.payload, beforeAccess: null } })).toThrow()
    const { afterAccess: _access, ...missingAccess } = fact.payload
    expect(() => parseFileMutationFact({ ...fact, payload: missingAccess })).toThrow()
    expect(() => parseFileMutationFact({ ...fact, payload: { ...fact.payload, afterAccess: { kind: "posix", mode: -1 } } })).toThrow()
    expect(() => parseFileMutationFact({ ...fact, payload: { ...fact.payload, afterAccess: { kind: "win32", daclBase64: 12 } } })).toThrow()
    expect(() => parseFileMutationFact({ ...fact, payload: { ...fact.payload, afterAccess: { kind: "win32", daclBase64: "", extra: true } } })).toThrow()
  })

  it("keeps historical fact shapes unchanged without inventing access", () => {
    const content = { path: "/file", displayPath: "file", changeKind: "created", before: null, after: { bytes: 1, sha256: "a".repeat(64), preview: "a" } }
    const payloads = [
      { ...content, toolUseId: "tool" },
      { ...content, mutationId: "mutation", toolUseId: "tool" },
      { ...content, mutationId: "mutation", operationId: "operation", origin: { kind: "tool_call", toolUseId: "tool" } },
    ]
    for (const [index, payload] of payloads.entries()) {
      const input = { type: "file.changed", version: index + 1, actor: "flywheel", payload }
      expect<unknown>(parseFileMutationFact(input)).toEqual(input)
      expect(parseFileMutationFact(input).payload).not.toHaveProperty("beforeAccess")
      expect(() => parseFileMutationFact({ ...input, payload: { ...payload, beforeAccess: null, afterAccess: { kind: "posix", mode: 0o644 } } })).toThrow()
    }
    expect(parseFileAccessProof({ kind: "posix", mode: 1e20, oldExtra: true })).toEqual({ kind: "posix", mode: 1e20 })
  })
})
