import { describe, expect, spyOn, test } from "bun:test"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { chatEntry, fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"

const configView = {
  revision: 0,
  values: {
    moduleSelection: [], allowPersistentProcesses: false, foregroundBashHoldSeconds: 240, showThinking: true, idleCompaction: true, shellWriteGuard: true, autoDeleteSessionDays: 0,
    requireWorkflowConfirmation: true, writeSyntaxTheme: "nord" as const, diffColors: "theme" as const, compatibleRendering: "auto" as const, webSearchProvider: "exa" as const,
    fontTipDismissed: false, tabsHintDismissed: false, proactiveCompactionThreshold: 270_000, showBuild: false,
    moduleSections: { subscription_usage: { alert_thresholds: [75, 90, 95, 100] } }, autoInstall: true, roles: {}, profiles: {}, keybindings: {},
    budget: { max_invocations: 100, max_tokens: 1_000_000, max_wall_clock_minutes: 60 }, workflow: { max_attempts: 100 },
    notificationsDesktop: false,
  },
  status: { kind: "valid" as const }, warnings: [], diagnostics: [],
}
const authView = { providers: [], warnings: [], profile: { id: "default", persistedId: "default", displayName: "Default", source: "default" as const, projectBinding: undefined, availableProfiles: [] }, subscriptionSpendConsent: { kind: "available" as const, profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] } }

describe("FlywheelAppService startup", () => {
  test("subscribe does not synchronously replay durable session metadata", async () => {
    const fetch = spyOn(globalThis, "fetch")
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    let listMetadataCalls = 0
    const manager = fakeManager({
      listMetadata: async () => {
        listMetadataCalls += 1
        return { sessions: [], errors: [] }
      },
    })
    const projections = fakeProjections()
    const service = createFlywheelAppService({
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: "/scratch/flywheel-app-service-startup-test" }),
      projectRoot: "/scratch/flywheel-app-service-startup-test",
      bus: createRuntimeUiBus(),
      ...projections,
      authStatusProjection: { observedSessionIds: new Set<string>(), snapshot: async () => authView, view: () => authView, replace: () => authView },
      capabilities: {
        ...projections.capabilities,
        view: () => ({ capabilities: [], moduleIds: [], descriptorIdentity: "test", modules: [], warnings: [], requireWorkflowConfirmation: true, workflowsMode: "off" as const, persistentProcesses: { persisted: false, effective: false, forcedByCli: false } }),
        workflowsMode: () => "off" as const,
        setModule: async () => ({ ok: true as const }),
        setModules: async () => ({ ok: true as const }),
        setWorkflowMode: async () => ({ ok: true as const }),
        setPersistentProcesses: async () => ({ ok: true as const }),
        refresh: async () => {},
        dispose: async () => {},
      },
      config: { view: () => configView, refresh: async () => configView, mutate: async () => await new Promise<never>(() => {}), dispose: async () => {} },
      historyProjection: {
        ...projections.historyProjection,
        outputWindow: async (_sessionId, request) => ({ totalBlocks: 0, visibleMessageCount: 0, range: { kind: "ok" as const, consistencyToken: "test:v1", anchor: request.anchor, window: { startBlockIndex: null, endBlockIndex: null, hasBefore: false, hasAfter: false, contentBytes: 0 }, blocks: [], streamingToolText: {}, streamingOutputChars: 0 } }),
        outputRange: async (_sessionId, request) => ({ kind: "ok" as const, consistencyToken: "test:v1", anchor: request.anchor, window: { startBlockIndex: null, endBlockIndex: null, hasBefore: false, hasAfter: false, contentBytes: 0 }, blocks: [], streamingToolText: {}, streamingOutputChars: 0 }),
        outputGroupChildren: async () => ({ groups: [], contentBytes: 0 }),
        outputBlockBody: async (_sessionId, request) => ({ blockId: request.blockId }),
      },
      runtimeSupervisor: {
        ...runtimeSupervisor(),
        ensureChatRunner: async () => await new Promise<never>(() => {}),
        renameSession: async () => true,
        dismissNotice: () => true,
        releaseForegroundBash: () => true,
        answerQuestion: async () => ({ ok: true }),
        runtimeState: () => null,
      },
    })

    service.subscribe(() => {})

    expect(listMetadataCalls).toBe(0)
    await service.query({ type: "snapshot" })
    expect(listMetadataCalls).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })

})
