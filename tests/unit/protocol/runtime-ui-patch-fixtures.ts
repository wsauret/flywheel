import type { RuntimeUiPatch, RuntimeUiPatchPayload } from "../../../src/protocol/runtime-ui-protocol-types.js"
import { sideQuestionCursor, sideQuestionRequestCursor, type SideQuestionHistoryView } from "../../../src/protocol/modules/side-question.js"

const sessionRow = {
  id: "session-1", kind: "chat", title: "Session", lifecycleState: "active", notices: [],
  inputMode: { kind: "chat" }, lastUpdated: "now", executionCwd: "/project",
  totalsLoading: true,
} as const
const status = {
  activity: "idle", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0,
  activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false,
  startedAt: 1, streamingStartedAt: null, accumulatedActiveMs: 0,
  compactionStartedAt: null, replyWaits: [],
} as const
const config = {
  revision: 1,
  values: {
    moduleSelection: [], allowPersistentProcesses: false, foregroundBashHoldSeconds: 0, showThinking: true, idleCompaction: true, autoDeleteSessionDays: 0,
    writeSyntaxTheme: "nord", requireWorkflowConfirmation: true, diffColors: "theme", compatibleRendering: "auto",
    webSearchProvider: "chatgpt", fontTipDismissed: false, tabsHintDismissed: false, proactiveCompactionThreshold: 80,
    showBuild: false, moduleSections: {}, autoInstall: false, notificationsDesktop: false,
    profiles: {}, keybindings: {}, budget: { max_invocations: 1, max_tokens: 1, max_wall_clock_minutes: 1 },
    workflow: { max_attempts: 1 },
  },
  status: { kind: "valid" }, warnings: [], diagnostics: [],
} as const
const capabilities = {
  capabilities: [], moduleIds: [], descriptorIdentity: "fixture", modules: [], warnings: [],
  requireWorkflowConfirmation: true, workflowsMode: "ask", persistentProcesses: { persisted: false, effective: false, forcedByCli: false },
} as const
const experimentView = {
  name: null, metric: { name: "duration", unit: "ms" }, secondaryMetrics: [], direction: "lower", segment: 0,
  baseline: null, best: null, confidence: null,
  runCounts: { total: 0, kept: 0, discarded: 0, crashed: 0, checksFailed: 0 }, runs: [], active: false, running: false,
} as const
const notification = {
  id: "episode-1", sourceId: "fixture", title: "Notice", message: "Message", severity: "warning",
  action: { kind: "open-auth" }, createdAt: 1, expiresAt: 2,
} as const
const remote = {
  relayUrl: "https://relay.example", connection: "off", devices: [], attachedClients: 0, pairing: null,
  lastError: null, pushPublicKey: null, projects: [], processInitiation: "on", lingerOffFor: "wes",
} as const

function workflowPatch<const P extends RuntimeUiPatchPayload>(payload: P, domain: "workflow_detail" | "workflow_view" | "workflow_live"): RuntimeUiPatch & { readonly payload: P } {
  return { cursor: { scope: "workflow", domain, workflowId: "workflow-1" }, position: 17, prevPosition: 11, payload }
}
function sessionPatch<const P extends RuntimeUiPatchPayload>(payload: P, domain: "session" | "session_detail" | "output" | "status" | "budget" | "question" | "roles" | "auth" | "changes" | "background" | "experiment_view"): RuntimeUiPatch & { readonly payload: P } {
  return { cursor: { scope: "session", domain, sessionId: "session-1" }, position: 17, prevPosition: 11, payload }
}
function workspacePatch<const P extends RuntimeUiPatchPayload>(payload: P, domain: "runtime" | "auth" | "commands" | "updates" | "modules" | "config" | "gitAiAttribution" | "git" | "commandUsage" | "chat_default" | "executor" | "service" | "definitionStaleness" | "mcp" | "papercuts" | "project_notifications" | "remote"): RuntimeUiPatch & { readonly payload: P } {
  return { cursor: { scope: "workspace", domain }, position: 17, prevPosition: 11, payload }
}

export const RUNTIME_UI_PATCH_FIXTURES = {
  "changes.changed": sessionPatch({ kind: "changes.changed" }, "changes"),
  "background.changed": sessionPatch({ kind: "background.changed" }, "background"),
  "runtime.invalidate": workspacePatch({ kind: "runtime.invalidate", reason: "rebase" }, "runtime"),
  "session.added": sessionPatch({ kind: "session.added", row: sessionRow }, "session"),
  "session.updated": sessionPatch({ kind: "session.updated", row: sessionRow }, "session"),
  "session.removed": sessionPatch({ kind: "session.removed" }, "session"),
  "session_detail.changed": sessionPatch({ kind: "session_detail.changed", row: sessionRow }, "session_detail"),
  "chat_default.changed": workspacePatch({ kind: "chat_default.changed", chatDefault: { kind: "model", model: "fixture", effort: "medium" } }, "chat_default"),
  "executor.changed": workspacePatch({ kind: "executor.changed", executor: { kind: "restarting", since: 1, cause: "stopped by signal SIGKILL" } }, "executor"),
  "service.changed": workspacePatch({ kind: "service.changed", service: { kind: "crash_loop", cause: "the hub stopped" } }, "service"),
  "output.delta": sessionPatch({ kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [{ kind: "insert", index: 0, blockId: "text-1", block: { kind: "text", id: "text-1", content: "fixture", timestamp: 1 } }] } }, "output"),
  "status.updated": sessionPatch({ kind: "status.updated", status }, "status"),
  "status.removed": sessionPatch({ kind: "status.removed" }, "status"),
  "budget.updated": sessionPatch({ kind: "budget.updated", budget: { totalsLoading: false, tokens: 1, cost: 2, billedCost: 2, priceUnavailable: false, contextPercent: 3, contextPromptTokens: 4 } }, "budget"),
  "budget.removed": sessionPatch({ kind: "budget.removed" }, "budget"),
  "workflow_detail.changed": workflowPatch({ kind: "workflow_detail.changed", view: null }, "workflow_detail"),
  "workflow_view.updated": workflowPatch({ kind: "workflow_view.updated", workflowView: { attempts: [], tree: { nodes: [] }, attemptsStatus: "loaded", state: "running" } }, "workflow_view"),
  "workflow_view.removed": workflowPatch({ kind: "workflow_view.removed" }, "workflow_view"),
  "workflow_live.changed": workflowPatch({ kind: "workflow_live.changed", agents: [{ attemptId: "attempt", sessionId: "member-1", operations: 2, activity: { name: "Read", detail: "a.ts" }, duration: 0, revision: 3 }], order: ["member-1"] }, "workflow_live"),
  "workflow_live.removed": workflowPatch({ kind: "workflow_live.removed" }, "workflow_live"),
  "question.updated": sessionPatch({ kind: "question.updated", question: { kind: "question", toolUseId: "tool-1", questions: [], timestamp: 1 } }, "question"),
  "question.removed": sessionPatch({ kind: "question.removed" }, "question"),
  "roles.updated": sessionPatch({ kind: "roles.updated", roles: { assignments: { implementer: { model: "fixture", effort: "medium" } } } }, "roles"),
  "roles.removed": sessionPatch({ kind: "roles.removed" }, "roles"),
  "auth.changed": workspacePatch({ kind: "auth.changed", auth: { providers: [], warnings: [], profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [] }, subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 0, authorityIncarnation: "fixture", authorityRevision: 0, accounts: [] } } }, "auth"),
  "commands.updated": workspacePatch({ kind: "commands.updated", catalog: { revision: 1, builtInCommands: [], offCommands: [] } }, "commands"),
  "update.changed": workspacePatch({ kind: "update.changed", update: { revision: 1, autoInstall: { persisted: false, forcedOff: false, effective: false }, status: { kind: "refused", version: "1.4.0" } } }, "updates"),
  "modules.changed": workspacePatch({ kind: "modules.changed", capabilities }, "modules"),
  "config.changed": workspacePatch({ kind: "config.changed", config }, "config"),
  "gitAiAttribution.changed": workspacePatch({ kind: "gitAiAttribution.changed", status: { kind: "checking" } }, "gitAiAttribution"),
  "git.changed": workspacePatch({ kind: "git.changed", git: { directories: { "/project": { branch: "main" } } } }, "git"),
  "commandUsage.changed": workspacePatch({ kind: "commandUsage.changed", usage: { uses: [{ name: "ship", count: 1 }] } }, "commandUsage"),
  "definitionStaleness.changed": workspacePatch({ kind: "definitionStaleness.changed", definitionStaleness: { overrides: [], diagnostics: [], reviewCount: 0 } }, "definitionStaleness"),
  "experiment_view.updated": sessionPatch({ kind: "experiment_view.updated", experimentView }, "experiment_view"),
  "experiment_view.removed": sessionPatch({ kind: "experiment_view.removed" }, "experiment_view"),
  "mcp.changed": workspacePatch({ kind: "mcp.changed", servers: [] }, "mcp"),
  "papercuts.changed": workspacePatch({ kind: "papercuts.changed", papercuts: { undisposedCount: 0 } }, "papercuts"),
  "project_notifications.raised": workspacePatch({ kind: "project_notifications.raised", episode: notification }, "project_notifications"),
  "project_notifications.resolved": workspacePatch({ kind: "project_notifications.resolved", sourceId: "fixture", episodeId: "episode-1", resolvedAt: 2 }, "project_notifications"),
  "project_notifications.dismissed": workspacePatch({ kind: "project_notifications.dismissed", sourceId: "fixture", episodeId: "episode-1", dismissedAt: 2 }, "project_notifications"),
  "remote.changed": workspacePatch({ kind: "remote.changed", remote }, "remote"),
  "side-question.changed": {
    cursor: sideQuestionCursor("session-1"), position: 17, prevPosition: 11,
    payload: { kind: "side-question.changed", view: {
      revision: 1, exchanges: [{ id: "exchange-1", question: "Question", answer: "Answer" }],
    } satisfies SideQuestionHistoryView },
  },
  "side-question-request.changed": {
    cursor: sideQuestionRequestCursor("session-1"), position: 17, prevPosition: 11,
    payload: { kind: "side-question-request.changed", view: {
      current: { id: "request-1", question: "Next question", answer: "", state: "running" },
    } },
  },
} satisfies { readonly [Kind in RuntimeUiPatchPayload["kind"]]: RuntimeUiPatch & { readonly payload: Extract<RuntimeUiPatchPayload, { readonly kind: Kind }> } }

export const runtimeUiPatchFixtures = Object.values(RUNTIME_UI_PATCH_FIXTURES)
