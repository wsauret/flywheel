import type { FrontendOutputBlock, SessionRow } from "../../src/protocol/app-service-types.js"
import type { ProcessStatus } from "../../src/protocol/client/transcript-model.js"
import type { RuntimeModulesView } from "../../src/protocol/module-protocol-types.js"
import type { WorkflowDetail } from "../../src/protocol/modules/workflows.js"
import type { RuntimeConfigValues, RuntimeConfigView } from "../../src/protocol/runtime-config-protocol-types.js"
import type { RuntimeSessionDetailView } from "../../src/protocol/session-detail-protocol-types.js"
import type { StatusView } from "../../src/protocol/status-protocol-types.js"
import type { OutputWindowSnapshot } from "../../src/protocol/transcript-protocol-types.js"

/** A session's status with `activity` and nothing else running. */
export function statusView(activity: StatusView["activity"] = "idle"): StatusView {
  return {
    activity, activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0,
    waitingOnBackgroundWork: false, replyWaits: [], activeBackgroundCommands: [], activeForegroundBashToolCallIds: [],
    processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null,
  }
}

/** The live process status a transcript row reads, with the calls that the
 *  foreground holds, the background manages, and the processor makes wait. */
export function processStatus(calls: { readonly held?: Iterable<string> | undefined; readonly managed?: Iterable<string> | undefined; readonly processorHeld?: Iterable<string> | undefined } = {}): ProcessStatus {
  return {
    activeForegroundBashToolCallIds: [...(calls.held ?? [])],
    activeBackgroundCommands: [...(calls.managed ?? [])].map((toolUseId) => ({ id: `process-${toolUseId}`, description: "Shell", toolUseId, startedAtMs: 0 })),
    processorHeldToolCallIds: [...(calls.processorHeld ?? [])],
  }
}

/** The detail a `sessionDetailSnapshot` read answers for `row`: its durable
 *  history in `conversationId`, with no budget read yet. */
export function detailView(row: SessionRow, conversationId = `conversation-${row.id}`): RuntimeSessionDetailView {
  const base = { source: "durable", id: row.id, conversationId, status: statusView(row.activity), budget: null } as const
  if (row.kind === "chat") return { ...base, kind: "chat", row }
  if (row.kind === "subagent") return { ...base, kind: "subagent", row }
  return { ...base, kind: "workflow-agent", row }
}

/** A valid workspace configuration at its defaults, with `values` in place of their own. */
export function configView(values: Partial<RuntimeConfigValues> = {}): RuntimeConfigView {
  return {
    revision: 1,
    values: {
      moduleSelection: [], allowPersistentProcesses: false, foregroundBashHoldSeconds: 0, showThinking: true, idleCompaction: true, shellWriteGuard: true,
      writeSyntaxTheme: "nord", requireWorkflowConfirmation: true, diffColors: "theme", compatibleRendering: "auto", webSearchProvider: "chatgpt",
      fontTipDismissed: false, tabsHintDismissed: false, proactiveCompactionThreshold: 0, autoDeleteSessionDays: 0, showBuild: false,
      moduleSections: {}, autoInstall: false, notificationsDesktop: false, profiles: {}, keybindings: {},
      budget: { max_invocations: 1, max_tokens: 1, max_wall_clock_minutes: 1 }, workflow: { max_attempts: 1 },
      ...values,
    },
    status: { kind: "valid" }, warnings: [], diagnostics: [],
  }
}

/** A readable workflow run launched from chat `parent`, with no usage yet. */
export function workflowDetail(overrides: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    workflowId: "child", title: "Run Workflow With Supplied Input", workflowDefinitionId: "test",
    createdAt: "", lastUpdated: "", executionCwd: "/repo", roleAssignments: { defaults: {}, overrides: {} },
    launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "launch" },
    auth: null, readability: "readable", admittedActions: ["workflow.send", "workflow.interrupt"],
    totals: { totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalInputTokens: 0, totalOutputTokens: 0 },
    policyUsage: { totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalInputTokens: 0, totalOutputTokens: 0 },
    attribution: "available", durationMs: 0, streamingStartedAt: null, activeIntervals: [], totalsLoading: false, ...overrides,
  }
}

/** The capabilities of an account that selected no optional module. */
export function modulesView(): RuntimeModulesView {
  return {
    capabilities: [], moduleIds: [], descriptorIdentity: "fixture", modules: [], warnings: [], requireWorkflowConfirmation: true,
    workflowsMode: "ask", persistentProcesses: { persisted: false, effective: false, forcedByCli: false },
  }
}

/** The tail window an `outputWindow` read answers: `blocks` as the newest
 *  blocks of the transcript, with older ones before them when `hasBefore`. */
export function tailWindow(blocks: readonly FrontendOutputBlock[], options: { readonly snapshotPosition?: number; readonly startBlockIndex?: number; readonly consistencyToken?: string } = {}): OutputWindowSnapshot {
  const { snapshotPosition = 0, startBlockIndex = 0, consistencyToken = "fixture" } = options
  return {
    snapshotPosition, totalBlocks: startBlockIndex + blocks.length, visibleMessageCount: blocks.length,
    range: {
      kind: "ok", consistencyToken, anchor: { kind: "tail" }, streamingToolText: {}, streamingOutputChars: 0, blocks,
      window: { startBlockIndex, endBlockIndex: startBlockIndex + blocks.length - 1, hasBefore: startBlockIndex > 0, hasAfter: false, contentBytes: 0 },
    },
  }
}
