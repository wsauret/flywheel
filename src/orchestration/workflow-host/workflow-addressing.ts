import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { resolveWorkflowAgentTarget, resolveWorkflowTargets, workflowAddresses, type WorkflowAddress, type WorkflowTargetResolution } from "../../protocol/client/workflow-addresses.js"
import { workflowTreeIndex } from "../../protocol/client/workflow-outline.js"
import type { LoadedWorkflowView } from "../../protocol/workflow-view-protocol-types.js"
import { addressReachesAgent, type AddressedAgent, type WorkflowMessageAddress } from "../../workflows/context-bundle/context-facts.js"
import { loadQueueSnapshotFromReader } from "../../workflows/view/view-store.js"
import type { WorkflowView } from "../../workflows/view/types.js"
import type { WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"
import { frontendAttempts } from "./frontend-attempts.js"
import { startedAgents } from "../../workflows/vm/host/host-commit-controller.js"
import { attemptNodeIdOf } from "../../workflows/vm/graph/graph-types.js"

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

type View = Pick<LoadedWorkflowView, "attempts" | "tree">

function shortened(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

const ITEM_LIMIT = 60
const DETAIL_LIMIT = 80

function stateWord(address: WorkflowAddress): string {
  return address.state === "parked" ? "interrupted" : address.state
}

/** One address as a line of the message targets: its key, its item when the item says
 *  more than the key, its current agent, its state, and its activity. */
function addressLine(address: WorkflowAddress): string {
  const item = address.item === undefined || address.item === address.target ? [] : [shortened(address.item, ITEM_LIMIT)]
  return `- ${[address.target, ...item, address.agent, stateWord(address), shortened(address.detail, DETAIL_LIMIT)].join(" | ")}`
}

function groupHeading(first: WorkflowAddress, count: number, open: boolean): string {
  if (first.kind === "item") return `phase ${first.group}: ${count} ${count === 1 ? "item" : "items"}, ${open ? "one line per item" : "all finished"}`
  if (count === 1) return `phase ${first.group}: one agent${open ? "" : ", finished"}`
  return `phase ${first.group}: ${count} named agents, ${open ? "one line per agent" : "all finished"}`
}

/** The message targets of a workflow as a parent agent reads them: for each
 *  list or phase that has not finished, a heading and one line per address,
 *  and for each that finished, its heading alone, because none of its items
 *  or agents takes a message. Empty for a tree with no phase yet. `cut`
 *  is the word of the cut that holds the run, such as `interrupted`: a cut
 *  returns its started agents to pending, so without it they read queued. */
export function workflowAddressLines(view: View, cut?: string): readonly string[] {
  const addresses = workflowAddresses(view, cut)
  if (addresses.length === 0) return []
  const groups = [...Map.groupBy(addresses, ({ groupId }) => groupId).values()]
  const open = (rows: readonly WorkflowAddress[]) => rows.some(({ finished }) => !finished)
  return [
    ...(groups.some(open) ? ["message targets (name these item keys or agent ids in targets for message_session and process interrupt/resume; omit targets only for the whole workflow):"] : []),
    ...groups.flatMap((rows) => {
      const [first] = rows
      if (first === undefined) return []
      return open(rows) ? [groupHeading(first, rows.length, true), ...rows.map(addressLine)] : [groupHeading(first, rows.length, false)]
    }),
  ]
}

/** The refusal of a `targets` list, with every target that takes a
 *  message now and its state, so a sender can choose again at once. */
export function workflowTargetRefusal(resolution: Extract<WorkflowTargetResolution, { ok: false }>): string {
  const reason = (() => {
    switch (resolution.reason) {
      case "none": return "this workflow has no item or agent that takes a message now: a list gets its items when it reads them, and a finished item or agent takes none"
      case "unknown": return `no item or agent of this workflow has the target "${resolution.target}"`
      case "ambiguous": return `more than one list or phase of this workflow that has not finished has the target "${resolution.target}"`
      case "finished": return `"${resolution.target}" has finished and reads no more messages`
    }
  })()
  const lines = resolution.valid.map(addressLine)
  return [
    `${reason}.`,
    ...(lines.length > 0
      ? ["Valid targets (key | item | agent | state | activity):", ...lines]
      : resolution.reason === "none" ? ["Send the message without targets to reach the whole workflow."] : ["No item or agent of this workflow takes a message now. Send the message without targets to reach the whole workflow."]),
  ].join("\n")
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

/** Whether `address` reaches an agent of the run that failed, which a
 *  person's Resume runs again. */
export function addressReachesFailedAgent(queue: Pick<WorkflowView, "tree"> | undefined, address: WorkflowDeliveryAddress): boolean {
  return queue?.tree.nodes.some((node) => node.kind === "agent" && node.disposition === "failed" && addressReachesAgent(address.addressedTo, node)) ?? false
}

/** The message targets of a workflow as its parent reads them in
 *  `process`: one line per item or agent that takes a message. `cut` is the
 *  word of the cut that holds the run, so its held agents read in that word. */
export async function workflowAddressText(reader: AsyncEventStateReadSurface, sessionId: string, cut?: string): Promise<readonly string[]> {
  const view = workflowView(await loadQueueSnapshotFromReader(reader, sessionId))
  return view === undefined ? [] : workflowAddressLines(view, cut)
}
