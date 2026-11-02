import { describe, expect, it } from "bun:test"
import { buildMutationDiff } from "../../../../src/infra/mutation-diff"
import { buildMutationDiffEvidence } from "../../../../src/infra/mutation-diff-evidence.js"
import { createRecordingFileMutationStore } from "../agent-runtime/tools/_fixtures.js"
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection"
import type { MessageEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { formatAgentFailureDisplay } from "../../../../src/infra/output/output-formatter"
import type { ToolHistorySummary } from "../../../../src/orchestration/module-seams"

const CWD = "/scratch/project"
const T0 = "2026-07-02T10:00:00.000Z"
let seq = 0

function entry(message: MessageEntry["message"]): MessageEntry {
  seq += 1
  return { id: `e${seq}`, parentId: seq === 1 ? null : `e${seq - 1}`, timestamp: T0, kind: "message", message }
}

describe("tree -> output blocks failed file changes", () => {
  it("replays failed file changes without unverified bodies while retaining canonical mutation evidence", async () => {
    const assistant = entry({
      kind: "assistant",
      content: [{
        type: "tool_use",
        id: "failed-write",
        name: "write",
        input: { path: "src/a.ts", content: "unverified body" },
      }],
    })
    const result = entry({
      kind: "toolResult",
      toolUseId: "failed-write",
      content: [{ type: "text", text: "write failed" }],
      isError: true,
    })
    const mutationEvidence = await buildMutationDiffEvidence(buildMutationDiff([{
      path: "src/other.ts",
      before: { kind: "text", text: "old" },
      after: { kind: "text", text: "new" },
    }]), "mutation", createRecordingFileMutationStore().writer.stageSessionContentNodes)
    const [block] = projectBlocksFromEntries([assistant, result], {
      executionCwd: CWD,
      toolResultMeta: new Map([["failed-write", {
        mutationEvidence,
        diff: "legacy diff",
        filetype: "typescript",
        displayContent: "legacy content",
      }]]),
    })

    expect(block).toMatchObject({
      kind: "tool",
      status: "error",
      errorMessage: "Write failed",
      fileChangeKind: "create",
      mutationEvidence,
    })
    expect(block).not.toHaveProperty("proposedDiff")
    expect(block).not.toHaveProperty("invocationBody")
    expect(block).not.toHaveProperty("diff")
    expect(block).not.toHaveProperty("content")
    expect(block).not.toHaveProperty("filetype")
  })
})

describe("tree -> output blocks failed workflow runs", () => {
  // A run that fails delivers its completion as the call's ok result, so the
  // card states the run's own failure, which a Resume can continue, and a
  // resumed run reads as running again.
  it("settles a workflow card by its run state, not by the call's ok result", () => {
    const assistant = entry({ kind: "assistant", content: [{ type: "tool_use", id: "workflow-1", name: "workflow", input: { workflow_definition_id: "implement", description: "Do it" } }] })
    const acknowledgement = entry({ kind: "toolResult", toolUseId: "workflow-1", content: [{ type: "text", text: "Workflow started; the terminal result will update this row." }] })
    const base = { toolUseId: "workflow-1", ownsSettlement: false, totalToolCount: 3, duration: 5000 }
    const settledAs = (summary: ToolHistorySummary) => projectBlocksFromEntries([assistant, acknowledgement], {
      executionCwd: CWD,
      toolResultMeta: new Map([["workflow-1", { terminalOutcome: "ok", displayContent: "Workflow failed." }]]),
      toolSummaries: new Map([["workflow-1", summary]]),
    })[0]

    expect(settledAs({ ...base, status: "error", failure: formatAgentFailureDisplay("Workflow failed") })).toMatchObject({ kind: "agentGroup", status: "error", failure: formatAgentFailureDisplay("Workflow failed"), duration: 5000 })
    expect(settledAs({ ...base, status: "active" })).toMatchObject({ kind: "agentGroup", status: "active" })
  })
})
