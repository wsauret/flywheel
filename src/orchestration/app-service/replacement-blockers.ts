import { basename } from "node:path"
import { Schema } from "effect"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import { isActiveActivity } from "../../protocol/app-service-types.js"
import type { StatusView } from "../../protocol/status-protocol-types.js"
import type { DurableSessionCatalog } from "../session/session-catalog-types.js"
import type { SessionStore } from "../session-store/types.js"
import { entryActivity } from "../session-store/activity.js"
import type { FlywheelAppService } from "./app-service.js"
import type { CommandAdmission } from "./mutation-admission.js"
import type { ReplacementState } from "./replacement-owner.js"

/** What a unit of work in a project is doing, which keeps the project open
 *  and may delay a replacement:
 *  - `shell`: a foreground or background shell command is running.
 *  - `turn`: a chat turn is between its start and its next safe point.
 *  - `question`: a question the agent asked has no answer yet.
 *  - `subagent`: a subagent child is running.
 *  - `call`: an admitted mutation has not returned yet.
 *  - `opening`: the project's composition is still opening.
 *  - `recovery`: the project's state is being recovered after an executor exit.
 *  Every reason keeps a project from closing when idle, so a project with a
 *  running or adopted command stays open. Only `call`, `opening`, and
 *  `recovery` delay a replacement, because the cut cannot carry them across:
 *  a replacement interrupts turns, questions, children, and workflows, and
 *  the successor resumes them, and it hands every running shell command to
 *  the successor, which adopts it (PI-REMOTE-012). */
const ReplacementBlockerReasonSchema = Schema.Literals(["shell", "turn", "question", "subagent", "workflow", "call", "opening", "recovery"])

/** One unit of live work in one project (PI-REMOTE-012). The account service
 *  collects every blocker across every open project from its project
 *  executors, over the executor lifecycle frames: the idle reaper keeps a
 *  project open while any remains, and a replacement waits on those whose
 *  reason delays it and cuts or hands over the rest. No client ever sees it:
 *  a waiting replacement shows nothing. `sessionId` is
 *  absent for a blocker that is the project itself: it is still opening, or
 *  its state is still being recovered. */
export const ReplacementBlockerSchema = Schema.Struct({
  projectRoot: Schema.NonEmptyString,
  projectLabel: Schema.NonEmptyString,
  sessionId: Schema.optionalKey(Schema.NonEmptyString),
  workflowId: Schema.optionalKey(Schema.NonEmptyString),
  sessionTitle: Schema.optionalKey(Schema.String),
  reason: ReplacementBlockerReasonSchema,
})
export type ReplacementBlocker = typeof ReplacementBlockerSchema.Type
export type ReplacementBlockerReason = ReplacementBlocker["reason"]

/** Whether this blocker delays a replacement rather than being interrupted
 *  or handed over by it. */
export function delaysReplacement(blocker: ReplacementBlocker): boolean {
  return blocker.reason === "call" || blocker.reason === "opening" || blocker.reason === "recovery"
}

export function sameBlockers(a: readonly ReplacementBlocker[], b: readonly ReplacementBlocker[]): boolean {
  return a.length === b.length && a.every((blocker, index) => {
    const other = b[index]
    return other !== undefined && blocker.projectRoot === other.projectRoot && blocker.projectLabel === other.projectLabel
      && blocker.sessionId === other.sessionId && blocker.workflowId === other.workflowId && blocker.sessionTitle === other.sessionTitle && blocker.reason === other.reason
  })
}

/** How long the change watcher waits for further changes before it reports
 *  one. Calls start and end in bursts; the account needs one report per
 *  settled change, not one per call. */
const SETTLE_MS = 100

/** How long repeats of an unreadable project store count before one summary
 *  records them. The idle reaper and a held replacement ask every few
 *  seconds, so a project whose folder is gone would otherwise write a
 *  record each time. */
const UNREADABLE_STORE_WINDOW_MS = 60 * 60_000

const log = Log.create({ service: "replacement-blockers" })

/** The part of a session's published status its blocker reads. */
type SessionStatus = Pick<StatusView, "activity" | "activeForegroundBashToolCallIds" | "activeBackgroundCommands">

export interface ExecutorBlockerDeps {
  readonly runningWorkflows: () => readonly string[]
  readonly projectRoot: string
  readonly projectLabel: string
  /** The durable session catalog: metadata only, with no summary totals.
   *  It reads the project store. */
  readonly listMetadata: () => Promise<DurableSessionCatalog>
  /** The chats whose runner this executor's session store holds, each with
   *  the status its runner holds in memory. It reads neither the project
   *  store nor a background Worker. */
  readonly residents: () => ReadonlyMap<string, SessionStatus>
  /** The child sessions whose run an owner in this process holds right now. */
  readonly runningChildren: () => readonly { readonly sessionId: string }[]
  /** The sessions whose handed-over command the executor's keeper holds
   *  running, which no run and no active row may account for. */
  readonly keptSessions: () => readonly string[]
  /** The published status of each session asked for; absent for a session
   *  with no status. It can read the project store. */
  readonly statuses: (sessionIds: readonly string[]) => Promise<ReadonlyMap<string, SessionStatus | undefined>>
  readonly inFlightCalls: () => number
  /** Told whether each question could read the project store. */
  readonly storeHealth: { readonly failed: (error: unknown) => void; readonly recovered: () => void }
}

/** What this executor owns that is live (PI-REMOTE-012). Ownership, not
 *  records, decides: a child whose run an owner in this process holds, a
 *  runner whose activity is streaming, a turn parked on a question, a running
 *  shell command, the keeper's included, and an admitted call that has not
 *  returned. Of these only the call delays a replacement, and any of them
 *  keeps the project open, a shell command in an idle chat or a paused
 *  workflow included. One blocker per session names the first of these its
 *  session holds.
 *
 *  The question reads the durable metadata, the store, and the published
 *  statuses only. It never reads the client catalog, because that read admits
 *  summary totals, and a summary read starts the executor's background
 *  Worker. The account's idle reaper asks this question just before it closes
 *  a project, so such a read would start a Worker only to stop it.
 *
 *  A project store that cannot be read, such as one whose folder was deleted
 *  while the project was open, never fails the question. The answer then
 *  comes from this executor's memory alone: its children, its resident chats
 *  with the status each runner holds, its kept commands, and its admitted
 *  calls. So a call in flight still delays a replacement, a running turn
 *  still keeps the project open, and a project with no live work reads as
 *  idle, which lets the idle reaper close it and a replacement proceed. */
export async function collectReplacementBlockers(deps: ExecutorBlockerDeps): Promise<ReplacementBlocker[]> {
  const project = { projectRoot: deps.projectRoot, projectLabel: deps.projectLabel }
  const blockers: ReplacementBlocker[] = []
  const stored = await storedChats(deps).then(
    (chats) => { deps.storeHealth.recovered(); return chats },
    (error: unknown) => { deps.storeHealth.failed(error); return undefined },
  )
  // Children are not catalog rows (ARCH-PROTOCOL-048). A child blocks only while an
  // owner in this process holds its run: a durable run left open by a process
  // that is gone is a record, not work, and never keeps a project from going
  // idle.
  const running = deps.runningChildren()
  for (const workflowId of deps.runningWorkflows()) blockers.push({ ...project, workflowId, reason: "workflow" })
  if (running.length > 0) {
    const labels = new Map(stored?.sessions.map((session) => [session.id, session.label]))
    for (const { sessionId } of running) {
      const sessionTitle = labels.get(sessionId)
      blockers.push({ ...project, sessionId, ...(sessionTitle === undefined ? {} : { sessionTitle }), reason: "subagent" })
    }
  }
  const chats = stored?.chats ?? [...deps.residents()].map(([sessionId, status]) => ({ sessionId, sessionTitle: undefined, status }))
  for (const { sessionId, sessionTitle, status } of chats) {
    const reason = sessionReason(status)
    if (reason) blockers.push({ ...project, sessionId, ...(sessionTitle === undefined ? {} : { sessionTitle }), reason })
  }
  for (const sessionId of deps.keptSessions()) {
    if (!blockers.some((blocker) => blocker.sessionId === sessionId)) blockers.push({ ...project, sessionId, reason: "shell" })
  }
  if (deps.inFlightCalls() > 0) blockers.push({ ...project, reason: "call" })
  return blockers
}

/** The chats the project store names, each with its published status. A
 *  chat is one when its runner is resident here, whatever its metadata
 *  says: some paths attach a runner and start a turn with no lifecycle
 *  write. A chat is also one when its metadata states it active, which
 *  covers a continuation that no resident runner holds yet. */
async function storedChats(deps: ExecutorBlockerDeps) {
  const { sessions } = await deps.listMetadata()
  const residents = deps.residents()
  const active = sessions.filter((session) => session.kind === "chat" && (session.lifecycleState === "active" || residents.has(session.id)))
  const statuses = await deps.statuses(active.map((session) => session.id))
  return {
    sessions,
    chats: active.map((session) => ({ sessionId: session.id, sessionTitle: session.label, status: statuses.get(session.id) })),
  }
}

/** The chats whose runner the session store holds, with the status each
 *  runner holds in memory: the fields the published status copies from it. */
function residentChats(store: Pick<SessionStore, "allIds" | "get">): ReadonlyMap<string, SessionStatus> {
  const residents = new Map<string, SessionStatus>()
  for (const sessionId of store.allIds()) {
    const entry = store.get(sessionId)
    if (entry?.kind !== "chat") continue
    residents.set(sessionId, { activity: entryActivity(entry), activeForegroundBashToolCallIds: entry.activeForegroundBashToolCallIds, activeBackgroundCommands: entry.activeBackgroundCommands })
  }
  return residents
}

function sessionReason(status: SessionStatus | undefined): ReplacementBlockerReason | undefined {
  if ((status?.activeForegroundBashToolCallIds.length ?? 0) > 0
    || status?.activeBackgroundCommands.some((command) => command.model === undefined)) return "shell"
  if (status?.activity === "awaiting_user") return "question"
  return isActiveActivity(status?.activity) ? "turn" : undefined
}

export interface BlockerChangeWatchDeps {
  readonly admission: Pick<CommandAdmission, "onOccupancyChange">
  readonly notify: () => void
  readonly settleMs?: number
}

/** Reports, coalesced, every change that can move this executor's delaying
 *  blockers: the admission gate going busy or idle. No session's work, a
 *  running command included, delays a replacement, so nothing else is
 *  watched. Only installed while the account holds a replacement, so an
 *  idle service pays nothing for it. */
export function watchReplacementBlockerChanges(deps: BlockerChangeWatchDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = (): void => {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = undefined
      deps.notify()
    }, deps.settleMs ?? SETTLE_MS)
    timer.unref?.()
  }
  const stopOccupancy = deps.admission.onOccupancyChange(schedule)
  return () => {
    stopped = true
    clearTimeout(timer)
    timer = undefined
    stopOccupancy()
  }
}

export interface ReplacementReportDeps {
  readonly runningWorkflows: ExecutorBlockerDeps["runningWorkflows"]
  readonly projectRoot: string
  /** The account registry's label for this project, carried by every blocker
   *  this executor reports. Defaults to the directory name. */
  readonly projectLabel: string | undefined
  readonly listMetadata: ExecutorBlockerDeps["listMetadata"]
  readonly runningChildren: ExecutorBlockerDeps["runningChildren"]
  readonly keptSessions: ExecutorBlockerDeps["keptSessions"]
  /** The executor's session store, whose resident chats the report reads. */
  readonly sessionStore: Pick<SessionStore, "allIds" | "get">
  /** The service whose status views and admission gate the report reads. */
  readonly client: Pick<FlywheelAppService, "query" | "admission">
}

export interface ReplacementReport {
  /** What this project owns that is live; empty means idle (PI-REMOTE-012). */
  blockers(): Promise<ReplacementBlocker[]>
  /** The account's replacement state, as its owner last published it. It
   *  starts or stops this executor's change watch and publishes nothing to
   *  clients: a waiting replacement is invisible (PI-REMOTE-012). */
  set(state: ReplacementState): void
  /** The handoff of the account's cut, once this executor has heard it: from
   *  the `draining` state, or from the cut itself, which can reach this
   *  executor before that state does. A drain is not cancelled, so the id
   *  stays heard. */
  handoffId(): string | undefined
  /** The cut of `handoffId` has reached this executor. */
  hear(handoffId: string): void
  /** Told, coalesced, when this project's blockers may have changed while a
   *  replacement is held. */
  onChange(listener: () => void): () => void
  /** Ends the change watch; admission is closing and nothing reports after it. */
  stop(): void
}

/** One executor's side of the replacement hold: it answers the account's
 *  blocker question and reports its own changes while a replacement is held. */
export function createReplacementReport(deps: ReplacementReportDeps): ReplacementReport {
  const projectLabel = deps.projectLabel ?? (basename(deps.projectRoot) || deps.projectRoot)
  const listeners = new Set<() => void>()
  let stopWatch: (() => void) | undefined
  let heard: string | undefined
  // A store that stays unreadable fails every question, so its first failure
  // records and the repeats count until a read succeeds or the window closes.
  const unreadable = coalesceRepeats<string>({
    windowMs: UNREADABLE_STORE_WINDOW_MS,
    first: (_store, error) => { log.warn("the project store could not be read; its blockers come from the executor's memory", { projectRoot: deps.projectRoot, error }) },
    repeated: (_store, repeats) => { log.warn("the project store could not be read again", { projectRoot: deps.projectRoot, count: repeats.count, windowMs: repeats.windowMs }) },
  })
  const storeHealth = {
    failed: (error: unknown) => unreadable.observe("store", errorMessage(error)),
    recovered: () => unreadable.end("store"),
  }
  const stop = (): void => {
    stopWatch?.()
    stopWatch = undefined
    unreadable.end()
  }
  return {
    blockers: () => collectReplacementBlockers({
      projectRoot: deps.projectRoot, projectLabel,
      listMetadata: deps.listMetadata, runningChildren: deps.runningChildren, keptSessions: deps.keptSessions,
      runningWorkflows: deps.runningWorkflows,
      residents: () => residentChats(deps.sessionStore),
      statuses: async (sessionIds) => new Map((await deps.client.query({ type: "statusSnapshot", sessionIds })).views.map((entry) => [entry.sessionId, entry.view ?? undefined])),
      inFlightCalls: () => deps.client.admission.inFlight,
      storeHealth,
    }),
    set(state) {
      if (state.kind === "draining") heard = state.handoffId
      // Changes are watched only while the account holds a replacement: the
      // idle reaper reads blockers on its own clock and needs no reports.
      if (state.kind === "none") return stop()
      stopWatch ??= watchReplacementBlockerChanges({
        admission: deps.client.admission,
        notify: () => { for (const listener of listeners) listener() },
      })
    },
    handoffId: () => heard,
    hear(handoffId) { heard = handoffId },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    stop,
  }
}
