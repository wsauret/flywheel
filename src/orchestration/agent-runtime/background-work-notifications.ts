import { escapeXml, formatRuntimeNotification } from "./runtime-notifications.js"
import type { BackgroundWorkMeta, BackgroundWorkResult } from "./background-work.js"

interface NotificationReceipt {
  readonly promise: Promise<void>
  readonly work: readonly { id: string; description: string }[]
  timer?: ReturnType<typeof setTimeout>
}

/** Owns notification promises until the conversation sink settles their delivery. */
export function createBackgroundNotificationDelivery(
  sink: ((text: string, key?: string, runtimeNotice?: boolean) => void) | ((text: string, key?: string, runtimeNotice?: boolean) => Promise<void>),
  changed: () => void,
  retryFirstMs = 1_000,
) {
  const delivering = new Map<string, NotificationReceipt>()
  let closed = false
  return {
    enqueueNotification(text: string, key?: string, work?: readonly { id: string; description: string }[], runtimeNotice = false): void | Promise<void> {
      const notificationKey = key ?? `background-notification:${crypto.randomUUID()}`
      const existing = delivering.get(notificationKey)
      if (existing) return existing.promise
      const first = sink(text, notificationKey, runtimeNotice)
      if (!(first instanceof Promise)) return
      if (closed) { void first.catch(() => {}); return }
      const completed = Promise.withResolvers<void>()
      const entry: NotificationReceipt = { promise: completed.promise, work: work ?? [{ id: notificationKey, description: "background notification delivery" }] }
      delivering.set(notificationKey, entry)
      const retry = (delayMs: number): void => {
        if (closed) return
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          if (closed) return
          attempt(Promise.resolve().then(() => { if (!closed) return sink(text, notificationKey, runtimeNotice) }), Math.min(delayMs * 2, 30_000))
        }, delayMs)
        entry.timer.unref?.()
      }
      const attempt = (delivery: Promise<void>, delayMs: number): void => {
        void delivery.then(() => {
          if (closed) return
          delivering.delete(notificationKey)
          completed.resolve()
          changed()
        }, () => { retry(delayMs) })
      }
      attempt(first, retryFirstMs)
      return completed.promise
    },
    pendingWork: () => [...delivering.values()].flatMap(({ work }) => work),
    hasPending: (key: string) => !closed && delivering.has(key),
    close(): void {
      closed = true
      for (const entry of delivering.values()) clearTimeout(entry.timer)
    },
  }
}

/** Retires only the settled durable child runs covered by this receipt.
 * The caller retains ownership of the array and of interrupted live runs. */
export function retireCompletedSubagents<T extends { readonly meta: BackgroundWorkMeta }>(completed: T[], runIds?: readonly string[]): T[] {
  const delivered = runIds ? new Set(runIds) : null
  const covered = (entry: T): boolean => entry.meta.settlementOwner === "child_session" && (!delivered || delivered.has(entry.meta.id))
  const batch = completed.filter(covered)
  completed.splice(0, completed.length, ...completed.filter((entry) => !covered(entry)))
  return batch
}

export interface BackgroundNotificationEntry {
  readonly meta: {
    readonly type: string
    readonly description: string
    readonly toolUseId?: string
    /** The child session that did the work, which `message_session` reaches. */
    readonly sessionId?: string
  }
  readonly result: BackgroundWorkResult
}

export interface SubagentNotificationEntry {
  readonly type: "subagent"
  readonly description: string
  readonly toolUseId?: string
  readonly sessionId?: string
  readonly result: BackgroundWorkResult
}

interface ChildSessionCompletionResult {
  readonly status: "created" | "completed" | "partial" | "failed" | "cancelled" | "stopped" | "interrupted" | "paused"
  readonly agentType: string
  readonly description: string
  readonly result?: string
  readonly resultPreview?: string
  readonly totalTokens?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheCreationInputTokens?: number
  readonly reasoningTokens?: number
  readonly totalCostUsd?: number
  readonly toolUses?: number
  readonly durationMs?: number
}

/** What a `partial` status means to the parent, stated where the status is
 *  read: the child stopped at its turn budget, so its result is the work it
 *  had, not a completion. */
const PARTIAL_STATUS_HANDLING = "A status of partial means the subagent stopped at its turn budget before finishing: treat its result as unfinished work and decide whether to retask it with a narrower scope, continue the work yourself, or accept it."

function notificationEntryLines(entry: BackgroundNotificationEntry): string[] {
  const lines = [`<description>${escapeXml(entry.meta.description)}</description>`]
  if (entry.meta.sessionId) lines.push(`<session_id>${escapeXml(entry.meta.sessionId)}</session_id>`)
  if (entry.meta.toolUseId) lines.push(`<tool_use_id>${escapeXml(entry.meta.toolUseId)}</tool_use_id>`)
  lines.push(`<status>${entry.result.status}</status>`)
  if (entry.result.usage) {
    lines.push(`<usage><total_tokens>${entry.result.usage.totalTokens}</total_tokens><tool_uses>${entry.result.usage.toolUses}</tool_uses><duration_ms>${entry.result.usage.durationMs}</duration_ms></usage>`)
  }
  lines.push("<result>", escapeXml(entry.result.content), "</result>")
  return lines
}

function formatNotificationEntry(entry: BackgroundNotificationEntry): string {
  const tag = `${entry.meta.type}_notification`
  return [`<${tag}>`, ...notificationEntryLines(entry), `</${tag}>`].join("\n")
}

/** A notification reaches a root chat and a child alike, so its guidance says
 *  "ask the person" and names no module tool. The identity section tells a
 *  child to message its parent wherever an instruction says to ask the person.
 *
 *  The guidance a batch needs: the partial sentence only when a partial
 *  result is present, so every other notification stays as short as before. */
function handlingFor(entries: readonly BackgroundNotificationEntry[], before: string, after: string): string {
  const partial = entries.some((entry) => entry.result.status === "partial") ? ` ${PARTIAL_STATUS_HANDLING}` : ""
  return `${before}${partial} ${after}`
}

export function formatStandaloneNotification(entry: BackgroundNotificationEntry): string {
  return formatRuntimeNotification({
    tag: `${entry.meta.type}_notification`,
    handling: handlingFor([entry], "Incorporate the completed background-work result into the task and continue.", "If the result needs a decision from the person, ask the person."),
    body: notificationEntryLines(entry).join("\n"),
  })
}

/** Tells a parent that the runtime interrupted its child. The child is not
 *  active work, so the parent decides what happens to the work that the
 *  child was doing. A person's interrupt sends no notice: the child stays
 *  the parent's work (PI-AGENT-025). */
export function formatChildInterruptedNotification(child: { readonly description: string; readonly sessionId?: string }): string {
  return formatRuntimeNotification({
    tag: "child_interrupted_notification",
    handling: "The runtime interrupted this child. It is not active work, so no wait parks on it and a handoff does not wait for it. You can continue it with process(action='resume') or a message to it. Do its remaining work yourself, leave it, or ask the person.",
    fields: [["description", child.description], ...(child.sessionId ? [["session_id", child.sessionId] as const] : [])],
  })
}

export function formatSubagentNotificationBatch(entries: readonly BackgroundNotificationEntry[], remainingActive: number): string {
  return formatRuntimeNotification({
    tag: "subagent_notifications",
    handling: handlingFor(entries, "Incorporate all completed subagent results into the task and continue.", "When remaining_active is greater than zero and all remaining work depends on those subagents, call process with { action: \"wait\" }. If a result needs a decision from the person, ask the person."),
    fields: [["remaining_active", String(remainingActive)], ["completed_count", String(entries.length)]],
    body: entries.map(formatNotificationEntry).join("\n"),
  })
}

function formatDurableSubagentNotification(entries: readonly SubagentNotificationEntry[], remainingActive: number): string {
  return formatSubagentNotificationBatch(entries.map((entry) => ({
    meta: {
      type: entry.type,
      description: entry.description,
      ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    },
    result: entry.result,
  })), remainingActive)
}

export function childSessionBackgroundResult(run: ChildSessionCompletionResult): BackgroundWorkResult {
  const content = run.result ?? run.resultPreview
    ?? `Subagent '${run.agentType}' (${run.description}) was interrupted when its runtime stopped.`
  const usage = run.totalTokens === undefined && run.toolUses === undefined && run.durationMs === undefined
    ? undefined
    : {
        totalTokens: run.totalTokens ?? 0,
        ...(run.inputTokens !== undefined ? { inputTokens: run.inputTokens } : {}),
        ...(run.outputTokens !== undefined ? { outputTokens: run.outputTokens } : {}),
        ...(run.cacheReadInputTokens !== undefined ? { cacheReadTokens: run.cacheReadInputTokens } : {}),
        ...(run.cacheCreationInputTokens !== undefined ? { cacheCreateTokens: run.cacheCreationInputTokens } : {}),
        ...(run.reasoningTokens !== undefined ? { reasoningTokens: run.reasoningTokens } : {}),
        ...(run.totalCostUsd !== undefined ? { totalCostUsd: run.totalCostUsd } : {}),
        toolUses: run.toolUses ?? 0,
        durationMs: run.durationMs ?? 0,
      }
  return {
    status: run.status === "completed" || run.status === "partial" || run.status === "cancelled" || run.status === "stopped" ? run.status : "failed",
    content,
    ...(usage ? { usage } : {}),
  }
}

export interface DurableSubagentCompletionNotification {
  readonly key: string
  readonly completionRunIds: readonly string[]
  readonly text: string
}

const SUBAGENT_COMPLETIONS_KEY_PREFIX = "subagent-completions:"

/** The key names every child run the notification covers. It is the one
 *  record of that coverage: the in-flight hold and the committed entry both
 *  carry it, and every later hold under the key keeps it. */
export function durableSubagentCompletionNotification(
  entries: readonly (SubagentNotificationEntry & { readonly childRunId: string })[],
  remainingActive: number,
): DurableSubagentCompletionNotification {
  const runIds = entries.map((entry) => entry.childRunId).sort()
  return {
    key: `${SUBAGENT_COMPLETIONS_KEY_PREFIX}${runIds.map(encodeURIComponent).join(",")}`,
    completionRunIds: runIds,
    text: formatDurableSubagentNotification(entries, remainingActive),
  }
}

/** Run coverage encoded by the durable notification producer in a hold or entry id. */
export function subagentCompletionRunIds(key: string): readonly string[] {
  if (!key.startsWith(SUBAGENT_COMPLETIONS_KEY_PREFIX)) return []
  return key.slice(SUBAGENT_COMPLETIONS_KEY_PREFIX.length).split(",").map(decodeURIComponent)
}

/** Work ids encoded by the completion producers in their durable keys. */
export function completionWorkIds(key: string): readonly string[] {
  const workflowPrefix = "workflow-completion:"
  if (key.startsWith(workflowPrefix)) return key.slice(workflowPrefix.length).split(":", 1)
  return subagentCompletionRunIds(key)
}

/** True when a notification for the run is held or already committed. */
export function hasDurableSubagentNotificationEvidence(
  completedRunIds: ReadonlySet<string>,
  held: readonly { readonly key: string }[],
  childRunId: string,
): boolean {
  return completedRunIds.has(childRunId)
    || held.some((row) => subagentCompletionRunIds(row.key).includes(childRunId))
}
