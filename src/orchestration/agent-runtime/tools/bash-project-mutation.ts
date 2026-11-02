/**
 * Runs one mutating bash command in a private copy of the project and lands
 * what it changed as file mutations of that bash tool call.
 *
 * Publication goes through the shared file edit publisher, so lineage facts,
 * path queues, the read ledger, and Git AI attribution are the same ones the
 * edit and write tools use. The model still sees a bash call and its result;
 * the result names the applied, merged, and refused files, and its details
 * carry the canonical mutation diff that per-file undo reads.
 *
 * A command that a planned replacement handed to a later build lands there,
 * through the same landing, from the record the launching build wrote into the
 * copy's home when it took the copy (ARCH-RUNTIME-033).
 */

import { lstatSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PersistenceWriteRefused } from "../../../infra/event-store-types.js";
import { join, sep } from "node:path";
import type { ContainedFileMetadata } from "../../../infra/descriptor-directory.js";
import { DebugLog } from "../../../infra/debug-log.js";
import { errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { buildMutationBytesEvidence, type MutationEvidenceEntry } from "../../../infra/mutation-evidence.js";
import { formatConflictMarkers, formatFileSamples, formatNotAppliedFiles, summarizeFileSamples, summarizeNotAppliedFiles, type NotAppliedFile } from "../../../infra/not-applied-files.js";
import { ownedCommandRunner, type OwnedCommandRunner } from "../../../infra/owned-command.js";
import type { FileEditAuthority, FileEditPublication, FileEditPublicationOutcome, PlannedFileEdit } from "../../file-edits/file-edit-operation.js";
import { RetainedFileEditAuthority } from "../../file-edits/retained-file-edit-host.js";
import { readCopyRepositoryState } from "./bash-copy-repository-state.js";
import { rebaseChange, type RebaseContext } from "./bash-copy-rebase.js";
import { deniedWriteNote, guardedArgv, hostMutationGuard, type MutationGuardKind } from "./bash-mutation-guard.js";
import { prepareMutationGitEnvironment } from "./bash-git-wrapper.js";
import { runPrivateCopyJob } from "./bash-private-copy-jobs.js";
import type { SessionFolderSnapshot } from "./bash-session-observation.js";
import type { RuntimePlatform } from "./bash-script.js";
import { detectCopyChanges, discardPrivateCopy, inspectPrivateCopyTopology, NoContainingWorkTreeError, pathInCopy, readPrivateProjectCopy, rewriteProjectRoot, takePrivateProjectCopy, type CopyRefresh, type LandableCopy, type LandableCopyRead, type PrivateProjectCopy } from "./bash-private-copy.js";
import type { CopyRelease, LaunchStamp, PrivateCopyPool } from "./bash-private-copy-pool.js";
import type { CopyChange, CopyChanges, RemovedDirectory, UnsupportedChange } from "./bash-private-copy-tree.js";
import { boundedMutationReport, publicationEvidence, publishToolFileEditOutcome, settledMutationEvidence } from "./file-edit-tool-adapter.js";
import { publishFileMutationAttribution } from "./file-mutation-artifact.js";
import type { ShellEnvironment } from "./shell-environment.js";
import type { PrivateCopy, ProjectMutationLanding, ProjectMutationSettlement } from "./shell-runtime-types.js";
import type { ToolContext, ToolResult } from "./types.js";

const log = Log.create({ service: "agent-bash" });

/** Concurrent writers are the premise of a rebase, so a file that changes again during its publication is merged
 *  again; past this many merges it is reported as not applied instead. */
const MAX_REBASES = 3;

/** What a landing reads of the tool call that ran its command: the session
 *  and call its changes publish under, and where the read ledger and Git AI
 *  attribution learn of them. A later build that adopted the command holds
 *  only what its handover row carries of the call, so it lands without the
 *  call's read ledger and attribution identity, which live in memory only. */
type MutationLandingContext = Pick<ToolContext, "sessionId" | "toolUseId" | "modelRequestId" | "parentToolUseId" | "sessionEventWriter" | "sessionEventStore" | "readLedger" | "gitAiAttribution" | "attributionIdentity">;

/** The landing of each copy this process lands for a command a previous build
 *  handed over, by the copy's home, for the life of the process. A host and the
 *  executor's keeper can each meet the end of the command of one handover row,
 *  and only the one that retires the row publishes, so both hold this one
 *  landing: a second landing would find the project changed already and report
 *  nothing, and the one that publishes could be that one. */
const handedOverLandings = new Map<string, Promise<ProjectMutationLanding>>();

/** The command, working directory, environment, and guarded launcher that
 *  place one execution inside the private copy, and the copy with the landing
 *  step its runner calls at exit. */
interface IsolatedExecution {
  readonly command: string;
  readonly context: ToolContext;
  readonly env: ShellEnvironment;
  readonly spawnOwned: NonNullable<ToolContext["spawnOwned"]>;
  readonly privateCopy: PrivateCopy;
}

/** An uncaptured launch overrides only its environment, never copy authority or OS guarding. */
export type MutationExecution = IsolatedExecution | Pick<IsolatedExecution, "env">;

/** Copies the project when cwd is inside it, otherwise the Git work tree that
 *  contains cwd. Refuses a cwd outside both without launching the command.
 *  Takes the copy under `home`, with its record, and launches the command in
 *  it through `run`. The runner lands the copy when the command exits, which
 *  for a managed command can be long after `run` returns: every file the
 *  command added, changed, or deleted there is published as a mutation of this
 *  tool call. A file that changed in the real project after the copy was taken
 *  gets the command's change merged into its current content (see
 *  `rebaseChange`); a change that cannot merge leaves the file as it is. An
 *  interrupted current-policy command publishes no project files. Session-folder writes
 *  already landed and remain observable. With a `pool`, the session's shell
 *  runtime's, the take refreshes the session's idle copy in place, and a copy
 *  whose landing ran to its end with its changes published or none to publish
 *  goes back to the pool when the pool proves that no process the command
 *  started still runs and holds no other copy of the project. Every other copy
 *  is deleted in the background once it lands, or when the launch fails: one
 *  of an interrupted command, of a landing that threw anywhere (evidence
 *  staging included), of a launch whose start stamp is unproven, or with no
 *  pool. Rejected and unverifiable copies stay available
 *  with their records, including Git-backed legacy copies that were interrupted. A command a planned replacement
 *  handed to a later build lands there instead (`handedOverPrivateCopy`), so
 *  this build neither lands nor deletes its copy, and a copy whose home a
 *  handover row names never goes back to the pool. A command whose copy cannot be
 *  taken still runs, in the real project, uncaptured (`runUncaptured`). The landing
 *  checks execution policy, repository topology, and semantic Git state before publishing file contents only. */
export async function runInPrivateCopy(input: {
  readonly context: ToolContext;
  readonly spawnOwned: NonNullable<ToolContext["spawnOwned"]>;
  readonly command: string;
  readonly env: ShellEnvironment;
  readonly home: string;
  /** The session scratch directory, which holds the mutation Git shim that every command of the session shares. */
  readonly scratchDir: string;
  readonly platform?: RuntimePlatform;
  readonly execPath?: string;
  readonly pool?: PrivateCopyPool;
  /** Launches the command; with no isolated execution, in the real project. */
  readonly run: (execution?: MutationExecution) => Promise<ToolResult>;
}): Promise<ToolResult> {
  const { context, spawnOwned, pool } = input;
  let env: ShellEnvironment;
  try {
    env = prepareMutationGitEnvironment({ env: input.env, scratchDir: input.scratchDir, cwd: context.executionCwd, platform: input.platform ?? process.platform, execPath: input.execPath ?? process.execPath });
  } catch (error) {
    return { content: `Error: Flywheel could not prepare the mutation Git wrapper (${errorMessage(error)}). This mutating command was not launched.`, outcome: "error" };
  }
  const runCommand = ownedCommandRunner({ spawnOwned });
  const guard = await hostMutationGuard(runCommand);
  let copy: PrivateProjectCopy;
  let executionCwd: string;
  let guarded: (argv: readonly string[]) => string[];
  try {
    if (guard.kind === "none" && process.platform !== "win32") throw new Error("the host's mutation guard is unavailable");
    // A model-supplied cwd can name the tree through a link or another letter case; the project root is already physical.
    executionCwd = realpathSync.native(context.executionCwd);
    copy = await takePrivateProjectCopy({ projectRoot: context.projectRoot, executionCwd, home: input.home, scratchDir: context.scratchDir, runGit: runCommand, guard: guard.kind, pool });
    guarded = guardedArgv(guard, copy);
  } catch (error) {
    discardPrivateCopy({ home: input.home });
    if (error instanceof NoContainingWorkTreeError) return { content: `Error: ${error.message}`, outcome: "error" };
    return await runUncaptured(input, guard.kind, error, env);
  }
  let landing: Promise<ProjectMutationLanding> | undefined;
  let launch: LaunchStamp | undefined;
  let withheld = false;
  const land: PrivateCopy["land"] = (settlement) => {
    landing ??= landPrivateCopy(context, copy, settlement, runCommand, { refresh: copy.refresh, release: pool && (() => withheld ? "handover" : pool.release(copy.reuse, launch)) });
    return landing;
  };
  try {
    return await input.run({
      command: rewriteProjectRoot(copy, input.command),
      context: { ...context, executionCwd: pathInCopy(copy, executionCwd) },
      env,
      spawnOwned: async (argv, options) => {
        const owned = await spawnOwned(guarded(argv), options);
        // The supervisor lives until its container settles, so its stamp is readable now.
        launch = pool?.launchStamp(owned.pid, guard.pidNamespace);
        return owned;
      },
      privateCopy: { home: copy.home, land, withhold: () => { withheld = true; } },
    });
  } catch (error) {
    // A runner throws only before its command launched or after it landed, so no later landing can still need the copy.
    if (!landing) discardPrivateCopy(copy);
    throw error;
  }
}

/** Runs a command whose copy could not be taken in the real project instead:
 *  the command always runs, and the capture of its changes is lost with the OS
 *  guard, which exists only to keep writes inside a copy. The
 *  result says so, so the agent can review the project, and the one
 *  `agent.bash.mutation.uncaptured` record beside `agent.bash.mutation.applied`
 *  gives the rate at which capture fails. */
async function runUncaptured(input: Parameters<typeof runInPrivateCopy>[0], guard: MutationGuardKind, error: unknown, env: ShellEnvironment): Promise<ToolResult> {
  const { context } = input;
  DebugLog.record({
    type: "agent.bash.mutation.uncaptured",
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    payload: { ...(context.toolUseId ? { toolUseId: context.toolUseId } : {}), guard, error: errorMessage(error) },
  });
  const result = await input.run({ env });
  return { ...result, content: `Flywheel could not take a private copy of the project (${errorMessage(error)}), so this command ran directly in the project and its file changes were not recorded as mutations. Run \`git status\` to review what it changed.\n\n${result.content}` };
}

/** The private copy of a command a previous build handed over, which the
 *  build that adopted the command lands when the command ends there: from the
 *  record the launching build wrote into `home` when it took the copy, through
 *  the landing that build would have run, as mutations of the command's tool
 *  call under `context`. The copy lands once in this process, whichever of its
 *  consumers meets the command's end first. A copy whose record is missing or
 *  unreadable lands nothing: its report names the copy, which stays, and the
 *  reason is recorded once. */
export function handedOverPrivateCopy(input: { readonly home: string; readonly context: MutationLandingContext; readonly spawnOwned: NonNullable<ToolContext["spawnOwned"]> }): PrivateCopy {
  const { home } = input;
  return {
    home,
    land: (settlement) => {
      const known = handedOverLandings.get(home);
      if (known) return known;
      const landing = landRecordedCopy(input, settlement);
      handedOverLandings.set(home, landing);
      return landing;
    },
  };
}

async function landRecordedCopy(input: Parameters<typeof handedOverPrivateCopy>[0], settlement: ProjectMutationSettlement): Promise<ProjectMutationLanding> {
  const { home, context } = input;
  const startedAt = performance.now();
  let read: LandableCopyRead;
  try {
    read = await readPrivateProjectCopy(home);
  } catch {
    read = { kind: "unreadable", reason: "could not be read" };
  }
  if (read.kind === "recorded") return await landPrivateCopy(context, read.copy, settlement, ownedCommandRunner({ spawnOwned: input.spawnOwned }));
  const reason = read.kind === "missing" ? "is missing" : read.reason;
  recordMutation(context, { ...emptyFilesSummary("record_unavailable"), startedAt }, { fate: "retained" });
  return mergeSessionEvidence(context, home, undefined, unlandableCopy(context, home, { kind: read.kind, reason }));
}

/** A copy this build took for a live command: whether the take refreshed an
 *  idle copy, and the step that gives it back to its session's pool, absent
 *  without a pool. A copy a previous build handed over has neither. */
interface TakenCopy {
  readonly refresh: CopyRefresh | undefined;
  readonly release: (() => "pooled" | CopyRetirement) | undefined;
}

/** Why a copy that could have gone back to its pool was discarded: the pool
 *  refused it, or `handover`, a handover row names its home, from which a
 *  later build can land it. */
type CopyRetirement = Exclude<CopyRelease, "pooled"> | "handover";

/** Checks eligibility before preparing file edits. Rejected copies retain their original record for recovery.
 *  A taken copy goes back to its pool only when the whole landing returned, evidence staging included. */
async function landPrivateCopy(context: MutationLandingContext, copy: LandableCopy, settlement: ProjectMutationSettlement, runGit: OwnedCommandRunner, taken?: TakenCopy): Promise<ProjectMutationLanding> {
  let retainCopy = false;
  let landed = false;
  const startedAt = performance.now();
  let summary = emptyFilesSummary("error");
  const settle = (landing: ProjectMutationLanding, entries: readonly MutationEvidenceEntry[] = []) =>
    mergeSessionEvidence(context, copy.home, copy.realRoot, withNote(copy, settlement, landing), entries, copy.observedSession);
  try {
    if (copy.execution.kind === "legacy-unlandable") {
      retainCopy = true;
      summary = emptyFilesSummary("legacy_unlandable");
      return await settle(unlandableCopy(context, copy.home, { kind: "legacy" }));
    }
    if (settlement.interrupted) {
      summary = emptyFilesSummary("interrupted");
      return await settle({ report: "The command was interrupted, so its changes to project files were discarded.", retainReport: true });
    }
    if (copy.execution.kind === "file-only-v4") {
      let rejection: "changed" | "unverified" | undefined;
      try {
        const topology = await inspectPrivateCopyTopology({
          copyRoot: copy.copyRoot, treeRoot: copy.execution.treeRoot, shared: copy.shared,
          privateGitDir: copy.git.kind === "repository" ? copy.git.privateGitDir : null,
        });
        if (!isDeepStrictEqual(topology, copy.execution.baseline.topology)) rejection = "changed";
        else {
          const repository = copy.git.kind === "repository" ? await readCopyRepositoryState(copy.git.privateGitDir, runGit) : null;
          if (!isDeepStrictEqual(repository, copy.execution.baseline.repository)) rejection = "changed";
        }
      } catch {
        rejection = "unverified";
      }
      if (rejection) {
        retainCopy = true;
        summary = emptyFilesSummary(`repository_${rejection}`);
        return await settle(unlandableCopy(context, copy.home, { kind: rejection }));
      }
    }
    const files = await publishCopyChanges({ ...context, signal: settlement.signal }, copy, runGit);
    summary = files.summary;
    const landing = await settle(files.landing, files.entries);
    landed = true;
    return landing;
  } catch (error) {
    retainCopy = error instanceof PersistenceWriteRefused && error.stage !== "preparation";
    if (error instanceof PersistenceWriteRefused) summary = emptyFilesSummary("persistence_refused");
    throw error;
  } finally {
    const release = landed && (summary.status === "completed" || summary.status === "unchanged") ? taken?.release?.() : undefined;
    recordMutation(context, { ...summary, guard: copy.guard, startedAt }, {
      ...(taken ? { copy: taken.refresh ? "refreshed" : "taken", ...taken.refresh } : {}),
      fate: retainCopy ? "retained" : release === "pooled" ? "pooled" : "discarded",
      ...(release && release !== "pooled" ? { retire: release } : {}),
    });
    if (!retainCopy && release !== "pooled") discardPrivateCopy(copy);
  }
}

/** Session-folder writes land in place, even when project publication is refused. */
async function mergeSessionEvidence(context: Pick<MutationLandingContext, "sessionEventWriter">, home: string, projectRoot: string | undefined, landing: ProjectMutationLanding, projectEntries: readonly MutationEvidenceEntry[] = [], snapshot?: SessionFolderSnapshot): Promise<ProjectMutationLanding> {
  const writer = context.sessionEventWriter;
  const stage = writer?.stageSessionContentNodes?.bind(writer);
  if (writer && !stage) throw new Error("File mutation evidence staging is unavailable");
  const entries = [...projectEntries];
  const lines: string[] = [];
  let observed;
  try {
    observed = await runPrivateCopyJob({ kind: "session", home, projectRoot, ...(snapshot ? { snapshot } : {}) });
  } catch (error) {
    lines.push(`Session-folder changes could not be verified: ${errorMessage(error)}`);
  }
  if (observed?.kind === "damaged") lines.push("Session-folder changes could not be verified because the before image was damaged.");
  if (observed?.kind === "observed" && (observed.changes.length > 0 || observed.removedDirectories.length > 0)) {
    lines.push("Recorded in session folder:", ...removedDirectoryLines(observed.removedDirectories), ...observed.changes.slice(0, 4).map(change => `${change.after === undefined ? "Deleted" : change.before === undefined ? "Created" : "Updated"} ${change.path}`));
    if (observed.changes.length > 4) lines.push(`and ${observed.changes.length - 4} more files (open this command's file-change evidence)`);
    if (stage) {
      entries.push(...observed.removedDirectories.map(directory => ({ kind: "removed_directory" as const, ...directory, displayPath: directory.path })));
      for (const change of observed.changes) {
        const file = await buildMutationBytesEvidence({ ...change, mutationId: randomUUID() }, stage);
        if (file) entries.push({ kind: "applied", file });
      }
    }
  }
  // Removed directories lead the manifest, so a reader that pages it meets each one before the files it held.
  const ordered = [...entries.filter(entry => entry.kind === "removed_directory"), ...entries.filter(entry => entry.kind !== "removed_directory")];
  const mutationEvidence = stage && entries.length > 0 ? await settledMutationEvidence(ordered, stage) : undefined;
  const report = landing.report === "No project files changed." && lines.length > 0 ? lines.join("\n") : [landing.report, ...lines].join("\n");
  return { ...landing, report: boundedMutationReport(report), ...(observed === undefined || observed.kind === "damaged" ? { retainReport: true as const } : {}), ...(mutationEvidence ? { mutationEvidence } : {}) };
}

function unlandableCopy(context: MutationLandingContext, home: string, reason: { readonly kind: "missing" | "unreadable"; readonly reason: string } | { readonly kind: "legacy" } | { readonly kind: "changed" } | { readonly kind: "unverified" }): ProjectMutationLanding {
  log.warn("a private copy cannot be landed; its completion names the copy", { sessionId: context.sessionId, toolUseId: context.toolUseId, reason: reason.kind });
  if (reason.kind === "legacy") return { retainReport: true, report: `The runtime moved to a newer build while this command ran in a private copy of the project, and the newer build cannot land that copy, because a build that still landed Git changes took it and its changes cannot be proven to be only the command's own file edits. None of the command's changes were applied to the project. The changed files and the copy's record remain at ${home}. Inspect that copy and apply the changes you need. Run Git commands as separate calls without mutates.` };
  if (reason.kind === "changed" || reason.kind === "unverified") return { retainReport: true, report: `${reason.kind === "changed" ? "A Git command changed the repository inside this mutating command" : "Flywheel could not verify the private copy's repository state"}. None of the command's changes were applied to the project. The changed files remain in the copy at ${home}. Run Git commands as separate calls without mutates. Inspect the copy and apply the file changes you need.` };
  return { retainReport: true, report: `The runtime moved to a newer build while this command ran in a private copy of the project, and the newer build cannot land that copy, because the copy's record ${reason.reason.slice(0, 160)}. None of the command's changes were applied to the project. The changed files remain in the copy at ${home}.` };
}

/** The report reaches the foreground result and the managed completion notification alike. */
function withNote(copy: LandableCopy, settlement: ProjectMutationSettlement, landing: ProjectMutationLanding): ProjectMutationLanding {
  const note = deniedWriteNote(copy.guard, copy, settlement.output);
  return note ? { ...landing, report: boundedMutationReport(`${landing.report}\n\n${note}`) } : landing;
}

type FilesSummary = Pick<MutationSummary, "files" | "rebased" | "conflictMarkers" | "notApplied" | "unsupported" | "status">;

function emptyFilesSummary(status: string): FilesSummary {
  return { files: 0, rebased: 0, conflictMarkers: 0, notApplied: 0, unsupported: 0, status };
}

async function publishCopyChanges(context: MutationLandingContext & Pick<ToolContext, "signal">, copy: LandableCopy, runGit: OwnedCommandRunner): Promise<{ readonly landing: ProjectMutationLanding; readonly summary: FilesSummary; readonly entries: readonly MutationEvidenceEntry[] }> {
  let scanned: CopyChanges;
  try {
    scanned = await detectCopyChanges(copy);
  } catch (error) {
    return {
      landing: { report: `No project file changes were applied: could not read the private copy: ${errorMessage(error)}` },
      summary: { files: 0, rebased: 0, conflictMarkers: 0, notApplied: 0, unsupported: 0, status: "error" },
      entries: [],
    };
  }
  const { changes, unsupported, removedDirectories } = scanned;
  const unsupportedLine = unsupportedLines(unsupported);
  if (changes.length === 0 && unsupported.length === 0 && removedDirectories.length === 0) {
    return {
      landing: { report: "No project files changed." },
      summary: { files: 0, rebased: 0, conflictMarkers: 0, notApplied: 0, unsupported: unsupported.length, status: "unchanged" },
      entries: [],
    };
  }
  const commandChanges = new Map(changes.map(change => [change.path, change]));
  const rebase: RebaseContext = { realRoot: copy.realRoot, baseRoot: copy.baseRoot, scratch: join(copy.home, "merge"), runGit, ...(context.signal ? { signal: context.signal } : {}) };
  const applied: FileEditPublication[] = [];
  /** Per rebased path, whether its latest merge marked conflicts. */
  const merges = new Map<string, boolean>();
  const notApplied: NotAppliedFile[] = [];
  const present: string[] = [];
  let stop: Exclude<FileEditPublicationOutcome<PlannedFileEdit>, { readonly status: "completed" }> | undefined;
  let failure: unknown;
  // The first round publishes every change. A file the project changed since
  // the copy was taken comes back as a conflict, is merged with the project's
  // current file, and publishes in the next round; a file that changes again
  // meanwhile is merged again, at most MAX_REBASES times. A file that stopped
  // being a regular file during its merge goes back to the next round as the
  // command left it, so that round finds and merges its new state.
  try {
    let pending = changes;
    for (let rebases = 0; pending.length > 0; rebases++) {
      const outcome = await publishChanges(context, copy, pending, merges);
      applied.push(...outcome.committedPrefix);
      if (outcome.status === "uncertain" && outcome.settlement === "committed") applied.push(outcome.current);
      if (outcome.status !== "completed") {
        stop = outcome;
        break;
      }
      if (rebases === MAX_REBASES) {
        notApplied.push(...outcome.conflicts.map(path => ({ path, reason: "it changed again after each merge" })));
        break;
      }
      const next: CopyChange[] = [];
      for (const path of outcome.conflicts) {
        const change = commandChanges.get(path)!; // SAFETY: conflicts name only published paths, each a key of commandChanges.
        const rebased = await rebaseChange(change, rebase);
        if (rebased.kind === "merged") {
          next.push(rebased.change);
          merges.set(path, rebased.marked);
        } else if (rebased.kind === "changed") {
          next.push(change);
          merges.delete(path);
        } else if (rebased.kind === "not_applied") notApplied.push({ path, reason: rebased.reason });
        else present.push(path);
      }
      pending = next;
    }
  } catch (error) {
    if (error instanceof PersistenceWriteRefused) throw error;
    failure = error;
  } finally {
    // A managed command lands after its tool call settled, so the landing, not the call, offers the settled files.
    publishFileMutationAttribution(context);
  }
  removeEmptiedDirectories(copy.realRoot, removedDirectories);
  const appliedPaths = applied.map(publication => publication.plan.admitted.path);
  const rebased = appliedPaths.filter(path => merges.get(path) === false);
  const conflictMarkers = appliedPaths.filter(path => merges.get(path) === true);
  const accounted = new Set([...appliedPaths, ...notApplied.map(file => file.path), ...present, ...(stop ? [stop.current.plan.admitted.path] : [])]);
  const untouched = changes.map(change => change.path).filter(path => !accounted.has(path));
  if (stop?.status === "not_applied") notApplied.push({ path: stop.current.plan.admitted.path, reason: stop.reason === "cancelled" ? "publication was interrupted" : errorMessage(stop.error) });
  notApplied.push(...untouched.map(path => ({ path, reason: "publication stopped before this file" })));
  const refusalSummary = summarizeNotAppliedFiles(notApplied);
  const entries: MutationEvidenceEntry[] = [
      ...removedDirectories.map(directory => ({ kind: "removed_directory" as const, ...directory, path: join(copy.realRoot, directory.path), displayPath: directory.path })),
      ...publicationEvidence(applied),
      ...notApplied.map(file => ({ kind: "not_applied" as const, ...file })),
      ...unsupported.map(file => ({ kind: "not_applied" as const, path: file.path, reason: file.reason })),
  ];
  const summary: FilesSummary = { files: applied.length, rebased: rebased.length, conflictMarkers: conflictMarkers.length, notApplied: notApplied.length, unsupported: unsupported.length, status: failure === undefined ? stop?.status ?? "completed" : "error" };
  const lines = [
    ...(applied.length > 0 || removedDirectories.length > 0 ? ["Applied to the project:", ...removedDirectoryLines(removedDirectories), ...applied.slice(0, 4).map(publication => `${publication.bytes === undefined ? "Deleted" : publication.plan.admitted.authority.snapshot === undefined ? "Created" : "Updated"} ${publication.plan.admitted.path}`), ...(applied.length > 4 ? [`and ${applied.length - 4} more files (open Session Changes)`] : [])] : []),
    ...(rebased.length > 0 ? [`These files also keep the changes the project made while the command ran: ${formatFileSamples(summarizeFileSamples(rebased))}`] : []),
    ...(conflictMarkers.length > 0 ? [`${formatConflictMarkers(summarizeFileSamples(conflictMarkers))}. Edit each file to resolve the marked sections.`] : []),
    ...(notApplied.length > 0 ? [`${formatNotAppliedFiles(refusalSummary)}. Make these changes again against the current files if they are still necessary.`] : []),
    ...unsupportedLine,
    ...(failure === undefined ? [] : [`${applied.length > 0 ? "Publication stopped" : "No project file changes were applied"}: ${errorMessage(failure)}`]),
    ...(stop ? [`Publication stopped: ${stoppedState(stop)}`] : []),
    ...((failure !== undefined || stop) && untouched.length > 0 ? [`Not applied: ${formatFileSamples(summarizeFileSamples(untouched))}`] : []),
  ];
  const landing: ProjectMutationLanding = {
    report: boundedMutationReport(lines.join("\n")),
    ...(notApplied.length > 0 ? { notAppliedSummary: refusalSummary } : {}),
  };
  return { landing, summary, entries };
}

/** Removes each directory the command removed once publication emptied it. Only an empty
 *  directory is removed, never a file, so a directory that still holds a file, such as one a
 *  concurrent writer created or one whose deletion was not applied, stays as it is. A link is
 *  never followed, at the directory, at any directory above it, or below it, so no directory
 *  outside the project is removed. */
function removeEmptiedDirectories(realRoot: string, directories: readonly RemovedDirectory[]): void {
  const prune = (directory: string): void => {
    try {
      // Dirent kinds come from lstat, so a link below the directory is not entered.
      for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) prune(join(directory, entry.name));
      rmdirSync(directory);
    } catch {
      // A directory that is not empty or not readable stays; nothing else depends on its removal.
    }
  };
  const realDirectory = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  for (const { path } of directories) {
    const parts = path.split(sep);
    if (parts.every((_, index) => realDirectory(join(realRoot, ...parts.slice(0, index + 1))))) prune(join(realRoot, path));
  }
}

/** The report lines that name each removed directory, at most four. */
function removedDirectoryLines(directories: readonly RemovedDirectory[]): string[] {
  return [
    ...directories.slice(0, 4).map(directory => `Removed directory ${directory.path}${sep} (${directory.files} file${directory.files === 1 ? "" : "s"})`),
    ...(directories.length > 4 ? [`and ${directories.length - 4} more directories`] : []),
  ];
}

/** Publishes one round of changes, each expected to find the real file in the state it names. */
async function publishChanges(context: MutationLandingContext & Pick<ToolContext, "signal">, copy: Pick<LandableCopy, "realRoot">, changes: readonly CopyChange[], merges: ReadonlyMap<string, boolean>): Promise<FileEditPublicationOutcome<PlannedFileEdit>> {
  const byPath = new Map(changes.map(change => [change.path, change]));
  return publishToolFileEditOutcome({ ...context, executionCwd: copy.realRoot }, {
    paths: changes.map(change => change.path),
    expected: new Map(changes.map(change => [change.path, change.expected])),
    // No link below the project root is followed, so no publication lands outside it; the bytes are exact at any size.
    admit: resolvedPath => RetainedFileEditAuthority.admitWritable(resolvedPath, copy.realRoot, Number.POSITIVE_INFINITY),
    plan: admitted => admitted.map(entry => ({ ...plannedEdit(entry, byPath.get(entry.path)!), conflictMarkers: merges.get(entry.path) ?? false })), // SAFETY: the publisher admits only the paths listed above, each a key of byPath.
  });
}

function plannedEdit(admitted: PlannedFileEdit["admitted"], change: CopyChange): PlannedFileEdit {
  const metadata = change.after === undefined ? undefined : publicationMetadata(admitted.authority, change.mode);
  return { admitted, after: change.after, ...(metadata ? { metadata } : {}) };
}

/** A file the command created carries the copy's POSIX permission bits, so a script it made executable stays
 *  executable. An existing file keeps its own, as every publication does, also when the command's file was merged
 *  into one the project created meanwhile. */
function publicationMetadata(authority: FileEditAuthority, mode: number | undefined): ContainedFileMetadata | undefined {
  if (authority.snapshot) return undefined;
  return process.platform !== "win32" && mode !== undefined ? { kind: "posix", mode } : authority.defaultPublicationMetadata();
}

/** The publisher lands regular file contents only; the agent can make these changes again without `mutates`. */
function unsupportedLines(unsupported: readonly UnsupportedChange[]): string[] {
  if (unsupported.length === 0) return [];
  const sample = summarizeNotAppliedFiles(unsupported.map(change => ({ path: change.path, reason: change.reason })));
  return [`Not applied, because only the contents of regular files land in the project: ${formatFileSamples({ total: sample.total, samples: sample.samples.map(change => `${change.path} (${change.reason})`) })}. Make these changes again without mutates.`];
}

/** The publisher stops at the first item it cannot settle, and states what became of it. */
function stoppedState(outcome: Exclude<FileEditPublicationOutcome<PlannedFileEdit>, { readonly status: "completed" }>): string {
  const path = outcome.current.plan.admitted.path;
  if (outcome.status === "not_applied") return `${path} was not applied: ${errorMessage(outcome.error)}`;
  return outcome.publication === "unknown" ? `${path} may have changed: ${errorMessage(outcome.error)}` : `${path} was applied, but ${outcome.settlement === "pending" ? "it is not durably recorded" : "its result could not be observed"}: ${errorMessage(outcome.error)}`;
}

interface MutationSummary {
  readonly files: number;
  readonly rebased: number;
  readonly conflictMarkers: number;
  readonly notApplied: number;
  readonly unsupported: number;
  readonly status: string;
  readonly guard?: MutationGuardKind;
  readonly startedAt: number;
}

/** What became of a landed copy. `copy` and the refresh counts describe a copy
 *  this build took; `retire` names why an otherwise reusable copy was discarded,
 *  so the rate of each retirement can be measured. */
interface CopyFate {
  readonly copy?: "taken" | "refreshed";
  readonly recloned?: number;
  readonly removed?: number;
  readonly refreshMs?: number;
  readonly fate: "pooled" | "discarded" | "retained";
  readonly retire?: CopyRetirement;
}

/** One record per `mutates` command: counts, the OS guard, the copy's fate, and duration only, never paths or content. */
function recordMutation(context: Pick<ToolContext, "sessionId" | "toolUseId">, summary: MutationSummary, fate: CopyFate): void {
  DebugLog.record({
    type: "agent.bash.mutation.applied",
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    payload: {
      ...(context.toolUseId ? { toolUseId: context.toolUseId } : {}),
      files: summary.files,
      rebased: summary.rebased,
      conflictMarkers: summary.conflictMarkers,
      notApplied: summary.notApplied,
      unsupported: summary.unsupported,
      status: summary.status,
      ...(summary.guard ? { guard: summary.guard } : {}),
      ...fate,
      durationMs: Math.round(performance.now() - summary.startedAt),
    },
  });
}
