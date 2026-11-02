import { afterAll, describe, expect, it } from "bun:test"
import { ManagedRuntime } from "effect"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EventStoreLive } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import type { ChatRunnerDeps } from "../../../../src/orchestration/chat/runner.js"
import { createChatRunnerLoader } from "../../../../src/orchestration/app-service/chat-runner-loader.js"
import { createSessionAuthAdmission } from "../../../../src/orchestration/session/session-auth-profile.js"
import { mockRunner, testSessionAuthAdmission } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { unusedChildSessionControl } from "../../../helpers/child-session-control.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { fixedDefinitions } from "../../../helpers/project-definitions.js"
import { testCapabilityModules } from "../../../helpers/request-tool-surface.js"

const refuse = (dependency: string) => (): never => { throw new Error(`the injected runner factory reads no ${dependency}`) }

// The runtime builds its store on first use, and the injected factory never uses it.
const runtime = ManagedRuntime.make(EventStoreLive(join(tmpdir(), "flywheel-chat-runner-loader-unopened.sqlite")))
afterAll(() => runtime.dispose())

const runnerDeps: ChatRunnerDeps = {
  sessionId: "session-1",
  conversationId: "conversation-1",
  projectRoot: "/scratch/project",
  executionCwd: "/scratch/project",
  userDataRoot: "/scratch/account/.flywheel",
  accountHome: "/scratch/account",
  definitions: fixedDefinitions(),
  updateEntry: () => {},
  runtime,
  projectionReader: asAsyncEventReadSurface(inMemoryEventReader([])),
  manager: {
    allocateId: refuse("session id"),
    publishSubagent: refuse("subagent publication"),
    read: refuse("session read"),
    subscribe: refuse("session subscription"),
    updateLifecycleState: refuse("lifecycle update"),
    publishActivation: refuse("activation"),
    captureRolesIfAbsent: refuse("role capture"),
    replaceRoleSnapshot: refuse("role snapshot"),
  },
  onError: () => {},
  onEnded: () => {},
  workflowMode: () => "ask",
  moduleSelection: testCapabilityModules,
  childSessions: unusedChildSessionControl(),
  resolveKey: async () => undefined,
  authAdmission: testSessionAuthAdmission(),
  subscribeProfiles: () => async () => {},
  startWorkflow: refuse("workflow launch"),
  recall: refuse("recall"),
}

const runner = mockRunner("session-1")

async function profileAdmission(failFirst = false) {
  const { workflowDeps } = await testSessionAuthAdmission().admitDefaults()
  const prepared: string[] = []
  const admission = createSessionAuthAdmission({
    materialize: async () => { throw new Error("unexpected retirement") },
    manager: { read: async () => ({ kind: "chat" as const, authProfileId: "personal" }), captureAuthProfileIfAbsent: async () => false },
    authProfiles: { inspect: () => ({
      id: "personal", persistedId: "personal", displayName: "Personal", source: "sticky", directory: "/scratch/unused-personal-profile",
      availableProfiles: [{ id: "personal", displayName: "Personal" }], projectBinding: undefined, retirements: {},
    }) },
    prepare: async (profileId) => {
      prepared.push(profileId)
      if (failFirst && prepared.length === 1) throw new Error("profile preparation failed")
      return workflowDeps
    },
  })
  return { admission, prepared, workflowDeps }
}

describe("createChatRunnerLoader", () => {
  it("warms the effective profile through admission and reuses its preparation on first send", async () => {
    const { admission, prepared, workflowDeps } = await profileAdmission()
    const loader = createChatRunnerLoader({ authAdmission: admission })
    try {
      await loader.warm()
      expect(prepared).toEqual(["personal"])
      expect((await admission.admit("session-1")).workflowDeps).toBe(workflowDeps)
      expect(prepared).toEqual(["personal"])
    } finally { await admission.dispose() }
  })

  it("contains warm preparation failure and lets first-send admission retry", async () => {
    const { admission, prepared } = await profileAdmission(true)
    const loader = createChatRunnerLoader({ authAdmission: admission })
    try {
      await expect(loader.warm()).resolves.toBeUndefined()
      expect(prepared).toEqual(["personal"])
      expect((await admission.admit("session-1")).profile.effectiveId).toBe("personal")
      expect(prepared).toEqual(["personal", "personal"])
    } finally { await admission.dispose() }
  })

  it("passes deps through to the injected createRunner", async () => {
    const seen: ChatRunnerDeps[] = []
    const loader = createChatRunnerLoader({
      authAdmission: testSessionAuthAdmission(),
      createRunner: async (deps) => {
        seen.push(deps)
        return runner
      },
    })

    await expect(loader.createRunner(runnerDeps)).resolves.toBe(runner)
    expect(seen).toEqual([runnerDeps])
  })

  it("warm skips the injected seam and never creates a runner", async () => {
    let createCalls = 0
    const loader = createChatRunnerLoader({
      authAdmission: { admitDefaults: async () => { throw new Error("Injected runner must skip auth preparation") } },
      createRunner: async () => {
        createCalls += 1
        return runner
      },
    })

    await expect(loader.warm()).resolves.toBeUndefined()
    expect(createCalls).toBe(0)
  })
})
