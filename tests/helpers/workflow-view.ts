import type { WorkflowTree, WorkflowTreeNode } from "../../src/protocol/workflow-view-protocol-types.js"
import type { AttemptRow } from "../../src/workflows/view/types.js"

/** A current view of plain agents, each a single phase of its own, for
 *  fixtures that do not exercise compilation or historical conversion. */
export function plainAgentTree(attempts: readonly Pick<AttemptRow, "id" | "definitionId" | "name" | "status">[]): WorkflowTree {
  return { nodes: attempts.flatMap((attempt): WorkflowTreeNode[] => {
    const disposition = attempt.status === "blocked" ? "skipped" : attempt.status
    return [
      { id: `${attempt.id}:phase`, kind: "phase", form: "single", phaseId: attempt.definitionId, label: attempt.name, parentId: null, disposition },
      { id: attempt.id, kind: "agent", definitionId: attempt.definitionId, label: attempt.name, parentId: `${attempt.id}:phase`, disposition, attempts: 1, currentAttemptId: attempt.id },
    ]
  }) }
}
