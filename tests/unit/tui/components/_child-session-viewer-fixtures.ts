import type { SessionSurface } from "../../../../src/tui/hooks/create-session-surface.js"
import type { WorkflowCards } from "../../../../src/tui/modules/workflows/cards.js"
import { transcriptOf } from "../_output-window-transcript.js"
import type { ChildSessionBodyProps } from "../../../../src/tui/components/child-session-body.js"

/** Workflow cards for viewers that show no workflow card. */
export const noWorkflowCards: WorkflowCards = {
  follow: () => ({ release: () => {} }), view: () => undefined, live: () => [], hold: () => ({ release: () => {} }), row: () => undefined,
  choices: () => undefined, choose: () => {}, interrupt: () => {}, resume: () => {}, restart: () => {}, openAgent: () => {},
  roleView: () => undefined, ensureRoleViews: () => {},
}


export function viewerSurface(kind: "subagent" | "workflow-agent", overrides: Partial<SessionSurface> = {}): SessionSurface {
  return {
    sessionId: () => "child",
    summary: () => ({
      id: "child", title: "Child", lifecycleState: "active", notices: [], lastUpdated: "", executionCwd: "/repo",
      parentSessionId: "parent", parentToolUseId: "tool-7",
      ...(kind === "subagent"
        ? { kind: "subagent" as const, inputMode: { kind: "message" as const }, admittedActions: ["session.send" as const] }
        : { kind: "workflow-agent" as const, workflowMembership: { kind: "attempt" as const, workflowId: "workflow", attemptId: "agent-1" }, inputMode: { kind: "message" as const }, admittedActions: ["session.send" as const] }),
      totalsLoading: false, totalCost: 0, totalBilledCost: 0, priceUnavailable: false,
      totalTokens: 0, contextPercent: 0, contextPromptTokens: 0, durationMs: 0,
    }),
    detail: () => null, loadResult: () => undefined, transcript: transcriptOf([]), outputView: () => undefined,
    status: () => undefined, budget: () => undefined,
    pendingQuestion: () => undefined, streamingToolText: () => ({}), streamingOutputChars: () => 0,
    agentState: () => "idle", interruptible: () => false, activeSubagentCount: () => 0, waitingOnBackgroundWork: () => false,
    activeBackgroundCommands: () => [], sessionKind: () => kind, sessionState: () => "active",
    elapsed: () => 0, pageOutput: () => {},
    ...overrides,
  }
}

export function childBodyProps(): Pick<ChildSessionBodyProps, "layoutSlot" | "createProcessControls" | "sessionIntro" | "showThinking" | "diffColors" | "roleView" | "childStatus" | "ensureChildViews" | "modelLabel" | "onOpenModel" | "transcriptInView" | "onOpenBackground"> {
  return {
    layoutSlot: {},
    createProcessControls: () => ({ activeHeldToolCallIds: () => new Set(), processorHeldToolCallIds: () => new Set(), activeManagedProcessToolCallIds: () => new Set(), onDetach: () => {}, onStop: () => {} }),
    sessionIntro: { runtimeIdentity: () => ({ version: "test", buildId: null }), showBuild: () => false, projectRoot: () => "/repo", accountHome: "/home", userDataRoot: "/home/.flywheel",
      branchName: () => undefined, modelLabel: () => undefined, profileName: () => undefined,
      fontTipDismissed: () => true, tabsHintDismissed: () => true, onDismissTabsHint: () => {}, moduleRows: () => [] },
    showThinking: false, diffColors: () => "theme", roleView: () => undefined, childStatus: () => ({ waitingOn: undefined }), ensureChildViews: () => {},
    modelLabel: () => undefined, onOpenModel: () => {}, transcriptInView: { show: () => {} }, onOpenBackground: () => {},
  }
}
