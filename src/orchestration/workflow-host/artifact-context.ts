import { join, relative } from "node:path";
import { FLYWHEEL_DIR_NAME } from "../../infra/directory-authorities.js";
import { isReviewableSessionFile } from "../../protocol/client/session-changes-copy.js";
import { Result, Schema } from "effect";
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js";
import { canonicalMutationPath } from "../../infra/file-mutation-queue.js";
import { Log } from "../../infra/log.js";
import type { ArtifactWriter } from "../../workflows/context-bundle/attempt-artifacts.js";
import { fieldSchema } from "../../workflows/output-contract/compile.js";
import { envelope } from "../../workflows/output-contract/envelope.js";
import { resolveToolPath } from "../agent-runtime/tools/tool-paths.js";
import { readConversationToolUseIds } from "../session/conversation/session-message-entries.js";
import type { SessionManager } from "../session/manager.js";
import { readLaunchedChildren, type LaunchedChild } from "../session/module-session-operations.js";
import { sessionDisplayName } from "../session/schemas.js";
import type { RetainedPatch } from "../session/session-change-sources.js";
import { getSessionChangeReview, type SessionChangeReview } from "../session/session-change-review.js";
import type { Change } from "../session/session-file-changes.js";
import { readSessionMetadata } from "../session/session-metadata-store.js";
import { workflowMembershipReader } from "../session/workflow-membership.js";

const log = Log.create({ service: "artifact-context" });

const MAX_CONTEXT_BYTES = 120_000;
const MAX_FILE_BYTES = 8_000;
/** The bytes that every writer's diffs and notices share. */
const MAX_DIFF_BYTES = 60_000;
/** A diff part with less room than this shows only its omission notice. */
const MIN_DIFF_WINDOW_BYTES = 256;

// The envelope's file list. Every agent output carries the envelope, so this
// probe reads `files_modified` from the output of any agent and ignores the
// keys the agent's own contract declares.
const EnvelopeFilesSchema = Schema.Struct({
  files_modified: Schema.optionalKey(fieldSchema(envelope.files_modified)),
});

// Remove after 2027-04-30. A work handoff stored before the agent output
// envelope listed its files under `artifacts`. The generic renderer shows the
// rest of that payload, so this reader takes only the two file lists.
const PreviousArtifactsSchema = Schema.Struct({
  artifacts: Schema.Struct({
    files_created: Schema.optionalKey(Schema.Array(Schema.String)),
    files_modified: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
});

let legacyArtifactsLogged = false;

/** One file the context shows, by its canonical path and its path from the
 *  worker directory. */
interface ArtifactFile {
  display: string;
  absolute: string;
}

/** One recorded edit and what its mutation kept of the file's patch. */
interface RecordedEdit {
  /** Whether the file was absent before this edit. */
  readonly created: boolean;
  /** Whether the file was absent after this edit. */
  readonly deleted: boolean;
  readonly retained: RetainedPatch;
  /** The launched session that recorded this edit, such as `subagent
   *  Explorer`. Absent for an edit of the agent's own calls. */
  readonly via?: string;
}

/** The recorded edits of one writer to one file, in recorded order. */
interface FileEdits extends ArtifactFile {
  readonly edits: readonly RecordedEdit[];
}

/** One writer's tool calls and the conversation batches whose calls are unknown. */
interface WriterCalls {
  readonly toolUseIds: ReadonlySet<string>;
  readonly unreadableBatches: number;
}

export interface ArtifactContextDeps {
  /** Directory where the workflow's workers and their tools execute. Handoff
   *  paths resolve from it, and every shown path is relative to it. */
  readonly executionCwd: string;
  /** Directory that owns the project's durable state. Edits to Flywheel's own
   *  files under it, such as session notes, are not shown. */
  readonly projectRoot: string;
  readonly reader: AsyncEventStateReadSurface;
  readonly workflowId: string;
}

/** The files one prior output names. A payload with no file list, or with a
 *  list of the wrong shape, names none. This reader only collects evidence
 *  for the next prompt, and the generic renderer shows the whole payload. */
function artifactPaths(handoff: ArtifactWriter["handoffs"][number]): readonly string[] {
  const current = Schema.decodeUnknownResult(EnvelopeFilesSchema)(handoff);
  if (Result.isSuccess(current) && current.success.files_modified) return current.success.files_modified;
  const previous = Schema.decodeUnknownResult(PreviousArtifactsSchema)(handoff);
  if (Result.isFailure(previous)) return [];
  const paths = [...previous.success.artifacts.files_created ?? [], ...previous.success.artifacts.files_modified ?? []];
  if (!legacyArtifactsLogged && paths.length > 0) {
    legacyArtifactsLogged = true;
    log.info("artifact context read a previous-shape work handoff", { fileCount: paths.length });
  }
  return paths;
}

function displayPath(base: string, absolute: string): string {
  return relative(base, absolute).replaceAll("\\", "/");
}

/** The canonical files that handoffs name. An empty name, or a name with a
 *  NUL byte, which no file system admits, is skipped. */
function namedFiles(paths: readonly string[], executionCwd: string, base: string): ArtifactFile[] {
  const resolved: ArtifactFile[] = [];
  for (const raw of paths) {
    const file = raw.trim();
    if (!file || file.includes("\0")) {
      log.warn("skipping invalid artifact path", { path: raw });
      continue;
    }
    const absolute = canonicalMutationPath(resolveToolPath(executionCwd, file));
    resolved.push({ display: displayPath(base, absolute), absolute });
  }
  return resolved;
}

/** The tool calls of every conversation of one writer attempt. */
async function writerCalls(reader: AsyncEventStateReadSurface, conversationIds: readonly string[], signal: AbortSignal): Promise<WriterCalls> {
  const toolUseIds = new Set<string>();
  let unreadableBatches = 0;
  for (const conversationId of conversationIds) {
    const calls = await readConversationToolUseIds(reader, conversationId);
    signal.throwIfAborted();
    for (const id of calls.toolUseIds) toolUseIds.add(id);
    unreadableBatches += calls.unreadableBatches;
  }
  return { toolUseIds, unreadableBatches };
}

/** Whether one of the writer's own calls made the change, directly or
 *  through a nested call that its container call ran. */
function isOwnChange(change: Change, toolUseIds: ReadonlySet<string>): boolean {
  return (change.toolUseId !== undefined && toolUseIds.has(change.toolUseId))
    || (change.parentToolUseId !== undefined && toolUseIds.has(change.parentToolUseId));
}

/** One session whose recorded changes a writer's part shows: the workflow
 *  session, where the agent's own calls ran, or a session that one of those
 *  calls launched, or a descendant of one. */
interface EditSource {
  readonly review: SessionChangeReview;
  /** Whether the writer made this change. */
  readonly owns: (change: Change) => boolean;
  /** How the diffs of a launched session name it, such as `subagent Explorer`. */
  readonly via?: string;
}

/** The sessions that one writer's calls launched, with all their
 *  descendants, each read through its own session's change fold, which owns
 *  only the changes that session recorded: its descendants are sources of
 *  their own. A launched session does the agent's work, so every change it
 *  records is the agent's.
 *  `notices` names each session whose file edits or child sessions do not
 *  read. Store read failures propagate. */
async function launchedSources(
  read: SessionManager["read"],
  launched: readonly LaunchedChild[],
  reader: AsyncEventStateReadSurface,
  signal: AbortSignal,
): Promise<{ readonly sources: readonly EditSource[]; readonly notices: readonly string[] }> {
  const sources: EditSource[] = [];
  const notices: string[] = [];
  let unreadable = 0;
  // Each child binds to one parent, so the walk from the workflow's children
  // never reaches a session twice.
  const pending = [...launched];
  for (let child = pending.shift(); child !== undefined; child = pending.shift()) {
    const via = `${child.session.kind} ${sessionDisplayName({ id: child.sessionId, session: child.session })}`;
    const review = await getSessionChangeReview(reader, child.sessionId);
    const descendants = await readLaunchedChildren(read, child.sessionId);
    signal.throwIfAborted();
    sources.push({ review, owns: (change) => change.sessionId === child.sessionId, via });
    const gaps = review.unknownFileMutationGaps(child.sessionId);
    if (gaps > 0) notices.push(`Partial evidence: ${gaps === 1 ? "1 recorded file edit" : `${gaps} recorded file edits`} of ${via} could not be read.`);
    unreadable += descendants.unreadable;
    pending.push(...descendants.children);
  }
  if (unreadable > 0) {
    notices.push(unreadable === 1
      ? "Partial evidence: 1 session that this agent launched could not be read, so its edits are not shown."
      : `Partial evidence: ${unreadable} sessions that this agent launched could not be read, so their edits are not shown.`);
  }
  return { sources, notices };
}

/** One change and the source that recorded it. */
interface SourcedChange {
  readonly change: Change;
  readonly source: EditSource;
}

/** The edits that one writer recorded in its sources, per file in the order
 *  of the writer's first edit to it, and in recorded order within a file.
 *  Each source's change fold supplies its changes and their retained patches.
 *  Undeclared shell writes record no change, so they are not shown. */
async function writerEdits(
  sources: readonly EditSource[],
  deps: ArtifactContextDeps,
  base: string,
  signal: AbortSignal,
): Promise<FileEdits[]> {
  const byPath = new Map<string, SourcedChange[]>();
  for (const source of sources) {
    for (const file of source.review.files()) {
      if (!isReviewableSessionFile(file.path, canonicalMutationPath(join(deps.projectRoot, FLYWHEEL_DIR_NAME)))) continue;
      for (const change of file.changes) {
        if (!source.owns(change)) continue;
        const changes = byPath.get(file.path) ?? [];
        changes.push({ change, source });
        byPath.set(file.path, changes);
      }
    }
  }
  // Event positions order the facts of every session of the workspace, so
  // the edits of a launched session interleave with the agent's own.
  const byPosition = (left: SourcedChange, right: SourcedChange): number => left.change.source.position - right.change.source.position;
  const edited = [...byPath]
    .flatMap(([path, changes]) => {
      const first = changes.sort(byPosition)[0];
      return first ? [{ path, changes, first }] : [];
    })
    .sort((left, right) => byPosition(left.first, right.first));
  const files: FileEdits[] = [];
  for (const { path, changes } of edited) {
    const edits: RecordedEdit[] = [];
    for (const { change, source } of changes) {
      edits.push({
        created: change.before === null, deleted: change.after === null, retained: await source.review.retainedPatch(change),
        ...(source.via !== undefined ? { via: source.via } : {}),
      });
      signal.throwIfAborted();
    }
    files.push({ display: displayPath(base, path), absolute: path, edits });
  }
  return files;
}

/** The hunks of one retained patch, without its file header lines. */
function patchHunks(patch: string): string {
  const start = patch.search(/^@@/m);
  return start === -1 ? "" : patch.slice(start).replace(/\n+$/, "");
}

/** The diff of one retained edit, against the file as that edit found it.
 *  Each edit is its own diff because a later edit's line numbers and context
 *  hold the earlier edit and any edit of other work between them, so the
 *  diffs of one file apply in recorded order and do not merge into one. */
function editDiff(display: string, edit: RecordedEdit): string | null {
  const hunks = edit.retained.kind === "patch" ? patchHunks(edit.retained.unifiedDiff) : "";
  if (!hunks) return null;
  return [
    ...(edit.via !== undefined ? [`# via ${edit.via}`] : []),
    `diff --git a/${display} b/${display}`,
    `--- ${edit.created ? "/dev/null" : `a/${display}`}`,
    `+++ ${edit.deleted ? "/dev/null" : `b/${display}`}`,
    hunks,
  ].join("\n");
}

/** One line for each kind of edit evidence of a file that its diffs do not
 *  show whole. */
function fileNotices(file: FileEdits): string[] {
  const edits = (count: number) => count === 1 ? `the diff of 1 recorded edit to ${file.display}` : `the diffs of ${count} recorded edits to ${file.display}`;
  const notices: string[] = [];
  const truncated = file.edits.flatMap(({ retained }) => retained.kind === "patch" && retained.omittedLines !== undefined ? [retained.omittedLines] : []);
  if (truncated.length > 0) {
    const lines = truncated.reduce((sum, omitted) => sum + omitted, 0);
    notices.push(truncated.length === 1 ? `Truncated: ${edits(1)} omits its last ${lines} lines.` : `Truncated: ${edits(truncated.length)} omit their last ${lines} lines in all.`);
  }
  const sensitive = file.edits.filter(({ retained }) => retained.kind === "sensitive").length;
  if (sensitive > 0) notices.push(`Omitted: ${edits(sensitive)}, because ${sensitive === 1 ? "it holds" : "they hold"} a recognized credential.`);
  const unretained = file.edits.filter(({ retained }) => retained.kind === "unretained").length;
  if (unretained > 0) notices.push(`Not retained: ${edits(unretained)}.`);
  return notices;
}

/** The notice lines that fit in `limit` bytes. One last line counts the rest. */
function boundedNotices(notices: readonly string[], limit: number): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const notice of notices) {
    const size = Buffer.byteLength(notice) + 2;
    if (bytes + size > limit) break;
    kept.push(notice);
    bytes += size;
  }
  const rest = notices.length - kept.length;
  return rest === 0 ? kept : [...kept, `Not shown: ${rest} more ${rest === 1 ? "notice" : "notices"} about the diffs of recorded edits.`];
}

function portionBytes(size: number, limit: number): number {
  return Math.floor((limit - Buffer.byteLength(`\n[... ${size} bytes omitted ...]\n`)) / 2);
}

function joinWindows(head: Uint8Array, tail: Uint8Array, size: number): string {
  let start = 0;
  // SAFETY: start is nonnegative and the short-circuit length check bounds every tail access.
  while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
  // Streaming decode drops only the incomplete character at a window's end.
  const first = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(head, { stream: true });
  const last = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(tail.subarray(start), { stream: true });
  const omitted = size - Buffer.byteLength(first) - Buffer.byteLength(last);
  return `${first}\n[... ${omitted} bytes omitted ...]\n${last}`;
}

function boundedText(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  if (limit < MIN_DIFF_WINDOW_BYTES) return `[... ${bytes.length} bytes omitted ...]`;
  const portion = portionBytes(bytes.length, limit);
  return joinWindows(bytes.subarray(0, portion), bytes.subarray(-portion), bytes.length);
}

async function readFileContent(file: Bun.BunFile, size: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (size <= MAX_FILE_BYTES) {
    const bytes = await file.slice(0, size).arrayBuffer();
    signal.throwIfAborted();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  const portion = portionBytes(size, MAX_FILE_BYTES);
  const head = await file.slice(0, portion).arrayBuffer();
  signal.throwIfAborted();
  const tail = await file.slice(size - portion, size).arrayBuffer();
  signal.throwIfAborted();
  return joinWindows(new Uint8Array(head), new Uint8Array(tail), size);
}

/** The line that says how many batches of a writer's conversations do not
 *  read, if any. */
function batchNotices(unreadableBatches: number): string[] {
  return unreadableBatches === 0 ? []
    : unreadableBatches === 1 ? ["Partial evidence: 1 recorded batch of this agent's conversations could not be read, so its edits are not shown."]
    : [`Partial evidence: ${unreadableBatches} recorded batches of this agent's conversations could not be read, so their edits are not shown.`];
}

/** The part that shows one writer's recorded edits, or null when the writer
 *  recorded none and all of its evidence was read. `partial` holds one line
 *  for each kind of evidence that does not read. `budget` is the diff and
 *  notice bytes still free. */
function writerPart(agentName: string, files: readonly FileEdits[], partial: readonly string[], budget: number): { readonly text: string; readonly bytes: number } | null {
  if (files.length === 0 && partial.length === 0) return null;
  const diff = files.flatMap((file) => file.edits.flatMap((edit) => editDiff(file.display, edit) ?? [])).join("\n");
  const bounded = diff ? boundedText(diff, budget) : "";
  const notices = boundedNotices(files.flatMap(fileNotices), budget - Buffer.byteLength(bounded));
  const text = [
    `## File Edits by Agent "${agentName}"`,
    "These diffs are the edits that this agent's own tool calls recorded. A diff after a `# via` line is an edit of the subagent or workflow that it names, which the agent launched. Each diff is one recorded edit against the file as that edit found it, in recorded order.",
    ...partial,
    ...(bounded ? [`\`\`\`diff\n${bounded}\n\`\`\``] : []),
    ...notices,
  ].join("\n\n");
  return { text, bytes: Buffer.byteLength(bounded) + Buffer.byteLength(notices.join("\n\n")) };
}

/** The context bundle's file evidence for the writers of the prior handoff and
 *  the inherited artifacts. Each writer's part shows only the edits that its
 *  own conversations' tool calls recorded, and every edit of each subagent or
 *  workflow that those calls launched and of its descendants, each as its own
 *  diff from the recording session's file facts at read time. So the agent
 *  of a sibling item, any other agent, a session that the writer did not launch, or the
 *  person never appears as that writer's change. A writer that recorded no edit gets no part. A separate
 *  part shows the current state of every file that a writer edited or that
 *  its handoff names, which other work can also have changed. Diff, notice,
 *  and file bytes stay within fixed budgets, and every truncation, every edit
 *  whose diff text is not retained or held a credential, every unreadable
 *  conversation batch, and every launched session whose edits do not read is
 *  disclosed.
 *  Cancellation stops admission between reads; an admitted read settles
 *  first. Missing or unreadable UTF-8 files are omitted, and admitted reads
 *  still consume budget. Store read failures propagate. */
export async function buildArtifactContext(
  writers: readonly ArtifactWriter[],
  deps: ArtifactContextDeps,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  const base = canonicalMutationPath(deps.executionCwd);
  const members = await workflowMembershipReader(deps.reader).list(deps.workflowId);
  signal.throwIfAborted();

  // The session manager's own metadata read: an agent's calls launch the
  // workflow session's children.
  const read: SessionManager["read"] = (id) => readSessionMetadata(deps.reader, id);
  const parts: string[] = [];
  const files = new Map<string, ArtifactFile>();
  let diffBudget = MAX_DIFF_BYTES;
  let editedFiles = 0;
  let launchedSessions = 0;
  for (const writer of writers) {
    const calls = await writerCalls(deps.reader, writer.conversationIds, signal);
    const own = calls.toolUseIds;
    const sources: EditSource[] = [];
    const notices = [...batchNotices(calls.unreadableBatches)];
    const launched = [];
    for (const member of members.filter(({ conversationId }) => writer.conversationIds.includes(conversationId))) {
      const review = await getSessionChangeReview(deps.reader, member.sessionId);
      sources.push({ review, owns: (change) => change.sessionId === member.sessionId && isOwnChange(change, own) });
      const descendants = await readLaunchedChildren(read, member.sessionId);
      launched.push(...descendants.children);
      const gaps = review.unknownFileMutationGaps(member.sessionId);
      if (gaps > 0) notices.push(`Partial evidence: ${gaps} recorded file edits of this agent could not be read.`);
      if (descendants.unreadable > 0) notices.push(`Partial evidence: ${descendants.unreadable} child sessions of this agent could not be read.`);
    }
    const children = await launchedSources(read, launched.filter(({ session }) => session.launchedFrom?.toolUseId !== undefined && own.has(session.launchedFrom.toolUseId)), deps.reader, signal);
    launchedSessions += children.sources.length;
    sources.push(...children.sources);
    const edits = own.size > 0 ? await writerEdits(sources, deps, base, signal) : [];
    editedFiles += edits.length;
    const part = writerPart(writer.agentName, edits, [...notices, ...children.notices], diffBudget);
    if (part) {
      parts.push(part.text);
      diffBudget = Math.max(0, diffBudget - part.bytes);
    }
    for (const file of [...edits, ...namedFiles(writer.handoffs.flatMap(artifactPaths), deps.executionCwd, base)]) {
      if (!files.has(file.absolute)) files.set(file.absolute, { display: file.display, absolute: file.absolute });
    }
  }

  const currentIntro = "Each file below is its current state. Other work can also have changed it since the agents above edited it.";
  let budget = MAX_CONTEXT_BYTES - Buffer.byteLength(parts.join("\n\n"))
    - Buffer.byteLength(`## Current Files (${files.size}/${files.size} shown)\n\n${currentIntro}\n\n`) - 2;
  const fileSections: string[] = [];
  for (const { display: path, absolute } of files.values()) {
    signal.throwIfAborted();
    const ext = path.split(".").pop() ?? "";
    const prefix = `#### ${path}\n\`\`\`${ext}\n`;
    const suffix = "\n```";
    const overhead = Buffer.byteLength(prefix + suffix) + (fileSections.length > 0 ? 2 : 0);
    if (overhead >= budget) continue;
    try {
      const file = Bun.file(absolute);
      const { size } = await file.stat();
      signal.throwIfAborted();
      const reservation = Math.min(size, MAX_FILE_BYTES) + overhead;
      if (reservation > budget) continue;
      budget -= reservation;
      fileSections.push(prefix + await readFileContent(file, size, signal) + suffix);
    } catch {
      signal.throwIfAborted();
      // Handoffs can name missing files or files that are not readable UTF-8,
      // and an agent can have deleted a file it edited.
    }
  }
  if (fileSections.length > 0) {
    const header = fileSections.length < files.size
      ? `## Current Files (${fileSections.length}/${files.size} shown)`
      : "## Current Files";
    parts.push([header, currentIntro, fileSections.join("\n\n")].join("\n\n"));
  }
  if (parts.length === 0) return null;

  const result = parts.join("\n\n");
  log.info("artifact context built", {
    writerCount: writers.length,
    launchedSessionCount: launchedSessions,
    editedFileCount: editedFiles,
    fileCount: files.size,
    filesIncluded: fileSections.length,
    diffBytes: MAX_DIFF_BYTES - diffBudget,
    bytes: Buffer.byteLength(result),
  });
  return result;
}
