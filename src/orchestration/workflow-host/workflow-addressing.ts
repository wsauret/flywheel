import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { resolveWorkflowAgentTarget, resolveWorkflowTargets, workflowAddressLines, workflowTargetRefusal, type WorkflowAddress, type WorkflowTargetResolution } from "../../protocol/client/workflow-addresses.js"
import { workflowTreeIndex } from "../../protocol/client/workflow-outline.js"
import type { LoadedWorkflowView } from "../../protocol/workflow-view-protocol-types.js"
import { addressReachesAgent, type AddressedAgent, type WorkflowMessageAddress } from "../../workflows/context-bundle/context-facts.js"
import { loadQueueSnapshotFromReader } from "../../workflows/view/view-store.js"
import type { WorkflowView } from "../../workflows/view/types.js"
import type { WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"
import { frontendAttempts } from "./frontend-attempts.js"
import { startedAgents } from "../../workflows/vm/host-commit-controller.js"
import { attemptNodeIdOf } from "../../workflows/vm/graph-types.js"

/** The workflow view of one session as every client reads it: its attempts
 *  and its one operational tree, from the held view projection. */
function workflowView(view: WorkflowView | null): LoadedWorkflowView | undefined {
  return view ? { attempts: frontendAttempts(view), attemptsStatus: "loaded", state: view.status, tree: view.tree } : undefined
}

function messageAddress(address: WorkflowAddress): WorkflowMessageAddress {
  return address.kind === "agent"
    ? { _tag: "agent", nodeId: address.nodeId, definitionId: address.target }
    : { _tag: "item", listNodeId: address.groupId, itemNodeId: address.nodeId, key: address.target }
}

/** What a message or an interrupt names: the item keys and named-agent ids
 *  that a sender names in `targets`, or the attempt whose agent view a
 *  person sends from, which names that agent's item or named agent. */
export type WorkflowTargets = readonly string[] | { readonly attemptId: string }

/** A person's message from the agent view of an attempt that its agent no
 *  longer runs, such as an attempt that a retry replaced while the person
 *  typed. It steers no replacement. */
export const EARLIER_AGENT_SESSION_REFUSAL = "This is an earlier session of its agent, so it takes no message. Message the agent from its current session."

function attemptResolution(view: LoadedWorkflowView, attemptId: string): WorkflowTargetResolution | string {
  const agentNodeId = attemptNodeIdOf(attemptId)
  const node = agentNodeId === null ? undefined : workflowTreeIndex(view.tree).byId.get(agentNodeId)
  if (agentNodeId === null || node?.kind !== "agent" || node.currentAttemptId !== attemptId) return EARLIER_AGENT_SESSION_REFUSAL
  return resolveWorkflowAgentTarget(view, agentNodeId)
}

/** Resolves message or interrupt targets, or the refusal text
 *  that lists every valid target with its state. Nothing is written either
 *  way. Interrupt refuses the whole request if any target has not started. */
export async function resolveWorkflowDeliveryAddress(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
  targets: WorkflowTargets,
  operation: "message" | "interrupt" = "message",
): Promise<{ readonly ok: true; readonly address: WorkflowDeliveryAddress } | { readonly ok: false; readonly refusal: string }> {
  const queue = await loadQueueSnapshotFromReader(reader, sessionId)
  const view = workflowView(queue)
  if (view === undefined) return { ok: false, refusal: "this session has no workflow queue." }
  const resolution = "attemptId" in targets ? attemptResolution(view, targets.attemptId) : resolveWorkflowTargets(view, targets)
  if (typeof resolution === "string") return { ok: false, refusal: resolution }
  if (!resolution.ok) return { ok: false, refusal: workflowTargetRefusal(resolution) }
  const [first, ...rest] = resolution.addresses
  if (first === undefined) return { ok: false, refusal: "targets must name at least one item or agent." }
  const address: WorkflowDeliveryAddress = {
    addressedTo: [messageAddress(first), ...rest.map(messageAddress)],
    label: resolution.addresses.map(({ kind, target }) => `${kind} ${target}`).join(", "),
  }
  const refusal = operation === "interrupt" ? workflowInterruptRefusal(address, startedAgents(queue).map(({ agent }) => agent)) : undefined
  return refusal === undefined ? { ok: true, address } : { ok: false, refusal }
}

/** Refuses an addressed Interrupt before any cut if a target has no started attempt. Whole Interrupt keeps its between-agents behavior. */
export function workflowInterruptRefusal(address: WorkflowDeliveryAddress, agents: readonly AddressedAgent[]): string | undefined {
  if (address.addressedTo.some(({ _tag }) => _tag === "workflow")) return undefined
  const unstarted = address.addressedTo.flatMap((target) => target._tag === "workflow" || agents.some((agent) => addressReachesAgent([target], agent)) ? [] : [target._tag === "item" ? target.key : target.definitionId])
  return unstarted.length === 0 ? undefined : `${unstarted.join(", ")} ${unstarted.length === 1 ? "has" : "have"} not started; interrupt ${unstarted.length === 1 ? "it" : "them"} once running, or interrupt the whole workflow. No agents were interrupted.`
}

/** Whether an agent that runs now, or that an interrupt parked, is one that
 *  `address` reaches. Only such an agent reads the message at once; every
 *  other agent that the address reaches reads it when it starts. A message
 *  to the whole workflow reaches every agent that runs now; between agents
 *  none runs, and the next agent reads its record when it starts. */
export function addressReachesStartedAgent(queue: Pick<WorkflowView, "tree" | "attempts"> | undefined, address: WorkflowDeliveryAddress): boolean {
  return startedAgents(queue).some(({ agent }) => addressReachesAgent(address.addressedTo, agent))
}

/** The message targets of a workflow as its parent reads them in
 *  `process`: one line per item or agent that takes a message. `cut` is the
 *  word of the cut that holds the run, so its held agents read in that word. */
export async function workflowAddressText(reader: AsyncEventStateReadSurface, sessionId: string, cut?: string): Promise<readonly string[]> {
  const view = workflowView(await loadQueueSnapshotFromReader(reader, sessionId))
  return view === undefined ? [] : workflowAddressLines(view, cut)
}
