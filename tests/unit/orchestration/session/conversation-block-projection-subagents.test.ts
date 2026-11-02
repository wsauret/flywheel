import { formatAgentFailureDisplay } from "../../../../src/infra/output/output-formatter.js"
import { describe, expect, it } from "bun:test"

import type { MessageEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { projectBlocksFromEntries, TreeBlockProjection } from "../../../../src/orchestration/session/conversation/conversation-block-projection"
import { formatToolInputProblems } from "../../../../src/orchestration/agent-runtime/tools/validate-input"
import type { ToolHistorySummary } from "../../../../src/orchestration/module-seams"

const CWD = "/scratch/project"
const T0 = "2026-07-02T10:00:00.000Z"

let seq = 0
function entry(message: MessageEntry["message"], overrides: Partial<MessageEntry> = {}): MessageEntry {
  seq += 1
  return { id: `e${seq}`, parentId: seq === 1 ? null : `e${seq - 1}`, timestamp: T0, kind: "message", message, ...overrides }
}

describe("subagent conversation block reconstruction", () => {
  it.each(["completed", "partial"] as const)("replays a %s dispatch's selected handoff summary", (status) => {
    const assistant = entry({ kind: "assistant", content: [{ type: "tool_use", id: "dispatch", name: "subagent", input: { persona: "explorer", description: "Trace" } }] })
    const result = entry({ kind: "toolResult", toolUseId: "dispatch", content: [{ type: "text", text: JSON.stringify({ summary: "**Fixed** the issue. Tests pass." }) }] })
    const [block] = projectBlocksFromEntries([assistant, result], { executionCwd: CWD, toolSummaries: new Map([["dispatch", {
      toolUseId: "dispatch", status, ownsSettlement: true, totalToolCount: 1, summary: "Fixed the issue",
    }]]) })
    expect(block).toMatchObject({ kind: "agentGroup", status, summary: "Fixed the issue" })
  })

  it("reconstructs a control row with the target run goal", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_steer",
        name: "subagent",
        input: { kind: "steer", session_id: "child-session", message: "Focus on tests", display_goal: "Invented name" },
      }],
    })
    const result = entry({ kind: "toolResult", toolUseId: "toolu_steer", content: [{ type: "text", text: "{\"status\":\"accepted\"}" }] })
    const [block] = projectBlocksFromEntries([assistant, result], {
      executionCwd: CWD,
      toolSummaries: new Map([["toolu_dispatch", {
        toolUseId: "toolu_dispatch",
        status: "completed",
        ownsSettlement: true,
        totalToolCount: 1,
        linkUri: "flywheel://session/child-session",
        description: "Review provider settings",
      }]]),
    })

    expect(block).toMatchObject({
      kind: "tool",
      presentation: { name: "Subagent steer", detail: "Review provider settings" },
      status: "completed",
    })
  })

  it("shows a parent's process resume as its child's card, its interrupt and stop as rows that name the child, and hides its reads and a recorded stop of a command", () => {
    const projection = new TreeBlockProjection({ executionCwd: CWD, toolSummaries: new Map([["dispatch", {
      toolUseId: "dispatch", status: "active", ownsSettlement: true, totalToolCount: 3, agentType: "reviewer",
      linkUri: "flywheel://session/c0ffee000001", description: "Trace repaint",
    }]]) })
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "dispatch", name: "subagent", input: { description: "Trace repaint", persona: "reviewer" } }] }))
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "list", name: "process", input: { action: "list" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "list", content: [{ type: "text", text: "Children that you started" }] }))
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "status", name: "process", input: { action: "status", process_id: "c0ffee000001" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "status", content: [{ type: "text", text: "child | running | subagent | Trace repaint" }] }))
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "interrupt", name: "process", input: { action: "interrupt", process_id: "c0ffee000001" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "interrupt", content: [{ type: "text", text: "Interrupted" }] }))
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "resume", name: "process", input: { action: "resume", process_id: "c0ffee000001" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "resume", content: [{ type: "text", text: "{\"status\":\"resumed\"}" }] }))
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "stop", name: "process", input: { action: "stop", process_id: "c0ffee000001" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "stop", content: [{ type: "text", text: "Stopped" }] }))
    // History holds stops of commands from before children were processes.
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "command-stop", name: "process", input: { action: "stop", process_id: "bash-bg-1" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "command-stop", content: [{ type: "text", text: "Stopped" }] }))
    expect(projection.snapshot()).toMatchObject([
      { kind: "agentGroup", id: "dispatch", label: "Reviewer", status: "interrupted" },
      { kind: "tool", id: "interrupt", presentation: { name: "Interrupt", detail: "Trace repaint" }, status: "completed" },
      { kind: "agentGroup", id: "resume", label: "Reviewer resume", description: "Trace repaint", totalToolCount: 3, status: "active" },
      { kind: "tool", id: "stop", presentation: { name: "Stop", detail: "Trace repaint" }, status: "completed" },
    ])
  })

  // Previous call shape: `subagent` retried and resumed a child before
  // `process` resumed it. Recorded calls keep their cards. Remove these
  // readers and their tests after 2027-04-08.
  it.each([
    "active",
    "completed",
    "cancelled",
    "stopped",
    "partial",
    "paused",
    "error",
  ] as const)("shows a retry as a full subagent row in its new run's %s state", (status) => {
    const state = status === "error" ? { status, failure: formatAgentFailureDisplay("Provider failed") }
      : status === "paused" ? { status, pausedBy: "person" as const }
      : { status };
    const assistant = entry({
      kind: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_retry",
        name: "subagent",
        input: { kind: "retry", session_id: "old-child-session" },
      }],
    })
    const launch = entry({ kind: "toolResult", toolUseId: "toolu_retry", content: [{ type: "text", text: "{\"status\":\"running\"}" }] })
    const [block] = projectBlocksFromEntries([assistant, launch], {
      executionCwd: CWD,
      toolSummaries: new Map<string, ToolHistorySummary>([
        ["toolu_dispatch", {
          toolUseId: "toolu_dispatch",
          status: "error",
          ownsSettlement: false,
          totalToolCount: 2,
          linkUri: "flywheel://session/old-child-session",
          description: "Review provider settings",
          failure: formatAgentFailureDisplay("Provider failed"),
        }],
        ["toolu_retry", {
          toolUseId: "toolu_retry",
          ...state,
          ownsSettlement: status !== "error",
          agentType: "reviewer",
          model: "gpt-6 high",
          totalToolCount: 5,
          totalTokens: 900,
          duration: 7000,
          linkUri: "flywheel://session/old-child-session",
          description: "Review provider settings",
        }],
      ]),
    })

    expect(block).toMatchObject({
      kind: "agentGroup",
      id: "toolu_retry",
      label: "Reviewer retry",
      agentType: "reviewer",
      description: "Review provider settings",
      model: "gpt-6 high",
      totalToolCount: 5,
      totalTokens: 900,
      duration: 7000,
      status,
      linkUri: "flywheel://session/old-child-session",
    })
  })

  it("shows an accepted resume as a full row of the target's latest run and a rejected one as its own error", () => {
    const projection = new TreeBlockProjection({ executionCwd: CWD, toolSummaries: new Map([["dispatch", {
      toolUseId: "dispatch", status: "active", ownsSettlement: true, totalToolCount: 3, agentType: "reviewer",
      linkUri: "flywheel://session/child", description: "Trace repaint",
    }]]) })
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "dispatch", name: "subagent", input: { kind: "dispatch", description: "Trace repaint", persona: "reviewer" } }] }))
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "resume", name: "subagent", input: { kind: "resume", session_id: "child" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "resume", content: [{ type: "text", text: "{\"status\":\"resumed\"}" }] }))
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "rejected", name: "subagent", input: { kind: "resume", session_id: "child" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "rejected", isError: true, content: [{ type: "text", text: "Subagent is already running" }] }))
    expect(projection.snapshot()).toMatchObject([
      { kind: "agentGroup", id: "dispatch", label: "Reviewer", totalToolCount: 3, status: "interrupted" },
      { kind: "agentGroup", id: "resume", label: "Reviewer resume", description: "Trace repaint", totalToolCount: 3, status: "active" },
      { kind: "tool", id: "rejected", status: "error", errorMessage: "Subagent is already running" },
    ])
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "resume-again", name: "subagent", input: { kind: "resume", session_id: "child" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "resume-again", content: [{ type: "text", text: "{\"status\":\"resumed\"}" }] }))
    expect(projection.snapshot()).toMatchObject([
      { id: "dispatch", totalToolCount: 3, status: "interrupted" },
      { id: "resume", totalToolCount: 3, status: "interrupted" },
      { id: "rejected", status: "error" },
      { id: "resume-again", totalToolCount: 3, status: "active" },
    ])
    projection.updateToolSummary({ toolUseId: "dispatch", status: "completed", ownsSettlement: true, totalToolCount: 4, agentType: "reviewer", linkUri: "flywheel://session/child", description: "Trace repaint" })
    expect(projection.snapshot()).toMatchObject([
      { id: "dispatch", totalToolCount: 4, status: "interrupted" },
      { id: "resume", totalToolCount: 4, status: "interrupted" },
      { id: "rejected", status: "error" },
      { id: "resume-again", totalToolCount: 4, status: "completed" },
    ])
    projection.updateToolSummary({ toolUseId: "dispatch", status: "error", failure: { title: "Subagent failed", message: "Provider failed", guidance: "Retry it" }, ownsSettlement: false, totalToolCount: 4, agentType: "reviewer", linkUri: "flywheel://session/child", description: "Trace repaint" })
    const [, earlierResume, , owner] = projection.snapshot()
    if (earlierResume?.kind !== "agentGroup" || owner?.kind !== "agentGroup") throw new Error("expected resume cards")
    expect(projection.toolBlockReader(earlierResume).read(undefined)).toMatchObject({ id: "resume", status: "interrupted" })
    expect(projection.toolBlockReader(owner).read(undefined)).toMatchObject({ id: "resume-again", status: "error" })
  })

  it.each([false, true])("keeps a steer outcome (rejected=%s) separate from its child's state", (rejected) => {
    const childStatus = rejected ? "completed" as const : "active" as const
    const projection = new TreeBlockProjection({ executionCwd: CWD, toolSummaries: new Map([["dispatch", {
      toolUseId: "dispatch", status: childStatus, ownsSettlement: true, totalToolCount: 0,
      linkUri: "flywheel://session/child", description: "Trace terminal repaint regression",
    }]]) })
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "dispatch", name: "subagent", input: { kind: "dispatch", description: "Trace terminal repaint regression" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "dispatch", content: [{ type: "text", text: "Started" }] }))
    const child = projection.snapshot()[0]
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "steer", name: "subagent", input: { kind: "steer", session_id: "child", display_goal: "Invented" } }] }))
    projection.add(entry({ kind: "toolResult", toolUseId: "steer", isError: rejected, content: [{ type: "text", text: rejected ? "Cannot steer this subagent because it has already settled." : '{"status":"accepted","parked":false}' }] }))
    expect(projection.snapshot()[0]).toBe(child)
    expect(child).toMatchObject({ status: childStatus })
    expect(projection.snapshot()[1]).toMatchObject({
      kind: "tool", presentation: { name: "Subagent steer", detail: "Trace terminal repaint regression" }, status: rejected ? "error" : "completed",
      ...(rejected ? { errorMessage: "Cannot steer this subagent because it has already settled" } : {}),
    })
  })

  it("refreshes indexed target summaries without changing control order", () => {
    const projection = new TreeBlockProjection({ executionCwd: CWD })
    projection.add(entry({ kind: "assistant", content: [{ type: "tool_use", id: "steer", name: "subagent", input: { kind: "steer", session_id: "child", display_goal: "Invented" } }] }))
    expect(projection.snapshot()[0]).toMatchObject({ presentation: { name: "Subagent steer", detail: "" } })
    projection.updateToolSummary({ toolUseId: "dispatch", status: "active", ownsSettlement: true, totalToolCount: 0, linkUri: "flywheel://session/child", description: "Recorded goal" })
    expect(projection.snapshot()[0]).toMatchObject({ id: "steer", presentation: { name: "Subagent steer", detail: "Recorded goal" } })
    projection.updateToolSummary({ toolUseId: "dispatch", status: "completed", ownsSettlement: true, totalToolCount: 0, linkUri: "flywheel://session/child", description: "Updated recorded goal" })
    expect(projection.snapshot()[0]).toMatchObject({ id: "steer", presentation: { name: "Subagent steer", detail: "Updated recorded goal" } })
  })

  it("shows a rejected retry's own error without owning the previous run", () => {
    const blocks = projectBlocksFromEntries([
      entry({ kind: "assistant", content: [{ type: "tool_use", id: "retry", name: "subagent", input: { kind: "retry", session_id: "missing", display_goal: "Invented" } }] }),
      entry({ kind: "toolResult", toolUseId: "retry", isError: true, content: [{ type: "text", text: "Subagent session was not found" }] }),
    ], { executionCwd: CWD })
    expect(blocks).toMatchObject([{ kind: "tool", status: "error", errorMessage: "Subagent session was not found", presentation: { name: "Subagent retry", detail: "" } }])
  })

  it("reconstructs a completed subagent shell without loading its operation rows", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_subagent",
        name: "subagent",
        input: { persona: "reviewer-elegance", description: "Locate runtime UI command seam" },
      }],
    })
    const result = entry({ kind: "toolResult", toolUseId: "toolu_subagent", content: [{ type: "text", text: "done" }] })
    const blocks = projectBlocksFromEntries([assistant, result], {
      executionCwd: CWD,
      toolSummaries: new Map([["toolu_subagent", {
        toolUseId: "toolu_subagent",
        status: "completed",
        ownsSettlement: true,
        linkUri: "flywheel://session/child-session",
        model: "gpt-6-luna medium",
        duration: 41_900,
        totalTokens: 37_100,
        totalToolCount: 44,
      }]]),
    })

    expect(blocks).toEqual([{
      kind: "agentGroup",
      containerKind: "subagent",
      id: "toolu_subagent",
      toolUseId: "toolu_subagent",
      label: "Reviewer Elegance",
      description: "Locate runtime UI command seam",
      agentType: "reviewer-elegance",
      sentence: { name: "Dispatched", detail: "reviewer-elegance" },
      status: "completed",
      children: [],
      totalToolCount: 44,
      totalTokens: 37_100,
      duration: 41_900,
      model: "gpt-6-luna medium",
      linkUri: "flywheel://session/child-session",
      timestamp: Date.parse(T0),
    }])
  })

  it("reconstructs an actionable failed subagent from the exact durable result", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_failed_subagent",
        name: "subagent",
        input: { persona: "reviewer-code-design", description: "Review provider settings UX" },
      }],
    })
    const failureText =
      "Subagent 'reviewer-code-design' (Review provider settings UX) failed: Out of credits: 402 This request requires more credits, or fewer max_tokens. " +
      "You requested up to 128000 tokens, but can only afford 124062. To increase, visit https://openrouter.ai/settings/credits and add more credits. " +
      "The runner exited before producing a result; either retry with a tighter scope, do the work directly."
    const result = entry({ kind: "toolResult", toolUseId: "toolu_failed_subagent", content: [{ type: "text", text: failureText }], isError: true })
    const [block] = projectBlocksFromEntries([assistant, result], {
      executionCwd: CWD,
      toolSummaries: new Map([["toolu_failed_subagent", {
        toolUseId: "toolu_failed_subagent",
        status: "error",
        ownsSettlement: false,
        totalToolCount: 0,
        model: "claude-fable-5.1",
        failure: formatAgentFailureDisplay("Subagent 'reviewer-code-design' (Review provider settings UX) failed: Out of credits..."),
      }]]),
    })

    expect(block).toMatchObject({
      kind: "agentGroup",
      status: "error",
      failure: {
        title: "Out of credits",
        message: "OpenRouter could not fund the requested 128,000-token output limit.",
      },
    })
    if (block?.kind !== "agentGroup" || block.status !== "error") return
    expect(block.failure.guidance).toContain("/model")
    expect(block.failure.detail).toContain("124,062")
  })

  it("reconstructs a non-API provider failure from durable result metadata", () => {
    const toolUseId = "toolu_stalled_subagent"
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "subagent", input: { persona: "reviewer-code-quality", description: "Review code" } }],
    })
    const result = entry({ kind: "toolResult", toolUseId, content: [{ type: "text", text: "Subagent failed after a provider timeout." }], isError: true })
    const failure = {
      title: "Model response stalled",
      message: "The model stopped sending progress while composing its response.",
      guidance: "Send a message to retry, or switch models with /model.",
      detail: "The stream stopped for 120 seconds.",
      action: { label: "Switch models", command: "/model" },
    }
    const [block] = projectBlocksFromEntries([assistant, result], {
      executionCwd: CWD,
      toolResultMeta: new Map([[toolUseId, { agentFailure: failure }]]),
      toolSummaries: new Map([[toolUseId, {
        toolUseId,
        status: "error",
        ownsSettlement: false,
        totalToolCount: 0,
        model: "claude-fable-5.1",
        failure: formatAgentFailureDisplay("Subagent failed after a provider timeout."),
      }]]),
    })

    expect(block).toMatchObject({ kind: "agentGroup", status: "error", failure })
  })

  it("reconstructs raw failure evidence when durable display metadata is blank", () => {
    const toolUseId = "toolu_invalid_subagent"
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "subagent", input: { persona: "reviewer-code-quality", description: "Review code" } }],
    })
    const result = entry({
      kind: "toolResult",
      toolUseId,
      content: [{ type: "text", text: formatToolInputProblems("subagent", ["The required parameter `kind` is missing"]) }],
      isError: true,
    })
    const [block] = projectBlocksFromEntries([assistant, result], {
      executionCwd: CWD,
      toolResultMeta: new Map([[toolUseId, {
        agentFailure: {
          title: "Subagent failed",
          message: "",
          guidance: "Send a message to retry. If it fails again, run /model.",
        },
      }]]),
    })

    expect(block).toMatchObject({
      kind: "agentGroup",
      status: "error",
      failure: {
        message: "Invalid input: The required parameter `kind` is missing",
        guidance: "Correct the tool input and retry.",
      },
    })
  })

  it.each([
    ["interrupted", "interrupted"],
    ["cancelled", "cancelled"],
  ] as const)("reconstructs a %s subagent as %s after its launch acknowledgement", (status, expected) => {
    const assistant = entry({
      kind: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_interrupted",
        name: "subagent",
        input: { persona: "reviewer-elegance", description: "Locate runtime UI command seam" },
      }],
    })
    const launchAck = entry({
      kind: "toolResult",
      toolUseId: "toolu_interrupted",
      content: [{ type: "text", text: '{"status":"running","result_available":false}' }],
    })
    const blocks = projectBlocksFromEntries([assistant, launchAck], {
      executionCwd: CWD,
      toolSummaries: new Map([["toolu_interrupted", {
        toolUseId: "toolu_interrupted",
        status,
        ownsSettlement: true,
        totalToolCount: 0,
        model: "gpt-test",
      }]]),
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe("agentGroup")
    if (blocks[0]?.kind === "agentGroup") expect(blocks[0].status).toBe(expected)
  })
})
