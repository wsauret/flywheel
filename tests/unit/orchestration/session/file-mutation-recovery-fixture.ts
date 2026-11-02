import { chmodSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { RetainedFileEditAuthority } from "../../../../src/orchestration/file-edits/retained-file-edit-host.js"
import { prepareFileMutationOperation } from "../../../../src/orchestration/session/file-mutation-fact-writers.js"
import { parseFileMutationFact } from "../../../../src/orchestration/session/file-mutation-facts.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { snapshotToFileObjectProof } from "../../../../src/orchestration/session/file-mutation-operation.js"

const MUTATION_TYPES = ["file.mutation.prepared", "file.mutation.settled", "file.changed", "file.artifact.recorded"] as const
const MUTATION_TYPE_SET: ReadonlySet<string> = new Set(MUTATION_TYPES)

export async function withStore(run: (fixture: ReturnType<typeof createFixture>) => Promise<void>): Promise<void> {
  const fixture = createFixture()
  try {
    await run(fixture)
  } finally {
    fixture.writer.dispose()
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-file-mutation-")))
  const store = createSqliteEventStore(resolveEventStoreDbFile(root))
  const sessionId = "mutation-session"
  const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
  return { root, store, writer, sessionId }
}

export function context(writer: ReturnType<typeof createSessionFactWriter>, toolUseId = "tool-call") {
  return { sessionEventWriter: writer, origin: { kind: "tool_call" as const, toolUseId, modelRequestId: "request" } }
}

export async function prepare(writer: ReturnType<typeof createSessionFactWriter>, path: string, beforeContent: string, afterContent: string) {
  const change = { path, displayPath: path, changeKind: "modified" as const, beforeContent, afterContent }
  const authority = RetainedFileEditAuthority.admit(path)
  try {
    const [prepared] = await prepareFileMutationOperation(context(writer), [{
      change,
      evidence: (() => {
        const snapshot = authority.existingSnapshot()
        return { beforeSnapshot: snapshot, postconditionAccess: snapshot.metadata }
      })(),
    }])
    if (!prepared) throw new Error("expected prepared mutation")
    return prepared
  } finally {
    authority.close()
  }
}

export async function prepareLegacy(writer: ReturnType<typeof createSessionFactWriter>, path: string, beforeContent: string, afterContent: string) {
  if (!writer.putInFlight) throw new Error("expected in-flight writer")
  await writer.putInFlight("file.mutation", "legacy-mutation", {
    mutationId: "legacy-mutation", path, displayPath: path, changeKind: "modified",
    before: contentEvidence(beforeContent), after: contentEvidence(afterContent), toolUseId: "legacy-tool",
  })
}

export function readBackProof(path: string) {
  const authority = RetainedFileEditAuthority.admit(path)
  try {
    return snapshotToFileObjectProof(authority.existingSnapshot())
  } finally {
    authority.close()
  }
}

export async function prepareBatch(
  writer: ReturnType<typeof createSessionFactWriter>,
  changes: readonly { path: string; beforeContent: string; afterContent: string }[],
) {
  const authorities = changes.map(({ path }) => RetainedFileEditAuthority.admit(path))
  try {
    return await prepareFileMutationOperation(context(writer), changes.map(({ path, beforeContent, afterContent }, index) => {
      const authority = authorities[index]
      if (!authority) throw new Error("missing admitted authority")
      const snapshot = authority.existingSnapshot()
      return {
        change: { path, displayPath: path, changeKind: "modified" as const, beforeContent, afterContent },
        evidence: { beforeSnapshot: snapshot, postconditionAccess: snapshot.metadata },
      }
    }))
  } finally {
    for (const authority of authorities) authority.close()
  }
}

export async function prepareAdd(writer: ReturnType<typeof createSessionFactWriter>, path: string, afterContent: string, toolUseId?: string) {
  const [prepared] = await prepareFileMutationOperation(context(writer, toolUseId), [{
    change: { path, displayPath: path, changeKind: "created", beforeContent: null, afterContent },
    evidence: { beforeSnapshot: null },
  }])
  if (!prepared) throw new Error("expected prepared add")
  return prepared
}

export async function prepareDelete(writer: ReturnType<typeof createSessionFactWriter>, path: string, beforeContent: string) {
  const authority = RetainedFileEditAuthority.admit(path)
  try {
    const [prepared] = await prepareFileMutationOperation(context(writer), [{
      change: { path, displayPath: path, changeKind: "deleted", beforeContent, afterContent: null },
      evidence: { beforeSnapshot: authority.existingSnapshot() },
    }])
    if (!prepared) throw new Error("expected prepared deletion")
    return prepared
  } finally {
    authority.close()
  }
}

export async function prepareMove(root: string, writer: ReturnType<typeof createSessionFactWriter>) {
  const sourcePath = join(root, "source.sh")
  const destinationPath = join(root, "destination.sh")
  writeFileSync(sourcePath, "source")
  chmodSync(sourcePath, 0o754)
  writeFileSync(destinationPath, "destination")
  chmodSync(destinationPath, 0o600)
  const source = RetainedFileEditAuthority.admit(sourcePath)
  const destination = RetainedFileEditAuthority.admit(destinationPath)
  const sourceSnapshot = source.existingSnapshot()
  const destinationSnapshot = destination.existingSnapshot()
  const [destinationMutation, sourceMutation] = await prepareFileMutationOperation(context(writer), [{
    change: {
      path: destination.canonicalPath,
      displayPath: "destination.sh",
      changeKind: "modified",
      beforeContent: destination.strictText(),
      afterContent: source.strictText(),
    },
    evidence: { beforeSnapshot: destinationSnapshot, postconditionAccess: sourceSnapshot.metadata },
  }, {
    change: {
      path: source.canonicalPath,
      displayPath: "source.sh",
      changeKind: "deleted",
      beforeContent: source.strictText(),
      afterContent: null,
    },
    evidence: { beforeSnapshot: sourceSnapshot },
  }])
  if (!destinationMutation || !sourceMutation) throw new Error("expected move mutations")
  return { source, sourceSnapshot, destination, sourceMutation, destinationMutation }
}

export function publishReplacement(path: string, content: string): void {
  const pending = `${path}.pending`
  writeFileSync(pending, content)
  renameSync(pending, path)
}

export function mutationFacts(store: ReturnType<typeof createSqliteEventStore>, sessionId: string) {
  return store.read({ aggregateId: `session:${sessionId}` })
    .filter((event) => MUTATION_TYPE_SET.has(event.type))
    .map((event) => parseFileMutationFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload }))
}
