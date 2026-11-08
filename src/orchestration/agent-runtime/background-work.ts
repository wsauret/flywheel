/**
 * Background-task registry. Callers register a Promise plus metadata; the
 * registry owns the rest of the lifecycle (stall watchdog timer, completion
 * notification XML).
 *
 * Registries coalesce subagents that settle in the same event-loop turn.
 * Completed work remains owed until its notification commits to the conversation.
 *
 * The registry is runtime-only. Any model-visible result derived from a
 * notification must flow through existing durable channels
 * (SQLite chat tree facts, session runtime events, subagent artifacts).
 */

import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import type { MutationEvidence } from "../../infra/mutation-evidence.js";
import type { PausedBy } from "../../infra/output-blocks.js";
import type { BackgroundCommandRecord } from "../../infra/runtime-fact-types.js";
import {
  createBackgroundNotificationDelivery,
  completionWorkIds,
  formatChildInterruptedNotification,
  formatStandaloneNotification,
  formatSubagentNotificationBatch,
  retireCompletedSubagents,
  type BackgroundNotificationEntry,
} from "./background-work-notifications.js";
import { commandIndexRecord, createBackgroundProcessTable, type BackgroundOutputRequest, type BackgroundProcessRecord, type BackgroundWorkOutput, type CommandExit } from "./background-work-processes.js";
import type { ManagedCommand } from "./tools/managed-command.js";
import type { BackgroundWorkProgress, WorkReference } from "./background-work-progress.js";
import { backgroundHandoffBlock, awaitedWork as awaits, waitableWork as waitable, type HandoffBlock } from "./background-work-readiness.js";
import { backgroundWorkOutcome } from "./background-work-outcome.js";

const log = Log.create({ service: "background-work" });

export interface BackgroundWorkResult {
  /** `partial`: the work stopped at its turn budget and `content` is what it
   *  had, not a completion. The parent decides whether to retask or accept. */
  /** `stopped`: a person ended the work with Stop; `cancelled`: the
   *  requesting agent did. Both are terminal and never resume. */
  /** `interrupted`: a person, the parent agent, or the runtime interrupted a child run. The run
   *  has not ended: it keeps its parent binding and can resume (ARCH-SESSIONS-018). */
  status: "completed" | "partial" | "failed" | "cancelled" | "stopped" | "interrupted";
  /** Who interrupted an `interrupted` child run: a person, its parent
   *  agent, or the runtime. Absent for a planned replacement's cut, which
   *  the successor resumes without a notice. */
  interruptedBy?: PausedBy;
  content: string;
  /** A wait's notice that a route may deliver with the parked tool results it follows (`ConversationMessage`
   *  `runtimeNotice`): only a reply wait's end without a reply sets it. */
  runtimeNotice?: true;
  /** Internal retry admission evidence. Present only for a model-run failure. */
  modelFailure?: true;
  executionOutputTail?: string;
  /** A background command has one exactly when its exit was observed. One
   *  without it ended with no recorded outcome, as in a crash. */
  exit?: CommandExit;
  /** What a mutating command published to the project when it exited. The
   *  registry records it with the settled tail, against the original tool
   *  call, so that call's row and per-file undo find it. */
  mutationEvidence?: MutationEvidence;
  usage?: {
    totalTokens: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
    reasoningTokens?: number;
    totalCostUsd?: number;
    toolUses: number;
    durationMs: number;
  };
}

/** The result of work that ended. An interrupted run has not ended, so it
 *  never records a completion. */
export type EndedWorkResult = BackgroundWorkResult & { readonly status: Exclude<BackgroundWorkResult["status"], "interrupted"> };

/** Identity pair of the originating tool call. Deferred facts written after
 *  dispatch (live output tails, terminal results, background meta) echo the
 *  identity the call's tool.input.completed fact carries so the
 *  tool-execution projection can match them to that call. */
export interface ToolCallIdentity {
  parentToolUseId?: string;
  modelRequestId?: string;
}

interface BackgroundWorkMetaBase extends ToolCallIdentity {
  id: string;
  type: string;
  description: string;
  toolUseId?: string;
  /** Durable child runs publish through cross-session reconciliation. */
  settlementOwner?: "child_session";
  /** The key the completion publishes under, so a repeat of it commits once. */
  notificationKey?: string;
}

export type BackgroundWorkMeta = BackgroundWorkMetaBase & (
  | { model: string; effort?: string; roleSessionId?: string }
  | { model?: never; effort?: never; roleSessionId?: never }
);

/** Stable per-id snapshot of a stoppable background task. Every field is
 *  constant for the lifetime of the id, so the id list is the identity. */
interface ActiveBackgroundCommandDescriptorBase {
  id: string;
  description: string;
  toolUseId: string;
  startedAtMs: number;
}

export type ActiveBackgroundCommandDescriptor = ActiveBackgroundCommandDescriptorBase & (
  | { model: string; effort?: string; roleSessionId?: string }
  | { model?: never; effort?: never; roleSessionId?: never }
);

interface StallWatchdog {
  /** Reads the task owner's current activity before an expired clock can abort it. */
  isIdle: () => boolean;
  abort: () => void;
  timeoutMs: number;
}

/** Handle returned by `track()`. `bump()` resets the stall watchdog timer;
 *  callers should invoke it whenever the underlying task makes observable
 *  progress (e.g. a subagent emits an event). Without bumping, the watchdog
 *  is a flat wall-clock kill switch. A watchdog fires once; `rearm()` arms it
 *  again for work that continues after its stall, such as a subagent whose
 *  stalled generation restarts. */
interface TrackHandle {
  bump: () => void;
  rearm: () => void;
}

/** How a task dies: `run` stops the underlying work. The registry invokes it
 * at most once for targeted termination or host-owned teardown. */
export type BackgroundKillSource = "agent" | "user" | "runtime";

/** How a request to stop a task was decided: this request began its stop, a
 *  stop of it was already under way, or nothing here can stop it because it
 *  is unknown, settled, or has no kill control. */
type StopDecision = "requested" | "under_way" | "refused";

interface KillControl {
  run: (source: BackgroundKillSource) => void | Promise<void>;
}

/** Who interrupted a tracked child now, as the child's own runner reports
 *  it, or nothing while it is not interrupted. A child that its parent agent
 *  or the runtime interrupted is not active work: no wait parks on it, and a
 *  handoff does not wait for it. A child that a person interrupted stays the
 *  parent's active work (PI-AGENT-025). A Resume makes it active work again. */
export interface ChildInterruption {
  interruptedBy(): PausedBy | undefined;
  /** Calls `listener` on each change of `interruptedBy`, until the returned
   *  function ends the observation. */
  observe(listener: () => void): () => void;
}

/** A child's completion that reconciliation holds durably under `key`. */
interface DurableSubagentNotification {
  readonly key?: string;
  readonly text: string;
  readonly completionRunIds?: readonly string[];
}

interface TrackArgs {
  done: Promise<BackgroundWorkResult>;
  meta: BackgroundWorkMeta;
  stall?: StallWatchdog;
  kill?: KillControl;
  /** Reads and formats one bounded request against the task's retained output.
   * Supplied only by producers with a pull-readable output stream. */
  readOutput?: (request: BackgroundOutputRequest) => Promise<string>;
  /** A detached task belongs to another durable session. Host teardown drops
   * this observer without killing or awaiting that session. */
  hostClose?: "detach";
  /** When the work started, for work that started before this registry. */
  startedAtMs?: number;
  /** A child session's interrupt as its runner reports it, for a child that
   *  an interrupt leaves running in place, such as a workflow. A subagent
   *  settles its task as `interrupted` instead. */
  interruption?: ChildInterruption;
  /** The task is a wait that the turn parks on, such as a reply wait, not a
   *  command: no live command list shows it, and its result is its own
   *  notice, with no notice for an empty result. */
  wait?: true;
  /** The task is a service that the agent started to keep running, such as
   *  a server: a command launched with `background=true`. It does not hold
   *  automatic completion, but an explicit process wait includes it. The
   *  host's close ends it. A command that left its tool call still running is
   *  finite work, not a service. */
  service?: true;
  /** The managed command a background command task is: its log, its hard
   *  deadline, and, while it runs and this host owns it, what a planned
   *  replacement's close hands to the next build. Its process record keeps
   *  it for as long as the record lasts. */
  command?: ManagedCommand;
}

interface TaskLifecycle extends BackgroundWorkProgress {
  /** Ended work whose notification has not yet committed to the conversation:
   *  the part of `awaitedTaskCount` that only a turn can retire. */
  pendingDeliveryCount(): number;
  /** Snapshot of active background tasks available for targeted control. */
  activeBackgroundCommands(): ActiveBackgroundCommandDescriptor[];
  /** Reads the retained output of one active task through the reader its
   *  producer supplied. `unknown` covers settled and never-known ids alike;
   *  `unsupported` names a live task with no pull-readable output. */
  readTaskOutput(toolUseId: string, request: BackgroundOutputRequest): Promise<BackgroundWorkOutput>;
  /** Session-scoped active and settled process records, keyed by task metadata id. */
  processRecords(): BackgroundProcessRecord[];
  processRecord(processId: string): BackgroundProcessRecord | undefined;
  /** The managed command a session process is, running or settled, for as
   *  long as its record lasts; absent for every other kind of task. */
  processCommand(processId: string): ManagedCommand | undefined;
  readProcessOutput(processId: string, request: BackgroundOutputRequest): Promise<BackgroundWorkOutput>;
  /** Awaits the canonical terminal promise for one session process. The wait is
   * event-driven and bounded; false means unknown, aborted, or timed out. */
  waitProcess(processId: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<boolean>;
  /** Session-scoped live channel for a running command's output tail. The
   *  per-turn `ToolContext.onExecutionOutput` channel dies with its turn; a
   *  command's tail outlives turns and runners, in the foreground hold and
   *  after it moves to the background, so it streams here. A running tail is
   *  in-flight state, not history: it is shown live and never recorded, and
   *  the durable record is the settled tail the registry publishes when the
   *  command settles. */
  streamExecutionOutput(toolUseId: string, output: string, identity?: ToolCallIdentity): void;
  /** Records the settled tail, the project edits, and the outcome of work
   *  that ended while no host of this registry tracked it, as the
   *  settlement of tracked work records them, with no notification: the
   *  completion reaches its conversation through the handover row. The caller
   *  awaits an asynchronous recorder's durability acknowledgement before
   *  retiring that row. A command whose supervisor recorded no exit gets no outcome. */
  recordSettlement(meta: BackgroundWorkMeta, result: BackgroundWorkResult, timing: SettlementTiming): void | Promise<void>;
  /** Delivers a subagent notification only after reconciliation has atomically
   * settled its parent tool call and durable mailbox cell. Returns the receipt
   * that settles once the conversation commits the notification and this
   * registry retires the runs it covers, or undefined when the registry admits
   * no more notifications. A repeat of a pending key joins its receipt. */
  deliverDurableSubagentNotification(notification: DurableSubagentNotification): Promise<void> | undefined;
  /** True while this live owner holds the keyed commit receipt, including retries. */
  ownsNotification(key: string): boolean;
  /** Fences delivery callbacks and settles accepted durable hold admissions. */
  closeNotifications(): Promise<void>;
  /** Forgets the settled child runs that a durable notification delivered
   *  past this registry, such as reconciliation that reaches the runner after
   *  a person stopped or deleted a paused child. Without it the run stays
   *  counted, and the parent parks as if it still waited on that child. */
  retireDeliveredSubagents(runIds: readonly string[]): void;
  /** Stops serving the host: no new work is admitted, and no notification is
   *  delivered, because the host that would read one is closing. `track()` from
   *  here on registers what it is given and terminates it at once, so a task
   *  that arrives while its host closes cannot outlive that host. Idempotent. */
  stopAdmission(): void;
  /** Terminates the background task associated with a tool use. Returns true
   *  only when this call requested a new kill; false means the task is unknown,
   *  settled, or already stopping. */
  terminate(toolUseId: string): boolean;
  terminateProcess(processId: string, source: BackgroundKillSource): StopDecision;
  /** Drops the observer of one live task, and its process record, without
   *  killing it or publishing its completion, for work another owner took
   *  over. False when the task is not live here. */
  detach(processId: string): boolean;
  /** Every running command a planned replacement's close can hand over. */
  handoverCandidates(): ManagedCommand[];
  /** Terminates all controllable tasks and waits for every tracked task to settle. */
  terminateAll(): Promise<void>;
}

interface SettledNotificationFlush {
  /** Delivers the batch of subagents that have already settled, now, instead of
   *  when its timer fires.
   *
   *  A settled batch waits on a timer so subagents finishing together arrive as
   *  one notification. That wait is only ever an optimisation, and a caller
   *  about to start a turn must not let it decide ordering: a message the user
   *  sends first would otherwise reach the model on its own, and the
   *  notification would follow as a turn of its own -- one more model request,
   *  carrying nothing but runtime data, after the model already answered
   *  without it. Idempotent, and a no-op when nothing has settled. */
  flushSettledNotifications(): void;
}

interface ChatRegistry extends TaskLifecycle, SettledNotificationFlush {
  kind: "chat";
  assertHandoffReady(): HandoffBlock | null;
  track(args: TrackArgs): TrackHandle;
}

interface WorkflowRegistry extends TaskLifecycle, SettledNotificationFlush {
  kind: "workflow";
  track(args: TrackArgs): TrackHandle;
  /** Returns owned work that is still active, including a running service,
   *  or whose result has not reached the model; null only when handoff can
   *  safely terminate this runner. A child that the parent agent or the
   *  runtime interrupted is not active work, so it never blocks a handoff. */
  assertHandoffReady(): HandoffBlock | null;
}

export type BackgroundWorkRegistry = ChatRegistry | WorkflowRegistry;

/** The host surface that admits child work without exposing registry lifecycle controls. */
export type BackgroundWorkTracking = Pick<BackgroundWorkRegistry, "track" | "detach" | "processRecord" | "liveWorkReferences" | "awaitedTaskCount" | "pendingDeliveryCount" | "observeWorkChanges" | "deliverDurableSubagentNotification" | "ownsNotification">;

/** Whether a handoff block waits for result delivery. Services alone require
 *  cleanup, not an automatic park; explicit process waits include them. */
export function awaitsWork(block: HandoffBlock | null | undefined): boolean {
  return block ? block.active + block.pending > 0 : false;
}

interface ActiveEntry {
  meta: BackgroundWorkMeta;
  done: Promise<BackgroundWorkResult>;
  stall: StallWatchdog | undefined;
  kill: KillControl | undefined;
  readOutput: ((request: BackgroundOutputRequest) => Promise<string>) | undefined;
  interruption: ChildInterruption | undefined;
  /** Ends the observation of `interruption` when the entry leaves. */
  stopObservingInterruption: (() => void) | undefined;
  startedAtMs: number;
  hostClose: "detach" | undefined;
  wait: boolean;
  service: boolean;
  /** Who asked for the stop that is under way, or undefined while none is.
   *  `requestStop` is its one writer. It names a stopped command's outcome,
   *  and the task's process record reads it as `stopping`. */
  stopRequestedBy: BackgroundKillSource | undefined;
  suppressNotification: boolean;
  stallTimer: ReturnType<typeof setTimeout> | null;
  stallFired: boolean;
}

interface RegistryOptions {
  kind: "chat" | "workflow";
  /** Delivers one notification into the host's conversation. `key` names the
   *  notification's durable hold: reconciliation already holds a child's
   *  completion under it, and a command's completion is held under it on its
   *  way in. The sink must hold and commit the message under that key, so the
   *  commit retires the hold and a repeat under the key commits once. A sink
   *  that drops the key leaves the hold for a later drain to deliver a second
   *  time. `runtimeNotice` is true for a notice of the closed set that a route may deliver with the parked tool
   *  results it follows (`ConversationMessage` `runtimeNotice`): a child's completion, stop, or runtime interrupt, and
   *  a reply wait's end without a reply. A command's completion and every other wait's end are false. */
  enqueueNotification: ((text: string, key?: string, runtimeNotice?: boolean) => void) | ((text: string, key?: string, runtimeNotice?: boolean) => Promise<void>);
  /** Initial delivery retry delay; tests can shorten it without a fake clock. */
  notificationRetryMs?: number;
  settleNotificationAdmission?: () => Promise<void>;
  /** Chat owns queued input in its mailbox, not a workflow pending bucket. */
  pendingInput?: () => boolean;
  onChange?: (commands: readonly ActiveBackgroundCommandDescriptor[]) => void;
  /** A running command's current tail, for live display only. */
  onExecutionOutput?: (toolUseId: string, output: string, identity: ToolCallIdentity) => void;
  /** A settled command's tail and project edits. An asynchronous recorder
   * acknowledges durability so handover recovery can retain its evidence on failure. */
  onExecutionOutputRecorded?: (toolUseId: string, output: string, identity: ToolCallIdentity, mutation: SettledProjectMutation) => void | Promise<void>;
  /** A background command as it starts and as it settles, which the owner
   *  records durably for the background index of its session. */
  onCommandRecorded?: (record: BackgroundCommandRecord) => void;
}

/** When settled work started and ended. */
interface SettlementTiming {
  readonly startedAtMs: number;
  readonly settledAtMs: number;
}

/** The project edits a settled command published, recorded with its tail. */
export type SettledProjectMutation = Pick<BackgroundWorkResult, "mutationEvidence">;

function clearStall(entry: ActiveEntry): void {
  if (entry.stallTimer) {
    clearTimeout(entry.stallTimer);
    entry.stallTimer = null;
  }
}

function identityOf(meta: BackgroundWorkMeta): ToolCallIdentity {
  return {
    ...(meta.parentToolUseId ? { parentToolUseId: meta.parentToolUseId } : {}),
    ...(meta.modelRequestId ? { modelRequestId: meta.modelRequestId } : {}),
  };
}

interface CompletedEntry extends BackgroundNotificationEntry {
  meta: BackgroundWorkMeta;
}

export function createBackgroundWorkRegistry(opts: RegistryOptions & { kind: "chat" }): ChatRegistry;
export function createBackgroundWorkRegistry(opts: RegistryOptions & { kind: "workflow" }): WorkflowRegistry;
export function createBackgroundWorkRegistry(opts: RegistryOptions): BackgroundWorkRegistry;
export function createBackgroundWorkRegistry(opts: RegistryOptions): BackgroundWorkRegistry {
  const active = new Map<string, ActiveEntry>();
  const completedSubagents: CompletedEntry[] = [];
  const processes = createBackgroundProcessTable();
  const lastExecutionOutputs = new Map<string, string>();
  let publishedIds = "";
  let admitting = true;
  const notifications = createBackgroundNotificationDelivery(opts.enqueueNotification, notifyChange, opts.notificationRetryMs);
  const { enqueueNotification, pendingWork, hasPending: notificationIsPending } = notifications;

  // A subagent that a person interrupted settled its run, but it stays the
  // parent's work until its Resume tracks it again or its end reaches the
  // parent through reconciliation (PI-AGENT-025).
  const interruptedByPerson = new Map<string, ActiveEntry>();
  const parentWork = (): ActiveEntry[] => [...active.values(), ...interruptedByPerson.values()];
  const workListeners = new Set<() => void>();
  const outstanding = () => {
    const live = parentWork();
    const liveIds = new Set(live.map(({ meta }) => meta.id));
    const pending = [...new Map([...completedSubagents.map(({ meta }) => meta), ...pendingWork()].map((work) => [work.id, work])).values()];
    return { live, pending: pending.filter(({ id }) => !liveIds.has(id)) };
  };

  const activeSubagentCount = (): number => parentWork().filter((entry) => entry.meta.type === "subagent").length;

  const liveWorkReferences = (): WorkReference[] => {
    const work = outstanding();
    return [
    ...work.live.filter((entry) => !entry.wait && awaits(entry)).map(({ meta }): WorkReference => {
      if (meta.type === "subagent" && meta.roleSessionId) return { kind: "session", sessionId: meta.roleSessionId };
      return meta.type === "workflow" ? { kind: "workflow", workflowId: meta.id } : { kind: "command", processId: meta.id };
    }),
    ...work.pending.map(({ id }): WorkReference => ({ kind: "command", processId: id })),
    ];
  };

  function track(args: TrackArgs, onSettled: (entry: ActiveEntry, result: BackgroundWorkResult, settledCleanly: boolean) => void): TrackHandle {
    // One id names one live task. A second registration for a live id would
    // strand the first task's watchdog, kill control and notification, so it is
    // refused before any of this one exists.
    if (active.has(args.meta.id)) throw new Error(`Background task ${args.meta.id} is already active`);
    const priorProcess = processes.record(args.meta.id)
    if (priorProcess) {
      const resumableChild = args.meta.settlementOwner === "child_session"
        && (priorProcess.kind === "subagent" || priorProcess.kind === "workflow")
        && priorProcess.status !== "running"
        && priorProcess.status !== "stopping"
      if (!resumableChild) throw new Error(`Background task ${args.meta.id} is already known in this session`)
      const priorToolUseId = processes.forget(args.meta.id)
      if (priorToolUseId) lastExecutionOutputs.delete(priorToolUseId)
    }
    // A child that a person interrupted and resumed runs again as this entry.
    // The process table keeps a bounded history, so its record may be gone.
    interruptedByPerson.delete(args.meta.id)
    const entry: ActiveEntry = {
      meta: args.meta,
      done: args.done,
      stall: args.stall,
      kill: args.kill,
      readOutput: args.readOutput,
      interruption: args.interruption,
      stopObservingInterruption: undefined,
      startedAtMs: args.startedAtMs ?? Date.now(),
      hostClose: args.hostClose,
      wait: args.wait === true,
      service: args.service === true,
      stopRequestedBy: undefined,
      suppressNotification: false,
      stallTimer: null,
      stallFired: false,
    };
    const stall = args.stall;
    const armStall = () => {
      if (!stall) return;
      entry.stallTimer = setTimeout(() => {
        if (!stall.isIdle()) {
          armStall();
          return;
        }
        entry.stallFired = true;
        log.warn("background task stall watchdog fired", {
          id: args.meta.id, type: args.meta.type, description: args.meta.description, timeoutMs: stall.timeoutMs,
        });
        stall.abort();
      }, stall.timeoutMs);
    };
    armStall();
    active.set(args.meta.id, entry);
    entry.stopObservingInterruption = args.interruption?.observe(() => { interruptionChanged(entry); });
    processes.admit({
      id: args.meta.id,
      type: args.meta.type,
      description: args.meta.description,
      startedAtMs: entry.startedAtMs,
      toolUseId: args.meta.toolUseId,
      readOutput: args.readOutput,
      command: args.command,
      done: args.done,
      stopRequested: () => entry.stopRequestedBy !== undefined,
    });
    recordCommand(commandIndexRecord(args.meta, entry.startedAtMs));
    notifyChange();

    const settle = (outcome: { ok: true; result: BackgroundWorkResult } | { ok: false; err: unknown }) => {
      clearStall(entry);
      if (!active.has(args.meta.id)) return;
      active.delete(args.meta.id);
      entry.stopObservingInterruption?.();
      const result = backgroundWorkOutcome({
        description: entry.meta.description, stallFired: entry.stallFired, stallTimeoutMs: entry.stall?.timeoutMs,
        killedBy: entry.stopRequestedBy,
      }, outcome);
      const evictedToolUseId = processes.settle(args.meta.id, { status: result.status, exit: result.exit });
      if (evictedToolUseId) lastExecutionOutputs.delete(evictedToolUseId);
      // A command the host tore down ended too, so its outcome is recorded
      // even when no notification is. The record goes before the change, so
      // an index read for the change does not find the command running with
      // no owner and show it as ended.
      recordCommand(commandIndexRecord(entry.meta, entry.startedAtMs, { result, settledAtMs: Date.now() }));
      notifyChange();
      if (entry.suppressNotification) return;
      recordSettledOutput(entry.meta, result);
      onSettled(entry, result, outcome.ok);
      notifyChange();
    };

    args.done.then(
      (result) => settle({ ok: true, result }),
      (err) => settle({ ok: false, err }),
    );

    // Admission can close while a task is launching. Host-owned work dies at
    // once; session-owned work only loses this host's observer.
    if (!admitting) {
      entry.suppressNotification = entry.meta.type !== "background_command";
      if (entry.hostClose === "detach") detach(args.meta.id);
      else requestStop(entry, "runtime", false);
    }

    return {
      bump: () => {
        if (!stall) return;
        if (entry.stallFired) return;
        if (!active.has(args.meta.id)) return;
        clearStall(entry);
        armStall();
      },
      rearm: () => {
        if (!stall || !active.has(args.meta.id)) return;
        entry.stallFired = false;
        clearStall(entry);
        armStall();
      },
    };
  }

  /** Tells the parent that the runtime interrupted one of its children. The
   *  child no longer holds a wait, so the notice is also what wakes a park
   *  that waited only on it. The parent's own interrupt needs no notice: its
   *  call's result says so. A person's interrupt and Resume send none: the
   *  child stays the parent's work (PI-AGENT-025). */
  function announceInterruption(entry: ActiveEntry, by: PausedBy | undefined): void {
    if (by !== "runtime" || !admitting || entry.suppressNotification) return;
    const sessionId = entry.meta.type === "subagent" ? entry.meta.roleSessionId : entry.meta.id;
    log.info("child interruption announced to its parent", { id: entry.meta.id, type: entry.meta.type });
    opts.enqueueNotification(formatChildInterruptedNotification({ description: entry.meta.description, ...(sessionId ? { sessionId } : {}) }), undefined, true);
  }

  function interruptionChanged(entry: ActiveEntry): void {
    if (active.get(entry.meta.id) !== entry) return;
    notifyChange();
    announceInterruption(entry, entry.interruption?.interruptedBy());
  }

  function activeBackgroundCommands(): ActiveBackgroundCommandDescriptor[] {
    const commands: ActiveBackgroundCommandDescriptor[] = [];
    for (const entry of active.values()) {
      if (entry.meta.toolUseId === undefined || entry.wait) continue;
      // A shell stop is a request, not process settlement. Keep its live
      // descriptor until `done` settles so the project stays open for it.
      if (!entry.kill || (entry.stopRequestedBy !== undefined && entry.meta.type !== "background_command")) continue;
      const descriptor = {
        id: entry.meta.id,
        description: entry.meta.description,
        toolUseId: entry.meta.toolUseId,
        startedAtMs: entry.startedAtMs,
      };
      if (entry.meta.model === undefined) {
        commands.push(descriptor);
      } else {
        commands.push({
          ...descriptor,
          model: entry.meta.model,
          ...(entry.meta.effort === undefined ? {} : { effort: entry.meta.effort }),
          ...(entry.meta.roleSessionId === undefined ? {} : { roleSessionId: entry.meta.roleSessionId }),
        });
      }
    }
    return commands;
  }

  async function readTaskOutput(toolUseId: string, request: BackgroundOutputRequest): Promise<BackgroundWorkOutput> {
    for (const entry of active.values()) {
      if (entry.meta.toolUseId !== toolUseId) continue;
      if (!entry.readOutput) return { ok: false, reason: "unsupported" };
      return { ok: true, text: await entry.readOutput(request) };
    }
    return { ok: false, reason: "unknown" };
  }

  function notifyChange(): void {
    for (const listener of workListeners) listener();
    const next = activeBackgroundCommands();
    // Descriptor fields are constant per id, so the id list is the identity.
    const ids = next.map((command) => command.id).join("\n");
    if (ids === publishedIds) return;
    publishedIds = ids;
    opts.onChange?.(next);
  }

  function recordKillFailure(entry: ActiveEntry, err: Error, retryable: boolean): void {
    log.warn("background task kill failed", {
      id: entry.meta.id,
      type: entry.meta.type,
      description: entry.meta.description,
      error: errorMessage(err),
    });
    if (!retryable) return;
    entry.stopRequestedBy = undefined;
    notifyChange();
  }

  /** The one transition of a task's stop request. Every stop, whether a
   *  person's, the agent's, or the runtime's, goes through it. */
  function requestStop(entry: ActiveEntry, source: BackgroundKillSource, retryable: boolean): StopDecision {
    if (!entry.kill) return "refused";
    if (entry.stopRequestedBy !== undefined) return "under_way";
    entry.stopRequestedBy = source;
    try {
      void Promise.resolve(entry.kill.run(source)).catch((err) => { recordKillFailure(entry, err instanceof Error ? err : new Error(String(err)), retryable); });
    } catch (err) {
      recordKillFailure(entry, err instanceof Error ? err : new Error(String(err)), retryable);
      return "refused";
    }
    notifyChange();
    return "requested";
  }

  function terminate(toolUseId: string): boolean {
    for (const entry of active.values()) {
      if (entry.meta.toolUseId !== toolUseId) continue;
      return requestStop(entry, "user", true) === "requested";
    }
    return false;
  }

  function terminateProcess(processId: string, source: BackgroundKillSource): StopDecision {
    const entry = active.get(processId);
    return entry ? requestStop(entry, source, true) : "refused";
  }

  function detach(processId: string): boolean {
    const entry = active.get(processId);
    if (!entry) return false;
    entry.suppressNotification = true;
    clearStall(entry);
    active.delete(processId);
    entry.stopObservingInterruption?.();
    // The task is another owner's from now on, so no record of it here says
    // it runs.
    processes.forget(processId);
    notifyChange();
    return true;
  }

  function stopAdmission(): void {
    admitting = false;
    interruptedByPerson.clear();
    for (const entry of active.values()) entry.suppressNotification = entry.meta.type !== "background_command";
  }

  async function terminateAll(): Promise<void> {
    const owned: ActiveEntry[] = [];
    interruptedByPerson.clear();
    for (const [id, entry] of active) {
      if (entry.hostClose === "detach") {
        detach(id);
        continue;
      }
      entry.suppressNotification = entry.meta.type !== "background_command";
      owned.push(entry);
      requestStop(entry, "runtime", false);
    }
    notifyChange();
    await Promise.allSettled(owned.map((entry) => entry.done));
    processes.clear();
    lastExecutionOutputs.clear();
  }

  function recordCommand(record: BackgroundCommandRecord | undefined): void {
    if (record) opts.onCommandRecorded?.(record);
  }

  function recordSettledOutput(meta: BackgroundWorkMeta, { executionOutputTail, mutationEvidence }: BackgroundWorkResult): void | Promise<void> {
    // A mutating command that printed nothing still records its settled mutation, with an empty tail.
    if (!meta.toolUseId || (executionOutputTail === undefined && mutationEvidence === undefined)) return;
    return publishExecutionOutput(meta.toolUseId, executionOutputTail ?? "", identityOf(meta), true, mutationEvidence ? { mutationEvidence } : {});
  }

  function publishExecutionOutput(toolUseId: string, output: string, identity: ToolCallIdentity, retain: boolean, mutation: SettledProjectMutation): void | Promise<void> {
    if (lastExecutionOutputs.get(toolUseId) === output) return;
    const recorded = opts.onExecutionOutputRecorded?.(toolUseId, output, identity, mutation);
    // Remember only durable tails. The settlement owner reports a rejection.
    if (recorded) {
      void recorded.then(() => { if (retain) lastExecutionOutputs.set(toolUseId, output); }, () => {});
      return recorded;
    }
    if (retain) lastExecutionOutputs.set(toolUseId, output);
  }

  function streamExecutionOutput(toolUseId: string, output: string, identity: ToolCallIdentity = {}): void {
    // A tracked command's identity comes from its entry; foreground work in its
    // hold is not tracked yet, so the caller's identity is the only one it has.
    for (const entry of active.values()) {
      if (entry.meta.toolUseId !== toolUseId) continue;
      opts.onExecutionOutput?.(toolUseId, output, identityOf(entry.meta));
      return;
    }
    opts.onExecutionOutput?.(toolUseId, output, identity);
  }

  /** Removes the settled child-session runs that a durable notification
   *  covers, or every one when it names none, and returns them. A child that
   *  a person interrupted ends only when the notification names its run.
   *  Neither kind retires merely because its notification entered a queue.
   *  A workflow's run reports its end only after the parent's sweep reads
   *  the committed notification, and the parent's turn on that notification
   *  can end first, so the commit itself ends the parent's observation of
   *  the run, as the durable settlement owner. A later run of the workflow
   *  is a new entry under the same id, so only the entries that were live
   *  when the notification was offered retire. */
  function retireDeliveredSubagents(runIds: readonly string[] | undefined, workflows: ReadonlyMap<string, ActiveEntry>): CompletedEntry[] {
    for (const runId of runIds ?? []) interruptedByPerson.delete(runId);
    for (const [runId, entry] of workflows) {
      if (active.get(runId) === entry) detach(runId);
    }
    return retireCompletedSubagents(completedSubagents, runIds);
  }

  function liveWorkflows(runIds: readonly string[] | undefined): ReadonlyMap<string, ActiveEntry> {
    return new Map((runIds ?? []).flatMap((runId) => {
      const entry = active.get(runId);
      return entry?.meta.type === "workflow" ? [[runId, entry] as const] : [];
    }));
  }

  // New durable child runs publish through reconciliation. Historical inline
  // subagents retain the existing same-tick notification contract.
  const settleIntoNotifications = () => {
    let flushScheduled = false;
    const flush = (): void => {
      flushScheduled = false;
      const batch = completedSubagents.filter((entry) => entry.meta.settlementOwner !== "child_session");
      if (batch.length === 0) return;
      const retained = completedSubagents.filter((entry) => entry.meta.settlementOwner === "child_session");
      completedSubagents.splice(0, completedSubagents.length, ...retained);
      enqueueNotification(formatSubagentNotificationBatch(batch, activeSubagentCount()), undefined, batch.map(({ meta }) => meta), true);
    };
    const deliverDurableSubagentNotification = (notification: DurableSubagentNotification): Promise<void> | undefined => {
      if (!admitting) return undefined;
      // The delivery of a pending key returns that key's receipt and sends nothing.
      if (notification.key !== undefined && notificationIsPending(notification.key)) return enqueueNotification(notification.text, notification.key, undefined, true) ?? Promise.resolve();
      const ids = notification.completionRunIds?.length ? notification.completionRunIds : notification.key === undefined ? undefined : completionWorkIds(notification.key);
      const workflows = liveWorkflows(ids);
      const batch = completedSubagents.filter((entry) => ids === undefined || ids.includes(entry.meta.id));
      const interrupted = (ids ?? []).flatMap((id) => {
        const entry = interruptedByPerson.get(id);
        return entry ? [entry.meta] : [];
      });
      const known = [...interrupted, ...batch.map((entry) => entry.meta)];
      const work = ids?.length ? ids.map((id) => ({
        id,
        description: known.find((meta) => meta.id === id)?.description ?? processes.record(id)?.description ?? `child result ${id}`,
      })) : undefined;
      const text = notification.text.length > 0 ? notification.text : formatSubagentNotificationBatch(batch, activeSubagentCount());
      const delivered = enqueueNotification(text, notification.key, work, true);
      if (!delivered) {
        retireDeliveredSubagents(ids, workflows);
        return Promise.resolve();
      }
      return delivered.then(() => {
        retireDeliveredSubagents(ids, workflows);
        notifyChange();
      });
    };
    const onSettled = (entry: ActiveEntry, result: BackgroundWorkResult, settledCleanly: boolean): void => {
      if (entry.meta.type === "workflow") {
        if (result.status === "stopped" || result.status === "cancelled") completedSubagents.push({ meta: entry.meta, result });
        return;
      }
      if (entry.meta.type !== "subagent") {
        const completed = { meta: entry.meta, result };
        if (entry.wait && !result.content) return;
        enqueueNotification(entry.wait ? result.content : formatStandaloneNotification(completed), entry.meta.notificationKey, [entry.meta], entry.wait === true && result.runtimeNotice === true);
        return;
      }
      // An interrupted run has not ended and owes no result. A person's
      // interrupt leaves it the parent's work; any other is not active work,
      // so no wait or handoff holds on it (PI-AGENT-025). Its Resume tracks
      // it again.
      if (result.status === "interrupted") {
        if (result.interruptedBy === "person") interruptedByPerson.set(entry.meta.id, entry);
        announceInterruption(entry, result.interruptedBy);
        return;
      }
      completedSubagents.push({ meta: entry.meta, result });
      if (entry.meta.settlementOwner === "child_session") {
        // The child session publishes its own completion through
        // reconciliation. When that publication itself rejected, no durable
        // completion exists for reconciliation to deliver, so this registry
        // delivers the synthesized failure now rather than leaving the parent
        // parked on a child it will never hear from.
        if (!settledCleanly) deliverDurableSubagentNotification({ text: "", completionRunIds: [entry.meta.id] });
        return;
      }
      if (flushScheduled) return;
      flushScheduled = true;
      setTimeout(flush, 0);
    };
    return { onSettled, deliverDurableSubagentNotification, flush };
  };

  const lifecycle: TaskLifecycle = {
    activeSubagentCount,
    activeTaskCount: () => { const work = outstanding(); return work.live.length + work.pending.length; },
    waitableTaskCount: () => { const work = outstanding(); return work.live.filter(waitable).length + work.pending.length; },
    awaitedTaskCount: () => { const work = outstanding(); return work.live.filter(awaits).length + work.pending.length; },
    pendingDeliveryCount: () => outstanding().pending.length,
    liveWorkReferences,
    observeWorkChanges: (listener) => { workListeners.add(listener); return () => { workListeners.delete(listener); }; },
    holdsWait: (toolUseId) => [...active.values()].some((entry) => entry.wait && entry.meta.toolUseId === toolUseId),
    activeBackgroundCommands,
    readTaskOutput,
    processRecords: processes.records,
    processRecord: processes.record,
    processCommand: processes.command,
    readProcessOutput: processes.readOutput,
    waitProcess: processes.wait,
    streamExecutionOutput,
    recordSettlement: (meta, result, timing) => {
      recordCommand(commandIndexRecord(meta, timing.startedAtMs, { result, settledAtMs: timing.settledAtMs }));
      return recordSettledOutput(meta, result);
    },
    deliverDurableSubagentNotification: (notification) => settling.deliverDurableSubagentNotification(notification),
    ownsNotification: notificationIsPending,
    closeNotifications: async () => { notifications.close(); await opts.settleNotificationAdmission?.(); },
    retireDeliveredSubagents: (runIds) => { retireDeliveredSubagents(runIds, liveWorkflows(runIds)); },
    stopAdmission,
    terminate,
    terminateProcess,
    detach,
    handoverCandidates: () => [...active.keys()].map((id) => processes.command(id)).filter((command): command is ManagedCommand => command?.owned !== undefined),
    terminateAll,
  };

  const settling = settleIntoNotifications();
  return {
    kind: opts.kind,
    ...lifecycle,
    flushSettledNotifications: settling.flush,
    track: (args) => track(args, settling.onSettled),
    assertHandoffReady(): HandoffBlock | null {
      const work = outstanding();
      return backgroundHandoffBlock(work.live, [
        ...work.pending.map((item) => item.description),
        ...(opts.pendingInput?.() ? ["queued Chat input"] : []),
      ]);
    },
  };
}
