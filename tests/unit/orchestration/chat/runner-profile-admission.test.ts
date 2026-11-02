import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createSessionAuthAdmission } from "../../../../src/orchestration/session/session-auth-profile.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { createAgentRuntime } from "../../../../src/orchestration/agent-runtime/factory.js"
import { describeAgentFailure } from "../../../../src/orchestration/agent-runtime/failure-message.js"
import { providerModelEligibilityDecision } from "../../../../src/orchestration/config/provider-model-eligibility.js"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { fixtureDefinitions } from "../../../helpers/project-definitions.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"

const temporaryDirectory = temporaryDirectories()

function session(authProfileId?: string): { readonly kind: "chat"; readonly authProfileId?: string } {
  return authProfileId === undefined ? { kind: "chat" } : { kind: "chat", authProfileId }
}

function authResolution(id: string) {
  return {
    id,
    persistedId: id,
    displayName: id,
    source: "sticky" as const,
    directory: `/scratch/auth/${id}`,
    availableProfiles: ["work", "personal"].map((profileId) => ({ id: profileId, displayName: profileId })),
    projectBinding: undefined,
    retirements: {},
  }
}

describe("session auth admission", () => {
  test.each([false, true])("request readiness preserves provider guidance without a missing-role error, pending=%s", async (pending) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const eligibility = providerModelEligibilityDecision({
      profileId: "default", revision: 1, catalogs: new Map(),
      enabledCandidates: new Map(pending ? [["openai_api", {
        candidate, configured: true, currentConnection: true, enabledOfferings: null,
        catalog: { kind: "unavailable", reason: "discovery-pending" },
      }]] : []),
    }).worker
    const auth = testAuthContext({})
    // A temporary project: every runner completion sweeps the breadcrumbs of
    // its definitions' project, which in the checkout is the developer's own
    // `.flywheel` and takes seconds to walk.
    const definitions = fixtureDefinitions()
    const directories = testDirectories(definitions.projectRoot)
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      definitions, moduleSelection: testCapabilityModules,
      userDataRoot: directories.userDataRoot, authDirectory: () => "/scratch/auth",
      profileId: "default", getAuth: () => auth, captureRuntimeConfig: testRuntimeConfigCapture,
      captureModelAccess: async () => { entered.resolve(); await release.promise; return { worker: eligibility, auth } },
    })
    const agent = runtime.createAgent({
      ...directories, purpose: { kind: "interactive-chat" }, agentsMd: "", onEvent() {},
      conversation: { kind: "stateless" }, lifecycle: { kind: "one-shot" },
      requestSelection: () => ({ roleId: "chat" }),
    })
    let settled = false
    const done = agent.done.then((result) => { settled = true; return result })
    agent.send("work")
    await entered.promise
    expect(settled).toBe(false)
    release.resolve()
    const { terminal } = await done
    expect(terminal.kind).toBe("model_unavailable")
    if (terminal.kind !== "model_unavailable") throw new Error(`Unexpected terminal: ${terminal.kind}`)
    expect(terminal.missing).toBe(pending ? "access" : "provider")
    expect(describeAgentFailure(terminal).title).toBe(pending ? "Model access still being checked" : "No model provider")
  })

  test.each([false, true])("rechecks initiating and joining admissions without changing held captures, failed preparation=%s", async (fails) => {
    let observation = "missing"
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const prepared: string[] = []
    const admission = createSessionAuthAdmission({
      materialize: async () => { throw new Error("unexpected retirement") },
      manager: { read: async () => session("work"), captureAuthProfileIfAbsent: async () => false },
      authProfiles: { inspect: () => authResolution("work") },
      observe: () => observation,
      prepare: async () => {
        const captured = observation
        prepared.push(captured)
        if (captured === "rotating") {
          entered.resolve()
          await release.promise
          if (fails) throw new Error("superseded preparation failed")
        }
        return { captured }
      },
    })
    try {
      const held = await admission.admit("held")
      expect((await admission.admitDefaults()).workflowDeps).toBe(held.workflowDeps)
      observation = "refused"
      expect((await admission.admitDefaults()).workflowDeps.captured).toBe("refused")
      observation = "rotating"
      const initiating = admission.admitDefaults()
      await entered.promise
      const joining = admission.admitDefaults()
      observation = "repaired"
      release.resolve()
      const [first, second] = await Promise.all([initiating, joining])
      expect(first.workflowDeps.captured).toBe("repaired")
      expect(second.workflowDeps).toBe(first.workflowDeps)
      expect(admission.current("held")).toBe(held)
      expect(held.workflowDeps.captured).toBe("missing")
      expect(prepared).toEqual(["missing", "refused", "rotating", "repaired"])
    } finally { release.resolve(); await admission.dispose() }
  })

  test("admits root work with separate persisted and environment-effective profiles", async () => {
    const admission = createSessionAuthAdmission({
      materialize: async () => { throw new Error("unexpected retirement") },
      manager: { read: async () => null, captureAuthProfileIfAbsent: async () => false },
      authProfiles: { inspect: () => ({
        ...authResolution("personal"),
        persistedId: "work",
        source: "environment" as const,
      }) },
      prepare: async (profileId) => ({ profileId }),
    })

    const snapshot = await admission.admitDefaults()

    expect(snapshot.profile).toEqual({ persistedId: "work", effectiveId: "personal" })
    expect(snapshot.workflowDeps.profileId).toBe("personal")
    await admission.dispose()
  })

  test("coalesces profile preparation while keeping session snapshots distinct", async () => {
    const sessions = new Map<string, ReturnType<typeof session>>([
      ["work-chat", session("work")],
      ["personal-chat", session("personal")],
    ])
    const prepared: string[] = []
    const manager = {
      read: async (id: string) => sessions.get(id) ?? null,
      captureAuthProfileIfAbsent: async () => false,
    }
    const admission = createSessionAuthAdmission({
      materialize: async () => { throw new Error("unexpected retirement") },
      manager,
      authProfiles: { inspect: () => authResolution("work") },
      prepare: async (profileId) => {
        prepared.push(profileId)
        return { profileId }
      },
    })

    const [work, workAgain, personal] = await Promise.all([
      admission.admit("work-chat"),
      admission.admit("work-chat"),
      admission.admit("personal-chat"),
    ])

    expect(prepared).toEqual(["work", "personal"])
    expect(work.profile).toEqual({ persistedId: "work", effectiveId: "work" })
    expect(workAgain.workflowDeps).toBe(work.workflowDeps)
    expect(personal.profile).toEqual({ persistedId: "personal", effectiveId: "personal" })
    expect(personal.workflowDeps).not.toBe(work.workflowDeps)
    await admission.dispose()
  })

  test("captures legacy sessions and lazily rebuilds only the invalidated profile while each session keeps its revision until it captures again", async () => {
    const sessions = new Map<string, ReturnType<typeof session>>([
      ["legacy", session()],
      ["pinned", session("personal")],
      ["also-work", session("work")],
    ])
    const captured: string[] = []
    const prepared: string[] = []
    const manager = {
      read: async (id: string) => sessions.get(id) ?? null,
      captureAuthProfileIfAbsent: async (id: string, profileId: string) => {
        const current = sessions.get(id)
        if (!current || current.authProfileId !== undefined) return false
        sessions.set(id, session(profileId))
        captured.push(`${id}:${profileId}`)
        return true
      },
    }
    const admission = createSessionAuthAdmission({
      materialize: async () => { throw new Error("unexpected retirement") },
      manager,
      authProfiles: { inspect: () => authResolution("work") },
      prepare: async (profileId) => {
        prepared.push(profileId)
        return { profileId }
      },
    })

    const firstWork = await admission.admit("legacy")
    const personal = await admission.admit("pinned")
    const alsoWork = await admission.admit("also-work")
    expect(admission.invalidate("work")).toEqual(["legacy", "also-work"])
    // A request already running on an invalidated session reads the revision
    // the session admitted until the session captures again: invalidation
    // never leaves an admitted session without a revision.
    expect(admission.current("legacy")).toBe(firstWork)
    expect(admission.current("also-work")).toBe(alsoWork)
    expect(admission.current("pinned")).toBe(personal)
    const secondWork = await admission.admit("legacy")
    expect(admission.current("legacy")).toBe(secondWork)
    expect(admission.current("also-work")).toBe(alsoWork)
    const secondAlsoWork = await admission.admit("also-work")
    const secondPersonal = await admission.admit("pinned")

    expect(captured).toEqual(["legacy:work"])
    expect(firstWork.workflowDeps).not.toBe(secondWork.workflowDeps)
    expect(secondAlsoWork.workflowDeps).toBe(secondWork.workflowDeps)
    expect(alsoWork.workflowDeps).not.toBe(secondAlsoWork.workflowDeps)
    expect(personal.workflowDeps).toBe(secondPersonal.workflowDeps)
    expect(prepared).toEqual(["work", "personal", "work"])
    await admission.dispose()
  })

  test("keeps capture A immutable and re-admits every downstream seam on effective profile B", async () => {
    const projectRoot = temporaryDirectory("flywheel-auth-profile-readmission-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
    const sessionId = await manager.createChat({ name: "Profile readmission", authProfileId: "profile-a" })
    let resolution: AuthProfileResolution = {
      id: "profile-a",
      persistedId: "profile-a",
      displayName: "A",
      source: "sticky",
      directory: join(projectRoot, "profile-a"),
      availableProfiles: [{ id: "profile-a", displayName: "A" }, { id: "profile-b", displayName: "B" }],
      projectBinding: undefined,
      retirements: {},
    }
    const prepared: string[] = []
    const admission = createSessionAuthAdmission({
      materialize: async () => { throw new Error("unexpected retirement") },
      manager,
      authProfiles: { inspect: () => resolution },
      prepare: async (profileId) => {
        prepared.push(profileId)
        return Object.freeze({
          chat: profileId,
          workflow: profileId,
          providerRoute: profileId,
          webBinding: profileId,
          benchmark: profileId,
          requestAdmission: Object.freeze({ profileRevision: profileId }),
        })
      },
    })

    try {
      const captureA = await admission.admit(sessionId)
      resolution = { ...resolution, id: "profile-b", displayName: "B", source: "environment", directory: join(projectRoot, "profile-b") }
      const captureB = await admission.admit(sessionId)

      expect(captureA.workflowDeps).toEqual({ chat: "profile-a", workflow: "profile-a", providerRoute: "profile-a", webBinding: "profile-a", benchmark: "profile-a", requestAdmission: { profileRevision: "profile-a" } })
      expect(captureB.profile).toEqual({ persistedId: "profile-a", effectiveId: "profile-b" })
      expect(captureB.workflowDeps).toEqual({ chat: "profile-b", workflow: "profile-b", providerRoute: "profile-b", webBinding: "profile-b", benchmark: "profile-b", requestAdmission: { profileRevision: "profile-b" } })
      expect(captureA.workflowDeps.requestAdmission).toEqual({ profileRevision: "profile-a" })
      expect(prepared).toEqual(["profile-a", "profile-b"])
    } finally {
      await admission.dispose()
      store.close()
    }
  })
})
