import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { DebugLog } from "../../../infra/debug-log.js";
import { errnoCode } from "../../../infra/error-message.js";
import { acquireLockSync, releaseLock, tryAcquireLockSync } from "../../../infra/ownership-file-lock.js";
import type { ClaudeReminder } from "../../agent-runtime/llm/claude-reminders.js";
import type { CliBlock, CliMessage, PlacedReminder } from "./cli-view.js";
import { isBridgeSessionId } from "./session-id.js";

// A rotation transcript is a disposable cache in the format that the engine resumes from. The CLI reads it only
// at boot, so the bridge deletes it after `system/init`.

/** The Flywheel-owned directory of a login's session locks, beside the engine's `projects/` tree, so that neither the
 *  engine nor the person's own sessions read a lock, and the sweep never reads one as a session. */
const SESSION_LOCKS_DIRECTORY = "session-locks";
/** The CLI shortens a project directory name past this length and adds a hash. */
const PROJECT_SLUG_LIMIT = 200;

/** The CLI's environment snapshot, with raw values; the CLI escapes them when it renders the reminder. */
interface EnvironmentSnapshot {
  readonly workingDirectory: string;
  readonly isWorktree: boolean;
  readonly isGitRepo: boolean;
  readonly additionalWorkingDirectories: readonly string[];
  readonly platform: string;
  readonly shell: string;
  readonly osVersion: string;
}

/** One turn-start attachment as the CLI stores it. The CLI renders its reminder from these values. */
type Attachment =
  | { readonly type: "environment"; readonly snapshot: EnvironmentSnapshot; readonly changes?: readonly { readonly field: string; readonly from?: string }[] }
  /** The model's identity with no text: the engine then renders the reminder in its own wording from the identity, the
   *  wording that a new engine query sends, so a rotation keeps the cached prefix. Not verified for a model whose new
   *  query the engine states in a second wording, which it chooses by a per-model flag. */
  | { readonly type: "model"; readonly identity: { readonly modelId: string; readonly marketingName: string | null; readonly knowledgeCutoff: string | null } }
  | { readonly type: "session_context"; readonly context: { readonly userEmail: string } }
  /** A changed date is the engine's own `date` attachment with `changed`, not its older `date_change` type: the engine
   *  reads the last `date` attachment as the date it last stated, so a `date_change` row would make it state the new
   *  date again at the next user message. */
  | { readonly type: "date"; readonly date: string; readonly changed?: true };

/** The order in which the CLI writes its turn-start attachment rows. */
const ATTACHMENT_ORDER: readonly Attachment["type"][] = ["environment", "model", "session_context", "date"];

interface RowHeader {
  readonly parentUuid: string | null;
  /** A row of an agent file: the conversation of an agent that a shared agent host runs (agent-host/agent-file.ts). */
  readonly isSidechain: boolean;
  readonly agentId?: string;
  readonly uuid: string;
  readonly timestamp: string;
  readonly sessionId: string;
}

/** One JSON line of a CLI transcript. */
export type TranscriptRow = RowHeader & (
  | {
    readonly type: "user";
    readonly message: { readonly role: "user"; readonly content: readonly CliBlock[] };
    readonly sourceToolAssistantUUID?: string;
    readonly toolUseResult?: ToolResult["content"];
    /** The engine's own row for a dispatcher's message to a hosted agent. */
    readonly isMeta?: true;
    readonly origin?: { readonly kind: "coordinator" };
  }
  | { readonly type: "assistant"; readonly message: CliAssistantMessage }
  | { readonly type: "attachment"; readonly attachment: Attachment; readonly rendered: readonly never[] }
);

type ToolResult = Extract<CliBlock, { type: "tool_result" }>;

/** A server tool call with no result. The CLI removes it from the message before the wire, with no trace. */
interface CarrierBlock {
  readonly type: "server_tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: { readonly [key: string]: never };
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as const;

/** An assistant message as the CLI stores it, in a transcript row or a replay frame. */
export interface CliAssistantMessage {
  readonly id: string; readonly type: "message"; readonly role: "assistant"; readonly model: string; readonly content: readonly (CliBlock | CarrierBlock)[];
  readonly stop_reason: "tool_use" | "end_turn"; readonly stop_sequence: null; readonly usage: typeof ZERO_USAGE;
}

export interface TranscriptInput {
  readonly sessionId: string;
  /** The wire model id that assistant rows name. */
  readonly model: string;
  readonly history: readonly CliMessage[];
  readonly reminders: readonly PlacedReminder[];
  /** The shell that the engine names (`engineShell`), which every environment row states in place of the reminder's.
   *  Absent where the engine names the reminder's shell. */
  readonly shell?: string;
  /** The login's account email. The CLI adds its account context only on a Claude login. */
  readonly accountEmail?: string;
  /** Present for an agent file: the agent's id and its text after each listed user message, which the engine added
   *  at a dispatch (`HostedView.dispatches`). */
  readonly agent?: { readonly agentId: string; readonly dispatches: readonly number[]; readonly dispatchText: string };
}

export interface TranscriptClock {
  readonly now: Date;
  newUuid(): string;
}

/**
 * Builds the transcript rows for `history`: one linear `parentUuid` chain in which every row carries
 * `isSidechain`, `timestamp`, and `sessionId`. Each canonical reminder becomes the CLI's own attachment row,
 * placed after the user row that held it, with its original values: the CLI renders a reminder from the row's
 * data, so the rows give the bytes of the first query and keep the cached history prefix. A tool result row
 * names its assistant row. Assistant blocks, signed thinking included, are written as received, with no
 * `requestId`, because the CLI sends that id back to the service as the previous request; a thinking-only answer
 * gets the carrier of `cliAssistantMessage`.
 */
export function transcriptRows(input: TranscriptInput, clock: TranscriptClock = { now: new Date(), newUuid: randomUUID }): readonly TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const timestamp = clock.now.toISOString();
  const agent = input.agent;
  const header = (): RowHeader => ({
    parentUuid: rows.at(-1)?.uuid ?? null, isSidechain: agent !== undefined, ...(agent === undefined ? {} : { agentId: agent.agentId }),
    uuid: clock.newUuid(), timestamp, sessionId: input.sessionId,
  });
  let snapshot: EnvironmentSnapshot | undefined;
  let assistantRow: string | undefined;
  for (const [index, message] of input.history.entries()) {
    if (message.role === "assistant") {
      const row: TranscriptRow = { ...header(), type: "assistant", message: cliAssistantMessage(message, index, input.model) };
      rows.push(row);
      assistantRow = row.uuid;
      continue;
    }
    const firstResult = message.content.find((block): block is ToolResult => block.type === "tool_result");
    rows.push({
      ...header(), type: "user", message: { role: "user", content: message.content.map(cliKeyOrder) },
      ...(firstResult === undefined || assistantRow === undefined ? {} : { sourceToolAssistantUUID: assistantRow, toolUseResult: firstResult.content }),
    });
    const attachments: Attachment[] = [];
    for (const { reminder } of input.reminders.filter((placed) => placed.message === index)) {
      const attachment = attachmentFor(reminder, snapshot, input.shell);
      if (attachment.type === "environment") snapshot = attachment.snapshot;
      attachments.push(attachment);
      if (reminder.kind === "environment" && input.accountEmail !== undefined) {
        attachments.push({ type: "session_context", context: { userEmail: accountEmailContext(input.accountEmail) } });
      }
    }
    for (const attachment of attachments.toSorted((a, b) => ATTACHMENT_ORDER.indexOf(a.type) - ATTACHMENT_ORDER.indexOf(b.type))) {
      rows.push({ ...header(), type: "attachment", attachment, rendered: [] });
    }
    for (const at of agent?.dispatches ?? []) {
      if (at !== index || agent === undefined) continue;
      rows.push({ ...header(), type: "user", message: { role: "user", content: [{ type: "text", text: agent.dispatchText }] }, isMeta: true, origin: { kind: "coordinator" } });
    }
  }
  return rows;
}

/** The row id of each history message that is a user row, by message index, for the rows that `transcriptRows` built
 *  from that history. A later in-place rotation cuts the CLI's conversation at one of them. */
export function userRowIds(history: readonly CliMessage[], rows: readonly TranscriptRow[]): Map<number, string> {
  const ids = rows.flatMap((row) => (row.type === "user" ? [row.uuid] : []));
  const users = history.flatMap((message, index) => (message.role === "user" ? [index] : []));
  return new Map(users.flatMap((index, order) => {
    const id = ids[order];
    return id === undefined ? [] : [[index, id] as const];
  }));
}

/**
 * The assistant message at `index` of canonical history as the CLI stores it, with no `requestId`. A thinking-only
 * answer gets one carrier block after its thinking: a `server_tool_use` with no result. The CLI drops an assistant
 * message that holds only thinking, both when it loads one and when it builds a request, unless another message
 * shares its id. The carrier is not thinking, so the message stays; the CLI's tool pairing then removes the orphan
 * carrier before the wire and adds no placeholder, because no thinking block follows it. The request therefore
 * carries the native thinking-only message. On a Claude login the CLI also removes, at load, every server tool use
 * whose name the Anthropic API does not define, so the carrier takes
 * the name of a server tool that the API defines and that the CLI handles in no other way: `code_execution`, not
 * `advisor` or `web_search`, which the CLI replaces with placeholder text. The message id reaches the service in the
 * CLI's `previous_message_id` diagnostics, so it names no product.
 */
export function cliAssistantMessage(message: CliMessage, index: number, model: string): CliAssistantMessage {
  const carrier: CarrierBlock[] = isThinkingOnly(message) ? [{ type: "server_tool_use", id: `srvtoolu_rotation_carrier_${index}`, name: "code_execution", input: {} }] : [];
  return {
    id: `msg_rotation_${index}`, type: "message", role: "assistant", model, content: [...message.content, ...carrier],
    stop_reason: message.content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: ZERO_USAGE,
  };
}

function isThinkingOnly(message: CliMessage): boolean {
  return message.content.length > 0 && message.content.every((block) => block.type === "thinking" || block.type === "redacted_thinking");
}

/**
 * The CLI resends a stored message's blocks with their stored key order, and its own tool result starts with
 * `tool_use_id`. The bridge writes that order, in a transcript row, a pushed frame, or a replay frame, so that a rotation sends the
 * bytes of the query it replaces.
 */
export function cliKeyOrder(block: CliBlock): CliBlock {
  if (block.type !== "tool_result") return block;
  // Not verified by a run: the position of `is_error`, which the deciding check did not exercise.
  return { tool_use_id: block.tool_use_id, type: "tool_result", content: block.content, ...(block.is_error === true ? { is_error: true } : {}) };
}

function attachmentFor(reminder: ClaudeReminder, previous: EnvironmentSnapshot | undefined, shell: string | undefined): Attachment {
  switch (reminder.kind) {
    case "environment":
      return { type: "environment", snapshot: {
        workingDirectory: reminder.workingDirectory, isWorktree: reminder.isWorktree, isGitRepo: reminder.isGitRepo,
        additionalWorkingDirectories: [], platform: reminder.platform, shell: shell ?? reminder.shell, osVersion: reminder.osVersion,
      } };
    case "environment-update": {
      // Not verified by a run: the change row's shape follows the CLI's attachment schema, which no run exercised.
      if (previous === undefined) throw new Error("an environment update reminder precedes the environment reminder");
      const snapshot = { ...previous, ...(reminder.workingDirectory === undefined ? {} : { workingDirectory: reminder.workingDirectory }),
        ...(reminder.isWorktree === undefined ? {} : { isWorktree: reminder.isWorktree }), ...(reminder.isGitRepo === undefined ? {} : { isGitRepo: reminder.isGitRepo }) };
      const changes = [
        ...(reminder.workingDirectory === undefined ? [] : [{ field: "workingDirectory", from: previous.workingDirectory }]),
        ...(reminder.isWorktree === undefined ? [] : [{ field: "isWorktree" }]),
        ...(reminder.isGitRepo === undefined ? [] : [{ field: "isGitRepo" }]),
      ];
      return { type: "environment", snapshot, changes };
    }
    case "model":
      return { type: "model", identity: { modelId: reminder.modelId, marketingName: reminder.displayName ?? null, knowledgeCutoff: reminder.knowledgeCutoff ?? null } };
    case "date":
      return reminder.changed ? { type: "date", date: reminder.date, changed: true } : { type: "date", date: reminder.date };
  }
}

/** The account-email context entry, byte for byte as the engine writes it in its `session_context` row: the engine
 *  renders its reminder from this stored value, so a rotation transcript that holds other text misses the cached
 *  history prefix. Not verified live: only an OAuth run shows the row. */
function accountEmailContext(email: string): string {
  return `The user's email address is ${email}. Use it only to identify the user, such as for authorship, attribution, or filtering their own work. Never send it to an unrelated service, such as in a request header, URL, or payload, unless the user explicitly asks.`;
}

/** The file operations of the transcript writer and the sweep. Tests replace it. */
export interface TranscriptFiles {
  realpath(path: string): string;
  /** Writes the file with mode 0600, creating its directory. Returns whether it created that directory. */
  write(path: string, text: string): boolean;
  /** Removes the file, or the directory with everything in it. */
  remove(path: string): void;
  /** Removes the directory only when it holds nothing. */
  removeEmptyDirectory(path: string): void;
  list(directory: string): readonly string[];
  modifiedMs(path: string): number | undefined;
}

/** The real files in the account's config directory. */
export const transcriptFiles: TranscriptFiles = {
  realpath: (path) => realpathSync(path),
  write: (path, text) => {
    const created = mkdirSync(dirname(path), { recursive: true, mode: 0o700 }) !== undefined;
    writeFileSync(path, text, { mode: 0o600 });
    return created;
  },
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  removeEmptyDirectory: (path) => {
    try {
      // `rmdir` refuses a directory that holds anything, so a file that another writer adds at any moment stays.
      rmdirSync(path);
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
    }
  },
  list: (directory) => {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  },
  modifiedMs: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
  },
};

/** The CLI's project directory name for a working directory, with the 32-bit string hash that it adds past the
 *  length limit. */
export function cliProjectSlug(realCwd: string): string {
  const slug = realCwd.replace(/[^a-zA-Z0-9]/gu, "-");
  if (slug.length <= PROJECT_SLUG_LIMIT) return slug;
  let hash = 0;
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- boundary: the CLI's hash wraps to 32 bits, which Math.trunc does not do
  for (let index = 0; index < realCwd.length; index += 1) hash = (hash << 5) - hash + realCwd.charCodeAt(index) | 0;
  return `${slug.slice(0, PROJECT_SLUG_LIMIT)}-${Math.abs(hash).toString(36)}`;
}

/** A written rotation transcript: its session, its path, and the row that the query resumes at. */
export interface WrittenTranscript {
  readonly sessionId: string;
  readonly path: string;
  readonly resumeAt: string;
}

/** The project directories that this process created for its transcripts, each with the count of its transcripts
 *  that are still there. Bridges of one project rotate at the same moment, so the directory belongs to all of them
 *  and goes with the last transcript, whichever bridge created it. */
const createdDirectories = new Map<string, number>();

/**
 * Takes the ownership lock of the bridge session `sessionId` of the login in `configDir` and returns its release. The
 * owner of a session id, a chat bridge or a shared agent host, holds the lock from before its engine writes anything
 * of the session until it deleted the session's artifacts after its engine's awaited close, so a sweep that takes
 * the lock proves that no owner can still use them. Throws when the lock cannot be taken; a new session id has no
 * other holder, so only the file system refuses it.
 */
export function lockSession(configDir: string, sessionId: string): () => void {
  const ownership = acquireLockSync(sessionLockPath(configDir, sessionId));
  return () => { releaseLock(ownership); };
}

/** The session locks of one chat bridge. Several holds of one session id share its one lock, which the bridge keeps
 *  while any hold lasts: each engine generation holds its session id until its awaited close, and a bridge with a
 *  lifetime holds its lifetime session id until every stop of every generation ended, because a rotation starts the
 *  next generation on the same id while the previous one still stops. */
export function sessionLocks(configDir: string) {
  const held = new Map<string, { readonly release: () => void; holds: number }>();
  return {
    hold(sessionId: string): () => void {
      const lock = held.get(sessionId) ?? { release: lockSession(configDir, sessionId), holds: 0 };
      held.set(sessionId, lock);
      lock.holds += 1;
      return () => {
        lock.holds -= 1;
        if (lock.holds > 0) return;
        held.delete(sessionId);
        lock.release();
      };
    },
  };
}

/** The path of the lock of `sessionId`, in the login's lock directory, which this creates when it is missing. */
function sessionLockPath(configDir: string, sessionId: string): string {
  const directory = join(configDir, SESSION_LOCKS_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${sessionId}.lock`);
}

/** When the running system booted, in epoch milliseconds. */
function systemBootMs(): number {
  return Date.now() - uptime() * 1000;
}

/**
 * Deletes the bridge sessions whose owner is proven gone: a rotation transcript, or a shared agent host's transcript
 * with its folder of agent files. The sweep reclaims a session only when it takes the session's lock (`lockSession`)
 * from a holder that is gone, so the artifacts of a live owner stay, whatever their age; a host can be live and idle
 * for longer than a day. Such a session goes from every project directory of the login, and its lock goes with it,
 * also when its owner ended before its engine wrote anything. The sweep reads no content, and a CLI session id never
 * matches, so the person's own `claude` sessions stay.
 */
function sweepLeftBehind(configDir: string, project: string, files: TranscriptFiles, bootMs: number): void {
  const lockDirectory = join(configDir, SESSION_LOCKS_DIRECTORY);
  const projects = join(configDir, "projects");
  // The locks are always real files, which `ownership-file-lock.ts` reads; `files` holds the engine's artifacts.
  const locked = new Set(transcriptFiles.list(lockDirectory).flatMap((name) => bridgeSessionOf(name, ".lock")));
  let projectDirectories: readonly string[] | undefined;
  for (const id of locked) {
    const lock = tryAcquireLockSync(join(lockDirectory, `${id}.lock`));
    if (lock.kind === "blocked") continue;
    try {
      // An owner that released its lock since the listing deleted its artifacts itself.
      if (lock.reclaimed === undefined) continue;
      projectDirectories ??= files.list(projects).map((slug) => join(projects, slug));
      for (const directory of projectDirectories) reclaimSession(directory, id, "owner-gone", files);
    } finally {
      releaseLock(lock);
    }
  }
  // Remove after 2027-02-01, when no build that writes artifacts without a lock (before 2026-11-01) can still run:
  // then every session without a lock has an owner that is gone. Until then, a session without a lock is proven left
  // behind only when it was last written before this boot, because an engine cannot outlive a reboot and writes its
  // artifacts after its launch. A lockless session written since the boot stays, and the sweep takes no lock on it,
  // so a sweep that crashes leaves no lock that a later sweep could read as the proof of a gone owner.
  const lockless = new Set(files.list(project).flatMap((name) => [...bridgeSessionOf(name, ""), ...bridgeSessionOf(name, ".jsonl")]));
  for (const id of lockless) {
    if (locked.has(id)) continue;
    const written = [join(project, `${id}.jsonl`), join(project, id), ...files.list(join(project, id, "subagents")).map((name) => join(project, id, "subagents", name))]
      .flatMap((path) => files.modifiedMs(path) ?? []);
    if (written.length === 0 || Math.max(...written) >= bootMs) continue;
    const lock = tryAcquireLockSync(sessionLockPath(configDir, id));
    if (lock.kind === "blocked") continue;
    try {
      reclaimSession(project, id, "written-before-boot", files);
    } finally {
      releaseLock(lock);
    }
  }
}

/** The bridge session id that `name` carries before `suffix`, or none. */
function bridgeSessionOf(name: string, suffix: string): string[] {
  if (!name.endsWith(suffix)) return [];
  const id = name.slice(0, name.length - suffix.length);
  return isBridgeSessionId(id) ? [id] : [];
}

/** Deletes the artifacts of the session `id` in `project`, if it has any there, with one record of the proof. */
function reclaimSession(project: string, id: string, proof: "owner-gone" | "written-before-boot", files: TranscriptFiles): void {
  const host = files.modifiedMs(join(project, id)) !== undefined;
  if (!host && files.modifiedMs(join(project, `${id}.jsonl`)) === undefined) return;
  files.remove(join(project, `${id}.jsonl`));
  if (host) files.remove(join(project, id));
  DebugLog.record({ type: "provider.claude_sdk.engine.artifacts_reclaimed", payload: { sessionId: id, artifacts: host ? "host" : "transcript", proof } });
}

/** Deletes the bridge sessions left behind where the CLI keeps the sessions of `cwd` (`sweepLeftBehind`). */
export function sweepLeftBehindSessions(configDir: string, cwd: string, files: TranscriptFiles = transcriptFiles, bootMs: number = systemBootMs()): void {
  sweepLeftBehind(configDir, join(configDir, "projects", cliProjectSlug(files.realpath(cwd))), files, bootMs);
}

/** Writes the transcript where the CLI looks for `sessionId`, after it deleted what was left behind there
 *  (`sweepLeftBehind`). The caller holds the session's lock (`lockSession`). */
export function writeTranscript(configDir: string, cwd: string, sessionId: string, rows: readonly TranscriptRow[], files: TranscriptFiles = transcriptFiles, bootMs: number = systemBootMs()): WrittenTranscript {
  const last = rows.at(-1);
  if (last === undefined) throw new Error("a rotation transcript needs at least one row");
  const project = join(configDir, "projects", cliProjectSlug(files.realpath(cwd)));
  sweepLeftBehind(configDir, project, files, bootMs);
  const path = join(project, `${sessionId}.jsonl`);
  const created = files.write(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const transcripts = createdDirectories.get(project);
  if (created || transcripts !== undefined) createdDirectories.set(project, (transcripts ?? 0) + 1);
  return { sessionId, path, resumeAt: last.uuid };
}

/**
 * Deletes a rotation transcript that the bridge wrote. When it was the last transcript in a project directory that
 * this process created, the function then deletes that directory if it is empty. The CLI and the person's own `claude` sessions share `projects/`, so a
 * directory that was there before, or that holds anything else, stays.
 */
export function removeTranscript(written: WrittenTranscript, files: TranscriptFiles = transcriptFiles): void {
  files.remove(written.path);
  const project = dirname(written.path);
  const transcripts = createdDirectories.get(project);
  if (transcripts === undefined) return;
  if (transcripts > 1) {
    createdDirectories.set(project, transcripts - 1);
    return;
  }
  createdDirectories.delete(project);
  files.removeEmptyDirectory(project);
}
