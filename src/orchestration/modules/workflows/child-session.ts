import type { WorkflowWorkTarget, ModuleWorkControl, ModuleWorkflowRuns } from "../../module-seams.js"
import { workflowProgress, workflowSummaryText } from "../../../protocol/client/workflow-progress.js"
import { loadQueueSnapshotFromReader } from "../../../workflows/view/view-store.js"
import { frontendAttempts } from "../../workflow-host/frontend-attempts.js"
import { workflowAddressText } from "../../workflow-host/workflow-addressing.js"
import { workflowLaunchHost, type WorkflowLaunchHost } from "../../workflow-host/launch-operation-contract.js"
import { readChildCall, readChildStop } from "../../session/chat-session-run-evidence.js"
import { liveWorkflowControl } from "../../session/live-session-control.js"
import { workflowMembershipReader } from "../../session/workflow-membership.js"

function launchHost({ hosts }: WorkflowWorkTarget): WorkflowLaunchHost {
  const host = hosts.get(workflowLaunchHost)
  if (!host) throw new Error("Workflow child control requires a bound workflow launch host")
  return host
}

/** A loaded workflow's shared aggregate, conditional count, completed agents
 *  outside phases over a list, and current attempt. A session with no queue
 *  has no progress. */
async function workflowProgressLines({ workflowId, projectionReader }: WorkflowWorkTarget): Promise<readonly string[]> {
  const queue = await loadQueueSnapshotFromReader(projectionReader, workflowId)
  if (queue === null) return []
  const progress = workflowProgress({ attempts: frontendAttempts(queue), tree: queue.tree })
  const members = await workflowMembershipReader(projectionReader).list(workflowId)
  const { conditional, completed, current } = progress
  return [
    `progress: ${workflowSummaryText(progress)}${conditional > 0 ? `, ${conditional} run only if needed` : ""}`,
    ...(completed.length > 0 ? [`completed agents: ${completed.map((agent) => `${agent.id} (${agent.name})`).join(", ")}`] : []),
    ...(current ? [`current agent: ${current.id} (${current.name}), ${current.status}`] : []),
    ...members.map(({ sessionId, membership }) => `agent session: ${sessionId} | workflow ${workflowId} | ${membership.kind === "historical-follow-up" ? `follow-up ${membership.followUpId}` : `attempt ${membership.attemptId}`}`),
  ]
}

/** The workflows module's owner of its children: the Stop of a person or of
 *  the parent agent, the parent agent's Resume, and the reads of its cut
 *  and progress. Progress reads the workflow's queue through its held
 *  projection on each call, and copies nothing into the parent. */
export const workflowWorkControl: ModuleWorkControl<WorkflowWorkTarget> = {
  restoreTracking: (input) => launchHost(input).restoreLaunchTracking(input.workflowId, input.tasks),
  async stop(input) {
    await launchHost(input).stopLaunch(input.workflowId, input.by)
    const call = await readChildCall(input.projectionReader, input.run.launchedFrom)
    if (call?.stoppedBy) return { ok: true, status: call.stoppedBy === "agent" ? "cancelled" : "stopped" }
    const queue = await loadQueueSnapshotFromReader(input.projectionReader, input.workflowId)
    if (queue?.status === "completed" || queue?.status === "failed") return { ok: true, status: queue.status }
    if (call?.settled) return { ok: true, status: "settled" }
    return { ok: false, error: "This workflow's Stop did not record a terminal result. Cancellation was not confirmed." }
  },
  resume: (input) => launchHost(input).resumeLaunch(input.workflowId, input.address),
  cut: (input) => launchHost(input).launchCut(input.workflowId),
  progress: workflowProgressLines,
  addresses: async (input) => workflowAddressText(input.projectionReader, input.workflowId, await launchHost(input).launchCut(input.workflowId) ? "interrupted" : undefined),
}

export const workflowWorkState: ModuleWorkflowRuns["state"] = async (input) => {
  const binding = input.run.launchedFrom
  const stop = await readChildStop(input.projectionReader, { parentSessionId: binding.parentSessionId, toolUseId: binding.toolUseId })
  if (stop) return "settled"
  const queue = await loadQueueSnapshotFromReader(input.projectionReader, input.workflowId)
  if (queue?.status === "completed") return "settled"
  if (queue?.status === "failed") return "interrupted"
  if (await workflowWorkControl.cut(input)) return "interrupted"
  return liveWorkflowControl(input.reader, input.workflowId) ? "running" : "idle"
}
