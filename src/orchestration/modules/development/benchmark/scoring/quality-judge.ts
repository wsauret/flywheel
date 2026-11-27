import { join } from "node:path";
import { completeJudge, type JudgeLoopOptions, type JudgeModel, type JudgeSettlement } from "./judge.js";
import { planForQualityJudging, type ImplementCandidate } from "./implement-scoring.js";
import type { QualityFinding, QualityScore } from "./run-store.js";
import type { ImplementTask } from "../catalog.js";
import { bytesIdentity, structuredIdentity } from "../campaign/content-identity.js";
import { realFileUnder } from "../campaign/paths.js";

// The judged code quality of an implementer cell (ARCH-DIRECTORIES-026). A judge reads the task's request, its
// reference solution where the task stores one, and the cell's committed diff and handoff, and reports typed findings.
// The score derives from the findings alone, so a reader can audit each point a cell lost. Hidden tests judge
// functional correctness; the judge reports what they cannot see.

const FINDING_KINDS = ["needless-code", "wrong-abstraction", "convention-break", "missed-defect"] as const;
const SEVERITIES = ["major", "minor"] as const;
const POINTS = { major: 15, minor: 5 } as const;

/** The reference solution of each task that stores one, as a path under its task directory. A plan task stores none.
 *  The bytes of each reference are part of the judge identity, so a changed reference needs a new calibration. */
const JUDGE_REFERENCES: ReadonlyMap<string, string> = new Map([
  ["astropy__astropy-14598", "controls/reference.patch"],
  ["ds1000-298", "original/reference_code.py.gz"],
  ["getmoto__moto-7365", "original/gold.patch"],
  ["httpx-streaming-json-iteration", "original/solution/solution.patch"],
  ["jquense__yup-2305", "original/solution/fix.patch"],
  ["psf__requests-6028", "original/gold.patch"],
  ["redis__redis-10068", "original/patch.patch"],
  ["rust-react", "controls/reference.rs"],
  ["scheme-metacircular", "controls/reference-eval.scm"],
]);

/** Whether `task`'s reference solution is a patch, so a calibration can seed defects into it. */
export function hasReferencePatch(task: string): boolean {
  return JUDGE_REFERENCES.get(task)?.endsWith(".patch") === true;
}

const RUBRIC = [
  "Report only concrete findings that cite a line of a changed hunk, with a claim and evidence; any other finding is discarded. Each finding has one kind:",
  "- needless-code: code whose deletion would not change behavior, an abstraction with one caller, a speculative extension point, a defensive check on data the program itself produced, or a comment that restates the code.",
  "- wrong-abstraction: misplaced ownership, a duplicate copy of state that another value already holds, or a shape that fights the surrounding code.",
  "- convention-break: the change ignores the file's or the project's existing patterns, names, or helpers.",
  "- missed-defect: a real bug in the changed behavior. Name the concrete input or sequence that triggers it in `scenario`; a missed-defect finding without a reachable scenario is discarded.",
  "Severity is major when the finding would block the change in review, and minor otherwise.",
  "Prefer the smallest correct change. Reward matching the existing conventions and honest naming. Do not report functional failures of the stated behavior that the request's own tests would catch: hidden tests judge correctness. Do not report style preferences that the surrounding code does not establish.",
  "The reference solution, when present, shows one correct change; a different correct change is not a finding.",
].join("\n");

/** What the judge reads about a task: its request, and its reference solution where the task stores one. */
export interface QualityJudgeInput {
  readonly instruction: string;
  readonly reference: string | undefined;
}

function buildQualityJudgePrompt(input: QualityJudgeInput, diff: string, summary: string): string {
  return [
    "You are a meticulous staff engineer reviewing one implementation diff for engineering quality. The author is anonymous.",
    RUBRIC,
    "",
    "## Request",
    input.instruction,
    "",
    "## Reference solution",
    input.reference ?? "(none)",
    "",
    "## Diff",
    diff || "(no diff)",
    "",
    "## Author's handoff",
    summary || "(none)",
    "",
    "Respond with only one JSON object. `line` is the line number in the new file. `scope_ok` is false when the diff changes things the request does not ask for:",
    `{"findings":[{"kind":"needless-code"|"wrong-abstraction"|"convention-break"|"missed-defect","severity":"major"|"minor","file":"path","line":1,"claim":"One sentence.","evidence":"The changed code that shows it.","scenario":"Only for missed-defect: the input that triggers it."}],"scope_ok":true}`,
  ].join("\n");
}

/** The judge identity over the implementer tasks `tasks`: every static prompt byte, the score points, and the bytes of
 *  each task's reference solution. A judged-quality score line records it as its scoring version, and a calibration
 *  holds only for the identity it ran under, so an edited reference needs a new judgment of every change. */
export async function qualityScoringVersion(tasks: readonly ImplementTask[]): Promise<string> {
  const references = Object.fromEntries(await Promise.all(tasks.filter(({ id }) => JUDGE_REFERENCES.has(id))
    .map(async (task) => [task.id, bytesIdentity((await qualityJudgeInput(task)).reference ?? "")] as const)));
  return `quality-${structuredIdentity({
    prompt: buildQualityJudgePrompt({ instruction: "<REQUEST>", reference: "<REFERENCE>" }, "<DIFF>", "<SUMMARY>"),
    noReference: buildQualityJudgePrompt({ instruction: "", reference: undefined }, "", ""),
    references,
    points: POINTS,
  }).slice(0, 16)}`;
}

/** The identity of the exact judge input of one diff: a stored judgment of it holds only while this matches. */
export function qualityPromptIdentity(input: QualityJudgeInput, diff: string, summary: string): string {
  return structuredIdentity(buildQualityJudgePrompt(input, diff, summary));
}

/** The judged quality of a diff from 0 to 100: 15 points off per major finding and 5 per minor finding. */
export function judgedScore(findings: readonly Pick<QualityFinding, "severity">[]): number {
  return Math.max(0, 100 - findings.reduce((total, { severity }) => total + POINTS[severity], 0));
}

/** The request and reference text of `task`, as the judge reads them. */
export async function qualityJudgeInput(task: ImplementTask): Promise<QualityJudgeInput> {
  const path = JUDGE_REFERENCES.get(task.id);
  if (path === undefined) return { instruction: planForQualityJudging(task), reference: undefined };
  const file = await realFileUnder(task.taskDir, join(task.taskDir, path), `${task.id}/${path}`);
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const reference = new TextDecoder("utf-8", { fatal: true }).decode(path.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes);
  return { instruction: planForQualityJudging(task), reference };
}

type Judgment = Pick<QualityScore, "findings" | "scopeOk" | "discarded">;

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => candidate === value);
}

/** A path as a diff or a judge writes it, without a leading `a/`, `b/`, or `./`. */
export function diffPath(path: string): string {
  return path.trim().replace(/^(?:[ab]\/|\.\/)/, "");
}

/** The new-file line ranges of each hunk of `diff`, by file. A hunk that only deletes covers the line it follows. */
function hunkLines(diff: string): ReadonlyMap<string, readonly (readonly [number, number])[]> {
  const hunks = new Map<string, [number, number][]>();
  let file: string | undefined;
  for (const row of diff.split("\n")) {
    if (row.startsWith("+++ ")) file = row.slice(4) === "/dev/null" ? undefined : diffPath(row.slice(4).split("\t")[0] ?? "");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (!hunk || file === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    hunks.set(file, [...hunks.get(file) ?? [], [start, start + Math.max(count, 1) - 1]]);
  }
  return hunks;
}

/** Parse the judge's response to `diff`. A malformed response or finding is an error, so the call retries. A finding
 *  that the diff does not support is discarded and counted: one whose file and line lie in no hunk of the diff, one
 *  with a blank claim or evidence, and a missed-defect finding that names no scenario. */
export function parseQualityJudgment(text: string, diff: string): JudgeSettlement<Judgment | undefined> {
  const failed = (error: string) => ({ value: undefined, error });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return failed("Judge response did not contain JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (error) {
    return failed(`Judge response JSON failed to parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("findings" in parsed) || !Array.isArray(parsed.findings) || !("scope_ok" in parsed) || typeof parsed.scope_ok !== "boolean") {
    return failed("Judge response did not match the quality finding schema");
  }
  const findings: QualityFinding[] = [];
  const hunks = hunkLines(diff);
  let discarded = 0;
  for (const value of parsed.findings) {
    if (typeof value !== "object" || value === null) return failed("Judge response contained a non-object finding");
    const fields = new Map<string, unknown>(Object.entries(value));
    const [kind, severity, file, line, claim, evidence, scenario] = ["kind", "severity", "file", "line", "claim", "evidence", "scenario"].map((key) => fields.get(key));
    if (!isOneOf(FINDING_KINDS, kind) || !isOneOf(SEVERITIES, severity) || typeof file !== "string" || file.trim() === ""
      || typeof line !== "number" || !Number.isInteger(line) || line < 1 || typeof claim !== "string" || typeof evidence !== "string") {
      return failed("Judge response contained an invalid finding");
    }
    const grounded = hunks.get(diffPath(file))?.some(([first, last]) => line >= first && line <= last) === true;
    const stated = claim.trim() !== "" && evidence.trim() !== "";
    const reachable = kind !== "missed-defect" || (typeof scenario === "string" && scenario.trim() !== "");
    if (!grounded || !stated || !reachable) {
      discarded++;
      continue;
    }
    findings.push({ kind, severity, file, line, claim, evidence, ...kind === "missed-defect" && typeof scenario === "string" ? { scenario } : {} });
  }
  return { value: { findings, scopeOk: parsed.scope_ok, discarded }, error: null };
}

/** The diff that one judged-quality call reads: an implementer cell, or a calibration control under its control id. */
export type QualityCandidate = Pick<ImplementCandidate, "variant" | "task" | "repeat" | "diff" | "summary">;

/** Judge each candidate's diff once. Each call is accounted through `onAttempt` before anything is published, and
 *  each settlement, failed ones included, goes to `onSettled`; the returned scores are the successful ones. */
export async function scoreImplementQuality(
  candidates: readonly QualityCandidate[],
  inputs: ReadonlyMap<string, QualityJudgeInput>,
  model: JudgeModel,
  options: Omit<JudgeLoopOptions<QualityScore>, "existing"> = {},
): Promise<QualityScore[]> {
  const scores: QualityScore[] = [];
  for (const candidate of candidates) {
    if (options.signal?.aborted) return scores;
    const input = inputs.get(candidate.task);
    if (!input) throw new Error(`Missing judged-quality input for task ${candidate.task}`);
    const { variant, task, repeat } = candidate;
    const completion = await completeJudge(model, buildQualityJudgePrompt(input, candidate.diff, candidate.summary), options.timeoutMs, options.signal);
    await options.onAttempt?.({ score: { kind: "quality-score", variant, task, repeat }, terminal: completion.terminal, accounting: completion.accounting });
    if (completion.terminal === "cancelled") return scores;
    const parsed = completion.error === null ? parseQualityJudgment(completion.value, candidate.diff) : { value: undefined, error: completion.error };
    const score: QualityScore = { variant, task, repeat, ...parsed.value ?? { findings: [], scopeOk: true, discarded: 0 } };
    await options.onSettled?.({ value: score, error: parsed.error });
    if (parsed.error === null) scores.push(score);
  }
  return scores;
}
