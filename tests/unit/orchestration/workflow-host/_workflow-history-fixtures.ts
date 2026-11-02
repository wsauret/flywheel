import type { WorkflowView, AttemptRow } from "../../../../src/workflows/view/types"
import { plainAgentTree } from "../../../helpers/workflow-view"

export const T0 = "2026-07-02T10:00:00.000Z"

export function step(id: string, patch: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id,
    definitionId: id,
    briefId: id,
    workflowDefinitionId: "wf",
    name: id === "s1" ? "Step One" : "Step Two",
    status: "completed",
    writes: [],
    resumeRevertCount: 0,
    ...patch,
  }
}

export function queue(): WorkflowView {
  const attempts = [step("s1", { lastConversationId: "conv-s1" })]
  return {
    attempts,
    tree: plainAgentTree(attempts),
    cursor: 1,
    status: "completed",
    mutationLog: [{ timestamp: Date.parse(T0), action: "status-change", actor: "flywheel", reason: "completed", attemptIds: ["s1"] }],
    followUpConversationId: "conv-follow",
  }
}
