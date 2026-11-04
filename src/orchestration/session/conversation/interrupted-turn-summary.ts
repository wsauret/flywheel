import { parseProjectionFact } from "../../../infra/event-projection.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import { parseFileMutationFact } from "../file-mutation-facts.js"
import { readProviderRequestAuditFact } from "../provider-request-audit-facts.js"
import { providerRequestIdentityFromPayload } from "../provider-request-audit-types.js"
import { turnEndEntryId, type TurnEnd } from "./turn-end-record.js"

/** Facts a turn leaves behind that outlive the turn itself. Tool inputs,
 *  results, and file mutations commit as they happen rather than at the turn's
 *  save point, so a process that dies mid-turn still leaves a complete record
 *  of what it did - roughly eleven such facts per committed turn. */
const INTERRUPTED_WORK_FACT_TYPES = [
  "tool.input.completed",
  "tool.result.recorded",
  "file.changed",
] as const

/** What an interrupted turn actually did, read from durable facts.
 *
 *  `finishedTools` have a recorded result, so they provably executed.
 *  `unconfirmedTools` have only a completed input: the input fact is written
 *  when the provider finishes streaming the call's arguments, before the tool
 *  runs, so a crash in that window leaves a call that may never have executed.
 *  The two must stay separate: telling a resuming model that an edit or a
 *  bash command "already ran" when only its arguments arrived steers it to
 *  skip work that never happened. */
export interface InterruptedWork {
  readonly finishedTools: readonly string[]
  readonly unconfirmedTools: readonly string[]
  readonly paths: readonly string[]
}

/** Whose work a sweep reads. One session's facts interleave the calls of
 *  every conversation it holds, such as the parallel steps of a workflow, so
 *  a call is this conversation's only when the provider request that made it
 *  names this conversation. */
export interface InterruptedWorkScope {
  readonly sessionId: string
  readonly conversationId: string
  /** Calls whose results this conversation already committed. Its branch
   *  accounts for them, and for the nested calls they made, so they are not
   *  interrupted work: a live turn parked on a wait has committed its results
   *  and has no reply after them yet. */
  readonly answeredToolUseIds: ReadonlySet<string>
}

/** Why the turn never reached its save point: the owning process died, or
 *  the user interrupted it and Flywheel ended that process to stop it. */
export type InterruptedTurnReason = "crash" | "interrupted"

interface ToolCall {
  readonly toolName: string
  readonly modelRequestId: string
  readonly parentToolUseId?: string
}

/** Reads the work that the scope's conversation committed after
 *  `afterPosition` and that its branch does not answer. A call whose input
 *  names no provider request belongs to no conversation, so it is not read. */
export async function readInterruptedWork(store: AsyncEventStateReadSurface, scope: InterruptedWorkScope, afterPosition: number): Promise<InterruptedWork> {
  const aggregateId = `session:${scope.sessionId}`
  const calls = new Map<string, ToolCall>()
  const named = new Set<string>()
  const finished = new Set<string>()
  const changes: { readonly toolUseId: string; readonly path: string }[] = []
  let newestCall = 0
  const addCall = (event: StoredFact): void => {
    const { toolUseId, toolName, modelRequestId, parentToolUseId } = event.payload
    if (typeof toolUseId !== "string" || typeof toolName !== "string" || typeof modelRequestId !== "string") return
    calls.set(toolUseId, typeof parentToolUseId === "string" ? { toolName, modelRequestId, parentToolUseId } : { toolName, modelRequestId })
    newestCall = Math.max(newestCall, event.position)
  }
  const recent = await store.readSlice({ aggregateId, types: INTERRUPTED_WORK_FACT_TYPES, afterPosition })
  for (const event of storedFacts(recent.facts)) {
    if (event.type === "file.changed") {
      const change = changedFile(event)
      if (change) changes.push(change)
      continue
    }
    const toolUseId = event.payload.toolUseId
    if (typeof toolUseId !== "string") continue
    named.add(toolUseId)
    if (event.type === "tool.result.recorded") finished.add(toolUseId)
    else addCall(event)
  }
  // A call's input commits before the assistant entry that moves the
  // boundary, so a result or file change after it can name a call whose
  // input lies before it.
  const unread = [...new Set([...named, ...changes.map((change) => change.toolUseId)])].filter((toolUseId) => !calls.has(toolUseId))
  if (unread.length > 0) {
    const inputs = await store.readSlice({ aggregateId, types: ["tool.input.completed"], toolUseIds: unread })
    for (const event of storedFacts(inputs.facts)) addCall(event)
  }
  const own = await ownRequestIds(store, scope, new Set([...calls.values()].map((call) => call.modelRequestId)), newestCall)
  // A nested call has no result entry of its own: the enclosing call's
  // committed result answers it.
  const isAnswered = (toolUseId: string): boolean => {
    if (scope.answeredToolUseIds.has(toolUseId)) return true
    const parent = calls.get(toolUseId)?.parentToolUseId
    return parent !== undefined && isAnswered(parent)
  }
  const isOwn = (toolUseId: string): boolean => {
    const call = calls.get(toolUseId)
    return call !== undefined && own.has(call.modelRequestId) && !isAnswered(toolUseId)
  }
  const finishedTools: string[] = []
  const unconfirmedTools: string[] = []
  for (const [toolUseId, call] of calls) {
    if (!named.has(toolUseId) || !isOwn(toolUseId)) continue
    const bucket = finished.has(toolUseId) ? finishedTools : unconfirmedTools
    if (!bucket.includes(call.toolName)) bucket.push(call.toolName)
  }
  const paths: string[] = []
  for (const { toolUseId, path } of changes) {
    if (isOwn(toolUseId) && !paths.includes(path)) paths.push(path)
  }
  return { finishedTools, unconfirmedTools, paths }
}

/** Requests are read newest first, one page at a time, because the requests
 *  of an interrupted turn are among the newest of its session. */
const REQUEST_PAGE_SIZE = 64

/** The ids among `requestIds` whose request this conversation made. A
 *  request precedes every fact of its calls, so the read pages back from
 *  `beforeCall`, the newest call, until it has found every id. */
async function ownRequestIds(store: AsyncEventStateReadSurface, scope: InterruptedWorkScope, requestIds: ReadonlySet<string>, beforeCall: number): Promise<ReadonlySet<string>> {
  const own = new Set<string>()
  const unresolved = new Set(requestIds)
  let beforePosition = beforeCall
  while (unresolved.size > 0) {
    const page = storedFacts((await store.readSlice({
      aggregateId: `session:${scope.sessionId}`, types: ["model.requested"], beforePosition, order: "desc", limit: REQUEST_PAGE_SIZE,
    })).facts)
    for (const event of page) {
      const fact = readProviderRequestAuditFact(event)
      if (fact.type !== "model.requested" || !unresolved.delete(fact.payload.requestId)) continue
      if (providerRequestIdentityFromPayload(fact.payload).conversationId === scope.conversationId) own.add(fact.payload.requestId)
    }
    const oldest = page.at(-1)
    if (oldest === undefined || page.length < REQUEST_PAGE_SIZE) break
    beforePosition = oldest.position
  }
  return own
}

/** The call that changed a file and the path it changed. A person's undo
 *  is no call, so it is no turn's work. */
function changedFile(event: StoredFact): { readonly toolUseId: string; readonly path: string } | undefined {
  const fact = parseProjectionFact(event, parseFileMutationFact)
  if (fact.type !== "file.changed") return undefined
  const toolUseId = fact.version === 1 || fact.version === 2
    ? fact.payload.toolUseId
    : fact.payload.origin.kind === "tool_call" ? fact.payload.origin.toolUseId : undefined
  return toolUseId === undefined ? undefined : { toolUseId, path: fact.payload.displayPath }
}

function storedFacts(facts: readonly unknown[]): StoredFact[] {
  return facts.filter((fact): fact is StoredFact => !(fact instanceof Error))
}

/** Whether anything durable happened after the watermark. */
export function hasInterruptedWork(work: InterruptedWork): boolean {
  return work.finishedTools.length > 0 || work.unconfirmedTools.length > 0 || work.paths.length > 0
}

/** The record of an interrupted turn, written into the conversation at the
 *  point the interruption happened.
 *
 *  Phrased as history rather than as an instruction, because it stays in the
 *  branch: every later turn reads it in its chronological place, where a
 *  standing order to "continue where you left off" would be wrong. The list is
 *  capped because this is orientation, not an inventory, and the tool timeline
 *  holds the rest. */
export function interruptedWorkMessage(work: InterruptedWork, reason: InterruptedTurnReason = "crash"): string {
  const parts = [reason === "crash"
    ? "The process running this turn exited before the turn finished."
    : "The user interrupted this turn before it finished, and the process running it was ended to stop it."]
  if (work.finishedTools.length > 0) parts.push(`Tools that finished: ${summarize(work.finishedTools)}.`)
  if (work.unconfirmedTools.length > 0) {
    parts.push(`Tools that were called but whose results were lost, so they may not have run: ${summarize(work.unconfirmedTools)}.`)
  }
  if (work.paths.length > 0) parts.push(`Files that were already modified: ${summarize(work.paths)}.`)
  parts.push("Its reply was lost.", "Inspect the current state rather than assuming the work above is unfinished, and do not repeat work that finished.")
  return parts.join(" ")
}

/** Entry id for the record of the turn interrupted at `boundary` (the store
 *  position the sweep started after). It carries the reason like every
 *  turn-end record, and the projection moves its interruption boundary on
 *  the record's prefix so a second interruption before any new assistant
 *  work still gets its own record instead of colliding with this one.
 *
 *  Derived from the boundary rather than allocated, so two processes that
 *  recover the same interruption compute the same id and the second finds the
 *  record already there. Exactly-once without a lock: the id settles a
 *  concurrent double-write, and the boundary moving on the record's own
 *  commit settles every later interruption. */
export function interruptedTurnEntryId(boundary: number, reason: InterruptedTurnReason = "crash"): string {
  const end: TurnEnd = reason === "interrupted" ? { reason: "paused", pausedBy: "person" } : { reason }
  return turnEndEntryId(end, new Bun.CryptoHasher("sha256").update(`interrupted-turn:${boundary}`).digest("hex").slice(0, 8))
}

const SUMMARY_LIMIT = 12

function summarize(values: readonly string[]): string {
  const shown = values.slice(0, SUMMARY_LIMIT).join(", ")
  const remaining = values.length - SUMMARY_LIMIT
  return remaining > 0 ? `${shown}, and ${remaining} more` : shown
}
