/** Bounded, file-backed curated memory.
 *  Two stores, one per learning reach (ARCH-LEARNING-008):
 *  project memory (`MEMORY.json`, project-specific working context) and global memory
 *  (`USER.json`, who the user is across projects). The file names are storage
 *  detail; `LearningScope` is the public vocabulary. Each store is one JSON
 *  document, `{ version, entries }`, where every entry carries its text and a
 *  `protected` flag the user sets by editing the file. Entry text is arbitrary:
 *  the document carries the structure, so no line of an entry is reserved, and
 *  a hand edit either decodes or is refused as unreadable. Only entry text
 *  counts toward the store's limit; the document's own syntax is free.
 *
 *  Both stores inject into the system prompt as a snapshot (ARCH-LEARNING-009):
 *  a chat captures it when a person message starts a turn, and every agent of
 *  one workflow carries the snapshot its workflow captured. A write is durable
 *  on disk at once and reaches the prompt at the next capture, so the requests
 *  of one turn share one prompt prefix. A store an earlier release wrote as a
 *  `.md` file beside the JSON name is read until its next successful mutation
 *  publishes the JSON document and removes it.
 *
 *  Disk is the single source of truth: every mutation re-reads it under the
 *  store's lock, so concurrent writers compose instead of clobbering. One
 *  mutation window holds the store's directory open and does everything through
 *  that one descriptor: the cross-process ownership lock, the read, the
 *  caller's audit callback, and the publication. The two lock layers are keyed
 *  on the same logical store path: the per-target mutation queue orders the
 *  runners of this process, and the ownership lock file beside the store
 *  excludes writers in other processes for the whole read-write window. */

import { Schema } from "effect";
import { basename, dirname, join, resolve } from "node:path";
import { FLYWHEEL_DIR_NAME } from "../../../infra/directory-authorities.js";
import { contentEvidence } from "../../../infra/content-evidence.js";
import { errorMessage } from "../../../infra/error-message.js";
import type { LearningScope } from "../../../infra/learning-scope.js";
import { buildMutationDiff, type MutationDiff, type MutationDiffTarget } from "../../../infra/mutation-diff.js";
import { acquireLockIn, releaseLockIn } from "../../../infra/ownership-file-lock.js";
import { redactSecrets } from "../../../infra/redact-secrets.js";
import { firstThreatMessage, scanForThreats } from "../../../infra/threat-patterns.js";
import { withMutationQueueKey } from "../../../infra/file-mutation-queue.js";
import {
  type ContainedDirectory,
  ContainedPathError,
  withContainedDirectory,
} from "../../../infra/descriptor-directory.js";
import {
  directoryComponents,
  readFileUnder,
  type ContainedFileLocation,
} from "../../../infra/write-file-under.js";

const MEMORY_STORE_VERSION = 1;

const MemoryEntrySchema = Schema.Struct({
  content: Schema.String,
  protected: Schema.Boolean,
});

const MemoryDocumentSchema = Schema.Struct({
  version: Schema.Literal(MEMORY_STORE_VERSION),
  entries: Schema.Array(MemoryEntrySchema),
});

const decodeMemoryDocument = Schema.decodeUnknownSync(MemoryDocumentSchema, { onExcessProperty: "error" });

export type MemoryEntry = typeof MemoryEntrySchema.Type;

interface MemoryValues<T> {
  readonly project: T;
  readonly global: T;
}

/** The limits keep the whole store loadable as one small frozen prompt block.
 *  They bound entry text only, never the document syntax around it. */
export const MEMORY_CHAR_LIMITS: MemoryValues<number> = { project: 2_500, global: 1_500 };
export const MAX_MEMORY_BATCH_OPERATIONS = 64;

const MAX_MEMORY_FILE_BYTES = 128 * 1024;

/** Stable block headers for the system-prompt snapshot. */
const MEMORY_BLOCK_HEADERS: MemoryValues<string> = {
  project: "PROJECT MEMORY (user preferences and working context for this project)",
  global: "GLOBAL MEMORY (who the user is, across projects)",
};

export interface MemoryStoreConfig {
  readonly locations: MemoryValues<ContainedFileLocation>;
  /** Test override; production always uses `MEMORY_CHAR_LIMITS`. */
  readonly limits?: MemoryValues<number>;
}

/** One contained relative path, always in POSIX components. */
function containedPath(...components: readonly string[]): string {
  return components.join("/");
}

/** Project memory lives with the project; global memory lives under the
 *  account home that follows the user.
 *
 *  Each trusted base is a directory that already exists, and the Flywheel
 *  directory below it is created on demand by the first write, so a fresh
 *  account or a fresh clone reads and writes memory without pre-installation.
 *  That is why the global store is contained by the startup-selected account
 *  home rather than by `userDataRoot`, which a fresh account has not created
 *  yet; the file still lands at the same `<userDataRoot>/memory/USER.json`. */
export function createMemoryStoreConfig(projectRoot: string, accountHome: string): MemoryStoreConfig {
  return {
    locations: {
      // A contained location names its path in POSIX components, which is what
      // the containment boundary splits on. A native join would hand Windows a
      // single backslash-joined name, and containment refuses that.
      project: { baseDir: projectRoot, relativePath: containedPath(FLYWHEEL_DIR_NAME, "memory", "MEMORY.json") },
      global: { baseDir: accountHome, relativePath: containedPath(FLYWHEEL_DIR_NAME, "memory", "USER.json") },
    },
  };
}

export function memoryStorePath(config: MemoryStoreConfig, reach: LearningScope): string {
  const location = config.locations[reach];
  return join(location.baseDir, location.relativePath);
}

/** The `.md` name an earlier release gave the same store. */
function legacyFileName(storeName: string): string {
  return `${basename(storeName, ".json")}.md`;
}

export type MemoryOperation =
  | { action: "add"; content: string }
  | { action: "replace"; oldText: string; content: string }
  | { action: "remove"; oldText: string };

export type MemoryMutationResult =
  /** The store changed on disk. */
  | { kind: "written"; message: string; usage: string; entryCount: number; contentHash: string; diff: MutationDiff }
  /** Nothing changed and nothing needed to: a duplicate add is a success. */
  | { kind: "noop"; message: string; usage: string; entryCount: number }
  /** The mutation was refused. `consolidation` marks the refusals that count
   *  toward the caller's per-turn consolidation-failure cap (at-capacity and
   *  zero-match), which are the ones the model is told to self-correct. */
  | {
    kind: "refused";
    error: string;
    consolidation?: true;
    currentEntries?: readonly string[];
    usage?: string;
    matches?: readonly string[];
  };

function limitFor(config: MemoryStoreConfig, reach: LearningScope): number {
  return config.limits?.[reach] ?? MEMORY_CHAR_LIMITS[reach];
}

/** Decode one JSON store document into its normalized entries. */
function parseJsonDocument(raw: string): readonly MemoryEntry[] {
  const parsed: unknown = JSON.parse(raw);
  return decodeMemoryDocument(parsed).entries.map((entry) => ({ content: entry.content.trim(), protected: entry.protected }));
}

const LEGACY_HEADER_PATTERN = /^§( protected)?$/gm;
const LEGACY_HEADER_PREFIX = /^§(?: protected)?(?:\n|$)/;
const LEGACY_ENTRY_DELIMITER = "\n§\n";

/** Decode a store an earlier release wrote as a `.md` file. Three shapes exist
 *  on disk: the JSON document under the old name, the `§` header grammar
 *  where a standalone `§` or `§ protected` line starts each entry, and the
 *  oldest delimiter grammar where `§` lines only separate entries. The header
 *  grammar reads every header as metadata for the entry below it. */
function parseLegacyDocument(raw: string): readonly MemoryEntry[] {
  const normalized = raw.replaceAll("\r\n", "\n");
  if (normalized.trimStart().startsWith("{")) return parseJsonDocument(normalized);
  if (!LEGACY_HEADER_PREFIX.test(normalized)) {
    return normalized.split(LEGACY_ENTRY_DELIMITER).map((content) => ({ content: content.trim(), protected: false }));
  }
  const headers = [...normalized.matchAll(LEGACY_HEADER_PATTERN)];
  return headers.map((header, index) => {
    const bodyStart = header.index + header[0].length + 1;
    const bodyEnd = headers[index + 1]?.index ?? normalized.length;
    return { content: normalized.slice(bodyStart, bodyEnd).trim(), protected: header[1] !== undefined };
  });
}

/** Drop empty entries and repeated text. Protection wins when the same text
 *  appears both protected and editable. */
function normalizeEntries(entries: readonly MemoryEntry[]): readonly MemoryEntry[] {
  const unique = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    if (!entry.content) continue;
    const existing = unique.get(entry.content);
    if (!existing || (!existing.protected && entry.protected)) unique.set(entry.content, entry);
  }
  return [...unique.values()];
}

function serializeEntries(entries: readonly MemoryEntry[]): string {
  return `${JSON.stringify({ version: MEMORY_STORE_VERSION, entries }, null, 2)}\n`;
}

function inventory(entries: readonly MemoryEntry[]): string[] {
  return entries.map((entry) => `${entry.protected ? "[protected] " : ""}${entry.content}`);
}

/** What one read of a store found. `source` says which file the bytes came
 *  from: the JSON store, the legacy `.md` beside it, or neither. `raw` is the
 *  exact text read, which identifies the pre-state of a write. */
type StoreRead =
  | { ok: true; source: "store" | "legacy" | "absent"; raw: string; entries: readonly MemoryEntry[] }
  | { ok: false; reason: string };

/** Decode one store through whatever reads a file of its directory by name.
 *  Absence is an empty store. Bytes that are not UTF-8, or text that is not
 *  the document, are a store this tool must not rewrite, and the reason names
 *  the file so the user can repair it. A path that escapes the trusted root is
 *  raised, never degraded to "unreadable". */
function readStore(readFile: (name: string) => Buffer | undefined, storeName: string): StoreRead {
  let name = storeName;
  try {
    let bytes = readFile(storeName);
    if (!bytes) {
      name = legacyFileName(storeName);
      bytes = readFile(name);
    }
    if (!bytes) return { ok: true, source: "absent", raw: "", entries: [] };
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const entries = name === storeName ? parseJsonDocument(raw) : parseLegacyDocument(raw);
    return { ok: true, source: name === storeName ? "store" : "legacy", raw, entries: normalizeEntries(entries) };
  } catch (error) {
    if (error instanceof ContainedPathError) throw error;
    return { ok: false, reason: `${name} could not be decoded: ${errorMessage(error)}` };
  }
}

/** Read one store by path, for the read-only callers that hold no window. */
function readStoreByPath(location: ContainedFileLocation): StoreRead {
  const components = directoryComponents(dirname(location.relativePath));
  return readStore(
    (name) => readFileUnder(location.baseDir, containedPath(...components, name), { maxBytes: MAX_MEMORY_FILE_BYTES, privateDirectories: true }),
    basename(location.relativePath),
  );
}

/** Read the store through the directory this window holds. */
function readHeldStore(directory: ContainedDirectory, location: ContainedFileLocation): StoreRead {
  return readStore((name) => directory.readFile(name, MAX_MEMORY_FILE_BYTES), basename(location.relativePath));
}

/** Entry text is the only thing the limit bounds. */
function charCount(entries: readonly MemoryEntry[]): number {
  return entries.reduce((total, entry) => total + entry.content.length, 0);
}

function usageText(entries: readonly MemoryEntry[], limit: number): string {
  const current = charCount(entries);
  const pct = limit > 0 ? Math.min(100, Math.trunc((current / limit) * 100)) : 0;
  return `${pct}% - ${current.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars`;
}

function previews(entries: readonly string[], width = 80): string[] {
  return entries.map((entry) => (entry.length > width ? `${entry.slice(0, width)}...` : entry));
}

function readFailedResult(reason: string): MemoryMutationResult {
  return {
    kind: "refused",
    error: `Refusing to write memory: ${reason}. Treating an unreadable store as empty and saving would wipe existing memory, so nothing was changed. If the file was temporarily locked, retry in a moment; otherwise tell the user the memory file needs repair.`,
  };
}

/** What one publication changed: the store path, the entries it holds now, and
 *  the exact bytes that landed, beside the read the locked window saw. The
 *  result's evidence and its diff are both captured from it, so neither
 *  rereads the file after the write. */
interface MemoryPublished {
  readonly location: ContainedFileLocation;
  readonly before: Extract<StoreRead, { ok: true }>;
  readonly entries: readonly MemoryEntry[];
  readonly content: string;
}

/** The result of one publication, including the secret-filtered local artifact
 *  that says what changed. Persistence policy belongs to the caller because the
 *  same result can be disclosed locally and recorded in a project history. A
 *  global store path is never shown to a model, so its diff names the file
 *  only. A legacy migration is two files in one diff: the old file removed and
 *  the JSON document added. */
function writtenResult(published: MemoryPublished, reach: LearningScope, limit: number, message: string): MemoryMutationResult {
  const { location, before } = published;
  const storePath = join(location.baseDir, location.relativePath);
  const diffPath = (path: string): string => reach === "global" ? basename(path) : path;
  const targets: MutationDiffTarget[] = [];
  if (before.source === "legacy") {
    targets.push({
      path: diffPath(join(dirname(storePath), legacyFileName(basename(storePath)))),
      before: { kind: "text", text: before.raw },
      after: { kind: "absent" },
    });
  }
  targets.push({
    path: diffPath(storePath),
    before: before.source === "store" ? { kind: "text", text: before.raw } : { kind: "absent" },
    after: { kind: "text", text: published.content },
  });
  return {
    kind: "written",
    message,
    usage: usageText(published.entries, limit),
    entryCount: published.entries.length,
    contentHash: contentEvidence(published.content).sha256,
    diff: buildMutationDiff(targets),
  };
}

/** What one publication changes the store from and to. The caller journals its
 *  audit evidence against both: the content identity proves the write landed,
 *  and only the pre-state can prove it never did. */
export interface MemoryPublication {
  /** sha256 of the whole store content this write publishes. */
  readonly contentHash: string;
  /** sha256 of the content it replaces, or null when the store had no file. */
  readonly previousSha256: string | null;
}

export type BeforeMemoryPublish = (publication: MemoryPublication) => void;

/** Publish the new store content and report exactly what landed.
 *  `beforePublish` runs with the identity of the bytes about to land and of the
 *  bytes they replace, so a caller can make its audit evidence durable before
 *  the artifact exists. A store read from the legacy file has no JSON
 *  pre-state, and the legacy file is removed once the document is published,
 *  so the migration is complete in the same window that read it. */
function persist(
  directory: ContainedDirectory,
  location: ContainedFileLocation,
  entries: readonly MemoryEntry[],
  read: Extract<StoreRead, { ok: true }>,
  beforePublish?: BeforeMemoryPublish,
): MemoryPublished {
  const content = serializeEntries(entries);
  const storeName = basename(location.relativePath);
  beforePublish?.({
    contentHash: contentEvidence(content).sha256,
    previousSha256: read.source === "store" ? contentEvidence(read.raw).sha256 : null,
  });
  directory.writeFile(storeName, content);
  if (read.source === "legacy") directory.removeFile(legacyFileName(storeName));
  return { location, before: read, entries, content };
}

/** Normalize model-authored entry content for storage: trimmed, with recognized
 *  credential value formats redacted at the same boundary breadcrumbs use. */
function normalizeContent(content: string): string {
  return redactSecrets(content).trim();
}

/** Run one read-modify-write while holding the process queue, the store's
 *  directory, and the cross-process ownership lock inside it. The in-process key
 *  is the logical store path, which names the same target however the path
 *  resolves, and everything `fn` does goes through the directory it is handed. */
async function withMemoryStoreLock<T>(
  location: ContainedFileLocation,
  fn: (directory: ContainedDirectory) => Promise<T>,
): Promise<T> {
  return withMutationQueueKey(resolve(join(location.baseDir, location.relativePath)), () =>
    withContainedDirectory(location.baseDir, directoryComponents(dirname(location.relativePath)), { privateDirectories: true }, async (directory) => {
      const hold = await acquireLockIn(directory, `${basename(location.relativePath)}.lock`);
      try {
        return await fn(directory);
      } finally {
        releaseLockIn(directory, hold);
      }
    }));
}

/** Apply one mutation with single-op semantics: duplicate add is a
 *  success, an at-capacity add or zero-match edit is a consolidation refusal
 *  carrying the current inventory, an ambiguous substring across distinct
 *  entries refuses with previews, and identical duplicates match the first. */
export async function applyMemoryOperation(
  config: MemoryStoreConfig,
  reach: LearningScope,
  operation: MemoryOperation,
  beforePublish?: BeforeMemoryPublish,
): Promise<MemoryMutationResult> {
  const location = config.locations[reach];
  const limit = limitFor(config, reach);

  if (operation.action !== "remove") {
    const content = normalizeContent(operation.content);
    if (!content) return { kind: "refused", error: emptyContentError(operation.action) };
    const blocked = firstThreatMessage(content, "strict");
    if (blocked) return { kind: "refused", error: blocked };
  }
  if (operation.action !== "add" && !operation.oldText.trim()) {
    return { kind: "refused", error: "old_text cannot be empty." };
  }

  return withMemoryStoreLock(location, async (directory) => {
    const read = readHeldStore(directory, location);
    if (!read.ok) return readFailedResult(read.reason);
    const entries = read.entries;

    switch (operation.action) {
      case "add": {
        const content = normalizeContent(operation.content);
        if (entries.some((entry) => entry.content === content)) {
          if (read.source === "legacy") {
            return writtenResult(persist(directory, location, entries, read, beforePublish), reach, limit, "Entry already exists; memory format migrated.");
          }
          return { kind: "noop", message: "Entry already exists (no duplicate added).", usage: usageText(entries, limit), entryCount: entries.length };
        }
        const next = [...entries, { content, protected: false }];
        if (charCount(next) > limit) {
          return {
            kind: "refused",
            consolidation: true,
            error: `Memory at ${charCount(entries).toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars. Adding this entry (${content.length} chars) would exceed the limit by ${(charCount(next) - limit).toLocaleString("en-US")} chars. Free at least that much: reissue as ONE batch that removes stale entries first, then removes whole lower-priority entries (see current_entries below), and adds the new entry together. Every kept entry must stay a plain sentence a human can read without context; drop a whole entry rather than compress entries into fragments.`,
            currentEntries: inventory(entries),
            usage: usageText(entries, limit),
          };
        }
        return writtenResult(persist(directory, location, next, read, beforePublish), reach, limit, "Entry added.");
      }
      case "replace": {
        const content = normalizeContent(operation.content);
        const oldText = operation.oldText.trim();
        const matched = matchEntry(entries, oldText);
        if (matched.kind === "none") {
          return zeroMatchResult(entries, limit, oldText, "replace");
        }
        if (matched.kind === "ambiguous") {
          return { kind: "refused", error: `Multiple entries matched '${oldText}'. Be more specific.`, matches: previews(matched.entries) };
        }
        const next = [...entries];
        const current = next[matched.index];
        if (!current) throw new Error("matched memory entry disappeared");
        if (current.protected) return protectedResult(entries, limit, "replace");
        if (next.some((entry, index) => index !== matched.index && entry.content === content)) {
          return duplicateReplacementResult(entries, limit);
        }
        next[matched.index] = { content, protected: false };
        if (charCount(next) > limit) {
          return {
            kind: "refused",
            consolidation: true,
            error: `Replacement would put memory at ${charCount(next).toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars - over the limit by ${(charCount(next) - limit).toLocaleString("en-US")} chars. Remove stale or lower-priority entries in the same batch to make room (see current_entries below), then retry. Keep every entry a plain sentence a human can read without context; drop a whole entry rather than compress entries into fragments.`,
            currentEntries: inventory(entries),
            usage: usageText(entries, limit),
          };
        }
        return writtenResult(persist(directory, location, next, read, beforePublish), reach, limit, "Entry replaced.");
      }
      case "remove": {
        const oldText = operation.oldText.trim();
        const matched = matchEntry(entries, oldText);
        if (matched.kind === "none") {
          return zeroMatchResult(entries, limit, oldText, "remove");
        }
        if (matched.kind === "ambiguous") {
          return { kind: "refused", error: `Multiple entries matched '${oldText}'. Be more specific.`, matches: previews(matched.entries) };
        }
        if (entries[matched.index]?.protected) return protectedResult(entries, limit, "remove");
        const next = entries.filter((_, index) => index !== matched.index);
        return writtenResult(persist(directory, location, next, read, beforePublish), reach, limit, "Entry removed.");
      }
    }
  });
}

/** Apply a sequence of operations to one target atomically, validated against
 *  the FINAL budget only, so one call can free space and add together instead
 *  of the multi-call consolidate-then-retry dance that re-sends the whole
 *  conversation each time. All-or-nothing: the first malformed, unmatched, or
 *  ambiguous operation aborts the batch with the live state; a duplicate add
 *  is skipped, never a failure. */
export async function applyMemoryBatch(
  config: MemoryStoreConfig,
  reach: LearningScope,
  operations: readonly MemoryOperation[],
  beforePublish?: BeforeMemoryPublish,
): Promise<MemoryMutationResult> {
  if (operations.length > MAX_MEMORY_BATCH_OPERATIONS) {
    return {
      kind: "refused",
      error: `operations list has ${operations.length} items; maximum is ${MAX_MEMORY_BATCH_OPERATIONS}.`,
    };
  }
  const location = config.locations[reach];
  const limit = limitFor(config, reach);
  if (operations.length === 0) return { kind: "refused", error: "operations list is empty." };

  // Scan every incoming content before any disk touch: one poisoned
  // operation rejects the whole batch.
  for (const [index, operation] of operations.entries()) {
    if (operation.action === "remove") continue;
    const blocked = firstThreatMessage(normalizeContent(operation.content), "strict");
    if (blocked) return { kind: "refused", error: `Operation ${index + 1}: ${blocked}` };
  }

  return withMemoryStoreLock(location, async (directory) => {
    const read = readHeldStore(directory, location);
    if (!read.ok) return readFailedResult(read.reason);

    const entries = read.entries;
    const working = [...entries];
    const abort = (message: string): MemoryMutationResult => ({
      kind: "refused",
      consolidation: true,
      error: `${message} No operations were applied (batch is all-or-nothing).`,
      currentEntries: inventory(entries),
      usage: usageText(entries, limit),
    });

    for (const [index, operation] of operations.entries()) {
      const position = `Operation ${index + 1} (${operation.action})`;
      if (operation.action === "add") {
        const content = normalizeContent(operation.content);
        if (!content) return abort(`${position}: content is required.`);
        if (working.some((entry) => entry.content === content)) continue;
        working.push({ content, protected: false });
        continue;
      }
      const oldText = operation.oldText.trim();
      if (!oldText) return abort(`${position}: old_text is required.`);
      const matched = matchEntry(working, oldText);
      if (matched.kind === "none") return abort(`${position}: no entry matched '${oldText}'.`);
      if (matched.kind === "ambiguous") return abort(`${position}: '${oldText}' matched multiple distinct entries - be more specific.`);
      if (working[matched.index]?.protected) return abort(`${position}: the matched entry is protected and the agent cannot ${operation.action} it.`);
      if (operation.action === "replace") {
        const content = normalizeContent(operation.content);
        if (!content) return abort(`${position}: content is required (use action 'remove' to delete).`);
        if (working.some((entry, entryIndex) => entryIndex !== matched.index && entry.content === content)) {
          return abort(`${position}: another entry already has that content; remove the matched entry to consolidate them.`);
        }
        working[matched.index] = { content, protected: false };
      } else {
        working.splice(matched.index, 1);
      }
    }

    if (charCount(working) > limit) {
      return {
        kind: "refused",
        consolidation: true,
        error: `After applying all ${operations.length} operations, memory would be at ${charCount(working).toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars - over the limit by ${(charCount(working) - limit).toLocaleString("en-US")} chars. Remove more stale or lower-priority entries in the same batch (see current_entries below), then retry. Keep every entry a plain sentence a human can read without context; drop a whole entry rather than compress entries into fragments.`,
        currentEntries: inventory(entries),
        usage: usageText(entries, limit),
      };
    }

    if (working.length === entries.length && working.every((entry, index) => entry.content === entries[index]?.content && entry.protected === entries[index]?.protected)) {
      if (read.source === "legacy") {
        return writtenResult(persist(directory, location, entries, read, beforePublish), reach, limit, "Batch made no logical changes; memory format migrated.");
      }
      return { kind: "noop", message: "Batch made no changes.", usage: usageText(entries, limit), entryCount: entries.length };
    }

    return writtenResult(persist(directory, location, working, read, beforePublish), reach, limit, `Applied ${operations.length} operation(s).`);
  });
}

type EntryMatch =
  | { kind: "none" }
  | { kind: "one"; index: number }
  | { kind: "ambiguous"; entries: string[] };

/** Substring match with the duplicate rule: several matches that are all
 *  the identical text safely resolve to the first; distinct texts refuse. */
function matchEntry(entries: readonly MemoryEntry[], oldText: string): EntryMatch {
  const indices = entries.flatMap((entry, index) => (entry.content.includes(oldText) ? [index] : []));
  const first = indices[0];
  if (first === undefined) return { kind: "none" };
  const distinct = new Set(indices.map((index) => entries[index]?.content));
  if (distinct.size > 1) return { kind: "ambiguous", entries: indices.map((index) => entries[index]?.content ?? "") };
  return { kind: "one", index: first };
}

function zeroMatchResult(entries: readonly MemoryEntry[], limit: number, oldText: string, action: string): MemoryMutationResult {
  const nearest = nearestEntries(entries, oldText);
  const hint = nearest.length > 0
    ? " The closest existing entries are listed in 'matches'; use exact text from one of them."
    : "";
  return {
    kind: "refused",
    consolidation: true,
    error: `No entry matched '${oldText}'. Check current_entries below and retry with the exact text of the entry you want to ${action}.${hint}`,
    currentEntries: inventory(entries),
    usage: usageText(entries, limit),
    ...(nearest.length > 0 ? { matches: nearest } : {}),
  };
}

/** Nearest existing entries to a failed old_text, by shared-token count.
 *  Recovery hint only: a paraphrased or stale old_text usually shares most of
 *  its words with the entry it meant, so token overlap finds it cheaply.
 *  Full entries, not previews: the caller is told to reuse the exact text,
 *  so a truncated candidate would send it into a second zero-match. */
function nearestEntries(entries: readonly MemoryEntry[], oldText: string): string[] {
  const wanted = tokenSet(oldText);
  if (wanted.size === 0) return [];
  return entries
    .map((entry) => ({ entry: entry.content, score: overlapCount(wanted, tokenSet(entry.content)) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((candidate) => candidate.entry);
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2));
}

function overlapCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count++;
  return count;
}

function emptyContentError(action: "add" | "replace"): string {
  return action === "add" ? "Content cannot be empty." : "new content cannot be empty. Use 'remove' to delete entries.";
}

function protectedResult(entries: readonly MemoryEntry[], limit: number, action: string): MemoryMutationResult {
  return {
    kind: "refused",
    error: `The matched entry is protected and the agent cannot ${action} it. The user can unprotect it by setting its "protected" field to false in the memory file.`,
    currentEntries: inventory(entries),
    usage: usageText(entries, limit),
  };
}

function duplicateReplacementResult(entries: readonly MemoryEntry[], limit: number): MemoryMutationResult {
  return {
    kind: "refused",
    consolidation: true,
    error: "Another entry already has that content. Remove the matched entry instead to consolidate them.",
    currentEntries: inventory(entries),
    usage: usageText(entries, limit),
  };
}

/** One store as its readers see it: the entries, or the reason the file on
 *  disk is not a store. Read-only, so an unreadable file is reported, never
 *  repaired or emptied. */
export type MemoryStoreView =
  | { readonly ok: true; readonly entries: readonly MemoryEntry[] }
  | { readonly ok: false; readonly reason: string };

export function readMemoryStore(config: MemoryStoreConfig, reach: LearningScope): MemoryStoreView {
  const read = readStoreByPath(config.locations[reach]);
  return read.ok ? { ok: true, entries: read.entries } : { ok: false, reason: read.reason };
}

/** One consistent model-facing inventory and its canonical content usage. */
export interface MemoryInventory {
  readonly entries: readonly string[];
  readonly usage: string;
}

export function readMemoryInventory(config: MemoryStoreConfig, reach: LearningScope): MemoryInventory {
  const view = readMemoryStore(config, reach);
  const entries = view.ok ? view.entries : [];
  return {
    entries: inventory(entries),
    usage: usageText(entries, limitFor(config, reach)),
  };
}

/** Usage line for one store's entries. */
export function memoryUsageText(config: MemoryStoreConfig, reach: LearningScope, entries: readonly MemoryEntry[]): string {
  return usageText(entries, limitFor(config, reach));
}

/** Build the frozen system-prompt snapshot: read both stores, deduplicate,
 *  substitute a `[BLOCKED]` placeholder for any entry matching the strict
 *  threat scan (the raw entry stays on disk for the user to inspect and
 *  remove; silently dropping it would hide the attack), and render each store
 *  as a block labeled with its reach, content identity, and usage. Read-only:
 *  a store that does not decode renders as one line that says so, because a
 *  silently empty block would hide the loss of memory from the agent and the
 *  user alike. Scanning is deterministic over disk bytes, so the snapshot is
 *  stable for the whole session. */
export function loadMemorySnapshot(config: MemoryStoreConfig): MemoryValues<string> {
  return {
    project: renderSnapshotBlock(config, "project"),
    global: renderSnapshotBlock(config, "global"),
  };
}

/** Both stores as prompt-ready text, including capacity for empty stores. */
export function renderMemorySnapshot(config: MemoryStoreConfig): string {
  const snapshot = loadMemorySnapshot(config);
  return [snapshot.project, snapshot.global].join("\n\n");
}

const SNAPSHOT_SEPARATOR = "═".repeat(46);

function renderSnapshotBlock(config: MemoryStoreConfig, reach: LearningScope): string {
  const location = config.locations[reach];
  const read = readStoreByPath(location);
  if (!read.ok) {
    const header = `${MEMORY_BLOCK_HEADERS[reach]} [reach: ${reach} | unreadable]`;
    return `${SNAPSHOT_SEPARATOR}\n${header}\n${SNAPSHOT_SEPARATOR}\n[UNREADABLE: ${read.reason}. This memory is unavailable until the user repairs the file; tell them when it matters.]`;
  }
  const entries = read.entries.map((entry) =>
    `${entry.protected ? "[protected] " : ""}${sanitizeSnapshotEntry(entry.content, entry.protected, basename(location.relativePath))}`);
  const body = entries.length === 0 ? "No entries." : entries.join("\n\n");
  const limit = limitFor(config, reach);
  // Reach and content identity are stated in the block itself, so a prompt
  // audit can match a rendered snapshot to the `memory.written` fact that
  // produced the store state.
  const header = `${MEMORY_BLOCK_HEADERS[reach]} [reach: ${reach} | sha256:${contentEvidence(read.raw).sha256} | ${usageText(read.entries, limit)}]`;
  return `${SNAPSHOT_SEPARATOR}\n${header}\n${SNAPSHOT_SEPARATOR}\n${body}`;
}

function sanitizeSnapshotEntry(entry: string, protectedEntry: boolean, file: string): string {
  if (entry.startsWith("[BLOCKED:")) return entry;
  const findings = scanForThreats(entry, "strict");
  if (findings.length === 0) return entry;
  const remediation = protectedEntry
    ? "The entry is protected; only the user can unprotect it before removal."
    : "Use the memory tool's remove action to delete the original.";
  return `[BLOCKED: ${file} entry contained threat pattern(s): ${findings.join(", ")}. Removed from system prompt. ${remediation}]`;
}
