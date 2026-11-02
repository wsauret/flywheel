import { randomUUID } from "node:crypto"
import { contentEvidence } from "../../../../infra/content-evidence.js"
import type { SessionHistoryRecoveryInput } from "../../../module-seams.js"
import { createConversationTreeWriterController } from "../../../chat/tree-writer.js"
import { isSessionOwnerGone } from "../../../session/pid-lock.js"
import { createSessionFactWriter, prepareSessionFactAppend } from "../../../session/session-fact-writer.js"
import { recordSubagentInterrupted, buildSubagentCompleted } from "./subagent-run-fact-writers.js"
import { readSubagentRuns } from "./subagent-run-projection.js"
import type { SubagentRunEntry } from "./subagent-run-types.js"
import { readReconciledBranch, tryOpenConversationTree } from "../../../session/conversation/conversation-tree-handle.js"
import { readToolExecutions } from "../../../session/tool-execution-projection.js"
import type { ToolExecutionStatus } from "../../../session/tool-execution-types.js"
// oxlint-disable-next-line import/no-cycle -- recovery inspects the kernel's planned authorization without owning it.
import { readPlannedSessionContinuationAsync } from "../../../session/planned-session-continuation.js"
import { returnUnreadHumanInput } from "../../../session/composer-returns.js"
import { readUnreadMessages } from "../../../session/conversation/queued-user-inputs.js"

interface StaleSubagentRecovery {
  interruptedCount: number
  recoveryMessageCount: number
}

interface RecoveryGroup {
  conversationId: string
  recoveryId: string
  runs: SubagentRunEntry[]
}

/** Cold-runtime boundary for subagent history. Current child-owned runs become
 * crash-paused and retain their binding for explicit resume. Historical inline
 * runs keep their terminal interruption repair and model-visible explanation. */
export async function recoverStaleSubagentRuns(input: SessionHistoryRecoveryInput): Promise<StaleSubagentRecovery> {
  if (!isSessionOwnerGone(input.sessionId, input.projectRoot)) return { interruptedCount: 0, recoveryMessageCount: 0 }

  const initialRuns = await readSubagentRuns(input.projectionReader, input.sessionId)
  const latest = initialRuns.at(-1)
  const cells = latest?.childSessionId === input.sessionId && (latest.status === "created" || latest.status === "completed")
    ? (await readUnreadMessages(input.projectionReader, input.sessionId)).filter((cell) => cell.origin === "human" || cell.producer?.kind === "human") : []
  if (latest?.childSessionId === input.sessionId && latest.conversationId && (latest.status === "created" || (latest.status === "completed" && cells.length > 0))) {
    const tree = await tryOpenConversationTree({ sessionId: input.sessionId, conversationId: latest.conversationId, store: input.projectionReader, writer: input.writer })
    if (tree) {
      try {
        const branch = await tree.getBranch()
        const calls = new Map(branch.flatMap((entry) => entry.kind === "message" && entry.message.kind === "assistant" && Array.isArray(entry.message.content) ? entry.message.content.flatMap((part) => part.type === "tool_use" && part.name === "handoff" ? [[part.id, part.input] as const] : []) : []))
        for (const entry of branch.toReversed()) {
          if (entry.kind !== "message" || entry.displayOnly) continue
          if (entry.message.kind === "user") break
          if (entry.message.kind !== "toolResult" || entry.message.isError || entry.message.interrupted || entry.message.blocked || !calls.has(entry.message.toolUseId)) continue
          // Remove after 2027-04-22: older successful handoffs can retain
          // explicitly human queued cells instead of returning them.
          await returnUnreadHumanInput({ reader: input.projectionReader, writer: input.writer }, { sessionId: input.sessionId, name: latest.description }, cells)
          if (latest.status === "created") await input.writer.append(prepareSessionFactAppend(input.sessionId, buildSubagentCompleted({
            childRunId: latest.childRunId, status: "completed", isError: false, content: JSON.stringify(calls.get(entry.message.toolUseId)), durationMs: 0,
          })))
          return { interruptedCount: 0, recoveryMessageCount: 0 }
        }
      } finally { tree.getStorage().dispose() }
    }
  }
  const planned = await readPlannedSessionContinuationAsync(input.projectionReader, input.sessionId)
  const openRuns = initialRuns.filter((run) => run.status === "created" && run.childRunId !== planned?.runId)
  if (openRuns.length > 0) await interruptRuns(input, openRuns)

  const runs = openRuns.length > 0
    ? await readSubagentRuns(input.projectionReader, input.sessionId)
    : initialRuns
  const interrupted = runs.filter((run) =>
    run.childSessionId === undefined
      && run.status === "interrupted"
      && run.interruptionReason === "runtime_restarted"
      && run.recoveryId !== undefined
  )
  if (interrupted.length === 0) return { interruptedCount: openRuns.length, recoveryMessageCount: 0 }

  const groups = recoveryGroups(input, interrupted)
  let recoveryMessageCount = 0
  for (const group of groups) {
    recoveryMessageCount += await ensureRecoveryMessage(input, group)
  }
  return { interruptedCount: openRuns.length, recoveryMessageCount }
}

async function interruptRuns(input: SessionHistoryRecoveryInput, runs: readonly SubagentRunEntry[]): Promise<void> {
  const toolUseIds = runs.flatMap((run) => run.childSessionId === undefined && run.toolUseId ? [run.toolUseId] : [])
  const toolsById = await readToolExecutions(input.projectionReader, input.sessionId, toolUseIds)
  const recoveryId = randomUUID()
  const writer = createSessionFactWriter({ sessionId: input.sessionId, writer: input.writer })
  try {
    await writer.transaction(() => {
      for (const run of runs) {
        recordSubagentInterrupted(writer, {
          childRunId: run.childRunId,
          reason: "runtime_restarted",
          recoveryId,
        })
        if (run.childSessionId !== undefined || !run.toolUseId) continue
        const tool = toolsById.get(run.toolUseId)
        if (!tool || isTerminalTool(tool.status)) continue
        const message = `Subagent '${run.description}' was interrupted because its parent runtime exited. It is not running; launch a new subagent to retry.`
        const evidence = contentEvidence(message)
        void writer.record({
          type: "tool.result.recorded",
          version: 1,
          actor: "flywheel",
          payload: {
            toolUseId: run.toolUseId,
            outcome: "interrupted",
            contentBytes: evidence.bytes,
            contentSha256: evidence.sha256,
            contentPreview: evidence.preview,
            contentTruncated: false,
            originalContentBytes: evidence.bytes,
            originalContentSha256: evidence.sha256,
            ...(run.modelRequestId ? { modelRequestId: run.modelRequestId } : {}),
            ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
            details: { reason: "runtime_restarted", childRunId: run.childRunId, recoveryId },
          },
        })
      }
    })
  } finally {
    writer.dispose()
  }
}

function isTerminalTool(status: ToolExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted" || status === "validation_failed"
}

function recoveryGroups(input: SessionHistoryRecoveryInput, runs: readonly SubagentRunEntry[]): RecoveryGroup[] {
  const groups = new Map<string, RecoveryGroup>()
  for (const run of runs) {
    const recoveryId = run.recoveryId
    if (!recoveryId) continue
    // The run fact carries its dispatcher's conversation. Historical runs
    // without the stamp resolve through the caller's fallback conversation or
    // are skipped, exactly like any unmapped run.
    const conversationId = run.conversationId ?? input.fallbackConversationId
    if (!conversationId) continue
    const key = `${conversationId}:${recoveryId}`
    const group = groups.get(key) ?? { conversationId, recoveryId, runs: [] }
    group.runs.push(run)
    groups.set(key, group)
  }
  return [...groups.values()]
}

async function ensureRecoveryMessage(input: SessionHistoryRecoveryInput, group: RecoveryGroup): Promise<number> {
  const entries = await readReconciledBranch({
    conversationId: group.conversationId,
    sessionId: input.sessionId,
    store: input.projectionReader,
    writer: input.writer,
    projectRoot: input.projectRoot,
    ...(input.protectedToolUseIds ? { protectedToolUseIds: input.protectedToolUseIds } : {}),
  })
  if (!entries) throw new Error(`Subagent recovery conversation is missing: ${group.conversationId}`)
  const entryId = `subagent-recovery:${group.recoveryId}`
  if (entries.some((entry) => entry.id === entryId)) return 0

  const treeWriter = createConversationTreeWriterController({
    conversationId: group.conversationId,
    sessionId: input.sessionId,
    projectRoot: input.projectRoot,
    store: input.reader,
    projectionReader: input.projectionReader,
    writer: input.writer,
  })
  try {
    await treeWriter.commitSystemTurn(formatRecoveryMessage(group), entryId)
  } finally {
    await treeWriter.dispose()
  }
  return 1
}


function formatRecoveryMessage(group: RecoveryGroup): string {
  const lines = [
    "<runtime_recovery>",
    "<reason>parent_runtime_restarted</reason>",
    `<interrupted_subagents count="${group.runs.length}">`,
  ]
  for (const run of group.runs) {
    lines.push(
      "<subagent>",
      `<child_run_id>${escapeXml(run.childRunId)}</child_run_id>`,
      `<agent_type>${escapeXml(run.agentType)}</agent_type>`,
      `<description>${escapeXml(run.description)}</description>`,
      "<status>interrupted</status>",
      "</subagent>",
    )
  }
  lines.push(
    "</interrupted_subagents>",
    "<current_state>None of these subagents is running. Background-task liveness from the previous process did not survive the restart.</current_state>",
    `<handling>Do not call process with { action: "wait" } for these interrupted runs and do not claim any was restarted. An interrupted child never blocks your work: do its work yourself, leave it, or continue it. To continue a child that process(action='list') shows, call process with action 'resume' and its session id. Otherwise launch a new subagent with the subagent tool. Only after a resume or a launch acknowledgement is the run active and waitable.</handling>`,
    "</runtime_recovery>",
  )
  return lines.join("\n")
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
