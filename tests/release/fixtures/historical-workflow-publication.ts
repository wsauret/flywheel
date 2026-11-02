import { contentEvidence } from "../../../src/infra/content-evidence.js"
import type { EventStoreAppend } from "../../../src/infra/event-store-types.js"

/**
 * Serializes the startup workload captured from publishWorkflow and its
 * historical writer on 2026-10-17. These versioned payloads must not follow
 * current workflow schemas: the pinned baseline must read the same workload.
 * The caller supplies the workspace path and publication wall clock.
 */
export function historicalWorkflowPublicationFacts(input: {
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly description: string
  readonly projectRoot: string
  readonly timestamp: number
  readonly completed: boolean
}): readonly EventStoreAppend[] {
  const { childSessionId, parentSessionId, description, projectRoot, timestamp, completed } = input
  const now = new Date(timestamp).toISOString()
  const toolUseId = `workflow-${childSessionId}`
  const toolInput = { workflow_definition_id: "implement", description }
  const inputPreview = JSON.stringify(toolInput)
  const evidence = contentEvidence(inputPreview)
  const child = { sessionId: childSessionId, timestamp, actor: "flywheel" }
  const workflow = { ...child, aggregateId: `workflow:${childSessionId}` }
  return [
    {
      aggregateId: `session:${parentSessionId}`, sessionId: parentSessionId, timestamp, actor: "agent",
      type: "tool.input.completed", version: 2,
      payload: {
        toolUseId, providerCallId: toolUseId, providerToolName: "workflow", toolName: "workflow",
        modelRequestId: "release-performance-fixture", input: toolInput,
        inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview,
        executionMode: "background", traceKind: "subagent", childHasOwnViewport: true,
      },
    },
    {
      ...child, aggregateId: `session:${childSessionId}`, type: "session.created", version: 3,
      payload: {
        label: description, lastUpdated: now, lifecycleState: "active", executionCwd: projectRoot,
        name: description, createdAt: now, activatedAt: now,
        launchedFrom: { parentSessionId, workflowDefinitionId: "implement", description, toolCallId: toolUseId },
        kind: "workflow", command: "workflow", workflowDefinitionId: "implement",
      },
    },
    {
      ...child, aggregateId: `session:${childSessionId}`, type: "session.roles.snapshotted", version: 4,
      payload: { roles: { defaults: {}, overrides: {} }, lastUpdated: now },
    },
    {
      ...workflow, type: "context.input.seeded", version: 1,
      payload: { workflowDefinitionId: "workflow", userRequest: description },
    },
    {
      ...workflow, type: "workflow.control.initialized", version: 11,
      payload: {
        control: {
          definitionIdentity: {
            workflowDefinitionId: "workflow", vmVersion: "2", skills: [], personas: [],
            graphSha256: "64bb1d9bb181c19153b3bc8e224b38df9fc2390689d9ca1f89f75495d5d5390f",
            steps: [{
              stepId: "work",
              policySha256: "640c88d9bd2dceb473cbd747da094789ab34d9638829ee664438e296d1ff9241",
              contentSha256: "61bc74f190fb51ba7f05671046134025467448e71ec415338b943f99aab77b14",
              outputSha256: "f35cd02cd97b67077a86f78eb15ec16044957e3420ff5787bcf1b5a715f40d06",
            }],
          },
          workflowName: "Workflow",
          graph: {
            nodes: [{
              kind: "agent", id: "workflow:node:1", workflowDefinitionId: "workflow", order: 0,
              ownership: { _tag: "workflow", workflowDefinitionId: "workflow" }, state: { _tag: "ready" },
              definitionId: "work", name: "Work", retry: null, condition: null,
            }],
            dependencies: [], joins: [],
          },
          attempts: [{
            id: "workflow:node:1:attempt:1", logicalNodeId: "workflow:node:1",
            workflowDefinitionId: "workflow", definitionId: "work", sequence: 1, iteration: 1,
            resumeRevertCount: 0, provenance: { _tag: "authored" },
            ownership: { _tag: "workflow", workflowDefinitionId: "workflow" },
            state: { _tag: "pending" }, parentAttemptId: null, conversationId: null,
            handoff: null, priorRetryFeedback: null, item: null,
          }],
          frontier: completed ? [] : ["workflow:node:1"],
          guardrails: {
            maxAttempts: 50, maxMutationsPerAttempt: 3, maxInserts: 20, insertsUsed: 0,
            attemptMutationsUsed: [{ attemptId: "workflow:node:1:attempt:1", used: 0 }],
          },
          status: completed ? "completed" : "ready", followUp: null, aggregateSeq: 4,
        },
      },
    },
    {
      ...workflow, type: "queue.created", version: 10,
      payload: {
        rows: {
          attempts: [{
            id: "workflow:node:1:attempt:1", definitionId: "work", briefId: "work",
            workflowDefinitionId: "workflow", name: "Work", status: completed ? "completed" : "pending",
            description: "Use when the task is about work.", writes: [], resumeRevertCount: 0,
          }],
          cursor: 0, status: completed ? "completed" : "idle", mutationLog: [], maxAttempts: 50,
        },
      },
    },
    {
      ...workflow, type: "queue.tree.changed", version: 4,
      payload: {
        tree: {
          nodes: [
            {
              id: "workflow:node:1:phase", label: "Work", parentId: null, disposition: "pending",
              kind: "phase", form: "single", phaseId: "work",
            },
            {
              id: "workflow:node:1", label: "Work", parentId: "workflow:node:1:phase",
              disposition: "pending", kind: "agent", definitionId: "work", attempts: 1,
              currentAttemptId: "workflow:node:1:attempt:1",
            },
          ],
          currentAgentNodeId: "workflow:node:1",
        },
      },
    },
    {
      aggregateId: `session:${parentSessionId}`, sessionId: parentSessionId, timestamp, actor: "flywheel",
      type: "session.child.linked", version: 1,
      payload: { childSessionId, lastUpdated: now },
    },
  ]
}
