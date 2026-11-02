import { describe, expect, spyOn, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js"
import { Log } from "../../../../src/infra/log.js"

import { createAuthPublicationBaseline, createAuthStatusPublisher, createProviderModelAuthPublisher } from "../../../../src/orchestration/app-service/auth-publication.js"
import { authStatusCursor, type AuthProviderStatus, type RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { authDir } from "../../../../src/infra/paths.js"
import { authScopesForProfile } from "../../../../src/orchestration/app-service/auth-profile-scope.js"
import { createAuthStatusProjection } from "../../../../src/orchestration/app-service/auth-status-projection.js"
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { createCursorIntake } from "../../../../src/protocol/client/cursor-intake.js"
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { durableRow } from "./_frontend-projection-fixtures.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { processLoginObservations } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js"
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js"

function provider(overrides: Partial<AuthProviderStatus> = {}): AuthProviderStatus {
  return {
    providerId: "anthropic_api",
    kind: "singleton",
    source: "unconfigured",
    expired: false,
    modelCapable: true,
    loginMethod: "api-key",
    statusRank: 0,
    group: "model",
    accounts: [],
    displayName: "Anthropic",
    ...overrides,
  }
}

function view(overrides: Partial<RuntimeAuthView> = {}): RuntimeAuthView {
  return {
    providers: [provider()],
    warnings: [],
    authFilePath: "/profiles/default/auth.json",
    profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
    subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
    ...overrides,
  }
}

const UNCONFIGURED = view()
const CONFIGURED = view({ providers: [provider({ source: "stored_key" })] })

/** Every session in these tests is a chat, so no workflow run is read. */
const noRuns = { read: async () => null }

describe("auth publication baseline", () => {
  test("reports a credential written since the publication as a change", () => {
    // The projection reads the auth store on every call, so a snapshot taken
    // now and a replace taken now both already carry the new credential. This
    // is the shape of the bug the baseline exists to prevent: two readings of
    // one source of truth agree, and the change goes unpublished.
    let stored: RuntimeAuthView = UNCONFIGURED
    const project = (): RuntimeAuthView => stored
    const baseline = createAuthPublicationBaseline()

    baseline.record(project())
    stored = CONFIGURED

    expect(project()).toEqual(project())
    expect(baseline.delta(project())).toEqual({ view: true, providers: true })
  })

  test("reports a re-reading of the published view as no change", () => {
    const baseline = createAuthPublicationBaseline()
    baseline.record(CONFIGURED)

    expect(baseline.delta(view({ providers: [provider({ source: "stored_key" })] }))).toEqual({ view: false, providers: false })
  })

  test("reports a first reading as a change, because the client holds nothing yet", () => {
    expect(createAuthPublicationBaseline().delta(UNCONFIGURED)).toEqual({ view: true, providers: true })
  })

  test("separates a profile-only change from a credential change", () => {
    const baseline = createAuthPublicationBaseline()
    baseline.record(CONFIGURED)

    // Session admission depends on credentials, so a renamed profile must not
    // invalidate it while it still republishes the view the client renders.
    const renamed = view({ providers: CONFIGURED.providers, profile: { ...CONFIGURED.profile, displayName: "Work" } })
    expect(baseline.delta(renamed)).toEqual({ view: true, providers: false })
  })

  test("invalidates reusable admission when the published consent revision changes", () => {
    const baseline = createAuthPublicationBaseline()
    baseline.record(CONFIGURED, "profile-a:usage-7:authority-1:3")

    expect(baseline.delta(CONFIGURED, "profile-a:usage-7:authority-1:4")).toEqual({ view: false, providers: true })
  })
})

describe("provider-model auth publication", () => {
  const temporaryDirectory = temporaryDirectories()
  test("publishes the same hidden-profile question and its removal to defaults and active or observed sessions", async () => {
    const root = temporaryDirectory("question-publication-")
    const defaults: AuthProfileResolution = { id: "a", persistedId: "a", displayName: "A", source: "default", directory: authDir(root, "a"), projectBinding: undefined, retirements: {}, availableProfiles: [{ id: "a", displayName: "A" }, { id: "b", displayName: "B" }] }
    const hidden = { ...defaults, id: "b", persistedId: "b", displayName: "B", directory: authDir(root, "b") }
    const account = { accountId: "account-b", identity: "person@example.com", configDir: `${hidden.directory}/${LOGIN_ACCOUNTS_DIRECTORY}/a` }
    const projection = createAuthStatusProjection({
      initialProfile: defaults, moduleSelection: () => composeFirstPartyModules(),
      resolveLoginProfile: (directory) => directory === hidden.directory ? hidden : undefined,
      subscriptionSpendConsent: (profileId) => ({ kind: "available", profileId, usageGeneration: 0, authorityIncarnation: "test", authorityRevision: 0, accounts: [] }),
    })
    const active = durableRow("active-b", { authProfileId: "b", lifecycleState: "active" })
    const observed = durableRow("observed-a", { authProfileId: "a", lifecycleState: "inactive" })
    await projection.snapshot({ kind: "session", sessionId: observed.id })
    const bus = createRuntimeUiBus()
    const publications: { scope: string; auth: RuntimeAuthView }[] = []
    bus.addListener((event) => {
      if (event.type === "patch" && event.patch.payload.kind === "auth.changed") publications.push({ scope: event.patch.cursor.scope === "session" ? event.patch.cursor.sessionId : "defaults", auth: event.patch.payload.auth })
    })
    const offered: string[] = []
    const publish = createAuthStatusPublisher({
      runs: noRuns,
      manager: { listActive: async () => ({ sessions: [active], errors: [] }), listForIds: async () => ({ sessions: [observed], errors: [] }) },
      defaults: () => defaults, userDataRoot: root, projection, attention: { state: (offeredView) => { offered.push(offeredView.profile.id) } },
      baseline: createAuthPublicationBaseline(), bus, disposed: () => false, refreshChatDefault: () => {},
    })
    processLoginObservations.recordRequest(account, "login-rejected")
    const waiting = processLoginObservations.awaitLogin(hidden.directory, account, new AbortController().signal)
    try {
      await publish()
      await bus.drain()
      expect(publications.map(({ scope }) => scope)).toEqual(["defaults", "active-b", "observed-a"])
      // Each profile's attention is offered once per publication, not once per scope.
      expect(offered).toEqual(["a", "b"])
      const question = publications[0]?.auth.loginQuestions?.[0]
      if (question === undefined) throw new Error("Missing project-wide login question")
      expect(question.profileId).toBe("b")
      expect(publications.every(({ auth }) => auth.loginQuestions?.[0]?.questionId === question.questionId)).toBe(true)
      processLoginObservations.answerLogin(question.questionId, "declined")
      await publish()
      await bus.drain()
      expect(publications.slice(3).map(({ auth }) => auth.loginQuestions)).toEqual([[], [], []])
      expect(await waiting).toBe("declined")
    } finally {
      processLoginObservations.clearRequest(account)
      await waiting
      await bus.clear()
    }
  })
  test("observes malformed storage and repair without eligibility or repeated read warnings", async () => {
    const userDataRoot = temporaryDirectory("auth-fault-publication-")
    const access = await new AuthProfileStore(userDataRoot).create("work")
    access.close()
    const profile: AuthProfileResolution = { id: "work", persistedId: "work", displayName: "Work", source: "default", directory: authDir(userDataRoot, "work"), projectBinding: undefined, retirements: {}, availableProfiles: [{ id: "work", displayName: "Work" }] }
    const projection = createAuthStatusProjection({
      initialProfile: profile, moduleSelection: () => composeFirstPartyModules(),
      subscriptionSpendConsent: () => ({ kind: "unavailable", profileId: profile.id, message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE }),
    })
    const warnings = spyOn(Log.create({ service: "auth-store" }), "warn").mockImplementation(() => {})
    try {
      writeFileSync(join(profile.directory, "auth.json"), "{")
      const fault = await projection.snapshot()
      expect(JSON.stringify(fault)).toContain("malformed")
      await projection.snapshot()
      await projection.snapshot()
      expect(warnings).toHaveBeenCalledTimes(1)
      writeFileSync(join(profile.directory, "auth.json"), "{}")
      expect(JSON.stringify(await projection.snapshot())).not.toContain("malformed")
      expect(warnings).toHaveBeenCalledTimes(1)
    } finally { warnings.mockRestore() }
  })

  test("catalog publication advances an observed inactive child's held auth cursor without publishing unobserved history", async () => {
    const userDataRoot = temporaryDirectory("auth-publisher-")
    let profile: AuthProfileResolution = { id: "work", persistedId: "work", displayName: "Work", source: "default", directory: authDir(userDataRoot, "work"), projectBinding: undefined, retirements: {}, availableProfiles: [{ id: "work", displayName: "Work" }] }
    const rows = [durableRow("child", { kind: "subagent", lifecycleState: "inactive", authProfileId: "work" }), durableRow("unobserved", { lifecycleState: "inactive", authProfileId: "work" })]
    const sessionReads: string[] = []
    const manager = {
      listActive: async () => {
        sessionReads.push("active")
        return { sessions: rows.filter((row) => row.lifecycleState === "active"), errors: [] }
      },
      listForIds: async (ids: readonly string[]) => {
        sessionReads.push(`ids:${ids.join(",")}`)
        return { sessions: rows.filter((row) => ids.includes(row.id)), errors: [] }
      },
    }
    const bus = createRuntimeUiBus()
    const completed = Promise.withResolvers<void>()
    const models = createProviderModelPreferenceService({
      displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next",
      publish: createProviderModelAuthPublisher({
        resolveProfile: () => profile,
        scopesForProfile: (resolved) => authScopesForProfile(resolved, profile, manager, noRuns, userDataRoot, projection.observedSessionIds),
        publish: async (scopes) => { await publish(scopes); completed.resolve() },
        onError: (_id, error) => { completed.reject(error) },
      }),
    })
    const projection = createAuthStatusProjection({
      initialProfile: profile, moduleSelection: () => composeFirstPartyModules([]),
      eligibilityState: models.state,
      subscriptionSpendConsent: () => ({ kind: "unavailable", profileId: profile.id, message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE }),
    })
    let catalogReads = 0
    const publish = createAuthStatusPublisher({
      manager, runs: noRuns, defaults: () => { catalogReads++; return profile }, userDataRoot, projection, attention: { state: () => {} }, baseline: createAuthPublicationBaseline(),
      bus, disposed: () => false, refreshChatDefault: () => {},
    })
    const scope = { kind: "session", sessionId: "child" } as const
    const cursor = authStatusCursor(scope)
    const applied: RuntimeAuthView[] = []
    const intake = createCursorIntake({ cursor, onApply: (patch) => { if (patch.payload.kind === "auth.changed") applied.push(patch.payload.auth) }, onRecover: () => { throw new Error("unexpected cursor recovery") } })
    const publishedSessions: string[] = []
    bus.addListener((event) => {
      if (event.type !== "patch" || event.patch.cursor.scope !== "session") return
      publishedSessions.push(event.patch.cursor.sessionId)
      if (event.patch.cursor.sessionId === "child") intake.accept(event.patch)
    })
    try {
      intake.seed(bus.snapshotPosition({ kind: "cursor", cursor }))
      await projection.snapshot(scope)
      models.publish(models.prepare({ profileId: profile.id, authRevision: "a", preferenceRevision: "p", catalogs: new Map(), accountCatalogs: new Map(), inventoryCandidates: new Map(), releaseDates: new Map() }))
      await completed.promise
      await bus.drain()
      expect(applied).toHaveLength(1)
      expect(applied[0]?.autoEnableNewModels?.eligibilityRevision).toBe(models.state(profile.id)?.revision)
      expect(publishedSessions).toEqual(["child"])
      expect(rows.every((row) => row.lifecycleState === "inactive")).toBe(true)
      expect(sessionReads).toEqual(["active", "ids:child", "ids:child"])
      profile = { ...profile, id: "successor", persistedId: "successor", displayName: "Successor", directory: authDir(userDataRoot, "successor"), retirements: { work: "successor" }, availableProfiles: [{ id: "successor", displayName: "Successor" }] }
      catalogReads = 0
      sessionReads.length = 0
      await publish()
      await bus.drain()
      expect(catalogReads).toBe(1)
      expect(sessionReads).toEqual(["active", "ids:child"])
      expect(applied.at(-1)?.profile).toMatchObject({ id: "successor", displayName: "Successor", availableProfiles: [{ id: "successor", displayName: "Successor" }] })
      expect(rows.map((row) => row.authProfileId)).toEqual(["work", "work"])
      expect(publishedSessions).toEqual(["child", "child"])
      sessionReads.length = 0
      await publish([{ kind: "defaults" }])
      expect(sessionReads).toEqual([])
      await expect(publish([{ kind: "session", sessionId: "missing" }])).rejects.toThrow("Session not found: missing")
      expect(sessionReads).toEqual(["ids:missing"])
    } finally {
      intake.reset()
      await models.dispose()
      await bus.clear()
    }
  })

  test("publishes every scope backed by the exact profile", async () => {
    const profile = { id: "work" }
    const published: unknown[] = []
    const completed = Promise.withResolvers<void>()
    const publish = createProviderModelAuthPublisher({
      resolveProfile: (profileId) => profileId === profile.id ? profile : undefined,
      scopesForProfile: async () => [{ kind: "defaults" }, { kind: "session", sessionId: "chat-1" }],
      publish: async (scopes) => {
        published.push(scopes)
        completed.resolve()
      },
      onError: () => {},
    })

    publish({ profileId: "work" })
    await completed.promise

    expect(published).toEqual([[{ kind: "defaults" }, { kind: "session", sessionId: "chat-1" }]])
  })

  test("does not publish a profile this runtime does not own", async () => {
    let published = false
    const publish = createProviderModelAuthPublisher({
      resolveProfile: () => undefined,
      scopesForProfile: async () => [{ kind: "defaults" }],
      publish: async () => { published = true },
      onError: () => {},
    })

    publish({ profileId: "external" })
    await Promise.resolve()

    expect(published).toBe(false)
  })
})
