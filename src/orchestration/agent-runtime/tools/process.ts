import { createStreamingSanitizer } from "../../../infra/control-characters.js";
import type { PersistentProcessRecord } from "../../../infra/persistent-process-manager.js";
import type { ChildRow, ChildSessionControl, ChildStatus } from "../../session/child-session-control.js";
import type { BackgroundWorkRegistry } from "../background-work.js";
import type { BackgroundOutputRequest, BackgroundProcessRecord } from "../background-work-processes.js";
import { formatRuntimeNotification } from "../runtime-notifications.js";
import { readBoundedSpoolTail, type BoundedSpoolTail, type RandomAccessSpool } from "./bash-output-tail.js";
import type { AdvertisedTool, ToolContext, RuntimeTool, RuntimeToolInput, ToolResult } from "./types.js";
import { parseWorkflowTargets } from "../../../protocol/client/workflow-addresses.js";

export const PROCESS_TOOL_NAME = "process";
/** The targeting rules that a child with addresses states beside them in its status, so they reach only an agent
 *  that has such a child (ARCH-CONTEXT-033). */
const CHILD_ADDRESS_GUIDANCE = "These addresses name item keys and named-agent ids for targeted direction, and agent session ids for direct messages and replies. Never substitute an agent session id for this child's process id. When a workflow runs a phase over a list or a phase of named agents, name item keys or agent ids from its status in targets for interrupt and resume. Omit targets only to act on the whole workflow. Interrupt refuses the entire request if any named agent has not started; interrupt it once it runs, or interrupt the whole workflow. Unknown or finished targets refuse the action and list valid alternatives.";
const PROCESS_TARGETS_SCHEMA = { type: "array", items: { type: "string" }, description: "Only for interrupt or resume of a child whose status lists addresses: item keys or agent ids from that status. Omit for the whole child. Unknown or finished targets refuse with valid alternatives." } as const;
export const DEFAULT_WAIT_SECONDS = 240;
// Bun converts larger timer durations to one millisecond.
const MAX_WAIT_SECONDS = 2147483.647;
const PROCESS_WAIT_TIMEOUT_SCHEMA = { type: "number", exclusiveMinimum: 0, maximum: MAX_WAIT_SECONDS, description: "Seconds to wait for managed work, from your estimate of its remaining duration. Estimate all managed work. Omitted: 240 seconds. Example: 7200 for two hours. Completion or expiry wakes you without stopping work. Every new wait needs a fresh estimate; this bounds only the wait." } as const;
const PROCESS_WAIT_GUIDANCE = "When everything left depends on managed work, call process with action='wait' and soft_timeout seconds from your estimate of remaining work. Wait includes every managed command, including one that transferred from the foreground. Never stop or restart a command just to wait for it. Estimate all managed work; use 7200 for two hours. Without an estimate the wait lasts at most four minutes. Completion or expiry consumes this one wait without stopping work. After expiry or a status check, if nothing needs action or a reply, wait again with a fresh remaining-work estimate and no visible text. Never poll or sleep instead. Messages remain subject to their existing relation and purpose restrictions; do not send status chatter.";

/** Validates a native wait estimate against the runtime's timer range. */
export function processWaitSeconds(input: RuntimeToolInput): number | undefined {
  if (input.soft_timeout === undefined) return DEFAULT_WAIT_SECONDS;
  const seconds = input.soft_timeout;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_WAIT_SECONDS
    ? seconds : undefined;
}

// Remove after 2027-10-30: transcripts that builds before 2026-10-30 wrote for
// gpt-6-luna hold `process` calls of this retired registration. Its wait that
// named a process returned after its own bound instead of parking the turn.
const RETIRED_BOUNDED_WAIT_REGISTRATION_ID = "process.luna";

/** Whether a call parks the turn on session work. A native wait always parks
 *  on every process and ignores a `process_id`. A recorded call of the retired
 *  bounded-wait registration that names a process did not park. A call with no
 *  registration reads as native: it comes from a build that stamped no
 *  registration, in which every `process` wait parked. */
export function isParkingWaitCall(call: { readonly name: string; readonly input: RuntimeToolInput; readonly registrationId?: string }): boolean {
  if (call.name !== PROCESS_TOOL_NAME || call.input.action !== "wait") return false;
  if (call.registrationId === RETIRED_BOUNDED_WAIT_REGISTRATION_ID && call.input.process_id !== undefined) return false;
  return processWaitSeconds(call.input) !== undefined;
}

const PROCESS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    process_id: { type: "string", description: "A process ID from action='list'; a child uses the id that list returns. Required for stop, interrupt, resume, and read_output. Status without it lists every process; list and wait ignore it." },
    action: { type: "string", enum: ["list", "status", "wait", "stop", "interrupt", "resume", "read_output"], default: "status" },
    soft_timeout: PROCESS_WAIT_TIMEOUT_SCHEMA,
    targets: PROCESS_TARGETS_SCHEMA,
    offset: { type: "integer", minimum: 0, description: "Optional retained-output line offset for action='read_output'. Omit to read the tail." },
    limit: { type: "integer", minimum: 1, description: "Optional maximum lines returned by action='read_output'. Defaults to 100." },
    query: { type: "string", minLength: 1, description: "Optional case-sensitive literal search for action='read_output'. Returns matching retained-output lines within limit." },
  },
  additionalProperties: false,
} as const;


const NOTHING_PENDING_GUIDANCE = "A launch mentioned in older conversation history is not live work. Only a successful launch acknowledgement from this runtime creates waitable work. Do not wait again until a new process is acknowledged; continue working or deliver your final response.";

const OUTPUT_LIMIT_DEFAULT = 100;
const OUTPUT_QUERY_MATCH_CAP = 200;

function elapsed(startedAtMs: number, endedAtMs = Date.now()): string {
  const seconds = Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

type ProcessToolView =
  | { source: "session"; record: BackgroundProcessRecord }
  | { source: "persistent"; record: PersistentProcessRecord };

function describe(view: ProcessToolView): string {
  if (view.source === "persistent") {
    const record = view.record;
    return `${record.id} | ${record.status === "exited" ? "completed" : "running"} | persistent | ${record.command.join(" ")} (${elapsed(record.startedAtMs)})`;
  }
  const record = view.record;
  return `${record.id} | ${record.status} | ${record.kind} | ${record.description} (${elapsed(record.startedAtMs, record.settledAtMs)})`;
}

async function processViews(backgroundTasks: BackgroundWorkRegistry, context: ToolContext): Promise<ProcessToolView[]> {
  const session = backgroundTasks.processRecords().map((record): ProcessToolView => ({ source: "session", record }));
  const persistent = context.persistentProcesses
    ? (await context.persistentProcesses.list()).map((record): ProcessToolView => ({ source: "persistent", record }))
    : [];
  return [...session, ...persistent].sort((left, right) => left.record.startedAtMs - right.record.startedAtMs || left.record.id.localeCompare(right.record.id));
}

/** The work the caller started: its managed commands and its children. A
 *  child is one row from the durable binding, addressed by its id, so the
 *  registry's own entries for children are left out. */
async function processList(backgroundTasks: BackgroundWorkRegistry, context: ToolContext, children: ChildSessionControl | undefined, unattendedChat: boolean): Promise<string> {
  const childRows = children && context.sessionId ? await children.list(context.sessionId) : [];
  const records = (await processViews(backgroundTasks, context))
    .filter((view) => view.source !== "session" || (view.record.kind !== "subagent" && view.record.kind !== "workflow"));
  const sessionsPointer = unattendedChat ? [] : [SESSIONS_POINTER];
  if (records.length === 0 && childRows.length === 0) return ["No managed processes and no children.", ...sessionsPointer].join(" ");
  return [
    ...(records.length > 0 ? ["Managed processes:", ...records.map((record) => `- ${describe(record)}`)] : []),
    ...(records.some((record) => record.source === "persistent") ? [PERSISTENT_RECORD_NOTE] : []),
    ...(childRows.length > 0 ? ["Your children (each id is the child's process id):", ...childRows.flatMap((row) => [`- ${describeChild(row)}`, ...row.addresses.map((line) => `  ${line}`)])] : []),
    ...sessionsPointer,
  ].join("\n");
}

const SESSIONS_POINTER = "Other sessions of this project are in list_sessions.";

const PERSISTENT_RECORD_NOTE = "Persistent records are unavailable after host exit.";

function describeChild(row: ChildRow): string {
  return `${row.id} | ${row.state} | ${row.kind} | ${row.name}`;
}

function interrupterName(by: NonNullable<ChildStatus["interruptedBy"]>): string {
  switch (by) {
    case "person": return "a person";
    case "agent": return "you";
    case "runtime": return "the runtime";
  }
}

/** A child's status: its row, who made its latest interrupt, and its
 *  progress, read from its own records at this call. */
function describeChildStatus(status: ChildStatus): string {
  const next = status.state !== "interrupted" ? undefined
    : status.interruptedBy === "person" ? "A person interrupted it, so only a person continues it."
    : "Continue it with action='resume' or a message to it, or leave it and do the work another way.";
  return [
    describeChild(status),
    ...(status.interruptedBy ? [`interrupted by: ${interrupterName(status.interruptedBy)}`] : []),
    ...(status.exited ? ["An unexpected exit cut its run. action='resume' continues it."] : []),
    ...status.progress,
    ...status.addresses,
    ...(status.addresses.length > 0 ? [CHILD_ADDRESS_GUIDANCE] : []),
    ...(next ? [next] : []),
  ].join("\n");
}

async function persistentRecord(context: ToolContext, id: string): Promise<PersistentProcessRecord | undefined> {
  return context.persistentProcesses ? (await context.persistentProcesses.list()).find((record) => record.id === id) : undefined;
}

const PERSISTENT_READ_BYTES = 64 * 1024;
const PERSISTENT_LINE_BYTES = 64 * 1024;

function persistentSpool(client: NonNullable<ToolContext["persistentProcesses"]>, record: PersistentProcessRecord, stream: "stdout" | "stderr", size: number): RandomAccessSpool {
  return {
    size,
    slice: async (start, end) => (await client.read(record.id, stream, start, end - start)).data,
  };
}

async function scanPersistentTail(context: ToolContext, record: PersistentProcessRecord, limit: number): Promise<string> {
  const client = context.persistentProcesses;
  if (!client) return "";
  const emptyTail = (): BoundedSpoolTail => ({ lines: [], reachedStart: true, totalLines: 0, truncatedLines: 0 });
  const stderr = record.stderrBytes > 0
    ? await readBoundedSpoolTail(persistentSpool(client, record, "stderr", record.stderrBytes), limit)
    : emptyTail();
  const remaining = limit - stderr.lines.length;
  const stdout = remaining > 0 && record.stdoutBytes > 0
    ? await readBoundedSpoolTail(persistentSpool(client, record, "stdout", record.stdoutBytes), remaining)
    : emptyTail();
  const lines = [...stdout.lines, ...stderr.lines];
  if (lines.length === 0) return "Output has 0 lines; offset 0 is past the end.";
  const reachedStart = stderr.reachedStart && (record.stdoutBytes === 0 || (remaining > 0 && stdout.reachedStart));
  const truncatedLines = stdout.truncatedLines + stderr.truncatedLines;
  const truncation = truncatedLines > 0 ? `\n(${truncatedLines} oversized line(s) truncated)` : "";
  if (!reachedStart) return `Last ${lines.length} lines:\n${lines.join("\n")}${truncation}`;
  const totalLines = (stdout.totalLines ?? 0) + (stderr.totalLines ?? 0);
  return `Lines 1-${lines.length} of ${totalLines}:\n${lines.join("\n")}${truncation}`;
}

async function scanPersistentOutput(context: ToolContext, record: PersistentProcessRecord, offset: number | undefined, limit: number, query: string | undefined): Promise<string> {
  const client = context.persistentProcesses;
  if (!client) return "";
  if (offset === undefined && query === undefined) return scanPersistentTail(context, record, limit);
  const retained: string[] = [];
  let totalLines = 0;
  let truncatedLines = 0;
  const keep = (line: string): void => {
    const bounded = line.length > PERSISTENT_LINE_BYTES ? `${line.slice(0, PERSISTENT_LINE_BYTES)}...[line truncated]` : line;
    if (bounded !== line) truncatedLines++;
    if (query) {
      if (line.includes(query) && retained.length < Math.min(limit, OUTPUT_QUERY_MATCH_CAP)) retained.push(`${totalLines + 1}: ${bounded}`);
    } else if (offset === undefined) {
      retained.push(bounded);
      if (retained.length > limit) retained.shift();
    } else if (totalLines >= offset && retained.length < limit) retained.push(bounded);
    totalLines++;
  };
  for (const [stream, byteCount] of [["stdout", record.stdoutBytes], ["stderr", record.stderrBytes]] as const) {
    if (byteCount === 0) continue;
    const decoder = new TextDecoder();
    let pending = "";
    let pendingWasTruncated = false;
    let endedWithNewline = false;
    const accept = (part: string): void => {
      const combined = pending + part;
      const lines = combined.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) keep(pendingWasTruncated ? `${line}...[line truncated]` : line);
      pendingWasTruncated = false;
      endedWithNewline = combined.endsWith("\n");
      if (pending.length > PERSISTENT_LINE_BYTES) {
        pending = pending.slice(0, PERSISTENT_LINE_BYTES);
        pendingWasTruncated = true;
      }
    };
    const sanitizer = createStreamingSanitizer(accept);
    let readOffset = 0;
    while (readOffset < byteCount) {
      const result = await client.read(record.id, stream, readOffset, PERSISTENT_READ_BYTES);
      sanitizer.push(decoder.decode(result.data, { stream: !result.eof }));
      if (result.eof || result.nextOffset <= readOffset) break;
      readOffset = result.nextOffset;
    }
    sanitizer.push(decoder.decode());
    sanitizer.finish();
    if (!endedWithNewline || pending.length > 0 || pendingWasTruncated) keep(pendingWasTruncated ? `${pending}...[line truncated]` : pending);
  }
  const truncation = truncatedLines > 0 ? `\n(${truncatedLines} oversized line(s) truncated)` : "";
  if (query) {
    if (retained.length === 0) return `No lines contain '${query}' (searched ${totalLines} lines).${truncation}`;
    const capped = retained.length === Math.min(limit, OUTPUT_QUERY_MATCH_CAP) ? `\n(first ${retained.length} matches shown)` : "";
    return `${retained.length} matching line(s):\n${retained.join("\n")}${capped}${truncation}`;
  }
  const start = offset ?? Math.max(0, totalLines - retained.length);
  if (retained.length === 0) return `Output has ${totalLines} lines; offset ${start} is past the end.${truncation}`;
  const more = start + retained.length < totalLines ? `\n(${totalLines - start - retained.length} more lines; continue with offset ${start + retained.length})` : "";
  return `Lines ${start + 1}-${start + retained.length} of ${totalLines}:\n${retained.join("\n")}${more}${truncation}`;
}


function processId(input: RuntimeToolInput, action: string): string | ToolResult {
  const id = input.process_id;
  return typeof id === "string" && id.length > 0
    ? id
    : { content: `process action '${action}' requires a non-empty process_id string.`, outcome: "error" };
}

/** The actions that change work. Each waits for its own turn at the gate. */
const CONTROL_ACTIONS: ReadonlySet<unknown> = new Set(["stop", "interrupt", "resume"]);

const PROCESS_SCOPE = "Manage the work that you started: your managed commands and your children.";
const PROCESS_ACTIONS = "Use one action: list returns the ids that the other actions take (never guess an id from a log suffix); status inspects one process without waiting, or lists them all when no process_id is given, and for a child it gives its state, who interrupted it, its progress, and the addresses that its work takes. wait parks the loop until the next process completes or soft_timeout seconds expire (the turn's other tool calls run first; it waits on every process, so a process_id is ignored; expiry does not stop work; no wait parks on a child that you or the runtime interrupted); stop requests cancellation (termination is confirmed only when the host reports it; an unsettled result means ownership remains managed, so do not release or relaunch the process), and a stopped child shows as Canceled; interrupt cuts a running child so that its work can continue later; resume continues your own interrupted child, or starts a new attempt of a child whose run failed, unless a person made its latest interrupt; and read_output reads retained output of a command.";

/** The advertised form of the native process tool. It names no background
 *  owner, so an agent without one advertises the same bytes. An unattended
 *  chat lists no session that it did not start and has no person who reads
 *  its transcript (PI-AGENT-121), so its form names neither. */
export function processToolDefinition(unattendedChat: boolean): AdvertisedTool {
  return {
    name: PROCESS_TOOL_NAME,
    action: "ui_meta",
    description: unattendedChat
      ? `${PROCESS_SCOPE} ${PROCESS_ACTIONS}`
      : `${PROCESS_SCOPE} Sessions that you did not start are in list_sessions. ${PROCESS_ACTIONS} The person sees each interrupt, resume, and stop of a child in the transcript; the other actions do not render there.`,
    promptSnippet: "List, inspect, wait for, stop, interrupt, or resume the work you started, or read its output",
    promptGuidelines: [
      PROCESS_WAIT_GUIDANCE,
    ],
    inputSchema: PROCESS_INPUT_SCHEMA,
    validatesOwnInput: true,
    isConcurrencySafe: (input) => !CONTROL_ACTIONS.has(input.action),
    // A crash never leaves an interrupt, a resume, or a stop of a child
    // without its call in the parent's history.
    deferUntilAssistantCommitted: true,
  };
}

/** The one tool for the work that an agent started: its commands, its
 *  services, and its children. `children` are the child controls of the
 *  project's session authority. A run without that authority, such as a
 *  headless task, starts no children, so it has none to list or control.
 *  `unattendedChat` selects the form and the list text of an unattended chat,
 *  which names no list_sessions. */
export function createProcessTool(backgroundTasks: BackgroundWorkRegistry, children?: ChildSessionControl, unattendedChat = false): RuntimeTool {
  return {
    ...processToolDefinition(unattendedChat),
    async execute(input, context): Promise<ToolResult> {
      if (input.action === undefined) {
        const result = await this.execute({ ...input, action: "status" }, context);
        return { ...result, content: `Note: omitted action was read as status.\n${result.content}` };
      }
      const action = input.action;
      const targets = parseWorkflowTargets(input.targets);
      if (input.targets !== undefined && action !== "interrupt" && action !== "resume") return { content: "process targets are only valid for interrupt or resume.", outcome: "error" };
      if (targets === null) return { content: "process targets must be a list of item keys or agent ids, each a non-empty string.", outcome: "error" };
      if (action === "list") return { content: await processList(backgroundTasks, context, children, unattendedChat), outcome: "ok" };
      if (action === "wait") {
        // Models often name the process they mean. The wait parks on every
        // process anyway, so the name is ignored rather than refused.
        const ignored = input.process_id === undefined ? "" : "process_id is ignored: a wait parks on every process that you started. ";
        const seconds = processWaitSeconds(input);
        if (seconds === undefined) return { content: `soft_timeout must be positive finite seconds, at most ${MAX_WAIT_SECONDS}. It bounds only this wait, not the work.`, outcome: "error" };
        // Static acknowledgement: whether anything is actually live is settled
        // by the agent loop after the whole tool batch, when same-turn
        // dispatches are registered. A wait with nothing pending is answered
        // by the wait_notification below, not by this result.
        return { content: `${ignored}Wait acknowledged for at most ${seconds} seconds. If managed work is running, the loop parks after this turn's other tool calls finish and resumes on completion or this wait's expiry. Expiry leaves work running and consumes this wait; another wait requires a fresh remaining-work estimate. Otherwise a wait notification will report that nothing was pending.`, outcome: "ok" };
      }
      if (action !== "status" && action !== "stop" && action !== "interrupt" && action !== "resume" && action !== "read_output") {
        return { content: "process requires action to be 'list', 'status', 'wait', 'stop', 'interrupt', 'resume', or 'read_output'.", outcome: "error" };
      }
      const id = processId(input, action);
      // A status without an ID asks what is running: answer with the list.
      if (typeof id !== "string") return action === "status" ? { content: await processList(backgroundTasks, context, children, unattendedChat), outcome: "ok" } : id;
      const parentSessionId = context.sessionId;
      const child = children && parentSessionId && await children.isChild(parentSessionId, id) ? { children, parentSessionId } : undefined;
      if (child) return childAction(child.children, child.parentSessionId, id, action, targets);
      if (action === "interrupt" || action === "resume") {
        return { content: `'${id}' is not a child that you started. action='${action}' acts only on your own children; process(action='list') lists them.`, outcome: "error" };
      }
      if (action === "status") {
        const session = backgroundTasks.processRecord(id);
        const persistent = session ? undefined : await persistentRecord(context, id);
        const view: ProcessToolView | undefined = session
          ? { source: "session", record: session }
          : persistent ? { source: "persistent", record: persistent } : undefined;
        return view
          ? { content: describe(view), outcome: "ok" }
          : { content: `No managed process has ID '${id}'.\n${await processList(backgroundTasks, context, children, unattendedChat)}`, outcome: "error" };
      }
      if (action === "stop") {
        if (backgroundTasks.terminateProcess(id, "agent")) return { content: `Stop requested for process '${id}'.`, outcome: "ok" };
        const persistent = await persistentRecord(context, id);
        if (persistent && context.persistentProcesses) {
          const result = await context.persistentProcesses.stop(id);
          if (result === "unsettled") return { content: `Termination was not confirmed for process '${id}'. ownership remains managed; descendant processes may still be running.`, outcome: "error" };
          return { content: result === "already_exited" ? `Process '${id}' already exited.` : `Stop requested for process '${id}'.`, outcome: "ok" };
        }
        return { content: `No active process has ID '${id}'. It may already have settled or been stopped.\n${await processList(backgroundTasks, context, children, unattendedChat)}`, outcome: "error" };
      }
      const limitValue = input.limit;
      const limit = typeof limitValue === "number" && Number.isFinite(limitValue) && limitValue >= 1 ? Math.min(Math.floor(limitValue), OUTPUT_QUERY_MATCH_CAP) : OUTPUT_LIMIT_DEFAULT;
      const offset = typeof input.offset === "number" && Number.isFinite(input.offset) && input.offset >= 0 ? Math.floor(input.offset) : undefined;
      const query = typeof input.query === "string" && input.query.length > 0 ? input.query : undefined;
      const request: BackgroundOutputRequest = { limit, ...(offset === undefined ? {} : { offset }), ...(query === undefined ? {} : { query }) };
      const sessionRead = await backgroundTasks.readProcessOutput(id, request);
      const persistent = sessionRead.ok ? undefined : await persistentRecord(context, id);
      if (!sessionRead.ok && !persistent) {
        const reason = sessionRead.reason === "unknown" ? `No managed process has ID '${id}'.` : `Process '${id}' has no pull-readable output stream.`;
        return { content: `${reason}\n${await processList(backgroundTasks, context, children, unattendedChat)}`, outcome: "error" };
      }
      if (persistent) return { content: await scanPersistentOutput(context, persistent, offset, limit, query), outcome: "ok" };
      return { content: sessionRead.ok ? sessionRead.text : "", outcome: "ok" };
    },
  };
}

/** One action on the caller's own child, which `id` names by its session id. */
async function childAction(
  children: ChildSessionControl,
  parentSessionId: string,
  id: string,
  action: "status" | "stop" | "interrupt" | "resume" | "read_output",
  targets?: readonly string[],
): Promise<ToolResult> {
  if (action === "status") {
    const status = await children.status(parentSessionId, id);
    return status ? { content: describeChildStatus(status), outcome: "ok" } : { content: `Child '${id}' has no status: its session is gone.`, outcome: "error" };
  }
  if (action === "read_output") return { content: `Child '${id}' has no output stream. Use action='status' for its progress, or message_session to ask it.`, outcome: "error" };
  if (action === "resume") {
    const answer = await children.resume(parentSessionId, id, targets);
    return answer.ok ? { content: `Child '${id}' continues. Its result arrives in a notification when it finishes.`, outcome: "ok" } : { content: answer.error, outcome: "error" };
  }
  if (action === "interrupt") {
    const answer = await children.interrupt(parentSessionId, id, targets);
    if (!answer.ok) return { content: answer.error, outcome: "error" };
    return { content: `Child '${id}' is interrupted. Its work stays where it stopped. Continue it later with action='resume' or a message to it, or do the work another way.`, outcome: "ok" };
  }
  const answer = await children.stop(parentSessionId, id);
  if (!answer.ok) return { content: answer.error, outcome: "error" };
  const state = answer.status === "cancelled" ? "is Canceled"
    : answer.status === "stopped" ? "is Stopped"
    : answer.status === "partial" ? "already ended with a partial result"
    : `already ${answer.status}`;
  return { content: `Child '${id}' ${state}.`, outcome: "ok" };
}

/** Silent model feedback for a wait action that found no live process after the turn's other calls settled. */
export function formatWaitNoopNotification(): string {
  return formatRuntimeNotification({
    tag: "wait_notification",
    handling: `Your process wait action settled with nothing to wait for: when this turn's tool calls finished, no process was still running. If completed-process notifications appear alongside this message, incorporate them and continue. Otherwise there was nothing to wait for. ${NOTHING_PENDING_GUIDANCE}`,
    fields: [["status", "nothing_pending"]],
  });
}
