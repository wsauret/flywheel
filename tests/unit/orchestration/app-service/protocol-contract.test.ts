import { describe, expect, test } from "bun:test"
import { Redacted, Schema } from "effect"
import { cursorKey, type RuntimeUiPatch } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { FrontendMutationSchema, RuntimeProtocolRpc, RuntimeUiPatchSchema, runtimeQueryResultSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { RuntimeCursorIdentitySchema, RuntimeSnapshotScopeSchema } from "../../../../src/protocol/runtime-cursor-schemas.js"
import { ProviderModelTargetSchema, ProviderModelViewSchema, RuntimeProviderModelsQuerySchema, RuntimeSetProviderModelMutationSchema } from "../../../../src/protocol/provider-model-preference-protocol-schemas.js"
import { runtimeDispatchResultSchema } from "../../../../src/protocol/runtime-dispatch-result-schemas.js"
import { buildMutationDiffEvidence } from "../../../../src/infra/mutation-diff-evidence.js"
import { createRecordingFileMutationStore } from "../agent-runtime/tools/_fixtures.js"

const contractFiles = [
  "src/protocol/app-service-types.ts", "src/protocol/runtime-ui-protocol-types.ts",
  "src/protocol/runtime-config-protocol-types.ts", "src/protocol/output-protocol-types.ts",
  "src/protocol/runtime-protocol-schemas.ts", "src/protocol/session-detail-protocol-schemas.ts", "src/protocol/runtime-cursor-schemas.ts", "src/protocol/auth-status-protocol-types.ts",
  "src/protocol/auth-profile-selection-protocol-types.ts", "src/protocol/provider-model-preference-protocol-types.ts",
  "src/protocol/provider-model-preference-protocol-schemas.ts", "src/protocol/status-protocol-types.ts",
  "src/protocol/budget-protocol-types.ts", "src/protocol/workflow-view-protocol-types.ts", "src/protocol/modules/experiments.ts",
  "src/protocol/protocol-module.ts", "src/protocol/modules.ts", "src/protocol/client/module-domain.ts",
  "src/protocol/question-protocol-types.ts", "src/protocol/update-protocol-types.ts",
  "src/protocol/module-protocol-types.ts", "src/protocol/modules/definition-overrides.ts",
  "src/protocol/modules/papercuts.ts", "src/protocol/modules/subagents.ts", "src/protocol/modules/subscription-usage.ts", "src/protocol/schema-union.ts"]

const forbiddenImports = [
  "../session-store/types", "../workflow-host/runner-types",
  "../session/manager", "../session/types",
  "../workflow-host/controller", "../../workflows/queue",
  "solid-js", "@opentui", "JSX",
]

const AUTO_INSTALL_ON = { persisted: true, forcedOff: false, effective: true }

describe("runtime protocol contract", () => {
  test("composer return claims preserve input metadata through the lossless mutation codec", () => {
    const mutation = { type: "session.claim_composer_returns", sessionId: "parent", submissionIds: ["send"] } as const
    expect(Schema.decodeUnknownSync(FrontendMutationSchema)(mutation)).toEqual(mutation)
    const codec = runtimeDispatchResultSchema(mutation.type)
    const result = { ok: true, kind: "claimed", items: [{ noticeId: "returned-input:child:person:send", sourceSessionId: "child", sourceName: "Child", input: { text: "words", submissionIds: ["send"], attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "aGVsbG8=" }] } }] }
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(result))).toEqual(result)
    expect(Schema.decodeUnknownSync(codec)({ ok: true, kind: "no_match" })).toEqual({ ok: true, kind: "no_match" })
    expect(() => Schema.decodeUnknownSync(codec)({ ok: true, kind: "claimed" })).toThrow()
  })
  test("login recovery commands and ignored answers keep their opaque episode identity", () => {
    const decode = Schema.decodeUnknownSync(FrontendMutationSchema, { onExcessProperty: "error" })
    for (const mutation of [
      { type: "auth.login", providerId: "anthropic_sub", instanceId: "account", loginQuestionId: "episode" },
      { type: "auth.login.decline", providerId: "anthropic_sub", loginQuestionId: "episode" },
      { type: "auth.login.cancel", loginQuestionId: "episode", operationId: "operation" },
    ] as const) {
      expect(decode(mutation)).toEqual(mutation)
      expect(() => decode({ ...mutation, authDir: "/private/login" })).toThrow()
    }
    const result = { kind: "ignored", providerId: "anthropic_sub" }
    const codec = runtimeDispatchResultSchema("auth.login")
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(result))).toEqual(result)
    expect(() => Schema.decodeUnknownSync(codec, { onExcessProperty: "error" })({ ...result, completed: true })).toThrow()
  })
  test("direct workflow launch operations are not accepted on the wire", () => {
    const decode = Schema.decodeUnknownSync(FrontendMutationSchema)
    expect(() => decode({ type: "workflow.launch", workflowDefinitionId: "debug", description: "Fix it" })).toThrow()
    expect(() => decode({ type: "workflow.slash_launch", command: "debug", rawArg: "Fix it" })).toThrow()
  })

  test("profile deletion previews are secret-safe and deletion requires the exact confirmed target", () => {
    const query = RuntimeProtocolRpc.requests.get("RuntimeQuery")!
    const dispatch = RuntimeProtocolRpc.requests.get("RuntimeDispatch")!
    const request = { type: "authProfileDeletionPreview", id: "work" } as const
    expect(Schema.decodeUnknownSync(query.payloadSchema)(request)).toEqual(request)
    const source = { id: "work", displayName: "Work" }
    const successor = { id: "personal", displayName: "Personal" }
    const decode = Schema.decodeUnknownSync(runtimeQueryResultSchema("authProfileDeletionPreview"))
    for (const preview of [
      { kind: "fresh-default", source },
      { kind: "automatic", source, successor },
      { kind: "choose", source, candidates: [successor, { id: "other", displayName: "Other" }] },
    ]) {
      expect(decode(preview)).toEqual(preview)
      expect(() => decode({ ...preview, source: { ...source, directory: "/private/auth" } })).toThrow()
    }
    const mutation = { type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work" } as const
    expect(() => Schema.decodeUnknownSync(dispatch.payloadSchema)(mutation)).toThrow()
    for (const successorId of [null, "personal"]) {
      expect(Schema.decodeUnknownSync(dispatch.payloadSchema)({ ...mutation, successorId })).toEqual({ ...mutation, successorId })
    }
  })

  test("session.fork accepts only its exact payload directly and on the wire", () => {
    const payload = { type: "session.fork", sessionId: "source" } as const
    const dispatch = RuntimeProtocolRpc.requests.get("RuntimeDispatch")
    if (dispatch === undefined) throw new Error("RuntimeDispatch RPC is missing")

    expect(Schema.decodeUnknownSync(FrontendMutationSchema)(payload)).toEqual(payload)
    expect(Schema.decodeUnknownSync(dispatch.payloadSchema)(payload)).toEqual(payload)
    for (const extra of [
      { at: 4 },
      { before: "message-2" },
      { entryId: "message-2" },
      { arbitrary: true },
    ]) {
      const candidate = { ...payload, ...extra }
      expect(() => Schema.decodeUnknownSync(FrontendMutationSchema)(candidate)).toThrow()
      expect(() => Schema.decodeUnknownSync(dispatch.payloadSchema)(candidate)).toThrow()
    }
  })

  test("contract modules do not import runtime, workflow, or TUI implementation types", async () => {
    for (const file of contractFiles) {
      const source = await Bun.file(file).text()
      for (const forbidden of forbiddenImports) expect(source.includes(forbidden), `${file} imports ${forbidden}`).toBe(false)
    }
  })

  test("provider-model targets are strict and never expose account instance ids", () => {
    const dispatch = RuntimeProtocolRpc.requests.get("RuntimeDispatch")!
    for (const scope of [{ kind: "defaults" }, { kind: "session", sessionId: "chat-1" }, { kind: "profile", profileId: "work" }] as const) {
      const request = { type: "auth.catalog.refresh", scope } as const
      expect(Schema.decodeUnknownSync(dispatch.payloadSchema)(request)).toEqual(request)
    }
    expect(() => Schema.decodeUnknownSync(dispatch.payloadSchema)({ type: "auth.catalog.refresh", scope: { kind: "profile" } })).toThrow()
    const subscription = { kind: "subscription", providerId: "chatgpt", accountCorrelationId: "opaque-a" } as const
    expect(Schema.decodeUnknownSync(ProviderModelTargetSchema, { onExcessProperty: "error" })(subscription)).toEqual(subscription)
    expect(() => Schema.decodeUnknownSync(ProviderModelTargetSchema, { onExcessProperty: "error" })({ ...subscription, instanceId: "secret" })).toThrow()
    expect(() => Schema.decodeUnknownSync(ProviderModelTargetSchema, { onExcessProperty: "error" })({ kind: "subscription", providerId: "chatgpt" })).toThrow()
    expect(() => Schema.decodeUnknownSync(ProviderModelTargetSchema, { onExcessProperty: "error" })({ kind: "singleton", providerId: "openai_api", accountCorrelationId: "mixed" })).toThrow()

    const query = { profileId: "work", target: subscription }
    expect(Schema.decodeUnknownSync(RuntimeProviderModelsQuerySchema, { onExcessProperty: "error" })(query)).toEqual(query)
    const mutation = { queriedProfileId: "work", queriedEligibilityRevision: 4, target: subscription, modelId: "gpt-5", checked: true }
    expect(Schema.decodeUnknownSync(RuntimeSetProviderModelMutationSchema, { onExcessProperty: "error" })(mutation)).toEqual(mutation)
    const view = { profileId: "work", eligibilityRevision: 4, target: subscription, providerDisplayName: "ChatGPT", catalog: { kind: "available" as const, provenance: "first-party" as const, liveOutcome: "valid" as const }, rows: [] }
    expect(JSON.stringify(Schema.decodeUnknownSync(ProviderModelViewSchema)(view))).not.toContain("instanceId")
  })

  test("cursor identity separates session-scoped and workspace-scoped streams", () => {
    const session = Schema.decodeUnknownSync(RuntimeCursorIdentitySchema)({ scope: "session", domain: "session", sessionId: "s1" })
    const workspace = Schema.decodeUnknownSync(RuntimeCursorIdentitySchema)({ scope: "workspace", domain: "runtime" })
    const auth = Schema.decodeUnknownSync(RuntimeCursorIdentitySchema)({ scope: "workspace", domain: "auth" })

    expect(cursorKey(session)).toBe("session:s1")
    expect(cursorKey(workspace)).toBe("runtime:workspace")
    expect(cursorKey(auth)).toBe("auth:workspace")
    expect("sessionId" in workspace).toBe(false)
  })

  test("snapshot scopes cover workspace domains and concrete cursors", () => {
    expect(Schema.decodeUnknownSync(RuntimeSnapshotScopeSchema)({ kind: "workspace", domain: "output" })).toEqual({ kind: "workspace", domain: "output" })
    expect(Schema.decodeUnknownSync(RuntimeSnapshotScopeSchema)({ kind: "cursor", cursor: { scope: "session", domain: "status", sessionId: "s1" } }))
      .toEqual({ kind: "cursor", cursor: { scope: "session", domain: "status", sessionId: "s1" } })
  })

  test("notification snapshot, ordered patches, and dismiss mutation share one strict contract", () => {
    const query = RuntimeProtocolRpc.requests.get("RuntimeQuery")
    const dispatch = RuntimeProtocolRpc.requests.get("RuntimeDispatch")
    if (query === undefined || dispatch === undefined) throw new Error("Runtime protocol RPCs are missing")

    expect(Schema.decodeUnknownSync(query.payloadSchema)({ type: "projectNotificationSnapshot" })).toEqual({ type: "projectNotificationSnapshot" })
    expect(Schema.decodeUnknownSync(dispatch.payloadSchema)({ type: "project_notifications.dismiss", sourceId: "provider:anthropic", episodeId: "episode-1" }))
      .toEqual({ type: "project_notifications.dismiss", sourceId: "provider:anthropic", episodeId: "episode-1" })
    const snapshot = { snapshotPosition: 1, notifications: [] }
    expect(Schema.decodeUnknownSync(query.successSchema)(snapshot)).toEqual(snapshot)

    const episode = {
      id: "episode-1", sourceId: "provider:anthropic", title: "Authentication required", message: "Sign in again.",
      severity: "warning", action: { kind: "open-auth" }, sourceSessionId: "session-1", createdAt: 10, expiresAt: 20,
    } as const
    for (const payload of [
      { kind: "project_notifications.raised", episode },
      { kind: "project_notifications.resolved", sourceId: episode.sourceId, episodeId: episode.id, resolvedAt: 15 },
      { kind: "project_notifications.dismissed", sourceId: episode.sourceId, episodeId: episode.id, dismissedAt: 16 },
    ] as const) {
      const patch = { cursor: { scope: "workspace", domain: "project_notifications" }, position: 2, prevPosition: 1, payload } satisfies RuntimeUiPatch
      expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
    }

    expect(() => Schema.decodeUnknownSync(dispatch.payloadSchema)({ type: "project_notifications.dismiss", sourceId: "provider:anthropic" })).toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)({ cursor: { scope: "workspace", domain: "project_notifications" }, position: 2, prevPosition: 1, payload: { kind: "project_notifications.raised", episode: { ...episode, action: "run-command" } } })).toThrow()
  })

  test("rejects every retired subscription usage operation", () => {
    const query = RuntimeProtocolRpc.requests.get("RuntimeQuery")
    const dispatch = RuntimeProtocolRpc.requests.get("RuntimeDispatch")
    if (query === undefined || dispatch === undefined) throw new Error("Runtime protocol RPCs are missing")

    expect(RuntimeProtocolRpc.requests.get("RuntimeSubscriptionUsageCurrent")).toBeUndefined()
    expect(RuntimeProtocolRpc.requests.get("RuntimeSubscriptionUsageHistory")).toBeUndefined()
    for (const payload of [
      { type: "subscription_usage.current", scope: { kind: "defaults" } },
      { type: "subscription_usage.history", scope: { kind: "defaults" }, range: "24h" },
    ]) expect(() => Schema.decodeUnknownSync(query.payloadSchema)(payload)).toThrow()
    for (const payload of [
      { type: "subscription_usage.open", scope: { kind: "defaults" } },
      { type: "subscription_usage.refresh", scope: { kind: "defaults" } },
    ]) expect(() => Schema.decodeUnknownSync(dispatch.payloadSchema)(payload)).toThrow()
  })

  test("definition staleness rejects the retired unknown-base status", () => {
    const patch = {
      cursor: { scope: "workspace", domain: "definitionStaleness" }, position: 2, prevPosition: 1,
      payload: { kind: "definitionStaleness.changed", definitionStaleness: {
        overrides: [{ family: "skill", id: "demo", layer: "user", path: "/demo/SKILL.md", status: "unknown-base", snapshotAvailable: false }],
        diagnostics: [], reviewCount: 1,
      } },
    }
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toThrow()
  })

  test("output patches preserve semantic tool result actions", () => {
    const patch = {
      cursor: { scope: "session", domain: "output", sessionId: "s1" },
      position: 2,
      prevPosition: 1,
      payload: {
        kind: "output.delta",
        delta: {
          visibleMessageCount: 0,
          blocks: [{
            kind: "upsert",
            index: 0,
            blockId: "tool:skill-1",
            block: {
              kind: "tool",
              id: "skill-1",
              name: "skill_manage",
              presentation: { name: "Save Skill", detail: "example" },
              status: "completed",
              resultAction: "created",
              invocationBody: { content: "Exact papercut observation", filetype: "text", presentation: "disclosure" },
              timestamp: 1,
            },
          }],
        },
      },
    } satisfies RuntimeUiPatch

    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
  })

  test("only streaming-only output patches can omit the visible message count", () => {
    const decode = Schema.decodeUnknownSync(RuntimeUiPatchSchema)
    const patch = { cursor: { scope: "session", domain: "output", sessionId: "s1" }, position: 2, prevPosition: 1,
      payload: { kind: "output.delta", delta: { blocks: [], streamingToolTextOps: [{ kind: "set", toolUseId: "t1", entry: { content: "hello" } }] } },
    } satisfies RuntimeUiPatch
    expect(decode(patch)).toEqual(patch)
    const counted = { ...patch, payload: { kind: "output.delta", delta: { blocks: [], streamingOutputChars: 12 } } } satisfies RuntimeUiPatch
    expect(decode(counted)).toEqual(counted)
    expect(() => decode({ ...patch, payload: { kind: "output.delta", delta: { blocks: [] } } })).toThrow()
    expect(() => decode({ ...patch, payload: { ...patch.payload, delta: { ...patch.payload.delta, truncateTo: 0 } } })).toThrow()
  })

  test("output patches carry block edits and never the whole streaming map", () => {
    const decode = Schema.decodeUnknownSync(RuntimeUiPatchSchema)
    const patch = { cursor: { scope: "session", domain: "output", sessionId: "s1" }, position: 2, prevPosition: 1,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [{ kind: "edit", index: 3, blockId: "tool:call-1", edits: [{ kind: "append", path: ["presentation", "detail"], offset: 3, text: " <<EOF" }] }] } },
    } satisfies RuntimeUiPatch
    expect(decode(patch)).toEqual(patch)
    const withMap = decode({ ...patch, payload: { ...patch.payload, delta: { ...patch.payload.delta, streamingToolText: { t1: { content: "whole" } } } } })
    expect(withMap.payload.kind === "output.delta" ? withMap.payload.delta : undefined).not.toHaveProperty("streamingToolText")
  })

  test("output patches preserve tool mutation artifacts and review-notice mutations", async () => {
    const mutationEvidence = await buildMutationDiffEvidence({
      version: 1, files: [{ path: ".flywheel/memory/project.md", change: "modified", unifiedDiff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new" }],
      omissions: [],
    }, "mutation", createRecordingFileMutationStore().writer.stageSessionContentNodes)
    const patch = {
      cursor: { scope: "session", domain: "output", sessionId: "s1" },
      position: 3,
      prevPosition: 2,
      payload: {
        kind: "output.delta",
        delta: {
          visibleMessageCount: 0,
          blocks: [
            {
              kind: "upsert",
              index: 0,
              blockId: "tool:memory-1",
              block: {
                kind: "tool",
                id: "memory-1",
                name: "memory",
                presentation: { name: "Add Memory", detail: "Prefers tabs" },
                status: "completed",
                resultAction: "updated",
                mutationEvidence,
                diffOmission: { kind: "files", files: [{ index: 0, omittedLines: 4 }] },
                timestamp: 1,
              },
            },
            {
              kind: "upsert",
              index: 1,
              blockId: "system:notice-1",
              block: {
                kind: "system",
                id: "notice-1",
                message: "Updated skill: `provider-quirks`.",
                mutationEvidence,
                diffOmission: { kind: "aggregate", omittedLines: 7 },
                timestamp: 1,
              },
            },
          ],
        },
      },
    } satisfies RuntimeUiPatch

    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
  })

  test("session summaries and output patches do not carry migrated telemetry, usage, workflow state, or TUI drafts", async () => {
    const appTypes = await Bun.file("src/protocol/app-service-types.ts").text()
    const outputTypes = await Bun.file("src/protocol/output-protocol-types.ts").text()
    const sessionStoreTypes = await Bun.file("src/orchestration/session-store/types.ts").text()

    expect(appTypes).not.toContain("readonly metrics")
    expect(appTypes).not.toContain("interface SessionMetrics")
    expect(appTypes).not.toContain("readonly runtime: SessionRuntimeView")
    expect(appTypes).not.toContain("readonly workflow:")
    expect(appTypes).not.toContain("pendingQuestion")
    expect(appTypes).not.toContain("state")
    expect(appTypes).not.toContain("draft")
    expect(outputTypes).not.toContain("streamPhase")
    expect(outputTypes).not.toContain("tokens")
    expect(outputTypes).not.toContain("contextPercent")
    expect(sessionStoreTypes).not.toContain("draftText")
    expect(sessionStoreTypes).not.toContain("draftPastes")
    expect(sessionStoreTypes).not.toContain("draftImages")
    expect(sessionStoreTypes).not.toContain("ComposerDraft")
  })

  test("migrated telemetry and workflow state have single protocol owners", async () => {
    const statusTypes = await Bun.file("src/protocol/status-protocol-types.ts").text()
    const budgetTypes = await Bun.file("src/protocol/budget-protocol-types.ts").text()
    const queueTypes = await Bun.file("src/protocol/workflow-view-protocol-types.ts").text()
    const questionTypes = await Bun.file("src/protocol/question-protocol-types.ts").text()
    const authTypes = await Bun.file("src/protocol/auth-status-protocol-types.ts").text()

    expect(statusTypes).toContain("activity")
    expect(statusTypes).not.toContain("contextPercent")
    expect(statusTypes).not.toContain("readonly cost")
    expect(statusTypes).not.toContain("notices")
    expect(budgetTypes).toContain("contextPercent")
    expect(budgetTypes).toContain("readonly cost")
    expect(budgetTypes).not.toContain("activity: FrontendActivity")
    expect(budgetTypes).not.toContain("streamPhase")
    expect(budgetTypes).not.toContain("notices")
    expect(queueTypes).toContain("FrontendWorkflowView")
    expect(queueTypes).toContain("state")
    expect(queueTypes).not.toContain("notices")
    expect(questionTypes).toContain("PendingQuestionView")
    expect(questionTypes).toContain("question.updated")
    expect(questionTypes).not.toContain("tokens")
    expect(questionTypes).not.toContain("state")
    expect(authTypes).toContain("AuthProviderStatus")
    expect(authTypes).not.toContain("envPreview")
    expect(authTypes).not.toContain("readonly access:")
    expect(authTypes).not.toContain("refreshToken")
  })

  test("auth is a complete latest-collapsible view with profile commands", () => {
    const patch = {
      cursor: { scope: "workspace", domain: "auth" },
      position: 4,
      prevPosition: 3,
      payload: {
        kind: "auth.changed",
        auth: {
          providers: [{ providerId: "openai_api", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 20, group: "model", displayName: "OpenAI API Key", accounts: [] }],
          warnings: [],
          profile: { id: "work", displayName: "Work", source: "project", availableProfiles: [{ id: "default", displayName: "Default" }, { id: "work", displayName: "Work" }], projectBinding: "work" },
          subscriptionSpendConsent: { kind: "available", profileId: "work", authorityIncarnation: "test-authority", authorityRevision: 0, usageGeneration: 0, accounts: [] },
        },
      },
    } satisfies RuntimeUiPatch
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)

    const schema = RuntimeProtocolRpc.requests.get("RuntimeDispatch")?.payloadSchema
    if (schema === undefined) throw new Error("RuntimeDispatch request schema is missing")
    for (const command of [
      { type: "auth.refresh", profileId: "work", operationId: "refresh-1" },
      { type: "auth.login.cancel" },
      { type: "auth.login.answer", providerId: "github_copilot", operationId: "login-1", answer: "" },
      { type: "auth.account.disconnect", providerId: "chatgpt", instanceId: "account-1", profileId: "work" },
      { type: "auth.account.rename", providerId: "chatgpt", instanceId: "account-1", label: "Work", profileId: "work" },
    ]) {
      const decoded = Schema.decodeUnknownSync(schema)(command)
      if (typeof decoded !== "object" || decoded === null) throw new Error("RuntimeDispatch command must decode to an object")
      expect(JSON.stringify(decoded)).toBe(JSON.stringify(command))
    }
    for (const command of [
      { type: "auth.profile.select", scope: { kind: "defaults" }, id: "work" },
      { type: "auth.profile.select", scope: { kind: "session", sessionId: "foreground" }, id: "work" },
      { type: "auth.profile.select", scope: { kind: "defaults-and-session", sessionId: "foreground" }, id: "work" },
      { type: "auth.profile.create", scope: { kind: "defaults" }, displayName: "New Profile" },
      { type: "auth.profile.rename", scope: { kind: "defaults" }, id: "old", displayName: "New Name" },
      { type: "auth.profile.bind_current_project", scope: { kind: "defaults" }, id: "work" },
      { type: "auth.profile.unbind_current_project", scope: { kind: "defaults" } },
      { type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: null },
    ]) {
      const decoded = Schema.decodeUnknownSync(schema)(command)
      if (typeof decoded !== "object" || decoded === null) throw new Error("RuntimeDispatch command must decode to an object")
      expect(JSON.stringify(decoded)).toBe(JSON.stringify(command))
      expect("sessionId" in decoded).toBe(false)
      expect("profileId" in decoded).toBe(false)
    }
    const completion = Schema.decodeUnknownSync(schema)({ type: "auth.login.complete", operationId: "login-1", input: "callback-code" })
    if (typeof completion !== "object" || completion === null || !("input" in completion)) throw new Error("Browser completion must decode to a secret-bearing mutation")
    expect(Redacted.isRedacted(completion.input)).toBe(true)
    expect(() => Schema.decodeUnknownSync(schema)({ type: "auth.profile.select", id: "work" })).toThrow()
    const resultSchema = RuntimeProtocolRpc.requests.get("RuntimeDispatch")?.successSchema
    if (resultSchema === undefined) throw new Error("RuntimeDispatch result schema is missing")
    for (const code of [{}, { userCode: "ABCD-1234" }]) {
      const result = { kind: "device_code", operationId: "login-1", providerId: "provider", verificationUri: "https://example.com/device", ...code }
      const decoded = Schema.decodeUnknownSync(resultSchema)(result)
      const encoded = Schema.encodeSync(resultSchema)(decoded)
      expect(encoded).toEqual(result)
      expect(Schema.decodeUnknownSync(resultSchema)(encoded)).toEqual(result)
    }
  })

  test("provider-model query and mutation stay correlated, strict, and proportional", () => {
    const querySchema = RuntimeProtocolRpc.requests.get("RuntimeQuery")?.payloadSchema
    const queryResultSchema = RuntimeProtocolRpc.requests.get("RuntimeQuery")?.successSchema
    const mutationSchema = RuntimeProtocolRpc.requests.get("RuntimeDispatch")?.payloadSchema
    const mutationResultSchema = RuntimeProtocolRpc.requests.get("RuntimeDispatch")?.successSchema
    expect(querySchema).toBeDefined()
    expect(queryResultSchema).toBeDefined()
    expect(mutationSchema).toBeDefined()
    expect(mutationResultSchema).toBeDefined()

    const target = { kind: "singleton", providerId: "openai" } as const
    const query = { type: "provider_models.query", profileId: "work", target } as const
    const row = {
      modelId: "gpt-5",
      checked: true,
      optInAvailable: true,
      configured: true,
    } as const
    const view = {
      profileId: "work",
      eligibilityRevision: 4,
      target,
      providerDisplayName: "OpenAI",
      catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
      rows: [row],
    } as const
    const mutation = {
      type: "provider_model.set",
      queriedProfileId: "work",
      queriedEligibilityRevision: 4,
      target,
      modelId: "gpt-5",
      checked: false,
    } as const
    const result = {
      profileId: "work",
      eligibilityRevision: 5,
      target,
      row: { ...row, checked: false },
    } as const
    const deselectAll = {
      type: "provider_models.deselect_all",
      queriedProfileId: "work",
      queriedEligibilityRevision: 4,
      target,
    } as const

    expect(Schema.decodeUnknownSync(querySchema!)(query)).toEqual(query)
    expect(Schema.decodeUnknownSync(queryResultSchema!)(view)).toEqual(view)
    expect(Schema.decodeUnknownSync(mutationSchema!)(mutation)).toEqual(mutation)
    expect(Schema.decodeUnknownSync(mutationResultSchema!)(result)).toEqual(result)
    expect(Schema.decodeUnknownSync(mutationSchema!)(deselectAll)).toEqual(deselectAll)
    expect(Schema.decodeUnknownSync(mutationResultSchema!)(view)).toEqual(view)
    expect("rows" in result).toBe(false)

    for (const malformed of [
      { ...query, target: { kind: "singleton", providerId: 1 } },
      { ...mutation, queriedProfileId: 1 },
      { ...mutation, queriedEligibilityRevision: -1 },
      { ...mutation, modelId: 1 },
      { ...mutation, checked: "false" },
    ]) expect(() => Schema.decodeUnknownSync(malformed.type === query.type ? querySchema! : mutationSchema!)(malformed)).toThrow()
  })

  test("background.terminate command payload round-trips through RuntimeDispatch", () => {
    const schema = RuntimeProtocolRpc.requests.get("RuntimeDispatch")?.payloadSchema
    expect(schema).toBeDefined()
    const command = { type: "background.terminate", sessionId: "workflow-1", toolUseId: "toolu_bg" } as const
    expect(Schema.decodeUnknownSync(schema!)(command)).toEqual(command)
  })

  test("bash.detach command payload round-trips through RuntimeDispatch", () => {
    const schema = RuntimeProtocolRpc.requests.get("RuntimeDispatch")?.payloadSchema
    expect(schema).toBeDefined()
    const command = { type: "bash.detach", sessionId: "chat-1", toolUseId: "toolu_bash" } as const
    expect(Schema.decodeUnknownSync(schema!)(command)).toEqual(command)
    expect(() => Schema.decodeUnknownSync(schema!)({ type: "bash.detach", sessionId: "chat-1" })).toThrow()
  })


  test("each capability mutation round-trips through RuntimeDispatch", () => {
    const schema = RuntimeProtocolRpc.requests.get("RuntimeDispatch")?.payloadSchema
    expect(schema).toBeDefined()
    for (const command of [
      { type: "settings.set_module", moduleId: "learning", expected: true, enabled: false },
      { type: "settings.set_module", moduleId: "provider-claude-agent-sdk", expected: false, enabled: true },
      { type: "settings.set_modules", preset: "minimal", expected: { moduleIds: ["learning"], requireWorkflowConfirmation: true, descriptorIdentity: "descriptor-learning" } },
      { type: "settings.set_modules", preset: "full", expected: { moduleIds: [], requireWorkflowConfirmation: true, descriptorIdentity: "descriptor-empty" } },
      { type: "settings.set_workflow_mode", expected: "on", mode: "ask" },
      { type: "settings.set_persistent_processes", expected: false, enabled: true },
    ] as const) {
      expect(Schema.decodeUnknownSync(schema!)(command)).toEqual(command)
    }
  })

  test("the capability wire accepts only installed module ids and keeps preset and mode vocabularies closed", () => {
    const schema = RuntimeProtocolRpc.requests.get("RuntimeDispatch")?.payloadSchema
    expect(schema).toBeDefined()
    expect(() => Schema.decodeUnknownSync(schema!)({ type: "settings.set_modules", preset: "custom", expected: { moduleIds: [], requireWorkflowConfirmation: true, descriptorIdentity: "descriptor-empty" } })).toThrow()
    expect(Schema.decodeUnknownSync(schema!)({ type: "settings.set_module", moduleId: "web", expected: false, enabled: true })).toEqual({ type: "settings.set_module", moduleId: "web", expected: false, enabled: true })
    expect(() => Schema.decodeUnknownSync(schema!)({ type: "settings.set_module", moduleId: "unknown", expected: false, enabled: true })).toThrow()
    expect(() => Schema.decodeUnknownSync(schema!)({ type: "settings.set_module", moduleId: 3, expected: false, enabled: true })).toThrow()
    expect(() => Schema.decodeUnknownSync(schema!)({ type: "settings.set_workflow_mode", expected: "off", mode: "sometimes" })).toThrow()
    expect(Schema.decodeUnknownSync(schema!)({ type: "config.mutate", setting: { id: "webSearchProvider", expected: { kind: "value", value: "chatgpt" }, desired: "exa" } })).toEqual({ type: "config.mutate", setting: { id: "webSearchProvider", expected: { kind: "value", value: "chatgpt" }, desired: "exa" } })
    const acknowledgement = { type: "config.mutate", setting: { id: "acknowledgedReleaseVersion", expected: { kind: "absent" }, desired: "0.1.1" } } as const
    expect(Schema.decodeUnknownSync(schema!)(acknowledgement)).toEqual(acknowledgement)
    expect(() => Schema.decodeUnknownSync(schema!)({ ...acknowledgement, setting: { ...acknowledgement.setting, desired: "not-a-release" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(schema!)({ type: "settings.set_web_search_provider", provider: "exa" })).toThrow()
  })

  test("one capability patch carries the complete module projection and persistent-process policy", () => {
    const invalidView = { capabilities: [], moduleIds: [], descriptorIdentity: "invalid:test", modules: [{ id: "provider-claude-agent-sdk", installed: true, effective: false, dependencies: [], setting: { control: "binary", label: "Anthropic Subscription", description: "Serve Claude models through the Claude login" } }], warnings: [], requireWorkflowConfirmation: true, workflowsMode: "off", persistentProcesses: { persisted: false, effective: true, forcedByCli: true }, error: "modules is invalid" } as const
    const patch = {
      cursor: { scope: "workspace", domain: "modules" },
      position: 4,
      prevPosition: 3,
      payload: { kind: "modules.changed", capabilities: invalidView },
    } satisfies RuntimeUiPatch

    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
    const { error: _error, ...validView } = invalidView
    const cleared = { ...patch, payload: { kind: "modules.changed", capabilities: { ...validView, moduleIds: ["skills"], requireWorkflowConfirmation: false } } } satisfies RuntimeUiPatch
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(cleared)).toEqual(cleared)
    const incomplete = { ...patch, payload: { kind: "modules.changed", capabilities: { moduleIds: ["skills"] } } }
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)(incomplete)).toThrow()
  })

  test("the capability snapshot answers with the published view and its position", () => {
    const schema = RuntimeProtocolRpc.requests.get("RuntimeQuery")?.successSchema
    expect(schema).toBeDefined()
    const result = { snapshotPosition: 9, capabilities: { capabilities: ["skills", "learning"], moduleIds: ["learning", "skills"], descriptorIdentity: "valid:learning+skills|confirm", modules: [], warnings: [], requireWorkflowConfirmation: true, workflowsMode: "off", persistentProcesses: { persisted: false, effective: false, forcedByCli: false } } }
    expect(Schema.decodeUnknownSync(schema!)(result)).toEqual(result)
  })

  test("the auto-install setting round-trips through RuntimeDispatch", () => {
    // The durable value is what a client may ask to change; the effective one
    // is the runtime's answer and is never sent back to it.
    const schema = RuntimeProtocolRpc.requests.get("RuntimeDispatch")?.payloadSchema
    expect(schema).toBeDefined()
    const command = { type: "settings.set_update_auto_install", expected: true, value: false } as const
    expect(Schema.decodeUnknownSync(schema!)(command)).toEqual(command)
  })

  test("one update patch carries the whole view: state and the effective policy together", () => {
    const patch = {
      cursor: { scope: "workspace", domain: "updates" },
      position: 4,
      prevPosition: 3,
      payload: { kind: "update.changed", update: { revision: 2, autoInstall: { persisted: false, forcedOff: false, effective: false }, status: { kind: "installing", version: "0.2.0" }, releaseNotice: { version: "0.1.1", message: "Updated to v0.1.1.", url: "https://github.com/wsauret/flywheel/releases/tag/v0.1.1" } } },
    } satisfies RuntimeUiPatch

    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)({ ...patch, payload: { ...patch.payload, update: { ...patch.payload.update, releaseNotice: { version: "0.1.1" } } } })).toThrow()
  })

  test("an update state that means a version is rejected on the wire without one", () => {
    const withoutVersion = {
      cursor: { scope: "workspace", domain: "updates" } as const,
      position: 4,
      prevPosition: 3,
      payload: { kind: "update.changed", update: { revision: 2, autoInstall: AUTO_INSTALL_ON, status: { kind: "available", blocking: "nothing" } } },
    }

    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)(withoutVersion)).toThrow()
    // The refusal reason is as required as the version: a notice that had to
    // guess at it is what the reason exists to replace.
    const withoutBlocking = { ...withoutVersion, payload: { kind: "update.changed", update: { revision: 2, autoInstall: AUTO_INSTALL_ON, status: { kind: "available", version: "0.2.0" } } } }
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)(withoutBlocking)).toThrow()
    // And idle carries no version, so a stale one cannot ride along.
    const idleWithVersion = { ...withoutVersion, payload: { kind: "update.changed", update: { revision: 2, autoInstall: AUTO_INSTALL_ON, status: { kind: "idle", version: "0.2.0" } } } }
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(idleWithVersion)).toEqual({ ...withoutVersion, payload: { kind: "update.changed", update: { revision: 2, autoInstall: AUTO_INSTALL_ON, status: { kind: "idle" } } } })
  })

  test("the update snapshot answers with the published view and the position it was taken at", () => {
    const schema = RuntimeProtocolRpc.requests.get("RuntimeQuery")?.successSchema
    expect(schema).toBeDefined()
    const result = { snapshotPosition: 7, update: { revision: 3, autoInstall: AUTO_INSTALL_ON, status: { kind: "installed", version: "0.3.0" }, releaseNotice: { version: "0.1.1", message: "Updated to v0.1.1.", url: "https://github.com/wsauret/flywheel/releases/tag/v0.1.1" } } }
    expect(Schema.decodeUnknownSync(schema!)(result)).toEqual(result)
  })

  test("a session catalog row requires only the resolved executionCwd on the wire", () => {
    const row = {
      id: "chat-1",
      kind: "chat",
      title: "Chat",
      lifecycleState: "active",
      notices: [],
      inputMode: { kind: "chat" },
      lastUpdated: "2026-01-01T00:00:00.000Z",
      totalsLoading: true,
    } as const
    const patch = { cursor: { scope: "session", domain: "session", sessionId: "chat-1" } as const, position: 2, prevPosition: 1, payload: { kind: "session.added", row } }

    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toThrow()
    const withExecutionCwd = { ...patch, payload: { kind: "session.added" as const, row: { ...row, executionCwd: "/workspace/app" } } }
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(withExecutionCwd)).toEqual(withExecutionCwd)
  })

})
