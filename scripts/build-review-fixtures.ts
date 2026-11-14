import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { Schema } from "effect";
import { exposurePatterns, exposures, publishedDiffLines, type PrivateIdentity } from "./review-fixture-publication.js";
import { harnessLintFile, loadHarnessLint, type HarnessLint } from "../src/orchestration/modules/development/benchmark/harness-names.js";

// Builds reviewer benchmark fixtures from real reviews recorded in a Flywheel
// store. For each code review since the repository's first commit it rebuilds
// the working tree the reviewer saw from the recorded file mutations and git,
// verifies every step against the recorded SHA-256 hashes, and writes one
// fixture per reviewed change: `source.json`, `diff.patch`, `prompt.md`,
// `manifest.json` with drafted labels, and `PROVENANCE.json`. It never changes
// the store or the repository, and two runs over the same inputs write the
// same bytes.
//
// Usage: bun run scripts/build-review-fixtures.ts --out <empty directory> [--store <flywheel.sqlite>] [--archive <pre-public checkout>]
//
// Restore mode (`--archive`) also rebuilds the reviews recorded before the
// public history, from the pre-public checkout, which it reads through
// `git show` only. Such a fixture pins the first public commit and carries
// `base.patch`, which turns that commit's version of the changed files into
// the review's base. In every fixture, lines that name another coding agent
// are rewritten before the diffs are made, with the terms of the maintainer's
// private harness-name lint. Restore mode needs that lint; without it a
// recorded fixture keeps its lines as recorded.
//
// Before it writes a fixture, the builder proves that its patches rebuild the
// reviewed state on the pinned commit, and refuses one that would publish a
// private detail of this machine or a harness name.
//
// Every drafted label has `accepted: false`, which the benchmark loader
// refuses until curation accepts or removes it.

const REPO = resolve(import.meta.dir, "..");
/** A commit counts as the anchor of a mutation that a tool recorded up to this
 *  long after the commit time, which has one-second resolution. */
const COMMIT_SLACK_MS = 3_000;
/** How near a fix hunk must be to a cited line to count as fixing it. */
const OVERLAP_LINES = 3;
/** How a review that found nothing says so. A result with no parsed finding
 *  and without this phrase is unreadable, not clean. */
const NOTHING_FOUND = /\bno (?:actionable )?(?:findings|defects)\b|"summary":\s*"Clean\b/i;
const PATH_RE = /[\w@./\-[\]]+\.(?:tsx|ts|md|json|jsonc|toml|py|sh|css|astro|yaml|yml|rs|js|mjs|snap|html|txt|sql|ps1)\b/g;

// ---------------------------------------------------------------- pure helpers

function sha256(text: string | undefined): string | undefined {
  return text === undefined ? undefined : createHash("sha256").update(text).digest("hex");
}

/** Reverse one unified diff on `content`: the content before the change, or
 *  undefined when a hunk does not match exactly where it says it is. An absent
 *  file is the empty string. */
export function reverseApplyPatch(content: string, patch: string): string | undefined {
  const lines = content.split("\n");
  const patchLines = patch.split("\n");
  let delta = 0;
  for (let index = 0; index < patchLines.length; index++) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(patchLines[index] ?? "");
    if (!header) continue;
    const oldSide: string[] = [];
    const newSide: string[] = [];
    let oldNoNewline = false;
    let newNoNewline = false;
    let last = "";
    for (index++; index < patchLines.length && !patchLines[index]!.startsWith("@@") && !patchLines[index]!.startsWith("Index: ") && !patchLines[index]!.startsWith("diff --git "); index++) {
      const line = patchLines[index]!;
      if (line.startsWith("\\")) {
        if (last === "-" || last === " ") oldNoNewline = true;
        if (last === "+" || last === " ") newNoNewline = true;
        continue;
      }
      last = line[0] ?? "";
      if (last === " " || last === "-") oldSide.push(line.slice(1));
      if (last === " " || last === "+") newSide.push(line.slice(1));
    }
    index--;
    const newCount = Number(header[4] ?? "1");
    const at = (newCount === 0 ? Number(header[3]) : Number(header[3]) - 1) + delta;
    if (newSide.some((line, offset) => lines[at + offset] !== line)) return undefined;
    lines.splice(at, newSide.length, ...oldSide);
    delta += oldSide.length - newSide.length;
    const after = at + oldSide.length;
    if (newNoNewline && !oldNoNewline) lines.splice(after, 0, "");
    if (oldNoNewline && !newNoNewline) {
      if (lines[after] !== "" || after !== lines.length - 1) return undefined;
      lines.pop();
    }
  }
  return lines.join("\n");
}

export interface Finding {
  title: string;
  severity: string;
  location: string;
  failure: string;
}

/** A handoff value as `Key: value` lines: a string as written, an object one line per field. */
function findingText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(findingText).join("\n\n");
  if (typeof value === "object" && value !== null) return Object.entries(value).map(([key, inner]) => `${key}: ${typeof inner === "string" ? inner : JSON.stringify(inner)}`).join("\n");
  return "";
}

/** The findings of one recorded review result, read as blocks of `Title:`,
 *  `Severity:`, `Location:`, and `Failure:` lines: the `findings` of its
 *  handoff JSON (text, or a list of texts or objects), else its summary, else
 *  the result text itself. */
export function parseFindings(result: string): Finding[] {
  let text = result;
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed === "object" && parsed !== null) text = findingText("findings" in parsed ? parsed.findings : "summary" in parsed ? parsed.summary : "");
  } catch {
    // A review that returned plain text is read as written.
  }
  const findings: Finding[] = [];
  for (const block of text.split(/\n\s*\n|(?=^(?:\d+\.\s*)?Title:)/m)) {
    const value = (name: string): string => new RegExp(`^(?:\\d+\\.\\s*)?${name}:\\s*(.*)$`, "mi").exec(block)?.[1]?.trim() ?? "";
    const severity = /^P[1-3]\b/.exec(value("Severity"))?.[0];
    if (severity) findings.push({ title: value("Title"), severity, location: value("Location"), failure: value("Failure") });
  }
  return findings;
}

export interface CitedLines {
  path: string;
  start: number;
  end: number;
}

/** The file and line ranges of a finding's location, such as
 *  `README.md:94; src/a.ts:30-32,75-91`. A path without lines cites the whole file. */
export function parseLocations(location: string): CitedLines[] {
  const cited: CitedLines[] = [];
  for (const part of location.split(/;\s*/)) {
    const match = /([\w@./\-[\]]+\.[A-Za-z]+)(?::([\d,\- ]+))?/.exec(part);
    if (!match) continue;
    const path = match[1]!.replace(/^\.\//, "");
    const ranges = (match[2] ?? "").split(",").map((range) => range.trim()).filter(Boolean);
    if (ranges.length === 0) cited.push({ path, start: 1, end: Number.MAX_SAFE_INTEGER });
    for (const range of ranges) {
      const [start, end] = range.split("-").map(Number);
      if (start !== undefined && Number.isFinite(start)) cited.push({ path, start, end: end !== undefined && Number.isFinite(end) ? end : start });
    }
  }
  return cited;
}

/** One changed block of a recorded mutation patch: the old-side lines it
 *  removes or inserts at, the lines it adds, and its hunk text. */
export interface PatchChange {
  start: number;
  end: number;
  added: string;
  hunk: string;
}

interface Hunk { oldStart: number; newStart: number; body: string[]; text: string }

/** The hunks of a unified diff. A side with no lines names the line before
 *  the hunk, so its first line is one further on. */
function hunks(patch: string): Hunk[] {
  return patch.split(/^(?=@@ )/m).slice(1).flatMap((part) => {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(part);
    if (!header) return [];
    const body = part.split("\n").slice(1).filter((line) => /^[ +-]/.test(line));
    return [{
      oldStart: Number(header[1]) + (header[2] === "0" ? 1 : 0),
      newStart: Number(header[3]) + (header[4] === "0" ? 1 : 0),
      body,
      text: part.trimEnd(),
    }];
  });
}

/** The changes of one patch, in the coordinates of the content before it. */
export function patchChanges(patch: string): PatchChange[] {
  return hunks(patch).flatMap((hunk) => {
    let line = hunk.oldStart;
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    const added: string[] = [];
    // A removed line spans itself; an added line falls between the old lines
    // around it, so a pure insertion ends one line before it starts.
    for (const row of hunk.body) {
      if (row[0] === " ") { line++; continue; }
      start = Math.min(start, line);
      if (row[0] === "+") {
        end = Math.max(end, line - 1);
        added.push(row.slice(1));
      } else {
        end = Math.max(end, line);
        line++;
      }
    }
    return start === Number.POSITIVE_INFINITY ? [] : [{ start, end, added: added.join("\n"), hunk: hunk.text }];
  });
}

/** The lines of the content after `patch` that it adds. */
export function addedLines(patch: string): Set<number> {
  const added = new Set<number>();
  for (const hunk of hunks(patch)) {
    let line = hunk.newStart;
    for (const row of hunk.body) {
      if (row[0] === "+") added.add(line);
      if (row[0] !== "-") line++;
    }
  }
  return added;
}

/** The line of the content before `patch` that holds line `line` of the content
 *  after it; an added line maps to the old line it was inserted at. */
function lineBefore(line: number, patch: string): number {
  let delta = 0;
  for (const hunk of hunks(patch)) {
    if (line < hunk.newStart) break;
    let before = hunk.oldStart;
    let after = hunk.newStart;
    for (const row of hunk.body) {
      if (row[0] !== "-" && after === line) return before;
      if (row[0] !== "-") after++;
      if (row[0] !== "+") before++;
    }
    delta = before - after;
  }
  return line + delta;
}

/** The changes that the reviewing lineage made to one file after the review,
 *  in the coordinates of the reviewed content. `sequence` is every recorded
 *  mutation of the file after the review in order, by any session; each
 *  lineage change maps back through the mutations before it. */
export function lineageChanges(sequence: readonly { patch: string; lineage: boolean; mutationId: string }[]): (PatchChange & { mutationId: string })[] {
  return sequence.flatMap((mutation, index) => mutation.lineage
    ? patchChanges(mutation.patch).map((change) => {
      const earlier = sequence.slice(0, index).toReversed();
      const map = (line: number) => earlier.reduce((current, previous) => lineBefore(current, previous.patch), line);
      return { ...change, start: map(change.start), end: map(change.end), mutationId: mutation.mutationId };
    })
    : []);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "finding";
}

/** A canonical JSON rendering: sorted keys, so equal content is equal bytes. */
function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, item) => typeof item === "object" && item !== null && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item, 2)}\n`;
}

// ---------------------------------------------------------------- git

function git(args: readonly string[], cwd = REPO) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

const blobs = new Map<string, string | undefined>();
/** The content of `path` at `commit` of the repository at `repo`. */
function blob(repo: string, commit: string, path: string): string | undefined {
  const key = `${commit}:${path}`;
  if (!blobs.has(key)) {
    const shown = git(["show", key], repo);
    blobs.set(key, shown.code === 0 ? shown.stdout : undefined);
  }
  return blobs.get(key);
}

interface Commit { ms: number; sha: string }

/** The history that a review's files are rebuilt from. A `recorded` review ran
 *  in this repository's public history; a `restore` review ran before it, in
 *  the pre-public checkout, and is rebuilt on the first public commit. */
interface Era {
  repo: string;
  variant: "recorded" | "restore";
  commits: Commit[];
  byPath: Map<string, Commit[]>;
}

/** First-parent history of HEAD in `repo`, oldest first, and per path the
 *  commits that touch it. It reads through `git show` only, which never
 *  writes, so the pre-public checkout stays as it is. */
function history(repo: string, variant: Era["variant"]): Era {
  const commits: Commit[] = [];
  const byPath = new Map<string, Commit[]>();
  let current: Commit | undefined;
  for (const line of git(["show", "--do-walk", "--first-parent", "--no-renames", "--name-only", "--format=C %H %ct", "HEAD"], repo).stdout.split("\n")) {
    if (line.startsWith("C ")) {
      const [, sha, seconds] = line.split(" ");
      current = { sha: sha!, ms: Number(seconds) * 1000 };
      commits.push(current);
    } else if (line.trim() && current) {
      byPath.set(line.trim(), [...byPath.get(line.trim()) ?? [], current]);
    }
  }
  const order = (a: Commit, b: Commit) => a.ms - b.ms || a.sha.localeCompare(b.sha);
  commits.sort(order);
  for (const list of byPath.values()) list.sort(order);
  return { repo, variant, commits, byPath };
}

/** A git diff from `before` to `after` of one path, with `a/` and `b/` names. */
async function fileDiff(path: string, before: string | undefined, after: string | undefined): Promise<string> {
  if (before === after) return "";
  const work = await mkdtemp(join(tmpdir(), "review-fixture-diff-"));
  try {
    const side = async (name: "a" | "b", text: string | undefined): Promise<string> => {
      if (text === undefined) return "/dev/null";
      await mkdir(dirname(join(work, name, path)), { recursive: true });
      await writeFile(join(work, name, path), text);
      return `${name}/${path}`;
    };
    const args = ["-c", "core.quotePath=false", "diff", "--no-index", "--no-prefix", "--no-color", "--no-ext-diff", "-U3", await side("a", before), await side("b", after)];
    return git(args, work).stdout;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- store

interface Mutation { ms: number; session: string; before?: string; after?: string; mutationId: string }
interface ReviewRun { id: string; session: string; parent: string; cwd: string; persona: string; model: string; effort: string; title: string; start: number; end: number; prompt: string; result: string }

// The fact payload fields this builder reads. Other fields are ignored.
const optionalString = Schema.optionalKey(Schema.String);
const Hash = Schema.optionalKey(Schema.NullOr(Schema.Struct({ sha256: Schema.String })));
const decodeCreated = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  childRunId: Schema.String, childSessionId: optionalString, parentSessionId: optionalString, executionCwd: optionalString,
  persona: Schema.optionalKey(Schema.Struct({ name: Schema.String })), agentType: optionalString,
  model: optionalString, effort: optionalString, description: optionalString,
})));
const decodePrompted = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ childRunId: Schema.String, prompt: Schema.String })));
const decodeCompleted = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ childRunId: Schema.String, status: Schema.String, result: optionalString })));
// A file change recorded before mutation IDs existed (before 2026-08-15) has
// no retained patch, so it keeps its place in the hash chain and never reverses.
const decodeChanged = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ path: Schema.String, mutationId: optionalString, before: Hash, after: Hash })));
const decodeArtifact = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  mutationId: optionalString, artifactKind: Schema.String,
  evidence: Schema.optionalKey(Schema.Struct({ patch: Schema.optionalKey(Schema.Struct({ kind: Schema.String, reference: Schema.optionalKey(Schema.Struct({ root: Schema.String })) })) })),
})));
const decodeContent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ kind: Schema.String, text: optionalString })));

function loadStore(store: string, since: number) {
  // Read-only: the store is the live record of every session.
  const db = new Database(store, { readonly: true });
  const rows = (type: string) => db.query<{ session_id: string; timestamp: number; payload: string }, [string, number]>(
    "select session_id, timestamp, payload from event where type = ? and timestamp >= ? order by position",
  ).all(type, since);
  const runs = new Map<string, ReviewRun>();
  const parents = new Map<string, string>();
  for (const row of rows("child_run.created")) {
    const payload = decodeCreated(row.payload);
    const child = payload.childSessionId ?? "";
    const parent = payload.parentSessionId ?? "";
    if (child) parents.set(child, parent);
    const persona = payload.persona?.name ?? payload.agentType ?? "";
    if (!persona.startsWith("reviewer-code")) continue;
    runs.set(payload.childRunId, {
      id: payload.childRunId, session: child, parent, cwd: payload.executionCwd ?? "", persona,
      model: payload.model ?? "", effort: payload.effort ?? "", title: payload.description ?? "",
      start: row.timestamp, end: Number.POSITIVE_INFINITY, prompt: "", result: "",
    });
  }
  for (const row of rows("subagent.prompted")) {
    const payload = decodePrompted(row.payload);
    const run = runs.get(payload.childRunId);
    if (run) run.prompt = payload.prompt;
  }
  for (const row of rows("subagent.completed")) {
    const payload = decodeCompleted(row.payload);
    const run = runs.get(payload.childRunId);
    if (run && payload.status === "completed") Object.assign(run, { end: row.timestamp, result: payload.result ?? "" });
  }
  const mutations = new Map<string, Mutation[]>();
  for (const row of rows("file.changed")) {
    const payload = decodeChanged(row.payload);
    if (!payload.path.startsWith(`${REPO}/`)) continue;
    const relative = payload.path.slice(REPO.length + 1);
    const before = payload.before?.sha256;
    const after = payload.after?.sha256;
    mutations.set(relative, [...mutations.get(relative) ?? [], {
      ms: row.timestamp, session: row.session_id, mutationId: payload.mutationId ?? "",
      ...(before ? { before } : {}), ...(after ? { after } : {}),
    }]);
  }
  const patches = new Map<string, { session: string; root: string }>();
  for (const row of rows("file.artifact.recorded")) {
    const payload = decodeArtifact(row.payload);
    const root = payload.evidence?.patch?.reference?.root;
    if (payload.artifactKind !== "mutation_diff" || payload.evidence?.patch?.kind !== "retained" || !root || !payload.mutationId) continue;
    patches.set(payload.mutationId, { session: row.session_id, root });
  }
  const patchText = (mutationId: string): string | undefined => {
    const reference = patches.get(mutationId);
    if (!reference) return undefined;
    const row = db.query<{ content: string }, [string, string]>("select content from tool_content where session_id = ? and sha256 = ?").get(reference.session, reference.root);
    const content = row ? decodeContent(row.content) : undefined;
    return content?.kind === "text" ? content.text : undefined;
  };
  return { runs: [...runs.values()].filter((run) => run.result && run.prompt), parents, mutations, patchText, close: () => db.close() };
}

type Store = ReturnType<typeof loadStore>;

// ---------------------------------------------------------------- reconstruction

type FileState =
  | { status: "rebuilt"; path: string; content: string | undefined; anchor?: Commit; reversed: number }
  | { status: "refused"; path: string; reason: string };

/** The content of `path` in the working tree at `ms`, proven by hashes: the
 *  first commit after `ms` that touches the path, with the recorded mutations
 *  between `ms` and that commit reversed one by one. */
function stateAt(store: Store, era: Era, base: Commit, path: string, ms: number): FileState {
  const anchor = era.byPath.get(path)?.find((commit) => commit.ms > Math.floor(ms / 1000) * 1000);
  const recorded = store.mutations.get(path) ?? [];
  if (!anchor) {
    // Never committed after the review: the reviewer saw the base version only
    // if the last recorded mutation before the review left exactly that.
    const last = recorded.filter((mutation) => mutation.ms <= ms).at(-1);
    const baseContent = blob(era.repo, base.sha, path);
    if (last && last.after !== sha256(baseContent)) return { status: "refused", path, reason: "uncommitted change at review start" };
    return { status: "rebuilt", path, content: baseContent, reversed: 0 };
  }
  const upTo = recorded.filter((mutation) => mutation.ms <= anchor.ms + COMMIT_SLACK_MS);
  const last = upTo.at(-1);
  if (!last) return { status: "refused", path, reason: "committed change with no recorded mutation" };
  let content = blob(era.repo, anchor.sha, path);
  const after = upTo.filter((mutation) => mutation.ms > ms);
  if (last.after !== sha256(content)) return { status: "refused", path, reason: "anchor commit does not match the last recorded mutation" };
  for (const mutation of after.toReversed()) {
    // A mutation with no before-hash created the file, so before it the file was absent.
    if (mutation.before === undefined) { content = undefined; continue; }
    const patch = store.patchText(mutation.mutationId);
    if (patch === undefined) return { status: "refused", path, reason: "mutation patch not retained" };
    const previous = reverseApplyPatch(content ?? "", patch);
    if (previous === undefined) return { status: "refused", path, reason: "mutation patch does not reverse" };
    content = previous;
    if (sha256(content) !== mutation.before) return { status: "refused", path, reason: "hash mismatch after reversing a mutation" };
  }
  return { status: "rebuilt", path, content, anchor, reversed: after.length };
}

/** Repository paths a review prompt names that a recorded mutation touched. */
function namedPaths(store: Store, prompt: string): string[] {
  const paths: string[] = [];
  for (const raw of prompt.match(PATH_RE) ?? []) {
    const path = raw.startsWith(`${REPO}/`) ? raw.slice(REPO.length + 1) : raw.replace(/^\.?\//, "");
    if (store.mutations.has(path) && !paths.includes(path)) paths.push(path);
  }
  return paths.sort();
}

/** Why a review prompt cannot be rebuilt from this checkout, if it cannot. A
 *  scratch file is outside the repository's history, and a session can
 *  rewrite it after the review, so a review that reads one is never rebuilt. */
export function promptRefusal(prompt: string, named: readonly string[]): string | undefined {
  if (/\.flywheel\/sessions\/\w+\/scratch\//.test(prompt)) return "review of a scratch artifact";
  if (named.length === 0) return "prompt names no changed file";
  return undefined;
}

function lineage(store: Store, root: string): Set<string> {
  const members = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [child, parent] of store.parents) {
      if (members.has(parent) && !members.has(child)) {
        members.add(child);
        grew = true;
      }
    }
  }
  return members;
}

// ---------------------------------------------------------------- labels

interface Label {
  defect: { id: string; title: string; category: string; files: string[]; catch_criteria: string; finder: string; accepted: false };
}

/** A lineage change that fixed a cited line: the mutation and its hunk. */
interface Fix { path: string; mutation: string; hunk: string }

/** One reviewed change as a fixture shows it: the files the recorded reviewer
 *  saw, rebuilt, and what the fixture's patches make of them. */
interface Group {
  era: Era;
  base: Commit;
  runs: ReviewRun[];
  files: Map<string, Extract<FileState, { status: "rebuilt" }>>;
  /** The reviewed content of each file as the fixture holds it, after the scrub. */
  reviewed: Map<string, string | undefined>;
  diff: string;
  /** The patch from the pinned commit to the review's scrubbed base of these
   *  files; for a recorded change, empty unless the scrub rewrote the base. */
  basePatch: string;
  /** Per file, the reviewed-content lines that `diff` adds. */
  added: Map<string, Set<number>>;
  /** Per file, the lines that the scrub rewrote in its base and reviewed content. */
  scrubbed: Map<string, number>;
}

/** The no-model checks of a drafted label: a cited line exists in the reviewed
 *  state, the fixture shows the lines around it unchanged, the reviewed diff
 *  adds it, a later mutation by the reviewing parent's lineage changed it
 *  before the change was committed, and the fix is not already in the base.
 *  Only the lineage's own retained, hash-verified mutation patches count as
 *  the fix, so another session's edit of the same lines never does. */
function validateFinding(finding: Finding, run: ReviewRun, group: Group, store: Store, team: Set<string>): { fix: Fix[]; files: string[] } | string {
  const failures = new Set<string>();
  const fix: Fix[] = [];
  const cited = new Set<string>();
  for (const cite of parseLocations(finding.location)) {
    const location = { ...cite, path: cite.path.startsWith(`${REPO}/`) ? cite.path.slice(REPO.length + 1) : cite.path };
    const state = group.files.get(location.path);
    const lines = state?.content?.split("\n") ?? [];
    if (!state || state.content === undefined || location.start > lines.length) { failures.add("cited line not in the reviewed state"); continue; }
    const window = lines.slice(Math.max(0, location.start - 3), location.start + 2).join("\n");
    if (!group.reviewed.get(location.path)?.includes(window)) { failures.add("cited lines not verbatim in the fixture"); continue; }
    const added = group.added.get(location.path) ?? new Set();
    const span = Array.from({ length: Math.min(location.end, lines.length) - location.start + 1 }, (_, offset) => location.start + offset);
    if (!span.some((line) => added.has(line))) { failures.add("cited line not added by the reviewed diff"); continue; }
    if (!state.anchor) { failures.add("cited file never committed after the review"); continue; }
    const anchor = state.anchor;
    // stateAt verified this sequence: each patch reverses to its recorded before-hash.
    const sequence = (store.mutations.get(location.path) ?? [])
      .filter((mutation) => mutation.ms > run.start && mutation.ms <= anchor.ms + COMMIT_SLACK_MS)
      .map((mutation) => ({ mutationId: mutation.mutationId, lineage: team.has(mutation.session) && mutation.ms > run.end, patch: store.patchText(mutation.mutationId) ?? "" }));
    if (!sequence.some((mutation) => mutation.lineage)) { failures.add("no later edit by the reviewing lineage"); continue; }
    const touching = lineageChanges(sequence)
      .filter((change) => change.start <= location.end + OVERLAP_LINES && change.end >= location.start - OVERLAP_LINES);
    if (touching.length === 0) { failures.add("fix does not touch the cited lines"); continue; }
    const baseContent = blob(group.era.repo, group.base.sha, location.path) ?? "";
    const fresh = touching.filter((change) => change.added === "" || !baseContent.includes(change.added));
    if (fresh.length === 0) { failures.add("fix already present in the base"); continue; }
    fix.push(...fresh.map((change) => ({ path: location.path, mutation: change.mutationId, hunk: change.hunk })));
    cited.add(location.path);
  }
  const unique = [...new Map(fix.map((item) => [`${item.mutation}\u0000${item.hunk}`, item])).values()];
  return cited.size > 0 ? { fix: unique, files: [...cited].sort() } : [...failures].sort().join("; ") || "no file:line location";
}

// ---------------------------------------------------------------- build

interface Built {
  id: string;
  kind: "defect" | "control";
  variant: Era["variant"];
  files: ReadonlyMap<string, string>;
  labels: Label["defect"][];
}

/** Every run's outcome: a refusal reason or the fixture kind it built, with the run IDs. */
type Outcome = Map<string, string[]>;

/** What a build reads besides the store. */
interface Sources {
  /** The public history, then the pre-public history when restore mode reads one. */
  eras: readonly Era[];
  /** The first public commit, which every restored fixture pins. */
  pin: string;
  /** Rewrites the lines that name another coding agent; unchanged text when
   *  the checkout has no harness-name lint, which only recorded fixtures allow. */
  scrub: (text: string) => { text: string; lines: number };
  lint?: HarnessLint;
  exposure: ReadonlyMap<string, RegExp>;
}

/** The public commit that a fixture of `base` pins: the base itself for a
 *  recorded change, the first public commit for a restored one. */
function pinOf(sources: Sources, era: Era, base: Commit): string {
  return era.variant === "restore" ? sources.pin : base.sha;
}

/** The fixture's view of rebuilt files. It scrubs the base and the reviewed
 *  content before it diffs them, so both patches stay valid, and diffs the
 *  pinned commit to that scrubbed base as `base.patch`. For a recorded change
 *  `base.patch` is empty unless the scrub rewrote a line of the base. */
async function fixtureView(sources: Sources, era: Era, base: Commit, files: Group["files"]): Promise<Omit<Group, "era" | "base" | "runs" | "files"> | string> {
  const pin = pinOf(sources, era, base);
  const view = { reviewed: new Map<string, string | undefined>(), diff: "", basePatch: "", added: new Map<string, Set<number>>(), scrubbed: new Map<string, number>() };
  const scrub = (text: string | undefined) => text === undefined ? { text, lines: 0 } : sources.scrub(text);
  for (const [path, state] of files) {
    const baseContent = blob(era.repo, base.sha, path);
    const before = scrub(baseContent);
    const after = scrub(state.content);
    const breaks = (original: string | undefined, scrubbed: ReturnType<typeof scrub>) => scrubbed.lines > 0 && parses(path, original) && !parses(path, scrubbed.text);
    if (breaks(baseContent, before) || breaks(state.content, after)) return "scrub breaks the syntax of a source file";
    const change = await fileDiff(path, before.text, after.text);
    view.reviewed.set(path, after.text);
    view.added.set(path, addedLines(change));
    view.diff += change;
    view.basePatch += await fileDiff(path, blob(REPO, pin, path), before.text);
    if (before.lines + after.lines > 0) view.scrubbed.set(path, before.lines + after.lines);
  }
  return view;
}

const SCRIPT_LOADERS = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx" } as const;

/** Whether `text` parses as the script that `path` names; true for any other file. */
function parses(path: string, text: string | undefined): boolean {
  const loader = Object.entries(SCRIPT_LOADERS).find(([extension]) => path.endsWith(extension))?.[1];
  if (loader === undefined || text === undefined) return true;
  try {
    new Bun.Transpiler({ loader }).transformSync(text);
    return true;
  } catch {
    return false;
  }
}

const trees = new Map<string, ReadonlySet<string>>();
/** The paths of the tree of the public commit `pin`. */
function treePaths(pin: string): ReadonlySet<string> {
  if (!trees.has(pin)) trees.set(pin, new Set(git(["ls-tree", "-r", "--name-only", "-z", pin]).stdout.split("\0").filter(Boolean)));
  return trees.get(pin)!;
}

/** The relative imports of the fixture's reviewed scripts, as `path: specifier`,
 *  that name no file of the sandbox tree: the pinned tree with the fixture's
 *  files as reviewed. A restored file can import a module that the newer
 *  pinned tree renamed, which a reviewer can see but the review did not.
 *  Type-only imports are not counted, because the transpiler drops them. */
function unresolvedImports(pin: string, reviewed: Group["reviewed"]): string[] {
  const exists = (path: string) => reviewed.has(path) ? reviewed.get(path) !== undefined : treePaths(pin).has(path);
  const unresolved: string[] = [];
  for (const [path, text] of reviewed) {
    const loader = Object.entries(SCRIPT_LOADERS).find(([extension]) => path.endsWith(extension))?.[1];
    if (loader === undefined || text === undefined || !parses(path, text)) continue;
    // scanImports refuses a shebang line, which transformSync accepts.
    for (const { path: specifier } of new Bun.Transpiler({ loader }).scanImports(text.replace(/^#!.*/, ""))) {
      if (!specifier.startsWith(".")) continue;
      const target = posix.join(posix.dirname(path), specifier);
      const stem = target.replace(/\.[cm]?jsx?$/, "");
      if (![target, ...["ts", "tsx", "js", "jsx", "mjs", "cjs"].flatMap((extension) => [`${stem}.${extension}`, `${target}/index.${extension}`])].some(exists)) unresolved.push(`${path}: ${specifier}`);
    }
  }
  return unresolved;
}

/** Whether `basePatch` and then `diff` apply to the pinned commit's version
 *  of the fixture's files and leave exactly the reviewed content. */
async function rebuilds(pin: string, group: Group): Promise<boolean> {
  const work = await mkdtemp(join(tmpdir(), "review-fixture-apply-"));
  try {
    const tree = join(work, "tree");
    await mkdir(tree);
    // Its own repository, so git apply resolves paths from the tree's root.
    git(["init", "-q"], tree);
    for (const path of group.files.keys()) {
      const content = blob(REPO, pin, path);
      if (content === undefined) continue;
      await mkdir(dirname(join(tree, path)), { recursive: true });
      await writeFile(join(tree, path), content);
    }
    for (const [name, patch] of [["base.patch", group.basePatch], ["diff.patch", group.diff]] as const) {
      if (!patch) continue;
      await writeFile(join(work, name), patch);
      if (git(["apply", "--whitespace=nowarn", join(work, name)], tree).code !== 0) return false;
    }
    for (const [path, expected] of group.reviewed) {
      const file = Bun.file(join(tree, path));
      if ((await file.exists() ? await file.text() : undefined) !== expected) return false;
    }
    return true;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const publicLineSets = new Map<string, ReadonlySet<string>>();
/** The lines of `path` at the public commit `pin`. */
function publicLines(pin: string, path: string): ReadonlySet<string> {
  const key = `${pin}:${path}`;
  if (!publicLineSets.has(key)) publicLineSets.set(key, new Set(blob(REPO, pin, path)?.split("\n")));
  return publicLineSets.get(key)!;
}

/** Per exposure category, the lines of a fixture's files that would publish a
 *  private detail, and the harness-name lint's violations as `harness name`. */
async function publicationExposures(sources: Sources, pin: string, files: ReadonlyMap<string, string>): Promise<Map<string, number>> {
  const lines = function* () {
    for (const [name, text] of files) yield* name.endsWith(".patch") ? publishedDiffLines(text, (path) => publicLines(pin, path)) : text.split("\n");
  };
  const found = exposures(sources.exposure, lines());
  if (sources.lint) {
    const staged = await mkdtemp(join(tmpdir(), "review-fixture-scan-"));
    try {
      for (const [name, text] of files) await writeFile(join(staged, name), text);
      const violations = sources.lint.violations([...files.keys()].map((name) => join(staged, name)));
      if (violations > 0) found.set("harness name", violations);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
  return found;
}

/** A labeled wave of review over one change, before publication. */
interface Candidate {
  group: Group;
  first: ReviewRun;
  kind: Built["kind"];
  labels: Label["defect"][];
  runs: unknown[];
  /** Files outside the fixture that the reviewing lineage changed after the
   *  review and before the fixture's files were committed: a fix or a test of
   *  the fixed behavior may sit there, outside what the fixture holds. */
  residue: string[];
}

async function rebuildGroups(store: Store, sources: Sources, record: (reason: string, runs: readonly ReviewRun[]) => void): Promise<Group[]> {
  const groups = new Map<string, Group>();
  for (const run of store.runs.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))) {
    // The recorded mutations and the history are this checkout's; a review
    // that ran in another worktree saw another tree.
    if (run.cwd !== REPO) { record("review ran outside this checkout", [run]); continue; }
    const named = namedPaths(store, run.prompt);
    const refusal = promptRefusal(run.prompt, named);
    if (refusal) { record(refusal, [run]); continue; }
    const era = sources.eras.find((candidate) => (candidate.commits[0]?.ms ?? Number.POSITIVE_INFINITY) <= run.start);
    const base = era?.commits.filter((commit) => commit.ms <= run.start).at(-1);
    if (!era || !base) { record("review predates the repository", [run]); continue; }
    const during = named.some((path) => (store.mutations.get(path) ?? []).some((mutation) => mutation.ms > run.start && mutation.ms <= run.end));
    if (during) { record("edit during the review window", [run]); continue; }
    const states = named.map((path) => stateAt(store, era, base, path, run.start));
    const failed = states.find((state) => state.status === "refused");
    if (failed?.status === "refused") { record(failed.reason, [run]); continue; }
    const files = new Map(states.flatMap((state) => state.status === "rebuilt" ? [[state.path, state] as const] : []));
    const view = await fixtureView(sources, era, base, files);
    if (typeof view === "string") { record(view, [run]); continue; }
    if (!view.diff) { record("empty reviewed diff", [run]); continue; }
    const key = `${era.variant}\u0000${base.sha}\u0000${sha256(view.diff)}`;
    const group = groups.get(key) ?? { era, base, runs: [], files, ...view };
    group.runs.push(run);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** A fixture the publication scan refused, with its line count per exposure category. */
interface Refusal { id: string; exposures: ReadonlyMap<string, number> }

async function build(store: Store, sources: Sources, outcome: Outcome): Promise<{ built: Built[]; refused: Refusal[] }> {
  const record = (reason: string, runs: readonly ReviewRun[]) => outcome.set(reason, [...outcome.get(reason) ?? [], ...runs.map((run) => run.id)]);
  const candidates: Candidate[] = [];
  for (const group of await rebuildGroups(store, sources, record)) {
    const [first] = group.runs;
    if (!first) continue;
    const labels: Label["defect"][] = [];
    const provenanceRuns = [];
    const residue = new Set<string>();
    const committed = Math.max(...[...group.files.values()].map((state) => state.anchor?.ms ?? Number.NEGATIVE_INFINITY)) + COMMIT_SLACK_MS;
    let reportedNothing = true;
    for (const run of group.runs) {
      const findings = parseFindings(run.result);
      if (findings.length > 0 || !NOTHING_FOUND.test(run.result)) reportedNothing = false;
      const team = lineage(store, run.parent);
      for (const [path, mutations] of store.mutations) {
        // A path the history never committed, such as a session's scratch file, is not part of the change.
        if (!group.files.has(path) && group.era.byPath.has(path) && mutations.some((mutation) => team.has(mutation.session) && mutation.ms > run.end && mutation.ms <= committed)) residue.add(path);
      }
      const drafted = [];
      for (const finding of findings.filter((item) => item.severity !== "P3")) {
        const check = validateFinding(finding, run, group, store, team);
        if (typeof check === "string") { drafted.push({ title: finding.title, severity: finding.severity, location: finding.location, rejected: check }); continue; }
        let id = slug(finding.title);
        for (let suffix = 2; labels.some((label) => label.id === id); suffix++) id = `${slug(finding.title)}-${suffix}`;
        labels.push({
          id, title: finding.title, category: run.persona.replace(/^reviewer-code-/, ""), files: check.files,
          catch_criteria: `The review must identify this defect at ${finding.location}: ${finding.title}. ${finding.failure}`.trim(),
          finder: run.model, accepted: false,
        });
        drafted.push({ title: finding.title, severity: finding.severity, location: finding.location, label: id, fix: check.fix });
      }
      provenanceRuns.push({ run: run.id, session: run.session, parent: run.parent, persona: run.persona, model: run.model, effort: run.effort, start: run.start, end: run.end, findings: drafted });
    }
    const untouched = [...group.files.values()].every((state) => !(store.mutations.get(state.path) ?? []).some((mutation) => mutation.ms > first.start && mutation.ms <= (state.anchor?.ms ?? Number.POSITIVE_INFINITY) + COMMIT_SLACK_MS));
    const kind = labels.length > 0 ? "defect" : reportedNothing && untouched ? "control" : undefined;
    if (!kind) {
      record(reportedNothing ? "clean review with a later edit" : "no finding passed the label checks", group.runs);
      for (const run of provenanceRuns) for (const finding of run.findings) record(`label check: ${"rejected" in finding ? finding.rejected : "passed"}`, group.runs.filter((member) => member.id === run.run));
      continue;
    }
    candidates.push({ group, first, kind, labels, runs: provenanceRuns, residue: [...residue].sort() });
  }
  // One fixture per change: of the waves that one parent's review of one file
  // set went through, the one whose findings drafted the most labels, then the earliest.
  const changes = Map.groupBy(candidates, ({ group, first }) => `${first.parent}\u0000${[...group.files.keys()].join("\u0000")}`);
  const built: Built[] = [];
  const refused: Refusal[] = [];
  for (const waves of changes.values()) {
    const [kept, ...others] = waves.toSorted((a, b) => b.labels.length - a.labels.length || a.first.start - b.first.start);
    if (!kept) continue;
    for (const other of others) record("another wave of the same change was kept", other.group.runs);
    const fixture = await publish(kept, others, sources);
    if (fixture instanceof Map) {
      for (const category of fixture.keys()) record(`publication scan: ${category}`, kept.group.runs);
      refused.push({ id: `review-${kept.first.id}`, exposures: fixture });
      continue;
    }
    if (!fixture) { record("patches do not rebuild the reviewed state", kept.group.runs); continue; }
    built.push(fixture);
    record(`built ${kept.kind}`, kept.group.runs);
  }
  return { built: built.sort((a, b) => a.id.localeCompare(b.id)), refused: refused.sort((a, b) => a.id.localeCompare(b.id)) };
}

/** The files of one fixture, or the exposures that refuse it, or undefined
 *  when its patches do not rebuild the reviewed state on the pinned commit. */
async function publish(candidate: Candidate, others: readonly Candidate[], sources: Sources): Promise<Built | Map<string, number> | undefined> {
  const { group, first, kind, labels } = candidate;
  const variant = group.era.variant;
  const pin = pinOf(sources, group.era, group.base);
  if (!await rebuilds(pin, group)) return undefined;
  const id = `review-${first.id}`;
  // Recorded text names this checkout and a session's scratch directory by
  // absolute path; a fixture names them relative to the repository instead.
  const publicText = (text: string) => sources.scrub(text.replaceAll(`${REPO}/`, "").replaceAll(REPO, ".").replace(/\.flywheel\/sessions\/[0-9a-f]{12}\/scratch\b/g, ".flywheel/scratch"));
  const prompt = publicText(first.prompt);
  const manifest = publicText(canonicalJson({ title: first.title || `Reviewed change ${first.id}`, review_prompt_hint: "", defects: labels }));
  const scrubbedLines = { ...Object.fromEntries(group.scrubbed), ...prompt.lines > 0 ? { "prompt.md": prompt.lines } : {}, ...manifest.lines > 0 ? { "manifest.json": manifest.lines } : {} };
  const files = new Map([
    ["source.json", canonicalJson({ commit: pin, variant })],
    ...group.basePatch ? [["base.patch", group.basePatch] as const] : [],
    ["diff.patch", group.diff],
    ["prompt.md", prompt.text],
    ["manifest.json", manifest.text],
    ["PROVENANCE.json", publicText(canonicalJson({
      variant,
      base: group.base.sha,
      files: [...group.files.values()].map((state) => ({ path: state.path, anchor: state.anchor?.sha ?? null, reversedMutations: state.reversed })),
      runs: candidate.runs,
      scrubbedLines,
      possibleFixResidue: candidate.residue,
      unresolvedImports: unresolvedImports(pin, group.reviewed),
      otherWaves: others.map((other) => ({ runs: other.group.runs.map((run) => run.id), labels: other.labels.length })),
    })).text],
  ]);
  const found = await publicationExposures(sources, pin, files);
  return found.size > 0 ? found : { id, kind, variant, labels, files };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const out = option("--out");
  if (!out) throw new Error("Usage: bun run scripts/build-review-fixtures.ts --out <empty directory> [--store <flywheel.sqlite>] [--archive <pre-public checkout>]");
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty; give an empty or new directory`);
  const archive = option("--archive");
  const lint = await loadHarnessLint(REPO, harnessLintFile(REPO));
  if (archive !== undefined && !lint) throw new Error("Restore mode rewrites the names of other coding agents with the terms of private/scripts/check-harness-names.ts, which this checkout does not have");
  const eras = [history(REPO, "recorded"), ...archive === undefined ? [] : [history(resolve(archive), "restore")]];
  const [pin] = eras[0]!.commits;
  if (!pin) throw new Error("Cannot read the repository's first commit");
  const store = loadStore(option("--store") ?? join(REPO, ".flywheel", "flywheel.sqlite"), eras.at(-1)!.commits[0]!.ms);
  const outcome: Outcome = new Map();
  try {
    const sources: Sources = { eras, pin: pin.sha, scrub: (text) => lint ? lint.scrub(text, (term) => `peerAgent${term + 1}`) : { text, lines: 0 }, ...lint ? { lint } : {}, exposure: exposurePatterns(privateIdentity(archive)) };
    const { built, refused } = await build(store, sources, outcome);
    for (const fixture of built) {
      await mkdir(join(out, fixture.id), { recursive: true });
      for (const [name, content] of fixture.files) await writeFile(join(out, fixture.id, name), content);
    }
    process.stdout.write(canonicalJson({
      reviews: store.runs.length,
      outcome: Object.fromEntries([...outcome].sort(([a], [b]) => a.localeCompare(b)).map(([reason, runs]) => [reason, { count: runs.length, runs }])),
      fixtures: built.map((fixture) => ({ id: fixture.id, kind: fixture.kind, variant: fixture.variant, labels: fixture.labels.map(({ id, title, files, finder }) => ({ id, title, files, finder })) })),
      refused: refused.map((refusal) => ({ id: refusal.id, exposures: Object.fromEntries(refusal.exposures) })),
    }));
  } finally {
    store.close();
  }
}

/** This machine's private details, which no fixture may publish: read from
 *  the environment, never written into this public script. */
function privateIdentity(archive: string | undefined): PrivateIdentity {
  const profiles = join(homedir(), ".flywheel", "auth", "profiles");
  const remote = (repo: string) => /([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(git(["remote", "get-url", "origin"], repo).stdout.trim());
  const origin = remote(REPO);
  const companion = existsSync(join(REPO, "private")) ? remote(join(REPO, "private")) : null;
  return {
    home: homedir(),
    user: userInfo().username,
    machines: [hostname().replace(/\.local$/, ""), process.env.FLYWHEEL_READINESS_WINDOWS_HOST ?? ""],
    // A profile is named by its directory and by the display name in its
    // profile.json, and FLYWHEEL_AUTH_PROFILE accepts either.
    authProfiles: [
      ...existsSync(profiles) ? readdirSync(profiles, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? [entry.name, displayName(join(profiles, entry.name, "profile.json"))] : []) : [],
      process.env.FLYWHEEL_LIVE_AUTH_PROFILE ?? "", process.env.FLYWHEEL_AUTH_PROFILE ?? "",
    ],
    repositories: [
      ...archive === undefined ? [] : [basename(resolve(archive))],
      ...origin && origin[2] !== basename(REPO) ? [`${origin[1]}/${basename(REPO)}`] : [],
      ...companion ? [companion[2]!] : [],
    ],
  };
}

/** The display name in a profile.json, or an empty name when the profile has none. */
function displayName(path: string): string {
  if (!existsSync(path)) return "";
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return typeof value === "object" && value !== null && "displayName" in value && typeof value.displayName === "string" ? value.displayName : "";
}
