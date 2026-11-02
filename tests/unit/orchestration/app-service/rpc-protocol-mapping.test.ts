import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { InvariantViolation } from "../../../../src/infra/invariant.js"
import type { FrontendMutation, RuntimeQueryResult } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeModuleSnapshotResult } from "../../../../src/protocol/module-protocol-types.js"
import { PapercutPatchPayloadSchema, RuntimePapercutCountSnapshotResultSchema, type RuntimePapercutCountSnapshotResult } from "../../../../src/protocol/modules/papercuts.js"
import type { ProjectNotificationEpisode } from "../../../../src/protocol/modules/project-notifications.js"
import type { OutputWindowSnapshot } from "../../../../src/protocol/transcript-protocol-types.js"
import { cursorKey, sessionDomainCursor, type RuntimeDomainIntakeBindings } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { workflowsProtocol } from "../../../../src/protocol/modules/workflows.js"
import {
  classifyRuntimeProtocolErrorKind,
  ExecutorGenerationChangedError,
  ExecutorNotRunningError,
  QuestionPatchPayloadSchema,
  RuntimeQuestionSnapshotResultSchema,
  RuntimeProtocolRpc,
  RuntimeUiPatchSchema,
} from "../../../../src/protocol/runtime-protocol-schemas.js"
import { runtimeDispatchResultSchema } from "../../../../src/protocol/runtime-dispatch-result-schemas.js"
import { RuntimeCursorIdentitySchema } from "../../../../src/protocol/runtime-cursor-schemas.js"
import { RuntimeAuthStatusSnapshotResultSchema } from "../../../../src/protocol/auth-status-protocol-schemas.js"
import { WorkflowRowsSchema, WorkflowTreeSchema, WorkflowTreeV1Schema, WorkflowViewSchema } from "../../../../src/workflows/view/schemas.js"
import {
  ExperimentViewPatchPayloadSchema,
  RuntimeBackgroundExperimentViewSnapshotSchema,
  RuntimeExperimentViewSnapshotResultSchema,
  type FrontendExperimentView,
  type RuntimeExperimentViewSnapshotResult,
} from "../../../../src/protocol/modules/experiments.js"

const experimentViewCursor = (sessionId: string) => sessionDomainCursor("experiment_view", sessionId)
const isExperimentViewPayload = Schema.is(ExperimentViewPatchPayloadSchema)
const workflowDomain = workflowsProtocol.domains[1]

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
type SnapshotCorrelation = Assert<Equal<RuntimeQueryResult<{ readonly type: "moduleSnapshot" }>, RuntimeModuleSnapshotResult>>
type PapercutCorrelation = Assert<Equal<RuntimeQueryResult<{ readonly type: "papercutCountSnapshot" }>, RuntimePapercutCountSnapshotResult>>
type PapercutIntakeObligation = Assert<Equal<Pick<RuntimeDomainIntakeBindings, "papercuts">, { readonly papercuts: object }>>
type NotificationSnapshot = { readonly snapshotPosition: number; readonly notifications: readonly ProjectNotificationEpisode[] }
type NotificationCorrelation = Assert<Equal<RuntimeQueryResult<{ readonly type: "projectNotificationSnapshot" }>, NotificationSnapshot>>
type NotificationIntakeObligation = Assert<Equal<Pick<RuntimeDomainIntakeBindings, "project_notifications">, { readonly project_notifications: object }>>
type WindowCorrelation = Assert<Equal<RuntimeQueryResult<{ readonly type: "outputWindow"; readonly sessionId: string; readonly request: never }>, OutputWindowSnapshot>>
type ExperimentViewCorrelation = Assert<Equal<RuntimeQueryResult<{ readonly type: "experimentViewSnapshot"; readonly sessionId: string }>, RuntimeExperimentViewSnapshotResult>>
type ExperimentViewIntakeObligation = Assert<Equal<Pick<RuntimeDomainIntakeBindings, "experiment_view">, { readonly experiment_view: object }>>

const experimentView: FrontendExperimentView = {
  name: "Faster tokenizer",
  metric: { name: "tokens_per_sec", unit: "tok/s" },
  secondaryMetrics: [{ name: "peak_mb", unit: "mb" }],
  direction: "higher",
  segment: 0,
  baseline: 1200,
  best: 1350,
  confidence: 2.4,
  runCounts: { total: 2, kept: 1, discarded: 1, crashed: 0, checksFailed: 0 },
  runs: [
    { run: 1, segment: 0, commit: "abc123", metric: 1200, metrics: { peak_mb: 512 }, status: "keep", description: "baseline", confidence: null, durationMs: 4200 },
    { run: 2, segment: 0, commit: "", metric: 1100, metrics: { peak_mb: 530 }, status: "discard", description: "unroll loop", confidence: 2.4, durationMs: null },
  ],
  active: true,
  running: false,
}

describe("Runtime protocol RPC mapping", () => {
  test("production RPC group exposes generic query, dispatch, and event operations", () => {
    expect(RuntimeProtocolRpc.requests.get("RuntimeQuery")?._tag).toBe("RuntimeQuery")
    expect(RuntimeProtocolRpc.requests.get("RuntimeDispatch")?._tag).toBe("RuntimeDispatch")
    expect(RuntimeProtocolRpc.requests.get("RuntimeEvents")?._tag).toBe("RuntimeEvents")
    const correlations: [SnapshotCorrelation, PapercutCorrelation, PapercutIntakeObligation, NotificationCorrelation, NotificationIntakeObligation, WindowCorrelation, ExperimentViewCorrelation, ExperimentViewIntakeObligation] = [true, true, true, true, true, true, true, true]
    expect(correlations).toEqual([true, true, true, true, true, true, true, true])
  })

  test("request-selected dispatch codecs preserve each specialized result category", () => {
    const target = { kind: "singleton", providerId: "provider" }
    const view = { profileId: "profile", eligibilityRevision: 2, target, providerDisplayName: "Provider", catalog: { kind: "unavailable", reason: "discovery-pending" }, rows: [], freeRoutes: { enabled: true } }
    const hidden = { profileId: "profile", eligibilityRevision: 2, target, hidden: true }
    const cases: readonly [FrontendMutation["type"], unknown][] = [
      ["command.invoke", { kind: "focus-session", sessionId: "destination" }],
      ["workflow.interrupt", { kind: "interrupt", interrupted: false, reason: "Not running" }],
      ["auth.login", { kind: "browser", operationId: "login", providerId: "provider", authorizeUri: "https://example.com/login" }],
      ["model.save_effort", { label: "High", warning: "Not mirrored", mirrored: false }],
      ["model.reset_assignments", { rows: [], warning: "Not mirrored", mirrored: false }],
      ["provider_model.set", hidden],
      ["provider_models.set_auto_enable", { profileId: "profile", eligibilityRevision: 2, autoEnableNewModels: false }],
      ...(["provider_models.deselect_all", "provider_models.recheck", "provider_free_routes.set"] as const).flatMap((type): [FrontendMutation["type"], unknown][] => [[type, view], [type, hidden]]),
      ["session.changes.undo", { status: "uncertain", message: "Not verified" }],
      ["session.changes.set_viewed", { status: "refused", message: "Changed" }],
      ["subscription_spend_consent.save", { kind: "invalid-envelope" }],
    ]
    for (const [type, result] of cases) {
      const codec = runtimeDispatchResultSchema(type)
      expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(result))).toEqual(result)
    }
  })

  test("experiment view snapshot and patch payloads round-trip through schemas", () => {
    const snapshot = { snapshotPosition: 7, experimentView }
    expect(Schema.decodeUnknownSync(RuntimeExperimentViewSnapshotResultSchema)(snapshot)).toEqual(snapshot)
    expect(Schema.decodeUnknownSync(RuntimeExperimentViewSnapshotResultSchema)({ snapshotPosition: 8, experimentView: null })).toEqual({ snapshotPosition: 8, experimentView: null })
    expect(Schema.decodeUnknownSync(RuntimeBackgroundExperimentViewSnapshotSchema)({ experimentView })).toEqual({ experimentView })
    const updated = { kind: "experiment_view.updated", experimentView } as const
    expect(Schema.decodeUnknownSync(ExperimentViewPatchPayloadSchema)(updated)).toEqual(updated)
    expect(Schema.decodeUnknownSync(ExperimentViewPatchPayloadSchema)({ kind: "experiment_view.removed" })).toEqual({ kind: "experiment_view.removed" })
    expect(isExperimentViewPayload(updated)).toBe(true)
    expect(isExperimentViewPayload({ kind: "workflow_view.removed" })).toBe(false)
  })

  test("experiment view patches carry positions on their own session cursor and expose no guard paths", () => {
    const cursor = experimentViewCursor("s1")
    const updated = { cursor, position: 3, prevPosition: 2, payload: { kind: "experiment_view.updated", experimentView } } as const
    const removed = { cursor, position: 4, prevPosition: 3, payload: { kind: "experiment_view.removed" } } as const
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(updated)).toEqual(updated)
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(removed)).toEqual(removed)
    expect(cursorKey(cursor)).toBe("experiment_view:s1")
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)({ ...updated, position: "3" })).toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeCursorIdentitySchema)({ scope: "workspace", domain: "experiment_view" })).toThrow()
    // Strict wire rows: charter guard paths and command state never cross this
    // wire, so an encoder carrying them is a defect rather than tolerated slack.
    const leaked = { ...updated, payload: { ...updated.payload, experimentView: { ...experimentView, protectedPaths: [".experiment/charter.md"] } } }
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema, { onExcessProperty: "error" })(leaked)).toThrow()
    const query = { type: "experimentViewSnapshot", sessionId: "s1" } as const
    const rpc = RuntimeProtocolRpc.requests.get("RuntimeQuery")
    if (rpc === undefined) throw new Error("RuntimeQuery RPC is missing")
    expect(Schema.decodeUnknownSync(rpc.payloadSchema)(query)).toEqual(query)
    expect(() => Schema.decodeUnknownSync(rpc.payloadSchema)({ type: "experimentViewSnapshot" })).toThrow()
  })

  test("experiment view wire values reject malformed rows and mismatched kinds", () => {
    const decode = (wire: unknown) => Schema.decodeUnknownSync(RuntimeExperimentViewSnapshotResultSchema)(wire)
    const [first] = experimentView.runs
    if (first === undefined) throw new Error("fixture has no runs")
    const withRun = (run: { readonly [field: string]: unknown }) => ({ snapshotPosition: 1, experimentView: { ...experimentView, runs: [run] } })
    expect(() => decode(withRun({ ...first, status: "kept" }))).toThrow()
    expect(() => decode(withRun({ ...first, run: 0 }))).toThrow()
    expect(() => decode(withRun({ ...first, metric: "1200" }))).toThrow()
    expect(() => decode(withRun({ ...first, metrics: { peak_mb: Number.NaN } }))).toThrow()
    expect(() => decode(withRun({ ...first, confidence: undefined }))).toThrow()
    expect(() => decode({ snapshotPosition: 1, experimentView: { ...experimentView, direction: "up" } })).toThrow()
    expect(() => decode({ snapshotPosition: 1, experimentView: { ...experimentView, runCounts: { ...experimentView.runCounts, kept: -1 } } })).toThrow()
    expect(() => decode({ snapshotPosition: 1, experimentView: { ...experimentView, running: "yes" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(ExperimentViewPatchPayloadSchema)({ kind: "experiment_view.updated" })).toThrow()
    expect(() => Schema.decodeUnknownSync(ExperimentViewPatchPayloadSchema)({ kind: "workflow_view.updated", experimentView })).toThrow()
  })

  test("papercut snapshot and full-view patch round-trip with a workspace cursor", () => {
    const query = RuntimeProtocolRpc.requests.get("RuntimeQuery")
    expect(query).toBeDefined()
    const snapshot = { snapshotPosition: 8, papercuts: { undisposedCount: 3 } }
    expect(Schema.decodeUnknownSync(query!.payloadSchema)({ type: "papercutCountSnapshot" })).toEqual({ type: "papercutCountSnapshot" })
    expect(Schema.decodeUnknownSync(RuntimePapercutCountSnapshotResultSchema)(snapshot)).toEqual(snapshot)

    const patch = {
      cursor: { scope: "workspace", domain: "papercuts" },
      position: 9,
      prevPosition: 8,
      payload: { kind: "papercuts.changed", papercuts: { undisposedCount: 4 } },
    }
    expect<unknown>(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
  })

  test("papercut wire values reject malformed counts and mismatched kinds", () => {
    for (const undisposedCount of [-1, 1.5, "3"]) {
      expect(() => Schema.decodeUnknownSync(RuntimePapercutCountSnapshotResultSchema)({ snapshotPosition: 8, papercuts: { undisposedCount } })).toThrow()
    }
    expect(() => Schema.decodeUnknownSync(PapercutPatchPayloadSchema)({ kind: "papercut.changed", papercuts: { undisposedCount: 4 } })).toThrow()
  })

  test("stream patch and command result payloads are schema-backed", () => {
    const patch = { cursor: { scope: "session", domain: "output", sessionId: "s1" }, position: 2, prevPosition: 1, payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [] } } }
    expect<unknown>(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)

    const row = { id: "s1", kind: "chat", title: "Changed", lifecycleState: "active", notices: [], inputMode: { kind: "chat" }, lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/workspace", totalsLoading: true }
    const sessionPatch = { cursor: { scope: "session", domain: "session", sessionId: "s1" }, position: 3, prevPosition: 2, payload: { kind: "session.updated", row } }
    expect<unknown>(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(sessionPatch)).toEqual(sessionPatch)
    expect(Schema.decodeUnknownSync(runtimeDispatchResultSchema("session.rename"))({ ok: true, sessionCatalogRow: row })).toEqual({ ok: true, sessionCatalogRow: row })
    expect(Schema.decodeUnknownSync(runtimeDispatchResultSchema("session.rename"))({ ok: false, error: "no such session" })).toEqual({ ok: false, error: "no such session" })
  })

  test("config mutation commands and every acknowledgement outcome round-trip losslessly", () => {
    const dispatch = RuntimeProtocolRpc.requests.get("RuntimeDispatch")
    if (dispatch === undefined) throw new Error("RuntimeDispatch is missing")
    const commands = [
      { type: "config.mutate", setting: { id: "webSearchProvider", expected: { kind: "value", value: "chatgpt" }, desired: "exa" } },
      { type: "config.mutate", setting: { id: "theme", expected: { kind: "absent" }, desired: "midnight" } },
      { type: "config.mutate", setting: { id: "module", section: "subscription_usage", key: "alert_thresholds", expected: { kind: "value", value: [75, 90] }, desired: [80, 95] } },
    ] as const
    for (const command of commands) expect(Schema.decodeUnknownSync(dispatch.payloadSchema)(command)).toEqual(command)
    expect(() => Schema.decodeUnknownSync(dispatch.payloadSchema)({ type: "config.refresh" })).toThrow()
    expect(() => Schema.decodeUnknownSync(dispatch.payloadSchema)({ type: "config.mutate", setting: { id: "webSearchProvider", expected: { kind: "value", value: "exa" }, desired: "other" } })).toThrow()

    const results = [
      { kind: "stale", message: "The configuration changed before this update. Try again." },
      { kind: "lock-failed", message: "The configuration is busy. Try again." },
      { kind: "parse-or-decode-failed", message: "The configuration is invalid and was not changed." },
      { kind: "write-not-applied", message: "The configuration could not be saved." },
      { kind: "write-outcome-unknown", message: "Saving the configuration could not be verified. Refresh before trying again." },
      { kind: "disposed", message: "Configuration updates are unavailable." },
      { kind: "committed", revision: 5 },
      { kind: "committed-with-durability-warning", revision: 5, warning: "The configuration was saved, but publication verification or durability could not be confirmed." },
      { kind: "committed-with-degraded-application", revision: 5, errors: ["A runtime component could not apply the configuration change."], durabilityWarning: "The configuration was saved, but publication verification or durability could not be confirmed." },
    ] as const
    for (const result of results) {
      const codec = runtimeDispatchResultSchema("config.mutate")
      expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(result))).toEqual(result)
    }
  })

  test("queue snapshot and patch payloads round-trip through schemas", () => {
    const queue = {
      attempts: [{ id: "attempt-1", definitionId: "work", briefId: "work", name: "Do work", status: "running", history: [] }],
      attemptsStatus: "loaded",
      state: "running",
      tree: { nodes: [
        { id: "work:phase", kind: "phase", form: "single", phaseId: "work", label: "Do work", parentId: null, disposition: "running" },
        { id: "work", kind: "agent", definitionId: "work", label: "Do work", parentId: "work:phase", disposition: "running", attempts: 1, currentAttemptId: "attempt-1" },
      ] },
    }
    const snapshot = { snapshotPosition: 4, view: queue }
    expect<unknown>(Schema.decodeUnknownSync(workflowDomain.snapshot.result)(snapshot)).toEqual(snapshot)
    expect<unknown>(Schema.decodeUnknownSync(workflowDomain.patch)({ kind: "workflow_view.updated", workflowView: queue })).toEqual({ kind: "workflow_view.updated", workflowView: queue })
    expect(Schema.decodeUnknownSync(workflowDomain.patch)({ kind: "workflow_view.removed" })).toEqual({ kind: "workflow_view.removed" })
    // A repeat holds the phase of each round, which names its round and how
    // the round ended.
    const looped = { attempts: [], attemptsStatus: "loaded", state: "completed", tree: { nodes: [
      { id: "loop", kind: "repeat", label: "while finds.kept · at most 3 rounds", parentId: null, disposition: "completed", loop: { iteration: 1, maxIterations: 3, outcome: "dry" } },
      { id: "loop:round:1:finds:phase:1", kind: "phase", form: "list", phaseId: "finds", label: "finds", parentId: "loop", disposition: "completed", round: { number: 1, outcome: "dry" }, list: { id: "loop:round:1:finds", expanded: true } },
      { id: "fix:phase", kind: "phase", form: "single", phaseId: "fix", label: "Fix", parentId: null, disposition: "conditional" },
      { id: "fix", kind: "agent", definitionId: "fix", label: "Fix", parentId: "fix:phase", disposition: "conditional", attempts: 0 },
    ] } } as const
    expect(Schema.decodeUnknownSync(workflowDomain.patch)({ kind: "workflow_view.updated", workflowView: looped })).toEqual({ kind: "workflow_view.updated", workflowView: looped })
    expect(Schema.decodeUnknownSync(WorkflowTreeSchema)(looped.tree)).toEqual(looped.tree)
    const durableQueue = { attempts: [], attemptsStatus: "loaded", state: "completed", tree: { nodes: [] } }
    expect<unknown>(Schema.decodeUnknownSync(workflowDomain.snapshot.result)({ snapshotPosition: 5, view: durableQueue })).toEqual({ snapshotPosition: 5, view: durableQueue })
    const patch = (workflowView: unknown) => ({ kind: "workflow_view.updated", workflowView })
    const decode = Schema.decodeUnknownSync(workflowDomain.patch)
    expect(() => decode(patch({ attempts: [], attemptsStatus: "loaded" }))).toThrow()
    // A tree before version 4 spelled an agent as a step. The wire carries
    // only the current tree; the historical reader still decodes the old one.
    const oldLeaf = { id: "work", kind: "step", label: "Do work", parentId: null, disposition: "pending", attempts: 0 }
    expect(() => decode(patch({ ...queue, tree: { nodes: [oldLeaf] } }))).toThrow()
    expect(() => Schema.decodeUnknownSync(WorkflowTreeSchema)({ nodes: [oldLeaf] })).toThrow()
    expect<unknown>(Schema.decodeUnknownSync(WorkflowTreeV1Schema)({ nodes: [oldLeaf] })).toEqual({ nodes: [oldLeaf] })
    const oldLoop = { nodes: [{ id: "loop", kind: "rounds", label: "Review", parentId: null, disposition: "completed", attempts: 0 }] }
    expect<unknown>(Schema.decodeUnknownSync(WorkflowTreeV1Schema)(oldLoop)).toEqual(oldLoop)
    expect(() => Schema.decodeUnknownSync(WorkflowTreeSchema)(oldLoop)).toThrow()
    const rows = { attempts: [], cursor: 0, status: "idle", mutationLog: [] }
    expect<unknown>(Schema.decodeUnknownSync(WorkflowRowsSchema)(rows)).toEqual(rows)
    expect(() => Schema.decodeUnknownSync(WorkflowViewSchema)(rows)).toThrow()
    expect<unknown>(decode(patch({ attempts: [], attemptsStatus: "unavailable" }))).toEqual(patch({ attempts: [], attemptsStatus: "unavailable" }))
    expect(() => decode(patch({ attempts: queue.attempts, attemptsStatus: "unavailable" }))).toThrow()
    expect(() => decode(patch({ ...queue, attempts: [{ ...queue.attempts[0], status: "conditional" }] }))).toThrow()
  })

  test("question snapshot and patch payloads round-trip through schemas", () => {
    const question = {
      kind: "question",
      toolUseId: "tool-1",
      questions: [{ question: "Continue?", choices: [{ kind: "option", label: "Yes" }], multiSelect: false }],
      timestamp: 2,
    }
    const snapshot = { snapshotPosition: 5, views: [{ sessionId: "s1", view: question }] }
    expect<unknown>(Schema.decodeUnknownSync(RuntimeQuestionSnapshotResultSchema)(snapshot)).toEqual(snapshot)
    expect<unknown>(Schema.decodeUnknownSync(QuestionPatchPayloadSchema)({ kind: "question.updated", question })).toEqual({ kind: "question.updated", question })
    expect(Schema.decodeUnknownSync(QuestionPatchPayloadSchema)({ kind: "question.removed" })).toEqual({ kind: "question.removed" })
  })

  test("a cancelled question block round-trips through the output patch schema", () => {
    const block = {
      kind: "question",
      toolUseId: "tool-1",
      questions: [{ question: "Continue?", choices: [{ kind: "option", label: "Yes" }], multiSelect: false }],
      cancelled: true,
      timestamp: 2,
    }
    const patch = {
      cursor: { scope: "session", domain: "output", sessionId: "s1" },
      position: 2,
      prevPosition: 1,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [{ kind: "upsert", index: 0, blockId: "tool-1", block }] } },
    }
    expect<unknown>(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
  })

  test("a historical question block with the removed errorMessage field still decodes, dropping the field", () => {
    const block = {
      kind: "question",
      toolUseId: "tool-1",
      questions: [{ question: "Continue?", choices: [{ kind: "option", label: "Yes" }], multiSelect: false }],
      cancelled: true,
      timestamp: 2,
    }
    const question = { ...block, errorMessage: "This question was not shown" }
    const snapshot = { snapshotPosition: 5, views: [{ sessionId: "s1", view: question }] }
    expect<unknown>(Schema.decodeUnknownSync(RuntimeQuestionSnapshotResultSchema)(snapshot)).toEqual({ snapshotPosition: 5, views: [{ sessionId: "s1", view: block }] })
  })

  test("auth status snapshots round-trip through schemas without credential fields", () => {
    const snapshot = {
      snapshotPosition: 6,
      auth: {
        providers: [{ providerId: "anthropic_api", kind: "singleton", source: "stored_key", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 10, group: "model", displayName: "Anthropic API Key", accounts: [] }],
        warnings: [],
        profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
        subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
      },
    }

    expect<unknown>(Schema.decodeUnknownSync(RuntimeAuthStatusSnapshotResultSchema)(snapshot)).toEqual(snapshot)
    expect(() => Schema.decodeUnknownSync(RuntimeAuthStatusSnapshotResultSchema)({
      snapshotPosition: 6,
      auth: {
        providers: [{ providerId: "anthropic_api", kind: "singleton", source: "stored_key", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 10, group: "model", displayName: "Anthropic API Key", accounts: [{ instanceId: "account", identity: "person@example.com", displayLabel: "person@example.com", expired: false, source: "oauth", accessToken: "secret" }] }],
        warnings: [],
        profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
        subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
      },
    }, { onExcessProperty: "error" })).toThrow()
  })

  test("classifyRuntimeProtocolErrorKind tags our own InvariantViolation, a paused project's refusal, and a read a generation change voided distinctly from any other caught error", () => {
    const invariantErr = new InvariantViolation({
      kind: "orphan-event",
      eventType: "chat.entries.appended",
      eventPosition: 42,
      aggregateId: "session:s1",
      detail: "no parent found",
    })
    expect(classifyRuntimeProtocolErrorKind(invariantErr)).toBe("invariant-violation")
    expect(classifyRuntimeProtocolErrorKind(new ExecutorNotRunningError())).toBe("not-running")
    expect(classifyRuntimeProtocolErrorKind(new ExecutorGenerationChangedError())).toBe("superseded")
    expect(classifyRuntimeProtocolErrorKind(new Error("boom"))).toBe("internal")
    expect(classifyRuntimeProtocolErrorKind("a thrown string")).toBe("internal")
  })
})
