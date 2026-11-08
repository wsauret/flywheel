/**
 * The session process records of one background-work registry. A record
 * starts with a task of a process kind and outlives it, so a stop, a read of
 * its output, or a wait still finds a process after it settled. The most
 * recent settled records stay, up to a bounded history. A command's process
 * also has one durable background index record when it starts and one when
 * it settles (`commandIndexRecord`).
 */

import type { BackgroundCommandRecord } from "../../infra/runtime-fact-types.js";
import type { BackgroundWorkMeta, BackgroundWorkResult } from "./background-work.js";
import type { ManagedCommand } from "./tools/managed-command.js";

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

/** How a command whose end was observed ended: with its own exit code, or
 *  by a signal, which leaves it no exit code. `signal` is null when the
 *  platform named none. */
export type CommandExit = { readonly code: number } | { readonly signal: string | null };

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

/** A live process reads whether a stop of it is under way from its task,
 *  the one owner of that request; a settled one holds how it ended. */
type ProcessState =
  | { readonly kind: "live"; readonly stopRequested: () => boolean }
  | { readonly kind: "settled"; readonly status: SettledProcessStatus; readonly settledAtMs: number; readonly exitCode?: number };

interface ProcessEntry {
  identity: Pick<BackgroundProcessRecord, "id" | "kind" | "description" | "startedAtMs">;
  state: ProcessState;
  readOutput: OutputReader | undefined;
  toolUseId: string | undefined;
  command: ManagedCommand | undefined;
  settled: Promise<void>;
}

/** What a task that starts tells its record. */
interface ProcessAdmission {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly startedAtMs: number;
  readonly toolUseId: string | undefined;
  readonly readOutput: OutputReader | undefined;
  readonly command: ManagedCommand | undefined;
  readonly done: Promise<unknown>;
  /** Whether a stop of the task is under way, which the record shows as `stopping`. */
  readonly stopRequested: () => boolean;
}

export interface BackgroundProcessTable {
  /** Starts the record of a task whose type is a process kind. */
  admit(task: ProcessAdmission): void;
  /** Records how a process ended. Resolves to the tool use of a settled
   *  record that the bounded history evicted, whose retained output the
   *  caller forgets with it. */
  settle(id: string, end: { readonly status: SettledProcessStatus; readonly exit?: CommandExit | undefined }): string | undefined;
  /** Forgets one record. Resolves to its tool use, whose retained output the
   *  caller forgets with it. */
  forget(id: string): string | undefined;
  clear(): void;
  records(): BackgroundProcessRecord[];
  record(id: string): BackgroundProcessRecord | undefined;
  command(id: string): ManagedCommand | undefined;
  readOutput(id: string, request: BackgroundOutputRequest): Promise<BackgroundWorkOutput>;
  /** Awaits the end of one process. The wait is event-driven and bounded;
   *  false means unknown, aborted, or timed out. */
  wait(id: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<boolean>;
}

function view({ identity, state }: ProcessEntry): BackgroundProcessRecord {
  if (state.kind === "live") return { ...identity, status: state.stopRequested() ? "stopping" : "running" };
  return { ...identity, status: state.status, settledAtMs: state.settledAtMs, ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }) };
}

export function createBackgroundProcessTable(): BackgroundProcessTable {
  const processes = new Map<string, ProcessEntry>();
  const settledIds = new Set<string>();

  function forget(id: string): string | undefined {
    const process = processes.get(id);
    processes.delete(id);
    settledIds.delete(id);
    return process?.toolUseId;
  }

  return {
    admit(task) {
      if (!isProcessKind(task.type)) return;
      processes.set(task.id, {
        identity: { id: task.id, kind: task.type, description: task.description, startedAtMs: task.startedAtMs },
        state: { kind: "live", stopRequested: task.stopRequested },
        readOutput: task.readOutput,
        toolUseId: task.toolUseId,
        command: task.command,
        settled: task.done.then(() => undefined, () => undefined),
      });
    },
    settle(id, end) {
      const process = processes.get(id);
      if (!process) return undefined;
      const exitCode = exitCodeOf(end.exit);
      process.state = { kind: "settled", status: end.status, settledAtMs: Date.now(), ...(exitCode === undefined ? {} : { exitCode }) };
      settledIds.add(id);
      if (settledIds.size <= SETTLED_PROCESS_HISTORY_LIMIT) return undefined;
      const oldest = settledIds.values().next().value;
      return oldest === undefined ? undefined : forget(oldest);
    },
    forget,
    clear() {
      processes.clear();
      settledIds.clear();
    },
    records: () => [...processes.values()].map(view),
    record(id) {
      const process = processes.get(id);
      return process ? view(process) : undefined;
    },
    command: (id) => processes.get(id)?.command,
    async readOutput(id, request) {
      const process = processes.get(id);
      if (!process) return { ok: false, reason: "unknown" };
      if (!process.readOutput) return { ok: false, reason: "unsupported" };
      return { ok: true, text: await process.readOutput(request) };
    },
    async wait(id, options) {
      const process = processes.get(id);
      if (!process) return false;
      if (process.state.kind === "settled") return true;
      const signal = options?.signal;
      if (signal?.aborted) return false;

      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const bounded = new Promise<boolean>((resolve) => {
        if (options?.timeoutMs !== undefined) timer = setTimeout(() => resolve(false), options.timeoutMs);
        if (signal) {
          abort = () => resolve(false);
          signal.addEventListener("abort", abort, { once: true });
        }
      });
      try {
        return await Promise.race([process.settled.then(() => true), bounded]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (abort) signal?.removeEventListener("abort", abort);
      }
    },
  };
}
