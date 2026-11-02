import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntimeChatKernel } from "../../../../src/orchestration/app-service/runtime-chat-kernel.js"
import { createRuntimeOwnership } from "../../../../src/orchestration/app-service/runtime-ownership.js"
import { ensureDurableChatSession, writePreReadinessTurn } from "../../../../src/orchestration/app-service/session-chat-durability.js"
import { durableBranchHasUserMessage } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { createChatRunnerLoader } from "../../../../src/orchestration/app-service/chat-runner-loader.js"
import { createContinuationLanes } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { createDeferred, mockRunner, testSessionAuthAdmission } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testCapabilityModules } from "../../../helpers/request-tool-surface.js"
import { fakeProjections } from "./app-service-doubles.js"
import { unusedChildSessionControl } from "../../../helpers/child-session-control.js"

const root = mkdtempSync(join(tmpdir(), "flywheel-chat-kernel-"))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function directories(name: string) {
  const fixture = join(root, name)
  const projectRoot = join(fixture, "project")
  const accountHome = join(fixture, "home")
  const userDataRoot = join(accountHome, ".flywheel")
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })
  return { projectRoot, executionCwd: projectRoot, accountHome, userDataRoot }
}

describe("runtime chat kernel readiness", () => {
  test("opens migrated durable state, writes a pre-readiness turn, and preserves it across ordered disposal", async () => {
    const paths = directories("durable")
    const firstOwnership = createRuntimeOwnership(() => {})
    const first = await createRuntimeChatKernel(paths, firstOwnership, fakeProjections().backgroundLane)
    expect((await first.projections.projection.snapshot()).rows).toEqual([])
    const sessionId = first.manager.allocateId()
    const conversationId = first.manager.allocateId()
    const context = { sessionId, projectRoot: paths.projectRoot, manager: first.manager, eventStore: first.eventReader, projectionReader: first.projectionReader, eventWriter: first.eventWriter }

    await ensureDurableChatSession(context, conversationId)
    await expect(writePreReadinessTurn(context, conversationId, "ready")).resolves.toBeString()
    expect(await durableBranchHasUserMessage({ conversationId, sessionId, store: context.eventStore })).toBe(true)
    expect((await first.projections.projection.snapshot()).rows.map((row) => row.id)).toEqual([sessionId])
    await firstOwnership.releaseAcquired()

    const reopenedOwnership = createRuntimeOwnership(() => {})
    const reopened = await createRuntimeChatKernel(paths, reopenedOwnership, fakeProjections().backgroundLane)
    try {
      const metadata = await reopened.manager.read(sessionId)
      expect(metadata?.kind).toBe("chat")
      if (!metadata || metadata.kind !== "chat") throw new Error("chat metadata was not reopened")
      expect(metadata.conversationId).toBe(conversationId)
      expect(await durableBranchHasUserMessage({ conversationId, sessionId, store: reopened.eventReader })).toBe(true)
    } finally {
      await reopenedOwnership.releaseAcquired()
    }
  })

  test("the real actor commits before lazy runner capabilities and delivers after they resolve", async () => {
    const paths = directories("deferred-supervisor")
    const ownership = createRuntimeOwnership(() => {})
    const kernel = await createRuntimeChatKernel(paths, ownership, fakeProjections().backgroundLane)
    const capabilities = createDeferred<Parameters<typeof createRuntimeSupervisor>[0]["runnerCapabilities"] extends () => Promise<infer C> ? C : never>()
    const delivered: string[] = []
    const authAdmission = testSessionAuthAdmission()
    const supervisor = createRuntimeSupervisor({
      undoChanges: async () => { throw new Error("Undo is not used in this test") },
      sessionStore: kernel.sessionStore,
      workflowHosts: kernel.workflowHosts,
      manager: kernel.manager,
      directories: paths,
      runtime: kernel.runtime,
      store: kernel.eventReader,
      projectionReader: kernel.projectionReader,
      writer: kernel.eventWriter,
      transcriptCache: kernel.transcriptCache,
      runnerCapabilities: () => capabilities.promise,
      authProfileId: () => "default",
      lifecycle: { settleSessionStore: async () => {}, settleAuthAdmission: async () => {} },
      continuationLanes: createContinuationLanes(),
      clientsHold: () => false,
    })
    try {
      const sessionId = await supervisor.openSessionRuntime()
      await expect(supervisor.sendChat(sessionId, "before broad readiness")).resolves.toEqual({ ok: true })
      const metadata = await kernel.manager.read(sessionId)
      expect(metadata?.kind).toBe("chat")
      if (!metadata || metadata.kind !== "chat") throw new Error("chat metadata was not materialized")
      expect(await durableBranchHasUserMessage({ conversationId: metadata.conversationId, sessionId, store: kernel.eventReader })).toBe(true)
      capabilities.resolve({
        runnerLoader: createChatRunnerLoader({
          authAdmission,
          createRunner: async () => mockRunner(sessionId, { deliverCommitted: (input) => { delivered.push(typeof input === "string" ? input : input.text); return true } }),
        }),
        definitions: repoDefinitions(),
        moduleSelection: testCapabilityModules,
        resolveKey: async () => undefined,
        authAdmission,
        subscribeProfiles: () => async () => {},
        workflowMode: () => "ask",
        recall: async () => { throw new Error("Conversation recall is not used in this test") },
        childSessions: unusedChildSessionControl(),
      })
      await supervisor.ensureChatRunner(sessionId)
      expect(delivered).toEqual(["before broad readiness"])
    } finally {
      await supervisor.disposeAll()
      await ownership.releaseAcquired()
    }
  })
})
