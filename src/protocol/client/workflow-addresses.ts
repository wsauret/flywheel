/**
 * The addresses of one workflow: the items of each list, the named agents
 * of each phase, and the agent of each phase of one agent, which a message
 * can name in `targets`. The runtime resolves and refuses targets with
 * {@link resolveWorkflowTargets}, a parent agent reads them as
 * {@link workflowAddressLines}, and the agent view's
 * composer reads its own with {@link workflowAgentAddress}. Each reads the one
 * operational tree of the workflow view through the shared outline and folds
 * no hierarchy of its own.
 */

import type { LoadedWorkflowView, WorkflowTreeNode } from "../workflow-view-protocol-types.js"
import { workflowCurrentAgent, workflowOutline, workflowTreeIndex, type WorkflowPhaseAgent } from "./workflow-outline.js"
import { workflowAgentDetail } from "./workflow-card.js"
import type { WorkflowAgentModel } from "./workflow-agent.js"
import type { WorkflowAgentState } from "../../infra/output-blocks.js"

type View = Pick<LoadedWorkflowView, "attempts" | "tree">

/** Normalizes model-supplied targets: missing or empty means whole workflow; null means invalid. */
export function parseWorkflowTargets(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  const targets = value.map((target) => typeof target === "string" ? target.trim() : "")
  if (targets.some((target) => !target)) return null
  return targets.length === 0 ? undefined : targets
}

/** One addressable part of a workflow. */
export interface WorkflowAddress {
  /** What a sender names in `targets`: the item key of an item of a list,
   *  or the record id of a named agent. */
  readonly target: string
  /** `item` is an item of a list, with its agent in each phase of its
   *  stream, and `agent` a named agent of a phase or the agent of a phase of
   *  one agent. */
  readonly kind: "item" | "agent"
  /** The control node the address names: the item of a list, or the
   *  agent. */
  readonly nodeId: string
  /** The control node of the list or the tree node of the phase that holds
   *  the address, and the phase's name. */
  readonly groupId: string
  readonly group: string
  /** The agents that the address reaches, in run order. */
  readonly agentNodeIds: readonly string[]
  /** The item on one line, for an item of a list. */
  readonly item?: string
  /** The record that the address runs now: the agent that runs or that an
   *  interrupt parked, else the first that has not finished, else the one
   *  that failed, else the last. */
  readonly agent: string
  readonly state: WorkflowAgentState
  /** The activity of that agent in the words of its line on the card. */
  readonly detail: string
  /** A finished item or agent reads no more messages. */
  readonly finished: boolean
}

/** The states of an agent whose own item or agent still reads a message. */
const MESSAGEABLE: ReadonlySet<WorkflowAgentState> = new Set(["running", "parked", "waiting", "queued"])

function finishedNode(node: WorkflowTreeNode | undefined): boolean {
  return node?.disposition === "completed" || node?.disposition === "failed" || node?.disposition === "skipped"
}

/** An agent's activity in the words of its line on the card, for an agent
 *  that reads text: `working`, a handoff summary in quotes, a reason, or
 *  the state it holds. */
function addressDetail(agent: WorkflowPhaseAgent, cut: string | undefined): string {
  if (agent.state === "running") return "working"
  const detail = workflowAgentDetail(agent, cut)
  if (detail?.kind === "summary") return `"${detail.text}"`
  return detail?.text ?? agent.state
}

/** Every address of the workflow, in the order its phases show them: the
 *  phases in run order, the items of a list in list order with the agents
 *  of every phase of its stream, the named agents of a phase in file order,
 *  and the agent of a phase of one agent by its record id. */
export function workflowAddresses(view: View, cut?: string): readonly WorkflowAddress[] {
  const { byId } = workflowTreeIndex(view.tree)
  const outline = workflowOutline(view, cut)
  const streams = new Set<string>()
  return outline.phases.flatMap((phase): WorkflowAddress[] => {
    const node = byId.get(phase.key)
    if (node?.kind !== "phase") return []
    if (phase.form !== "list") {
      return phase.agents.flatMap((agent): WorkflowAddress[] => {
        const agentNode = byId.get(agent.agentNodeId)
        if (agentNode?.kind !== "agent") return []
        return [{ target: agentNode.definitionId, kind: "agent", nodeId: agentNode.nodeId ?? agentNode.id, groupId: phase.key, group: phase.name, agentNodeIds: [agentNode.id], agent: agentNode.label, state: agent.state, detail: addressDetail(agent, cut), finished: finishedNode(agentNode) }]
      })
    }
    // The first phase of a stream names its items; each address reaches the
    // item's agent in every phase of the stream.
    const listId = node.list?.id
    if (listId === undefined || streams.has(listId)) return []
    streams.add(listId)
    const stream = outline.phases.filter((candidate) => { const other = byId.get(candidate.key); return other?.kind === "phase" && other.list?.id === listId })
    return phase.agents.flatMap((agent): WorkflowAddress[] => {
      const first = byId.get(agent.agentNodeId)
      if (first?.kind !== "agent" || first.item === undefined) return []
      const parts = stream.flatMap((part) => part.agents.filter((candidate) => candidate.label === agent.label))
      const current = workflowCurrentAgent(parts)
      if (current === undefined) return []
      return [{
        target: first.item.key,
        kind: "item",
        nodeId: first.item.nodeId,
        groupId: listId,
        group: phase.name,
        agentNodeIds: parts.map(({ agentNodeId }) => agentNodeId),
        item: first.item.text,
        agent: byId.get(current.agentNodeId)?.label ?? current.definitionId,
        state: current.state,
        detail: addressDetail(current, cut),
        finished: parts.every(({ agentNodeId }) => finishedNode(byId.get(agentNodeId))),
      }]
    })
  })
}

/** What one `targets` list names: the addresses in the order the list names
 *  them, or why the list names none. */
export type WorkflowTargetResolution =
  | { readonly ok: true; readonly addresses: readonly WorkflowAddress[] }
  | {
    readonly ok: false
    /** `none`: no item or agent of the workflow takes a message now.
     *  `unknown`: no address has the target. `ambiguous`: two lists or
     *  phases that have not finished share it. `finished`: every address
     *  with the target finished and reads no more messages. */
    readonly reason: "none" | "unknown" | "ambiguous" | "finished"
    readonly target: string
    /** The addresses that take a message now, which a sender can name. */
    readonly valid: readonly WorkflowAddress[]
  }


/** Resolves every target of a message, or refuses the whole list at its
 *  first target that names no unfinished address. A key that an earlier
 *  list or a repeat's earlier round also used names the one item with that
 *  key that has not finished. A repeated target names its address once. */
export function resolveWorkflowTargets(view: View, targets: readonly string[], cut?: string): WorkflowTargetResolution {
  const addresses = workflowAddresses(view, cut)
  const valid = addresses.filter(({ finished }) => !finished)
  const resolved: WorkflowAddress[] = []
  for (const target of targets) {
    const named = addresses.filter((address) => address.target === target)
    const open = named.filter(({ finished }) => !finished)
    const [match] = open
    const refusal = valid.length === 0 && named.length === 0 ? "none" : named.length === 0 ? "unknown" : open.length > 1 ? "ambiguous" : match === undefined ? "finished" : undefined
    if (refusal !== undefined || match === undefined) return { ok: false, reason: refusal ?? "finished", target, valid }
    if (!resolved.includes(match)) resolved.push(match)
  }
  return { ok: true, addresses: resolved }
}

/** The item or named agent that holds the agent of `agentNodeId`: the one
 *  address that an agent view's composer names, whichever phase of its
 *  stream that agent runs. A finished item or agent refuses as a finished
 *  target does. */
export function resolveWorkflowAgentTarget(view: View, agentNodeId: string, cut?: string): WorkflowTargetResolution {
  const addresses = workflowAddresses(view, cut)
  const valid = addresses.filter(({ finished }) => !finished)
  const match = addresses.find(({ agentNodeIds }) => agentNodeIds.includes(agentNodeId))
  if (match === undefined) return { ok: false, reason: valid.length === 0 ? "none" : "unknown", target: agentNodeId, valid }
  return match.finished ? { ok: false, reason: "finished", target: match.target, valid } : { ok: true, addresses: [match] }
}

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

/** The item or agent that an agent view's composer addresses: the target it
 *  sends, its name in a person's words, such as `item json`, and the
 *  composer's placeholder. */
export interface WorkflowAgentAddress {
  readonly target: string
  readonly label: string
  readonly placeholder: string
}

/** What the composer of an agent view addresses: the agent's item or the
 *  agent, while that agent runs or waits and its item has not finished.
 *  Undefined for an agent that finished, so its view shows no composer. */
export function workflowAgentAddress(view: View, model: WorkflowAgentModel, cut?: string): WorkflowAgentAddress | undefined {
  if (!MESSAGEABLE.has(model.state)) return undefined
  const resolution = resolveWorkflowAgentTarget(view, model.agentNodeId, cut)
  const [address] = resolution.ok ? resolution.addresses : []
  if (address === undefined) return undefined
  const label = `${address.kind} ${address.target}`
  return { target: address.target, label, placeholder: `Message ${label}` }
}
