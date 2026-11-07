/** Two directory authorities over one repository (ARCH-DIRECTORIES-001).
 *
 *  `projectRoot` owns durable project state; each session owns the
 *  `executionCwd` its tools run in. The cases that matter are the ones where
 *  the two differ: a start inside a nested package, a restart from another
 *  directory, and a disposable project root inside an enclosing repository.
 *  Every assertion here is about placement on disk and about what a later
 *  process reads back, so nothing is stubbed except the model. */

import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selectStartupDirectories, type ProjectDirectories } from "../../../../src/infra/directory-authorities.js"
import { toFileUri } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { createMemoryTool } from "../../../../src/orchestration/modules/learning/tools/memory.js"
import { writeDefinition } from "../../../../src/orchestration/agent-runtime/tools/write.js"
import type { ToolContext } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { executionCwdFromSession, requireSessionExecutionCwd } from "../../../../src/orchestration/session/session-execution-directory.js"
import { fakeSessionStore } from "../app-service/_frontend-projection-fixtures.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { createRecordingFileMutationStore } from "../agent-runtime/tools/_fixtures.js"
import { publishTestWorkflow, startTestWorkflowMember } from "./_session-manager-fixtures.js"

interface Repo {
  readonly root: string
  readonly pkg: string
  /** The account home, beside the repository: a project under the home is never the home itself (ARCH-DIRECTORIES-001). */
  readonly home: string
  readonly cleanup: () => void
}

/** A repository with a nested package, plus a `.git` entry so repository
 *  discovery has something real to find. */
function repository(prefix: string): Repo {
  // Canonical from the start: the startup selection publishes canonical paths,
  // and on macOS the temp directory is reached through a symlink.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const root = join(tmp, "repo")
  const pkg = join(root, "packages", "pkg")
  mkdirSync(join(root, ".git"), { recursive: true })
  mkdirSync(pkg, { recursive: true })
  return { root, pkg, home: join(tmp, "home"), cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

/** A tool context whose two directories differ, with the durable writer a
 *  learning write needs to report success. */
function toolContext(executionCwd: string, projectRoot: string): ToolContext {
  return {
    executionCwd,
    userDataRoot: `${projectRoot}/.test-account`,
    projectRoot,
    toolUseId: "tool_write_1",
    artifactScopeId: "project-directory-semantics",
    retrievalSessionId: "project-directory-semantics",
    sessionEventWriter: createRecordingFileMutationStore().writer,
  }
}

/** The project's event store, over the state generation this test owns until it
 *  closes the store. */
function openProjectStore(directories: ProjectDirectories): EventStore {
  const prepared = prepareWorkspaceState(directories)
  const store = createSqliteEventStore(prepared.dbFile)
  return {
    ...store,
    close: () => {
      store.close()
      prepared.generation.release()
    },
  }
}

async function writeFileWithTool(executionCwd: string, projectRoot: string, path: string): Promise<void> {
  const result = await writeDefinition.execute({ path, content: "tool output\n" }, toolContext(executionCwd, projectRoot))
  expect(result.outcome).toBe("ok")
}

/** One assistant tool call, recorded the way a real turn records it: the tool
 *  argument keeps the relative path the model used, so only the session's
 *  execution directory can give it meaning later. */
async function recordRelativeToolCall(store: EventStore, sessionId: string, conversationId: string, relativePath: string): Promise<void> {
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
  if (!tree) throw new Error(`expected conversation tree ${conversationId}`)
  await tree.appendMessages([
    { kind: "user", content: "write the note" },
    {
      kind: "assistant",
      content: [{ type: "tool_use", id: "tool_write_1", name: "write", input: { path: relativePath, content: "tool output\n" } }],
    },
    { kind: "toolResult", toolUseId: "tool_write_1", content: [{ type: "text", text: `Wrote 12 bytes to ${relativePath}` }] },
  ])
  tree.getStorage().dispose()
}

function historyProjection(store: EventStore, projectRoot: string, manager: Parameters<typeof createSessionDetailProjection>[0]["manager"]) {
  return createSessionDetailProjection({
    projectRoot,
    sessionStore: { get: () => undefined },
    manager,
    reader: asAsyncEventReadSurface(store),
    projectionReader: asAsyncEventReadSurface(store),
  })
}

const SESSION_CREATED_AT = "2026-01-01T00:00:00.000Z"
interface SessionCreatedPayload { [key: string]: unknown }


function appendChatSession(store: EventStore, sessionId: string, version: number, payload: SessionCreatedPayload): void {
  store.append({
    aggregateId: `session:${sessionId}`,
    sessionId,
    type: "session.created",
    version,
    actor: "flywheel",
    timestamp: 1,
    payload,
  })
}

function currentChat(executionCwd?: string): SessionCreatedPayload {
  return {
    kind: "chat",
    command: "chat",
    conversationId: "resolver-conversation",
    label: "Resolver",
    lastUpdated: SESSION_CREATED_AT,
    lifecycleState: "inactive",
    ...(executionCwd === undefined ? {} : { executionCwd }),
  }
}

describe("a session created inside a nested package", () => {
  it("selects the repository as projectRoot, records the package as executionCwd, and keeps durable state at the repository", async () => {
    const repo = repository("flywheel-nested-package-")
    try {
      const directories = selectStartupDirectories({ env: {}, cwd: repo.pkg, home: repo.home })

      expect(directories.projectRoot).toBe(repo.root)
      expect(directories.executionCwd).toBe(repo.pkg)

      const store = openProjectStore(directories)
      try {
        const manager = createSessionManager({ projectRoot: directories.projectRoot, executionCwd: directories.executionCwd, store })
        const sessionId = await manager.createChat({ name: "Nested" })

        expect((await manager.read(sessionId))?.executionCwd).toBe(repo.pkg)
        expect((await manager.listMetadata()).sessions[0]?.executionCwd).toBe(repo.pkg)
        expect(existsSync(join(repo.root, ".flywheel", "flywheel.sqlite"))).toBe(true)
        expect(existsSync(join(repo.pkg, ".flywheel"))).toBe(false)

        await writeFileWithTool(await requireSessionExecutionCwd(manager, sessionId, directories.projectRoot), directories.projectRoot, "notes.txt")
        expect(readFileSync(join(repo.pkg, "notes.txt"), "utf8")).toBe("tool output\n")
        expect(existsSync(join(repo.root, "notes.txt"))).toBe(false)
      } finally {
        store.close()
      }
    } finally {
      repo.cleanup()
    }
  })
})

describe("a restart from the repository root", () => {
  it("reopens the session in its recorded package directory and resolves historical relative paths there, also after the directory is removed", async () => {
    const repo = repository("flywheel-restart-")
    try {
      const launch = selectStartupDirectories({ env: {}, cwd: repo.pkg, home: repo.home })
      const conversationId = "conv-restart"
      const first = openProjectStore(launch)
      let sessionId: string
      try {
        const manager = createSessionManager({ projectRoot: launch.projectRoot, executionCwd: launch.executionCwd, store: first })
        sessionId = await manager.createChat({ name: "Nested", conversationId })
        await recordRelativeToolCall(first, sessionId, conversationId, "notes.txt")
      } finally {
        first.close()
      }

      // A later process starting at the repository root: its own directory is
      // the repository, and the session's is still the package.
      const restart = selectStartupDirectories({ env: {}, cwd: repo.root, home: repo.home })
      expect(restart.executionCwd).toBe(repo.root)

      const reopened = openProjectStore(restart)
      try {
        const manager = createSessionManager({ projectRoot: restart.projectRoot, executionCwd: restart.executionCwd, store: reopened })
        expect(await requireSessionExecutionCwd(manager, sessionId, restart.projectRoot)).toBe(repo.pkg)

        // History reads the same before and after its directory is removed
        // (PI-INTERACTION-147): nothing re-reads it against the project root.
        for (const removed of [false, true]) {
          if (removed) rmSync(repo.pkg, { recursive: true, force: true })
          const projection = historyProjection(reopened, restart.projectRoot, manager)
          const detail = (await projection.sessionDetail(sessionId)).view
          expect(detail?.row.executionCwd).toBe(repo.pkg)
          const catalog = createFrontendProjection({ sessionStore: fakeSessionStore(new Map()), manager, projectRoot: restart.projectRoot })
          expect((await catalog.snapshot()).rows.find((row) => row.id === sessionId)?.executionCwd).toBe(repo.pkg)

          const range = await projection.outputRange(sessionId, { anchor: { kind: "tail" }, maxBlocks: 32, maxBytes: 1024 * 1024 })
          if (range.kind !== "ok") throw new Error(`expected an ok tail range, got ${range.kind}`)
          const tool = range.blocks.find((block) => block.kind === "tool")
          expect(tool?.presentation.detail).toBe("notes.txt")
          expect(tool?.linkUri).toBe(toFileUri(join(repo.pkg, "notes.txt")))
          await projection.dispose()
        }
      } finally {
        reopened.close()
      }
    } finally {
      repo.cleanup()
    }
  })
})

describe("an agent of a workflow launched in a package directory", () => {
  it("reads its history in the workflow's recorded directory, also after the directory is removed", async () => {
    // An agent records no directory of its own: it reads its workflow's
    // through membership (ARCH-DIRECTORIES-007).
    const repo = repository("flywheel-workflow-agent-history-")
    const store = openProjectStore(selectStartupDirectories({ env: {}, cwd: repo.root, home: repo.home }))
    try {
      const manager = createSessionManager({ projectRoot: repo.root, executionCwd: repo.root, store })
      const workflowId = await publishTestWorkflow(manager, { executionCwd: repo.pkg })
      const agentId = await startTestWorkflowMember(manager, store, workflowId)
      await recordRelativeToolCall(store, agentId, `${workflowId}-conversation`, "notes.txt")

      for (const removed of [false, true]) {
        if (removed) rmSync(repo.pkg, { recursive: true, force: true })
        const projection = historyProjection(store, repo.root, manager)
        expect((await projection.sessionDetail(agentId)).view?.row.executionCwd).toBe(repo.pkg)
        const range = await projection.outputRange(agentId, { anchor: { kind: "tail" }, maxBlocks: 32, maxBytes: 1024 * 1024 })
        if (range.kind !== "ok") throw new Error(`expected an ok tail range, got ${range.kind}`)
        expect(range.blocks.find((block) => block.kind === "tool")?.linkUri).toBe(toFileUri(join(repo.pkg, "notes.txt")))
        await projection.dispose()
      }
    } finally {
      store.close()
      repo.cleanup()
    }
  })
})

describe("an explicit project root inside an enclosing repository", () => {
  it("keeps every durable write in the disposable root and leaves the enclosing repository untouched", async () => {
    const outer = repository("flywheel-isolation-")
    try {
      const enclosing = selectStartupDirectories({ env: {}, cwd: outer.root, home: outer.home })
      const outerStore = openProjectStore(enclosing)
      const outerDbFile = join(outer.root, ".flywheel", "flywheel.sqlite")
      let outerSessionId: string
      try {
        const manager = createSessionManager({ projectRoot: outer.root, executionCwd: outer.root, store: outerStore })
        outerSessionId = await manager.createChat({ name: "Enclosing" })
      } finally {
        outerStore.close()
      }
      const before = fingerprint(outerDbFile)

      // A disposable project root and a separate execution directory, both
      // below the enclosing repository and neither marked with `.git`.
      const sandbox = join(outer.root, "sandbox")
      const sandboxExecution = join(outer.root, "sandbox-execution")
      const home = join(outer.root, "home")
      for (const dir of [sandbox, sandboxExecution, home]) mkdirSync(dir, { recursive: true })
      const directories = selectStartupDirectories({ env: { FLYWHEEL_PROJECT_ROOT: sandbox }, cwd: sandboxExecution, home })
      expect(directories.projectRoot).toBe(sandbox)
      expect(directories.executionCwd).toBe(sandboxExecution)
      expect(directories.userDataRoot).toBe(join(home, ".flywheel"))

      const store = openProjectStore(directories)
      try {
        const manager = createSessionManager({ projectRoot: directories.projectRoot, executionCwd: directories.executionCwd, store })
        const sessionId = await manager.createChat({ name: "Sandboxed" })
        expect((await manager.listMetadata()).sessions.map((session) => session.id)).toEqual([sessionId])

        await writeFileWithTool(await requireSessionExecutionCwd(manager, sessionId, directories.projectRoot), directories.projectRoot, "artifact.txt")
        const memory = createMemoryTool({ accountHome: home, sessionId }, () => true)
        const stored = await memory.execute(
          { title: "Sandbox note", action: "add", content: "Project learning belongs to the project root." },
          toolContext(directories.executionCwd, directories.projectRoot),
        )
        expect(stored.outcome).toBe("ok")

        expect(existsSync(join(sandbox, ".flywheel", "flywheel.sqlite"))).toBe(true)
        expect(readFileSync(join(sandbox, ".flywheel", "memory", "MEMORY.json"), "utf8")).toContain("Project learning belongs to the project root.")
        expect(readFileSync(join(sandboxExecution, "artifact.txt"), "utf8")).toBe("tool output\n")
        expect(existsSync(join(sandboxExecution, ".flywheel"))).toBe(false)
      } finally {
        store.close()
      }

      expect(fingerprint(outerDbFile)).toEqual(before)
      const reopened = openProjectStore(enclosing)
      try {
        const manager = createSessionManager({ projectRoot: outer.root, executionCwd: outer.root, store: reopened })
        expect((await manager.listMetadata()).sessions.map((session) => session.id)).toEqual([outerSessionId])
      } finally {
        reopened.close()
      }
    } finally {
      outer.cleanup()
    }
  })
})

describe("session execution-directory resolution", () => {
  it("uses a canonical recorded directory when it exists", async () => {
    const repo = repository("flywheel-resolver-recorded-")
    const store = openProjectStore(selectStartupDirectories({ env: {}, cwd: repo.root, home: repo.home }))
    try {
      appendChatSession(store, "recorded", 3, currentChat(repo.pkg))
      const manager = createSessionManager({ projectRoot: repo.root, executionCwd: repo.root, store })

      expect(await requireSessionExecutionCwd(manager, "recorded", repo.root)).toBe(repo.pkg)
    } finally {
      store.close()
      repo.cleanup()
    }
  })

  it("refuses to start work in a removed recorded directory and names it", async () => {
    const repo = repository("flywheel-resolver-missing-")
    const store = openProjectStore(selectStartupDirectories({ env: {}, cwd: repo.root, home: repo.home }))
    try {
      const removed = join(repo.root, "removed")
      appendChatSession(store, "missing", 3, currentChat(removed))
      const manager = createSessionManager({ projectRoot: repo.root, executionCwd: repo.root, store })
      const refusal = `session execution directory does not exist: ${removed}. Restore the directory to continue.`

      expect(() => executionCwdFromSession({ executionCwd: removed }, "missing", repo.root)).toThrow(refusal)
      await expect(requireSessionExecutionCwd(manager, "missing", repo.root)).rejects.toThrow(refusal)
    } finally {
      store.close()
      repo.cleanup()
    }
  })

  it("uses the canonical project root for identity-only metadata", async () => {
    const repo = repository("flywheel-resolver-identity-")
    const store = openProjectStore(selectStartupDirectories({ env: {}, cwd: repo.root, home: repo.home }))
    try {
      appendChatSession(store, "identity", 3, currentChat())
      const manager = createSessionManager({ projectRoot: repo.root, executionCwd: repo.root, store })

      expect((await manager.read("identity"))?.executionCwd).toBeUndefined()

      expect(await requireSessionExecutionCwd(manager, "identity", repo.root)).toBe(repo.root)
    } finally {
      store.close()
      repo.cleanup()
    }
  })

  for (const version of [1, 2]) {
    it(`uses the canonical project root for valid v${version} metadata`, async () => {
      const repo = repository(`flywheel-resolver-v${version}-`)
      const store = openProjectStore(selectStartupDirectories({ env: {}, cwd: repo.root, home: repo.home }))
      try {
        appendChatSession(store, `legacy-${version}`, version, currentChat())
        const manager = createSessionManager({ projectRoot: repo.root, executionCwd: repo.root, store })

        expect((await manager.read(`legacy-${version}`))?.executionCwd).toBeUndefined()

        expect(await requireSessionExecutionCwd(manager, `legacy-${version}`, repo.root)).toBe(repo.root)
      } finally {
        store.close()
        repo.cleanup()
      }
    })
  }

  it("records a historical execution-directory update", async () => {
    const repo = repository("flywheel-resolver-updated-")
    const store = openProjectStore(selectStartupDirectories({ env: {}, cwd: repo.root, home: repo.home }))
    try {
      appendChatSession(store, "updated", 1, currentChat())
      store.append({
        aggregateId: "session:updated",
        sessionId: "updated",
        type: "session.execution_cwd.updated",
        version: 1,
        actor: "flywheel",
        timestamp: 2,
        payload: { executionCwd: repo.pkg, lastUpdated: "2026-01-01T00:00:01.000Z" },
      })
      const manager = createSessionManager({ projectRoot: repo.root, executionCwd: repo.root, store })

      expect((await manager.read("updated"))?.executionCwd).toBe(repo.pkg)
      expect(await requireSessionExecutionCwd(manager, "updated", repo.root)).toBe(repo.pkg)
    } finally {
      store.close()
      repo.cleanup()
    }
  })

  it("throws when no durable metadata exists", async () => {
    const repo = repository("flywheel-resolver-absent-")
    const store = openProjectStore(selectStartupDirectories({ env: {}, cwd: repo.root, home: repo.home }))
    try {
      const manager = createSessionManager({ projectRoot: repo.root, executionCwd: repo.root, store })

      await expect(requireSessionExecutionCwd(manager, "absent", repo.root)).rejects.toThrow("session absent has no durable metadata")
    } finally {
      store.close()
      repo.cleanup()
    }
  })

  it("does not append an execution-directory update fact", async () => {
    const repo = repository("flywheel-resolver-no-write-")
    const store = openProjectStore(selectStartupDirectories({ env: {}, cwd: repo.root, home: repo.home }))
    try {
      appendChatSession(store, "no-write", 3, currentChat())
      const manager = createSessionManager({ projectRoot: repo.root, executionCwd: repo.root, store })
      const before = store.currentPosition()

      await requireSessionExecutionCwd(manager, "no-write", repo.root)

      expect(store.currentPosition()).toBe(before)
      expect(store.read({ aggregateId: "session:no-write" }).map((event) => event.type)).toEqual(["session.created"])
    } finally {
      store.close()
      repo.cleanup()
    }
  })
})

/** Size and content digest of the enclosing repository's event store, so the
 *  isolation case can prove it was not written to rather than merely that it
 *  still exists. */
function fingerprint(dbFile: string) {
  const contents = readFileSync(dbFile)
  return { bytes: contents.byteLength, digest: Bun.SHA256.hash(contents, "hex") } satisfies { bytes: number; digest: string }
}