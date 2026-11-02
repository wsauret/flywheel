import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import type { WorkflowControllerDeps } from "../../../../src/orchestration/workflow-host/controller.js"

/** Seeds the model's launching call with the production workflow tool's identity. */
export async function seedModelWorkflowCall(deps: Pick<WorkflowControllerDeps, "eventWriter">, parentSessionId: string, toolUseId: string, description: string) {
  const input = { source: { kind: "path", path: "scratch/workflows/repair.workflow.yaml" }, description, summary: description }
  const evidence = contentEvidence(JSON.stringify(input))
  await deps.eventWriter.append({
    aggregateId: `session:${parentSessionId}`, sessionId: parentSessionId, type: "tool.input.completed", version: 2, actor: "agent", timestamp: Date.now(),
    payload: {
      toolUseId, providerCallId: "provider-launch", providerToolName: "workflow", toolName: "workflow", modelRequestId: "launch-request",
      input, inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview, executionMode: "background", traceKind: "subagent", childHasOwnViewport: true,
    },
  })
}
