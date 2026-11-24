/**
 * The session process records of one background-work registry. A record
 * derives from a live task of a process kind while it runs and outlives it,
 * so a stop or a read of its output still finds a process after it settled.
 * The most recent settled records stay, up to a bounded history. A command's process
 * also has one durable background index record when it starts and one when
 * it settles (`commandIndexRecord`).
 */

import type { BackgroundCommandRecord } from "../../../infra/runtime-fact-types.js";
import type { BackgroundKillSource, BackgroundWorkMeta, BackgroundWorkResult, CommandExit } from "./background-work-types.js";
import type { ManagedCommand } from "../tools/bash/execution/managed-command.js";

const SETTLED_PROCESS_HISTORY_LIMIT = 100;

/** The kinds of work a session process record names. A reply wait
 *  (ARCH-SESSIONS-032) is one, so a stop of the process can end it. */
const PROCESS_KINDS = ["background_command", "subagent", "workflow", "benchmark", "reply_wait"] as const;
type BackgroundProcessKind = (typeof PROCESS_KINDS)[number];

function isProcessKind(type: string): type is BackgroundProcessKind {
  return PROCESS_KINDS.some((kind) => kind === type);
}

export interface BackgroundOutputRequest {
  /** Zero-based line offset. Pass the prior page's advertised continuation
   * offset to continue sequentially; changing or omitting it starts a new view.
   * Query pages use the offset as the first source line to search. */
  offset?: number;
  limit: number;
  query?: string;
}

/** The exit code of an observed exit that has one. */
function exitCodeOf(exit: CommandExit | undefined): number | undefined {
  return exit !== undefined && "code" in exit ? exit.code : undefined;
}

/** The background index record of work that the index lists as a command
 *  (a background command or a benchmark, with the tool call that started
 *  it): running, or how it `settled`. Other work has no record. A background
 *  command whose exit no one observed records nothing when it settles: its
 *  record stays `running`, which the index reads as ended once no owner
 *  holds the command (D17). */
export function commandIndexRecord(meta: BackgroundWorkMeta, startedAtMs: number, settled?: { readonly result: BackgroundWorkResult; readonly settledAtMs: number }): BackgroundCommandRecord | undefined {
  if ((meta.type !== "background_command" && meta.type !== "benchmark") || meta.toolUseId === undefined) return undefined;
  const fields = {
    toolUseId: meta.toolUseId,
    processId: meta.id,
    description: meta.description,
    startedAtMs,
    ...(meta.modelRequestId ? { modelRequestId: meta.modelRequestId } : {}),
    ...(meta.parentToolUseId ? { parentToolUseId: meta.parentToolUseId } : {}),
    ...(meta.watch ? { watch: true as const } : {}),
  };
  if (!settled) return { ...fields, state: "running" };
  const { status, exit } = settled.result;
  if (meta.type === "background_command" && exit === undefined) return undefined;
  const exitCode = exitCodeOf(exit);
  return {
    ...fields,
    state: "settled",
    status: status === "completed" || status === "stopped" || status === "cancelled" ? status : "failed",
    ...(exitCode === undefined ? {} : { exitCode }),
    settledAtMs: settled.settledAtMs,
  };
}

export interface BackgroundProcessRecord {
  id: string;
  kind: BackgroundProcessKind;
  description: string;
  status: "running" | "stopping" | "completed" | "partial" | "failed" | "cancelled" | "stopped" | "interrupted";
  startedAtMs: number;
  settledAtMs?: number;
  exitCode?: number;
}

/** One read of a task's retained output, or the reason none exists. */
export type BackgroundWorkOutput =
  | { ok: true; text: string }
  | { ok: false; reason: "unknown" | "unsupported" };

type OutputReader = (request: BackgroundOutputRequest) => Promise<string>;

type SettledProcessStatus = Exclude<BackgroundProcessRecord["status"], "running" | "stopping">;

/** The registry's one record of a live task, from which its process record
 *  derives while it runs. A stop under way shows as `stopping`. */
export interface LiveProcessTask {
  readonly meta: Pick<BackgroundWorkMeta, "id" | "type" | "description" | "toolUseId">;
  readonly startedAtMs: number;
  readonly stopRequestedBy: BackgroundKillSource | undefined;
  readonly readOutput: OutputReader | undefined;
  readonly command: ManagedCommand | undefined;
}

/** What the settled history reads of a process after its task left. */
interface SettledProcess {
  readonly record: BackgroundProcessRecord;
  readonly toolUseId: string | undefined;
  readonly readOutput: OutputReader | undefined;
  readonly command: ManagedCommand | undefined;
}

export interface BackgroundProcessTable {
  /** Records how a live task of a process kind ended. Returns the tool use
   *  of a settled record that the bounded history evicted, whose retained
   *  output the caller forgets with it. */
  settle(task: LiveProcessTask, end: { readonly status: SettledProcessStatus; readonly exit?: CommandExit | undefined }): string | undefined;
  /** Forgets one settled record. Returns its tool use, whose retained output
   *  the caller forgets with it. */
  forget(id: string): string | undefined;
  clear(): void;
  records(): BackgroundProcessRecord[];
  record(id: string): BackgroundProcessRecord | undefined;
  command(id: string): ManagedCommand | undefined;
  readOutput(id: string, request: BackgroundOutputRequest): Promise<BackgroundWorkOutput>;
}

function liveRecord({ meta, startedAtMs, stopRequestedBy }: LiveProcessTask & { readonly meta: { readonly type: BackgroundProcessKind } }): BackgroundProcessRecord {
  return { id: meta.id, kind: meta.type, description: meta.description, startedAtMs, status: stopRequestedBy === undefined ? "running" : "stopping" };
}

function isLiveProcess(task: LiveProcessTask | undefined): task is LiveProcessTask & { readonly meta: { readonly type: BackgroundProcessKind } } {
  return task !== undefined && isProcessKind(task.meta.type);
}

/** The process view of `live`, the registry's map of live tasks by id, and
 *  the settled history. A live id and a settled id never coincide: a task
 *  that tracks again under a settled id forgets that record first. */
export function createBackgroundProcessTable(live: ReadonlyMap<string, LiveProcessTask>): BackgroundProcessTable {
  const settled = new Map<string, SettledProcess>();
  const find = (id: string): Pick<SettledProcess, "readOutput" | "command"> | undefined => {
    const task = live.get(id);
    return isLiveProcess(task) ? task : settled.get(id);
  };

  function forget(id: string): string | undefined {
    const process = settled.get(id);
    settled.delete(id);
    return process?.toolUseId;
  }

  return {
    settle(task, end) {
      if (!isLiveProcess(task)) return undefined;
      const exitCode = exitCodeOf(end.exit);
      const { meta } = task;
      settled.set(meta.id, {
        record: { id: meta.id, kind: meta.type, description: meta.description, startedAtMs: task.startedAtMs, status: end.status, settledAtMs: Date.now(), ...(exitCode === undefined ? {} : { exitCode }) },
        toolUseId: meta.toolUseId,
        readOutput: task.readOutput,
        command: task.command,
      });
      if (settled.size <= SETTLED_PROCESS_HISTORY_LIMIT) return undefined;
      const oldest = settled.keys().next().value;
      return oldest === undefined ? undefined : forget(oldest);
    },
    forget,
    clear: () => { settled.clear(); },
    records: () => [
      ...[...settled.values()].map(({ record }) => record),
      ...[...live.values()].filter(isLiveProcess).map(liveRecord),
    ],
    record(id) {
      const task = live.get(id);
      return isLiveProcess(task) ? liveRecord(task) : settled.get(id)?.record;
    },
    command: (id) => find(id)?.command,
    async readOutput(id, request) {
      const process = find(id);
      if (!process) return { ok: false, reason: "unknown" };
      if (!process.readOutput) return { ok: false, reason: "unsupported" };
      return { ok: true, text: await process.readOutput(request) };
    },
  };
}
