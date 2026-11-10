import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";

// Builds reviewer benchmark fixtures from real reviews recorded in a Flywheel
// store. For each code review since the repository's first commit it rebuilds
// the working tree the reviewer saw from the recorded file mutations and git,
// verifies every step against the recorded SHA-256 hashes, and writes one
// fixture per reviewed diff: `source.json`, `diff.patch`, `prompt.md`,
// `manifest.json` with drafted labels, and `PROVENANCE.json`. It never changes
// the store or the repository, and two runs over the same inputs write the
// same bytes.
//
// Usage: bun run scripts/build-review-fixtures.ts --out <empty directory> [--store <flywheel.sqlite>]
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
function blob(commit: string, path: string): string | undefined {
  const key = `${commit}:${path}`;
  if (!blobs.has(key)) {
    const shown = git(["show", key]);
    blobs.set(key, shown.code === 0 ? shown.stdout : undefined);
  }
  return blobs.get(key);
}

interface Commit { ms: number; sha: string }

/** First-parent history of HEAD, oldest first, and per path the commits that touch it. */
function history() {
  const commits: Commit[] = [];
  const byPath = new Map<string, Commit[]>();
  let current: Commit | undefined;
  for (const line of git(["log", "--first-parent", "--no-renames", "--name-only", "--format=C %H %ct", "HEAD"]).stdout.split("\n")) {
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
  return { commits, byPath };
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
const decodeChanged = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ path: Schema.String, mutationId: Schema.String, before: Hash, after: Hash })));
const decodeArtifact = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  mutationId: Schema.String, artifactKind: Schema.String,
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
      ms: row.timestamp, session: row.session_id, mutationId: payload.mutationId,
      ...(before ? { before } : {}), ...(after ? { after } : {}),
    }]);
  }
  const patches = new Map<string, { session: string; root: string }>();
  for (const row of rows("file.artifact.recorded")) {
    const payload = decodeArtifact(row.payload);
    const root = payload.evidence?.patch?.reference?.root;
    if (payload.artifactKind !== "mutation_diff" || payload.evidence?.patch?.kind !== "retained" || !root) continue;
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
function stateAt(store: Store, byPath: Map<string, Commit[]>, base: Commit, path: string, ms: number): FileState {
  const anchor = byPath.get(path)?.find((commit) => commit.ms > Math.floor(ms / 1000) * 1000);
  const recorded = store.mutations.get(path) ?? [];
  if (!anchor) {
    // Never committed after the review: the reviewer saw the base version only
    // if the last recorded mutation before the review left exactly that.
    const last = recorded.filter((mutation) => mutation.ms <= ms).at(-1);
    const baseContent = blob(base.sha, path);
    if (last && last.after !== sha256(baseContent)) return { status: "refused", path, reason: "uncommitted change at review start" };
    return { status: "rebuilt", path, content: baseContent, reversed: 0 };
  }
  const upTo = recorded.filter((mutation) => mutation.ms <= anchor.ms + COMMIT_SLACK_MS);
  const last = upTo.at(-1);
  if (!last) return { status: "refused", path, reason: "committed change with no recorded mutation" };
  let content = blob(anchor.sha, path);
  if (last.after !== sha256(content)) return { status: "refused", path, reason: "anchor commit does not match the last recorded mutation" };
  const after = upTo.filter((mutation) => mutation.ms > ms);
  for (const mutation of after.toReversed()) {
    const patch = store.patchText(mutation.mutationId);
    if (patch === undefined) return { status: "refused", path, reason: "mutation patch not retained" };
    const previous = reverseApplyPatch(content ?? "", patch);
    if (previous === undefined) return { status: "refused", path, reason: "mutation patch does not reverse" };
    // A mutation with no before-hash created the file, so before it the file was absent.
    content = mutation.before === undefined ? undefined : previous;
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

/** The no-model checks of a drafted label: a cited line exists in the reviewed
 *  state, a later mutation by the reviewing parent's lineage changed it before
 *  the change was committed, and the fix is not already in the base. Only the
 *  lineage's own retained, hash-verified mutation patches count as the fix, so
 *  another session's edit of the same lines never does. */
function validateFinding(finding: Finding, run: ReviewRun, files: Map<string, Extract<FileState, { status: "rebuilt" }>>, base: Commit, store: Store, team: Set<string>): { fix: Fix[]; files: string[] } | string {
  const failures = new Set<string>();
  const fix: Fix[] = [];
  const cited = new Set<string>();
  for (const cite of parseLocations(finding.location)) {
    const location = { ...cite, path: cite.path.startsWith(`${REPO}/`) ? cite.path.slice(REPO.length + 1) : cite.path };
    const state = files.get(location.path);
    const lines = state?.content?.split("\n").length ?? 0;
    if (!state || state.content === undefined || location.start > lines) { failures.add("cited line not in the reviewed state"); continue; }
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
    const baseContent = blob(base.sha, location.path) ?? "";
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
  files: ReadonlyMap<string, string>;
  labels: Label["defect"][];
}

/** Every run's outcome: a refusal reason or the fixture kind it built, with the run IDs. */
type Outcome = Map<string, string[]>;

async function build(store: Store, outcome: Outcome): Promise<Built[]> {
  const { commits, byPath } = history();
  const groups = new Map<string, { runs: ReviewRun[]; base: Commit; diff: string; files: Map<string, Extract<FileState, { status: "rebuilt" }>> }>();
  const record = (reason: string, runs: readonly ReviewRun[]) => outcome.set(reason, [...outcome.get(reason) ?? [], ...runs.map((run) => run.id)]);
  for (const run of store.runs.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))) {
    // The recorded mutations and the history are this checkout's; a review
    // that ran in another worktree saw another tree.
    if (run.cwd !== REPO) { record("review ran outside this checkout", [run]); continue; }
    const named = namedPaths(store, run.prompt);
    const refusal = promptRefusal(run.prompt, named);
    if (refusal) { record(refusal, [run]); continue; }
    const base = commits.filter((commit) => commit.ms <= run.start).at(-1);
    if (!base) { record("review predates the repository", [run]); continue; }
    const during = named.some((path) => (store.mutations.get(path) ?? []).some((mutation) => mutation.ms > run.start && mutation.ms <= run.end));
    if (during) { record("edit during the review window", [run]); continue; }
    const states = named.map((path) => stateAt(store, byPath, base, path, run.start));
    const failed = states.find((state) => state.status === "refused");
    if (failed?.status === "refused") { record(failed.reason, [run]); continue; }
    const rebuilt = new Map(states.flatMap((state) => state.status === "rebuilt" ? [[state.path, state] as const] : []));
    let diff = "";
    for (const [path, state] of rebuilt) diff += await fileDiff(path, blob(base.sha, path), state.content);
    if (!diff) { record("empty reviewed diff", [run]); continue; }
    const key = `${base.sha}\u0000${sha256(diff)}`;
    const group = groups.get(key) ?? { runs: [], base, diff, files: rebuilt };
    group.runs.push(run);
    groups.set(key, group);
  }
  const built: Built[] = [];
  for (const group of groups.values()) {
    const [first] = group.runs;
    if (!first) continue;
    const labels: Label["defect"][] = [];
    const provenanceRuns = [];
    let reportedNothing = true;
    for (const run of group.runs) {
      const findings = parseFindings(run.result);
      if (findings.length > 0 || !NOTHING_FOUND.test(run.result)) reportedNothing = false;
      const team = lineage(store, run.parent);
      const drafted = [];
      for (const finding of findings.filter((item) => item.severity !== "P3")) {
        const check = validateFinding(finding, run, group.files, group.base, store, team);
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
    const id = `review-${first.id}`;
    const manifest = { title: first.title || `Reviewed change ${first.id}`, review_prompt_hint: "", defects: labels };
    built.push({
      id, kind, labels,
      files: new Map([
        ["source.json", canonicalJson({ commit: group.base.sha })],
        ["diff.patch", group.diff],
        ["prompt.md", first.prompt.replaceAll(`${REPO}/`, "").replaceAll(REPO, ".")],
        ["manifest.json", canonicalJson(manifest)],
        ["PROVENANCE.json", canonicalJson({
          base: group.base.sha,
          files: [...group.files.values()].map((state) => ({ path: state.path, anchor: state.anchor?.sha ?? null, reversedMutations: state.reversed })),
          runs: provenanceRuns,
        })],
      ]),
    });
    record(`built ${kind}`, group.runs);
  }
  return built.sort((a, b) => a.id.localeCompare(b.id));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const out = option("--out");
  if (!out) throw new Error("Usage: bun run scripts/build-review-fixtures.ts --out <empty directory> [--store <flywheel.sqlite>]");
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty; give an empty or new directory`);
  const rootCommit = git(["log", "--max-parents=0", "--format=%ct", "HEAD"]).stdout.trim().split("\n").map(Number).sort((a, b) => a - b)[0];
  if (rootCommit === undefined || !Number.isFinite(rootCommit)) throw new Error("Cannot read the repository's first commit");
  const store = loadStore(option("--store") ?? join(REPO, ".flywheel", "flywheel.sqlite"), rootCommit * 1000);
  const outcome: Outcome = new Map();
  try {
    const built = await build(store, outcome);
    for (const fixture of built) {
      await mkdir(join(out, fixture.id), { recursive: true });
      for (const [name, content] of fixture.files) await writeFile(join(out, fixture.id, name), content);
    }
    process.stdout.write(canonicalJson({
      reviews: store.runs.length,
      outcome: Object.fromEntries([...outcome].sort(([a], [b]) => a.localeCompare(b)).map(([reason, runs]) => [reason, { count: runs.length, runs }])),
      fixtures: built.map((fixture) => ({ id: fixture.id, kind: fixture.kind, labels: fixture.labels.map(({ id, title, files, finder }) => ({ id, title, files, finder })) })),
    }));
  } finally {
    store.close();
  }
}
