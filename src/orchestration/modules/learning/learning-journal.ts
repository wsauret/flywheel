/** The audit outbox of the two learning stores.
 *
 *  A memory entry, a managed skill package, and a global operation's manifest
 *  are the durable artifacts, but a mutation the event store never accepted is
 *  unattributable (ARCH-LEARNING-007). Recording the fact after the artifact
 *  changes leaves a window: a crash in it loses the evidence for a change that
 *  is already on disk, and the artifact cannot be produced again to repair it.
 *
 *  So the fact is journalled first. The complete fact, the workspace that owes
 *  it, and the artifact state it asserts are written durably beside the store
 *  before the artifact changes; the append follows; and the entry is dropped
 *  only once the store accepted it. Anything left in the outbox is evidence for
 *  a change that was never recorded, and the next writer of the same workspace
 *  replays it.
 *
 *  A replay proves what it does before it acts. The store must not already
 *  hold the fact: every audit fact carries the writer-prepared identity of one
 *  append, so one pass reads the recorded identities once and an entry whose
 *  identity is already there is settled by dropping it. And the artifact must
 *  say what became of the mutation. An entry is dropped only on proof that the
 *  change never reached the artifact: the memory file or package still holds the
 *  pre-state the entry was measured against, or the operation ended without
 *  committing the transition. An artifact that holds neither state has been
 *  moved on by a later mutation, which proves nothing about this one, so the
 *  evidence is recorded rather than erased. An operation that is still short of
 *  the transition and not yet terminal may be one durable write away from it, so
 *  its entry is left exactly where it is and the pass stops there, in order.
 *
 *  The outbox is origin-bound. The fact belongs to the session aggregate of the
 *  workspace that opened the entry, so only that workspace settles it. A shared
 *  global store read from another project leaves its entries alone rather than
 *  recording another workspace's evidence in its own event store.
 *
 *  This is not a second recovery authority: the outbox decides nothing about
 *  the artifact. It carries one already-decided fact to the event store. */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../../../infra/atomic-write.js";
import { contentEvidence } from "../../../infra/content-evidence.js";
import type { AsyncEventReadSurface } from "../../../infra/event-store-types.js";
import { createEventProjection, parseProjectionFact } from "../../../infra/event-projection.js";
import { heldProjection } from "../../../infra/projection-registry.js";
import { Log } from "../../../infra/log.js";
import type { MemoryWrittenFact } from "../../../workflows/memory/memory-facts.js";
import type { SkillOperationTransitionedFact, SkillWrittenFact } from "../../../workflows/skill-facts.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import { ensurePrivateDirectoryUnder, ensurePrivateRootDirectory, PRIVATE_FILE_MODE } from "../../../infra/private-path.js";
import { readFileUnder, requireContainedDirectory } from "../../../infra/write-file-under.js";
import { parseSessionFact } from "../../session/session-fact-registry.js";
import { packageDigestAt } from "./skill-package-planning.js";
import { isTerminalState, readOperationManifest } from "./skill-operation-manifest.js";

const log = Log.create({ service: "learning-journal" });

/** The facts a learning write must leave behind. Nothing else is journalled:
 *  every other fact belongs to a caller that can retry its own work. */
export type AuditFact = MemoryWrittenFact | SkillWrittenFact | SkillOperationTransitionedFact;

const AUDIT_TYPES = ["memory.written", "skill.written", "skill.operation.transitioned"] as const;

/** The artifact state one journalled fact asserts, with the pre-state it was
 *  measured against. Both are needed: the intended state proves the mutation
 *  landed, and only the pre-state can prove it did not. An operation asserts a
 *  transition number instead, because its manifest is the progress authority and
 *  its transitions are one total order. */
type IntendedState =
  | { readonly kind: "package"; readonly dir: string; readonly sha256: string; readonly previous: string | null }
  | { readonly kind: "archive"; readonly source: string; readonly sourceSha256: string; readonly destination: string; readonly destinationPrevious: string | null; readonly destinationSha256: string }
  | { readonly kind: "file"; readonly path: string; readonly sha256: string; readonly previous: string | null }
  | { readonly kind: "operation"; readonly operationId: string; readonly transition: number };

export interface PendingAudit {
  readonly path: string;
  readonly fact: AuditFact;
}

export interface AuditWriter {
  record(fact: AuditFact): Promise<import("../../../infra/event-store-types.js").StoredFact | null>;
}

export interface OpenPendingAuditInput {
  /** The learning store the artifact and this outbox live beside. */
  readonly storeDir: string;
  /** The workspace that owes the append: its project learning store directory,
   *  which names the one event store the fact belongs in. */
  readonly workspace: string;
  readonly fact: AuditFact;
  readonly intended: IntendedState;
}

/** The outbox directory, relative to the store it belongs to. Every entry is
 *  read through this relative path so the read resolves each component against
 *  its parent's descriptor below the store. */
const JOURNAL_RELATIVE_DIR = ".operations/audit";

/** One outbox entry holds one fact and the artifact state it asserts; anything
 *  larger is not one this writer produced. */
const MAX_JOURNAL_ENTRY_BYTES = 256 * 1024;

/** One artifact a journalled file state names is a learning store file, which is
 *  bounded by the store that writes it. */
const MAX_ARTIFACT_BYTES = 1024 * 1024;

function journalDir(storeDir: string): string {
  return join(storeDir, ".operations", "audit");
}

/** Journal one fact durably before the artifact it describes changes. */
export function openPendingAudit(input: OpenPendingAuditInput): PendingAudit {
  // The outbox can be the first thing written beside a learning store, so the
  // store root itself is created here; the tree below it is created without
  // following a link.
  ensurePrivateRootDirectory(input.storeDir);
  const dir = ensurePrivateDirectoryUnder(input.storeDir, JOURNAL_RELATIVE_DIR);
  const path = join(dir, entryName());
  const entry: JournalRecord = {
    version: 1,
    workspace: canonicalMutationPath(input.workspace),
    intended: input.intended,
    fact: input.fact,
  };
  writeFileAtomic(path, JSON.stringify(entry), { mode: PRIVATE_FILE_MODE, durableDirectorySync: true });
  return { path, fact: input.fact };
}

/** Record the journalled fact and drop the entry, or report the failure. A
 *  writer that resolves `null` wrote nothing, so it is a failure like any other:
 *  the entry stays for the next pass. */
export async function settlePendingAudit(pending: PendingAudit, writer: AuditWriter): Promise<boolean> {
  try {
    const stored = await writer.record(pending.fact);
    if (!stored) return false;
  } catch (err) {
    log.warn("learning audit fact failed", { type: pending.fact.type, err: String(err) });
    return false;
  }
  discardPendingAudit(pending);
  return true;
}

/** Drop an entry whose fact must not be recorded: the mutation was refused, or
 *  another run already recorded it. */
export function discardPendingAudit(pending: PendingAudit): void {
  rmSync(pending.path, { force: true });
}

export interface ReconcileAuditsInput {
  readonly storeDir: string;
  /** Only entries this workspace opened are settled here. */
  readonly workspace: string;
  readonly writer: AuditWriter;
  readonly reader: AsyncEventReadSurface;
  /** The entry the caller opened for a change it has not applied yet. Its
   *  artifact still holds the pre-state the entry was measured against, so a
   *  pass would read it as a change that never landed and erase the evidence
   *  of a change that is about to happen. It is left to its own caller. */
  readonly active?: PendingAudit;
}

/** Record every fact this workspace still owes one store, oldest first, and
 *  report how many landed. The recorded identities are read once for the whole
 *  pass. A malformed entry is moved aside rather than retried forever, and an
 *  entry the pass cannot settle - a failing append, or a change still in flight
 *  - stops it, keeping the remaining entries in order. */
export async function reconcilePendingAudits(input: ReconcileAuditsInput): Promise<number> {
  const names = journalEntries(input.storeDir);
  if (names.length === 0) return 0;
  const recordedIdentities = await storedAuditIdentities(input.reader).replay();
  const recordedThisPass = new Set<string>();
  const workspace = canonicalMutationPath(input.workspace);
  let recorded = 0;
  for (const name of names) {
    const entry = decodeJournalEntry(input.storeDir, name);
    if (!entry) continue;
    // Resolved on both sides: the caller's path came through a contained-open
    // that resolves it, while an entry's path is joined from the store root as
    // given. A drive-relative root makes those two spellings differ on Windows,
    // and a mismatch here erases the caller's own unpublished evidence.
    if (input.active !== undefined && resolve(entry.pending.path) === resolve(input.active.path)) continue;
    if (entry.record.workspace !== workspace) {
      // Remove after 2027-03-24: the operation producer formerly used the
      // project skill-store path as its workspace key, for both manifest versions.
      const intended = entry.record.intended;
      if (entry.pending.fact.type !== "skill.operation.transitioned" || intended.kind !== "operation") continue;
      const legacy = canonicalMutationPath(join(workspace, ".flywheel", "skills"));
      if (entry.record.workspace !== legacy) continue;
      const operation = readOperationManifest(input.storeDir, intended.operationId);
      if (operation.kind !== "ok" || canonicalMutationPath(operation.manifest.projectStoreDir) !== legacy) continue;
    }
    // The artifact an entry names must be one this store owns, or reading it
    // would measure a file outside the store to decide the entry's fate. Such an
    // entry is not this outbox's evidence: it is preserved, never read from.
    const escape = intendedOutsideStore(input.storeDir, entry.record.intended);
    if (escape) {
      quarantine(entry.pending.path, escape);
      continue;
    }
    if (recordedIdentities.has(entry.identity) || recordedThisPass.has(entry.identity)) {
      log.info("pending learning audit fact already recorded", { type: entry.pending.fact.type, identity: entry.identity });
      discardPendingAudit(entry.pending);
      continue;
    }
    const settlement = settlementOf(input.storeDir, entry.record.intended);
    if (settlement === "in_flight") {
      log.info("pending learning audit fact waits for the change it describes", { type: entry.pending.fact.type, identity: entry.identity });
      break;
    }
    if (settlement === "never_landed") {
      log.info("pending learning audit fact describes a change that did not land", { type: entry.pending.fact.type, identity: entry.identity });
      discardPendingAudit(entry.pending);
      continue;
    }
    if (!await settlePendingAudit(entry.pending, input.writer)) break;
    // The pass is its own producer too: two entries of one transition can be in
    // the outbox at once, and only this keeps the second from appending twice.
    recordedThisPass.add(entry.identity);
    recorded += 1;
  }
  if (recorded > 0) log.info("recovered pending learning audit facts", { storeDir: input.storeDir, recorded });
  return recorded;
}

/** What the artifact says about one journalled entry: the change landed, it
 *  provably never did, or it may still be committed. */
type Settlement = "landed" | "never_landed" | "in_flight";

function settlementOf(storeDir: string, intended: IntendedState): Settlement {
  if (intended.kind === "operation") return operationSettlement(storeDir, intended);
  if (intended.kind === "archive") {
    const source = packageDigest(storeDir, intended.source);
    const destination = packageDigest(storeDir, intended.destination);
    if (!existsSync(intended.source) && destination === intended.destinationSha256) return "landed";
    if (source === intended.sourceSha256 && destination === (intended.destinationPrevious ?? undefined)) return "never_landed";
    return "in_flight";
  }
  const digest = intended.kind === "package" ? packageDigest(storeDir, intended.dir) : fileDigest(storeDir, intended.path);
  if (digest === intended.sha256) return "landed";
  if (digest === (intended.previous ?? undefined)) return "never_landed";
  return "landed";
}

/** Progress of one operation is monotonic in its transition count, so the
 *  manifest answers exactly: at or past the transition it committed, terminal
 *  below it means it never will, and anything else is an operation whose next
 *  durable write may still be this one. */
function operationSettlement(globalRoot: string, intended: Extract<IntendedState, { kind: "operation" }>): Settlement {
  const read = readOperationManifest(globalRoot, intended.operationId);
  // No usable manifest is no operation: it was quarantined or forgotten, and
  // nothing it did can be attributed to a confirmation any more.
  if (read.kind !== "ok") return "never_landed";
  if (read.manifest.transition >= intended.transition) return "landed";
  return isTerminalState(read.manifest.state) ? "never_landed" : "in_flight";
}

/** Why the artifact this entry asserts is not one the store holding the entry
 *  owns, or undefined when it is. An operation asserts a transition of its own
 *  manifest, which the store resolves itself, so it names no path to contain. */
function intendedOutsideStore(storeDir: string, intended: IntendedState): string | undefined {
  if (intended.kind === "operation") return undefined;
  const targets = intended.kind === "archive"
    ? [intended.source, intended.destination]
    : [intended.kind === "package" ? intended.dir : intended.path];
  return targets.some((target) => containedRelativePath(storeDir, target) === undefined)
    ? `intended ${intended.kind} state names an artifact the store that holds this entry does not own`
    : undefined;
}

/** `target` as a store-relative POSIX path, or undefined when it is not below
 *  the store at all. */
function containedRelativePath(storeDir: string, target: string): string | undefined {
  const within = relative(resolve(storeDir), resolve(target));
  if (within === "" || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return undefined;
  return within.split(sep).join("/");
}

/** The digest of one package below its owning store. The package directory is
 *  admitted component by component before the package reader sees its path, so
 *  a package-level link cannot turn audit recovery into an outside-store read. */
function packageDigest(storeDir: string, packageDir: string): string | undefined {
  const within = containedRelativePath(storeDir, packageDir);
  if (within === undefined) return undefined;
  try {
    requireContainedDirectory(storeDir, within);
    return packageDigestAt(packageDir);
  } catch {
    return undefined;
  }
}

/** The digest of one artifact file, read through the store directory as a
 *  bounded regular file and never through a link. An artifact that cannot be
 *  read that way has no digest, which the caller reads as "not the state this
 *  entry asserts". */
function fileDigest(storeDir: string, filePath: string): string | undefined {
  const within = containedRelativePath(storeDir, filePath);
  if (within === undefined) return undefined;
  try {
    const bytes = readFileUnder(storeDir, within, { maxBytes: MAX_ARTIFACT_BYTES });
    return bytes ? contentEvidence(bytes.toString("utf8")).sha256 : undefined;
  } catch {
    return undefined;
  }
}

/** Workspace-wide audit identities advance once per committed suffix. */
function storedAuditIdentities(reader: AsyncEventReadSurface) {
  return heldProjection(reader, "learning-audit-identities", () => createEventProjection(reader, {
    factTypes: AUDIT_TYPES,
    initialState: () => new Set<string>(),
    reduce(identities, event) {
      const identity = auditIdentity(parseProjectionFact(event, parseSessionFact<AuditFact>));
      if (identity !== undefined) identities.add(identity);
      return identities;
    },
  }));
}

/** The writer-prepared identity of one append, or undefined when the fact
 *  carries none. The identity is what makes a replay probe exact: it names one
 *  append and never the bytes it describes, so a later mutation with identical
 *  content never matches, and one operation's states are distinct appends. */
function auditIdentity(fact: AuditFact): string | undefined {
  if (fact.type === "skill.operation.transitioned") return `${fact.payload.operationId}:${fact.payload.state}`;
  if (fact.type === "skill.written") return fact.payload.identity.kind === "recorded" ? fact.payload.identity.writeId : undefined;
  return fact.payload.identity.kind === "recorded" ? fact.payload.identity.mutationId : undefined;
}

/** The ordering key of one entry: the wall clock, a per-process sequence that
 *  breaks same-millisecond ties, and a unique suffix. Entries replay in the
 *  order they were journalled, and one operation's transitions are journalled by
 *  the one process that holds its package locks, so this is that operation's own
 *  order. */
let journalled = 0;

function entryName(): string {
  journalled += 1;
  return `${String(Date.now()).padStart(14, "0")}-${String(journalled).padStart(6, "0")}-${randomUUID()}.json`;
}

function journalEntries(storeDir: string): readonly string[] {
  try {
    return readdirSync(journalDir(storeDir)).filter((name) => name.endsWith(".json")).sort();
  } catch (err) {
    if (isAbsent(err)) return [];
    throw err;
  }
}

/** The durable form of one outbox entry. */
interface JournalRecord {
  readonly version: 1;
  readonly workspace: string;
  readonly intended: IntendedState;
  readonly fact: AuditFact;
}

/** One entry ready to replay: its durable record, the pending handle, and the
 *  identity of the append it carries. */
interface JournalEntry {
  readonly record: JournalRecord;
  readonly pending: PendingAudit;
  readonly identity: string;
}

/** Strictly decode one entry, or move it aside. The outbox is Flywheel-owned,
 *  so a record that does not decode is a producer bug: it is preserved for
 *  inspection and never guessed at. An entry without a mutation identity is one
 *  such record: a replay could not tell it apart from an append the store
 *  already accepted, so it is never appended on a guess.
 *
 *  The entry is read through the store directory as a bounded regular file: a
 *  link at an entry name, an entry that is not a regular file, and one over the
 *  read limit are all unusable evidence, moved aside rather than read or retried
 *  forever. */
function decodeJournalEntry(storeDir: string, name: string): JournalEntry | undefined {
  const path = join(journalDir(storeDir), name);
  let text: string;
  try {
    const bytes = readFileUnder(storeDir, `${JOURNAL_RELATIVE_DIR}/${name}`, {
      maxBytes: MAX_JOURNAL_ENTRY_BYTES,
      privateDirectories: true,
    });
    if (!bytes) return undefined;
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    if (isAbsent(err)) return undefined;
    quarantine(path, err instanceof Error ? err.message : String(err));
    return undefined;
  }
  try {
    const decoded = decodeRecord(text);
    return { ...decoded, pending: { path, fact: decoded.record.fact } };
  } catch (err) {
    quarantine(path, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

interface ParsedJournalRecord {
  readonly version?: unknown;
  readonly workspace?: unknown;
  readonly intended?: unknown;
  readonly fact?: unknown;
}

interface ParsedIntendedState {
  readonly kind?: unknown;
  readonly dir?: unknown;
  readonly path?: unknown;
  readonly sha256?: unknown;
  readonly previous?: unknown;
  readonly operationId?: unknown;
  readonly transition?: unknown;
  readonly source?: unknown;
  readonly sourceSha256?: unknown;
  readonly destination?: unknown;
  readonly destinationPrevious?: unknown;
  readonly destinationSha256?: unknown;
}

function decodeRecord(text: string): Pick<JournalEntry, "record" | "identity"> {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error("entry is not an object");
  const parsed: ParsedJournalRecord = raw;
  if (parsed.version !== 1) throw new Error(`entry version ${String(parsed.version)} is not 1`);
  if (typeof parsed.workspace !== "string" || parsed.workspace.length === 0) throw new Error("entry names no workspace");
  const intended = decodeIntended(parsed.intended);
  const fact = parseSessionFact<AuditFact>(parsed.fact);
  if (!AUDIT_TYPES.includes(fact.type)) throw new Error(`${fact.type} is not a learning audit fact`);
  const identity = auditIdentity(fact);
  if (identity === undefined) throw new Error(`${fact.type} carries no mutation identity`);
  return { record: { version: 1, workspace: parsed.workspace, intended, fact }, identity };
}

function decodeIntended(value: unknown): IntendedState {
  if (typeof value !== "object" || value === null) throw new Error("entry asserts no artifact state");
  const parsed: ParsedIntendedState = value;
  const text = (field: unknown, key: string): string => {
    if (typeof field !== "string" || field.length === 0) throw new Error(`intended ${String(parsed.kind)} state has no ${key}`);
    return field;
  };
  const previous = (): string | null => {
    if (parsed.previous === null || (typeof parsed.previous === "string" && parsed.previous.length > 0)) return parsed.previous;
    throw new Error(`intended ${String(parsed.kind)} state has no pre-state`);
  };
  if (parsed.kind === "package") return { kind: parsed.kind, dir: text(parsed.dir, "dir"), sha256: text(parsed.sha256, "sha256"), previous: previous() };
  if (parsed.kind === "file") return { kind: parsed.kind, path: text(parsed.path, "path"), sha256: text(parsed.sha256, "sha256"), previous: previous() };
  if (parsed.kind === "archive") {
    const destinationPrevious = parsed.destinationPrevious === null || (typeof parsed.destinationPrevious === "string" && parsed.destinationPrevious.length > 0)
      ? parsed.destinationPrevious
      : (() => { throw new Error("intended archive state has no destination pre-state"); })();
    return {
      kind: parsed.kind,
      source: text(parsed.source, "source"),
      sourceSha256: text(parsed.sourceSha256, "sourceSha256"),
      destination: text(parsed.destination, "destination"),
      destinationPrevious,
      destinationSha256: text(parsed.destinationSha256, "destinationSha256"),
    };
  }
  if (parsed.kind === "operation") {
    if (typeof parsed.transition !== "number" || !Number.isInteger(parsed.transition) || parsed.transition < 1) {
      throw new Error(`intended operation state names transition ${String(parsed.transition)}`);
    }
    return { kind: parsed.kind, operationId: text(parsed.operationId, "operationId"), transition: parsed.transition };
  }
  throw new Error(`intended state ${String(parsed.kind)} is not a known artifact state`);
}

/** Move one unusable entry aside. Evidence an earlier pass already preserved is
 *  never overwritten: a name already taken gets a unique one beside it. */
function quarantine(path: string, reason: string): void {
  const preferred = `${path}.unusable`;
  const target = existsSync(preferred) ? `${preferred}.${randomUUID()}` : preferred;
  try {
    renameSync(path, target);
  } catch (err) {
    if (!isAbsent(err)) throw err;
  }
  log.warn("pending learning audit fact quarantined", { path: target, reason });
}

function isAbsent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}
