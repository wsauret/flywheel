// The judge of the comparison with Claude Code. Each block's two reports go
// to the pinned chat-ab judge (pair-judge.ts, admitChatAbJudge) twice, once
// in each slot order, and two orders that disagree are a tie. Each verdict
// that names a winner then goes to an adversarial pass, which tries to
// refute it, and a refuted verdict becomes a tie. An absolute check, with no
// model, states whether each report names each shipped bug site.
//
// The chat-ab pairwise prompt (judgePair) judges two code changes against a
// reference fix. Here the two arms write audit reports, not changes, so the
// judge reads a report prompt of its own, with the same verdict shape and the
// same reference fix (referenceFix). An answer test asks a question and
// changes nothing, so its judge reads an answer prompt against the test's
// written reference answer, and makes no shipped-site check. A planning task
// writes a plan, so its judge reads a plan prompt against the task's known
// requirements and never reads a fix.
import { Schema } from "effect";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { completeJudge } from "../../src/orchestration/modules/development/benchmark/judge.js";
import { namesShippedSite, SHIPPED_SITES } from "./workflow-audit-tests.js";
import { modelNamePattern, type Redaction } from "./judge-inputs.js";
import { eachJudgeJob, PAIR_JUDGE_INSTRUCTIONS, referenceFix, VerdictSchema, type ChatAbJudge } from "./pair-judge.js";
type ComparisonArm = "claude-code" | "flywheel";

const JUDGE_TIMEOUT_MS = 600_000;
const MAX_REPORT_CHARS = 60_000;

const REPORT_JUDGE_INSTRUCTIONS = [
  "You are a staff engineer judging two audit reports written for the same request in the Flywheel repository (TypeScript on Bun). You do not know who wrote either report.",
  "",
  "Judge in this order of importance:",
  "1. Real bugs: a report that names a real correctness bug, with the file, the line, and evidence that holds, is better. The reference fix below shows one real bug that shipped.",
  "2. False findings: penalize each finding that is not a real bug, or whose evidence does not hold.",
  "3. Evidence: reward a finding whose evidence a reader can check in the code.",
  "",
  "Use the reference fix only to understand one real bug and the code paths involved. A real bug that the reference does not fix counts as much as the one it fixes.",
  "Allow a tie only when the two reports are of genuinely equal quality.",
].join("\n");

const decodeVerdict = Schema.decodeUnknownSync(VerdictSchema);
type Verdict = typeof VerdictSchema.Type;

const RefutationSchema = Schema.Struct({ refuted: Schema.Boolean, reason: Schema.String });
const decodeRefutation = Schema.decodeUnknownSync(RefutationSchema);

/** What the judge must not read: the pinned model's names, the reminders, the tool prefixes, and the names of the
 *  two agents. */
function comparisonRedaction(model: string | readonly string[]): Redaction {
  const models = [...new Set(typeof model === "string" ? [model] : model)].sort();
  const patterns: readonly (readonly [RegExp, string])[] = [
    [/mcp__(?:flywheel|runtime)__/g, ""],
    [/<system-reminder>[\s\S]*?<\/system-reminder>/g, ""],
    [/\bClaude Code\b/gi, "<agent>"],
    [/\[Workflow harness[^\]]*\]/g, ""],
    ...models.map((name) => [new RegExp(modelNamePattern(name), "gi"), "<model>"] as const),
  ];
  return {
    identity: structuredIdentity({ patterns: patterns.map(([pattern, replacement]) => [pattern.source, pattern.flags, replacement]) }),
    redact: (text) => patterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text),
  };
}

/** The redaction of a coding task's judge. It also hides the paths and names of each arm's own workflow
 *  mechanism, which a report can mention: a workflow file's extension, the Flywheel session folder, and the session
 *  scratch folder. */
export function codingRedaction(model: string | readonly string[]): Redaction {
  const base = comparisonRedaction(model);
  const patterns: readonly (readonly [RegExp, string])[] = [
    [/[\w./-]*\.workflow\.(?:ya?ml|js)\b/g, "<workflow file>"],
    [/[\w./-]*\.flywheel\/[^\s)`'"]*/g, "<session path>"],
    [/[\w./-]*\bscratch\/[^\s)`'"]*/g, "<scratch path>"],
    [/\bmcp__\w+/g, "<tool>"],
  ];
  return {
    identity: structuredIdentity({ base: base.identity, patterns: patterns.map(([pattern, replacement]) => [pattern.source, pattern.flags, replacement]) }),
    redact: (text) => patterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), base.redact(text)),
  };
}

/** Inspect raw Git section headers before path redaction removes their identity. */
function withoutWorkflowSources(diff: string): string {
  return diff.split(/(?=^diff --git )/m).filter((section) => {
    const header = section.split("\n", 1)[0] ?? "";
    return !/\.workflow\.(?:ya?ml|js)(?=["\s]|$)|(?:^|[ /])(?:\.flywheel|scratch)\/|bench\/chat-ab\/workflow-authorship\/handcrafted\//.test(header);
  }).join("");
}

/** Only reports receive label blinding. A common word needs an explicit workflow reference. */
function redactWorkflowReport(report: string, references: { readonly ids: readonly string[]; readonly labels: readonly string[] }): string {
  const ids = new Set(references.ids);
  const labels = [...new Set([...ids, ...references.labels])].filter(Boolean).sort((a, b) => b.length - a.length);
  const patterns = labels.map((label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return ids.has(label) || /[\s-]/.test(label)
      ? new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "gi")
      : new RegExp(`\\b(?:workflow|phase|agent)\\s+\\\\?(["'])${escaped}\\\\?\\1|\`${escaped}\``, "gi");
  });
  return report.split(/(```[\s\S]*?```|`[^`\n]+`)/g).map((part) => {
    if (part.startsWith("```") || (part.startsWith("`") && !labels.some((label) => label.toLowerCase() === part.slice(1, -1).toLowerCase()))) return part;
    return patterns.reduce((text, pattern) => text.replace(pattern, "<workflow label>"), part);
  }).join("");
}

function clipped(report: string | null): string {
  if (report === null || !report.trim()) return "(no report: the run wrote no final reply)";
  return report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}\n[report truncated]` : report;
}

/** What the judge compares: two audit reports against the reference fix, two code changes (a coding task of
 *  test 3), each with its final report, against the task's reference patch, two answers to a question
 *  that asks for no change against a written reference answer, or two implementation plans against the
 *  task's known requirements. */
type JudgeMode = "reports" | "changes" | "answers" | "plans";

const ANSWER_JUDGE_INSTRUCTIONS = [
  "You are a staff engineer judging two answers written for the same request in the Flywheel repository (TypeScript on Bun). The request asks for analysis, not for a change. You do not know who wrote either answer.",
  "",
  "Judge in this order of importance:",
  "1. Correctness: each claim about the code is true, and each file:line reference points at code that supports its claim. Penalize each claim or reference that does not hold.",
  "2. Coverage: the answer does all that the request asks, and covers the points that the reference answer shows to matter.",
  "3. Usefulness: a reader can act on the answer because it is specific and has no padding.",
  "",
  "The reference answer below is one known-good answer. Use it to check claims and to see what matters. An answer that differs from the reference but is equally correct and complete is equally good. Do not reward similarity to the reference for its own sake.",
  "Allow a tie only when the two answers are of genuinely equal quality.",
].join("\n");

const PLAN_JUDGE_INSTRUCTIONS = [
  "You are a staff engineer judging two implementation plans written for the same request. You do not know who wrote either plan. You cannot read the repository; the known requirements below were verified against it.",
  "",
  "Judge in this order of importance:",
  "1. Grounding: a plan that meets the known requirements is better. A plan that repeats a false premise of the request, or relies on a file, symbol, or behavior that the requirements contradict, is worse.",
  "2. Structure: milestones in dependency order, each with the concrete files it changes and the narrowest command that verifies it.",
  "3. Elegance: one source of truth and direct use of existing primitives, with no speculative layers.",
  "4. Concision: penalize padded phases, repeated instructions, and boilerplate.",
  "",
  "Use the known requirements only to check grounding. A plan that meets a requirement in different words meets it. Do not infer who wrote a plan from its style.",
  "Allow a tie only when the two plans are of genuinely equal quality.",
].join("\n");

/** Each mode's prompt text. The reports, changes, and answers text is unchanged since recorded campaigns were judged. */
const MODE_TEXT = {
  reports: {
    instructions: REPORT_JUDGE_INSTRUCTIONS, what: "audit reports", items: "reports", referenceName: "reference fix",
    reference: "## Reference fix (one real bug, for intent only)", slot: "REPORT",
    correct: "correctX is yes when report X names the real bug of the reference with evidence that holds, partial when it names its site without evidence that holds, and no otherwise.",
    refute: "Refute the verdict only when the rationale relies on a finding that is not real, misses a real finding that reverses the order, or prefers the weaker report. Otherwise uphold it.",
  },
  changes: {
    instructions: PAIR_JUDGE_INSTRUCTIONS, what: "candidate changes, each with its final report", items: "changes", referenceName: "reference fix",
    reference: "## Reference fix (known correct, for intent only)", slot: "CHANGE",
    correct: "correctX is yes when change X fixes the reported problem on every path the request covers and breaks nothing, partial when it fixes part of it, and no otherwise.",
    refute: "Refute the verdict only when the rationale relies on a claim about a change that is not true, misses a defect that reverses the order, or prefers the weaker change. Otherwise uphold it.",
  },
  answers: {
    instructions: ANSWER_JUDGE_INSTRUCTIONS, what: "answers", items: "answers", referenceName: "reference answer",
    reference: "## Reference answer (known good, for checking claims only)", slot: "ANSWER",
    correct: "correctX is yes when answer X does what the request asks and its claims hold, partial when it does part of it or one of its claims does not hold, and no otherwise.",
    refute: "Refute the verdict only when the rationale relies on a claim about an answer that is not true, misses an error that reverses the order, or prefers the weaker answer. Otherwise uphold it.",
  },
  plans: {
    instructions: PLAN_JUDGE_INSTRUCTIONS, what: "implementation plans", items: "plans", referenceName: "known requirements",
    reference: "## Known requirements (verified against the repository, for checking grounding only)", slot: "PLAN",
    correct: "correctX is yes when plan X would deliver the request, meets the known requirements, and repeats no false premise, partial when it misses part of that, and no otherwise.",
    refute: "Refute the verdict only when the rationale relies on a claim about a plan that is not true, misses a grounding error that reverses the order, or prefers the weaker plan. Otherwise uphold it.",
  },
} as const;

function pairPrompt(mode: JudgeMode, request: string, reference: string, slotA: string, slotB: string): string {
  const text = MODE_TEXT[mode];
  return [
    text.instructions, "",
    "## Request", request, "",
    text.reference, reference, "",
    `## ${text.slot} A`, slotA, "",
    `## ${text.slot} B`, slotB, "",
    "Respond with only one JSON object on one line:",
    `{"correctA":"yes"|"partial"|"no","correctB":"yes"|"partial"|"no","winner":"A"|"B"|"tie","rationale":"At most three sentences naming the deciding difference."}`,
    text.correct,
  ].join("\n");
}

function refutationPrompt(mode: JudgeMode, request: string, reference: string, slotA: string, slotB: string, verdict: Verdict): string {
  const text = MODE_TEXT[mode];
  return [
    `You are a second staff engineer. A first judge compared two ${text.what} written for one request in the Flywheel repository (TypeScript on Bun) and chose a winner. Try to refute that verdict: check each claim that the rationale relies on against the ${text.referenceName} and the two ${text.items}.`,
    text.refute,
    "",
    "## Request", request, "",
    text.reference, reference, "",
    `## ${text.slot} A`, slotA, "",
    `## ${text.slot} B`, slotB, "",
    "## Verdict", JSON.stringify(verdict), "",
    "Respond with only one JSON object on one line:",
    `{"refuted":true|false,"reason":"At most three sentences."}`,
  ].join("\n");
}

const MAX_DIFF_CHARS = 120_000;

/** One change as the judge reads it: the diff, then the final report. */
function changeText(diff: string, report: string | null): string {
  const shown = !diff.trim() ? "(empty diff: no change was made)" : diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
  return `### Diff\n${shown}\n\n### Final report\n${clipped(report)}`;
}

/** One judge call: its parsed answer, or why it has none, and its estimated cost. */
interface Call<Value> {
  readonly value: Value | null;
  readonly error: string | null;
  readonly usd: number | null;
}

async function call<Value>(judge: ChatAbJudge, prompt: string, decode: (value: unknown) => Value): Promise<Call<Value>> {
  const settlement = await completeJudge(judge.model, prompt, JUDGE_TIMEOUT_MS);
  const usd = settlement.accounting.estimatedUsd.kind === "observed" ? settlement.accounting.estimatedUsd.value : null;
  if (settlement.error !== null) return { value: null, error: settlement.error, usd };
  try {
    return { value: decode(JSON.parse(/\{[\s\S]*\}/.exec(settlement.value)?.[0] ?? "")), error: null, usd };
  } catch (cause) {
    return { value: null, error: `unparsable answer: ${cause instanceof Error ? cause.message : String(cause)}`, usd };
  }
}

/** One slot order's verdict, in the arms' names, and the adversarial pass over it. */
interface OrderVerdict<Arm extends string = ComparisonArm> {
  /** Which arm sat in slot A. */
  readonly slotA: Arm;
  readonly winner: Arm | "tie" | null;
  /** Keyed by arm; the judge ledger schema requires exactly the two slot arms. */
  readonly correct: { readonly [arm: string]: Verdict["correctA"] } | null;
  readonly rationale: string | null;
  readonly error: string | null;
  /** The adversarial pass: null when the verdict named no winner, so there was nothing to refute. */
  readonly refutation: { readonly refuted: boolean | null; readonly reason: string | null; readonly error: string | null } | null;
}

/** The block's verdict: the winner that both slot orders name and no refutation overturned, or a tie. A call that
 *  failed leaves the block unjudged (null). */
function settleVerdict<Arm extends string>(orders: readonly OrderVerdict<Arm>[]): Arm | "tie" | null {
  if (orders.some((order) => order.winner === null || order.refutation?.refuted === null)) return null;
  const winners = orders.map((order) => order.refutation?.refuted ? "tie" : order.winner);
  return winners.every((winner) => winner === winners[0]) ? winners[0]! : "tie";
}

/** For each arm, whether its report names each shipped bug site (workflow-audit-tests.ts, namesShippedSite), keyed
 *  `<path>:<first>-<last>`. */
type SiteChecks = { readonly [arm: string]: { readonly [site: string]: boolean } };

function shippedSiteChecks<Arm extends string>(reports: { readonly [arm in Arm]: string | null }): SiteChecks {
  const check = (report: string | null) => Object.fromEntries(SHIPPED_SITES.map((site) => [`${site.path}:${site.lines[0]}-${site.lines[1]}`, report !== null && namesShippedSite(report, site)]));
  return Object.fromEntries(Object.entries<string | null>(reports).map(([arm, report]) => [arm, check(report)]));
}

export interface BlockJudgement<Arm extends string = ComparisonArm> {
  readonly test: string;
  readonly repeat: number;
  readonly orders: readonly OrderVerdict<Arm>[];
  readonly winner: Arm | "tie" | null;
  readonly sites: SiteChecks;
  readonly usd: number | null;
}

export interface JudgeJob<Arm extends string = ComparisonArm> {
  readonly test: string;
  readonly repeat: number;
  readonly task: string;
  readonly request: string;
  readonly reports: { readonly [arm in Arm]: string | null };
  /** Each arm's final diff. With it, the judge compares the two changes, each with its report, against
   *  `reference`, and makes no shipped-site check. */
  readonly changes?: { readonly [arm in Arm]: string };
  /** The reference fix, which replaces the task's reference.patch. */
  readonly reference?: string;
  /** A written reference answer to a question that asks for no change. With it, the judge compares the two
   *  reports as answers against this text, and makes no shipped-site check. */
  readonly referenceAnswer?: string;
  /** The task's known requirements. With them, the judge compares the two reports as implementation plans
   *  against this text, and makes no shipped-site check. */
  readonly requirements?: string;
  /** Per-cell declared workflow, phase, and agent labels. Never applied to task or reference code. */
  readonly workflowReferences?: { readonly [arm in Arm]: { readonly ids: readonly string[]; readonly labels: readonly string[] } };
}

/** Judges every block, each in both slot orders, with the adversarial pass over each verdict that names a winner. */
export async function judgeBlocks<Arm extends string>(judge: ChatAbJudge, redaction: Redaction, jobs: readonly JudgeJob<Arm>[], arms: readonly [Arm, Arm]): Promise<BlockJudgement<Arm>[]> {
  const judged: BlockJudgement<Arm>[] = [];
  const references = new Map<string, Promise<string>>();
  await eachJudgeJob(jobs, async (job) => {
    const mode: JudgeMode = job.changes !== undefined ? "changes" : job.referenceAnswer !== undefined ? "answers" : job.requirements !== undefined ? "plans" : "reports";
    const written = job.referenceAnswer ?? job.requirements ?? job.reference;
    if (written === undefined && !references.has(job.task)) references.set(job.task, referenceFix(job.task, redaction));
    const reference = written === undefined ? await references.get(job.task)! : redaction.redact(written);
    const request = redaction.redact(job.request);
    const slotText = (arm: Arm) => {
      const workflowReferences = job.workflowReferences?.[arm];
      const report = workflowReferences ? redactWorkflowReport(clipped(job.reports[arm]), workflowReferences) : clipped(job.reports[arm]);
      const diff = job.changes?.[arm];
      return redaction.redact(diff === undefined ? report : changeText(references ? withoutWorkflowSources(diff) : diff, report));
    };
    const costs: (number | null)[] = [];
    const orders: OrderVerdict<Arm>[] = [];
    for (const slotA of arms) {
      const slotB = slotA === arms[0] ? arms[1] : arms[0];
      const [reportA, reportB] = [slotText(slotA), slotText(slotB)];
      const verdict = await call(judge, redaction.redact(pairPrompt(mode, request, reference, reportA, reportB)), decodeVerdict);
      costs.push(verdict.usd);
      const name = (slot: Verdict["winner"]) => slot === "A" ? slotA : slot === "B" ? slotB : "tie";
      let refutation: OrderVerdict<Arm>["refutation"] = null;
      if (verdict.value !== null && verdict.value.winner !== "tie") {
        const answer = await call(judge, redaction.redact(refutationPrompt(mode, request, reference, reportA, reportB, verdict.value)), decodeRefutation);
        costs.push(answer.usd);
        refutation = { refuted: answer.value?.refuted ?? null, reason: answer.value?.reason ?? null, error: answer.error };
      }
      orders.push({
        slotA,
        winner: verdict.value === null ? null : name(verdict.value.winner),
        correct: verdict.value === null ? null : { [slotA]: verdict.value.correctA, [slotB]: verdict.value.correctB },
        rationale: verdict.value?.rationale ?? null,
        error: verdict.error,
        refutation,
      });
    }
    judged.push({
      test: job.test,
      repeat: job.repeat,
      orders,
      winner: settleVerdict(orders),
      sites: mode === "reports" ? shippedSiteChecks(job.reports) : Object.fromEntries(arms.map((arm) => [arm, {}])),
      usd: costs.some((cost) => cost === null) ? null : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0),
    });
  });
  return judged.sort((left, right) => left.test.localeCompare(right.test) || left.repeat - right.repeat);
}
