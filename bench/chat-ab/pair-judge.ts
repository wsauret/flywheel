// The pinned chat-ab judge and its pairwise call, shared by the comparison of
// two campaigns (compare.ts) and the absolute scorer (score.ts), which admits
// the same judge. A pairwise call reads the request, the fix that shipped (as a
// statement of intent only), and two redacted changes under the neutral
// labels A and B, each with its final handoff when it has one.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import type { OwnedCommandRunner } from "../../src/infra/owned-command.js";
import { admitBenchmark } from "../../src/orchestration/modules/development/benchmark/admission.js";
import { completeJudge, type JudgeModel } from "../../src/orchestration/modules/development/benchmark/judge.js";
import { createBenchmarkRuntime } from "../shared/runtime.js";
import { REPO_ROOT, TASKS_DIR } from "./harness-paths.js";
import { CHAT_AB_JUDGE, type Redaction, type RunInputs } from "./judge-inputs.js";
import { taskReference } from "./tasks.js";

/** How many judge calls run at once. */
const JUDGE_CONCURRENCY = 3;
const JUDGE_TIMEOUT_MS = 600_000;
const MAX_REFERENCE_CHARS = 80_000;
/** A reference commit that mixes unrelated work names the files that hold the fix. */
const REFERENCE_PATHS = new Map([
  ["provider-chain-fix", ["flywheel-tui/src/infra/session-notice.ts", "flywheel-tui/src/orchestration/agent-runtime/llm/anthropic.ts", "flywheel-tui/src/orchestration/agent-runtime/llm/openai-completions.ts", "flywheel-tui/src/orchestration/agent-runtime/llm/openai.ts", "flywheel-tui/src/orchestration/agent-runtime/llm/provider-availability.ts", "flywheel-tui/src/orchestration/agent-runtime/llm/provider-chain-client.ts"]],
]);

export const PAIR_JUDGE_INSTRUCTIONS = [
  "You are a staff engineer judging two candidate changes made for the same request in the Flywheel repository (TypeScript on Bun). You do not know who wrote either change.",
  "",
  "Judge in this order of importance:",
  "1. Correctness: the change fixes the reported problem on every path the request covers, and breaks nothing. A change that misses a path, or removes or weakens existing behavior (a repair path, a guard, a passing test), is worse than a change that does less but breaks nothing.",
  "2. Scope: penalize behavior changes the request did not ask for.",
  "3. Tests: reward a test that fails before the change and passes after it, at a boundary a user would observe.",
  "4. Engineering quality: the smallest correct change that matches the existing conventions.",
  "",
  "The reference fix below is one known-correct fix that shipped. Use it to understand the intent and the code paths involved. A different design that is equally correct is equally good. Do not reward similarity to the reference for its own sake.",
  "When a change comes with its final handoff, the report of the work, use the handoff only to check honesty: a handoff that claims a test or a verification the diff does not contain makes its change worse.",
  "Allow a tie only when the two changes are of genuinely equal quality.",
].join("\n");

const CorrectSchema = Schema.Literals(["yes", "partial", "no"]);
export const VerdictSchema = Schema.Struct({ correctA: CorrectSchema, correctB: CorrectSchema, winner: Schema.Literals(["A", "B", "tie"]), rationale: Schema.String });
type Verdict = typeof VerdictSchema.Type;
const decodeVerdict = Schema.decodeUnknownSync(VerdictSchema);

/** The admitted judge, with the runner its calls read the reference fix through. */
export interface ChatAbJudge extends AsyncDisposable {
  readonly model: JudgeModel;
  readonly run: OwnedCommandRunner;
  readonly profileId?: string;
  readonly authorityIncarnation?: string;
}

/** Admits the pinned judge on `authProfile`. Disposing it ends the runtime it runs on. */
export async function admitChatAbJudge(authProfile: string, validateModel?: (model: string) => void, evidenceDirectory?: string): Promise<ChatAbJudge> {
  const runtime = await createBenchmarkRuntime(REPO_ROOT, { authProfile });
  try {
    const admission = await admitBenchmark({
      ...runtime.deps,
      profileId: runtime.profileId,
      authorityIncarnation: runtime.usageAuthority.authorityIncarnation,
      launcher: runtime.launcher,
      background: runtime.background,
      foregroundBashHold: runtime.foregroundBashHold,
      shell: runtime.shell,
    }, [{ role: "judge", ...CHAT_AB_JUDGE }]);
    const model = await admission.createJudge(CHAT_AB_JUDGE.model, "", CHAT_AB_JUDGE.effort, evidenceDirectory, validateModel);
    return { model, run: runtime.runOwnedCommand, profileId: runtime.profileId, authorityIncarnation: runtime.usageAuthority.authorityIncarnation, [Symbol.asyncDispose]: () => runtime[Symbol.asyncDispose]() };
  } catch (cause) {
    await runtime[Symbol.asyncDispose]();
    throw cause;
  }
}

/** Reads and redacts reference.patch when present, or the shipped fix from WHY.md without docs or benchmark churn. */
export async function referenceFix(task: string, run: OwnedCommandRunner, redaction: Redaction, tasksDir = TASKS_DIR): Promise<string> {
  const reference = await taskReference({ id: task, taskDir: join(tasksDir, task) });
  let diff: string;
  if (reference.kind === "patch") diff = await readFile(reference.path, "utf8");
  else {
    const paths = REFERENCE_PATHS.get(task);
    const shown = await run(["git", "-C", REPO_ROOT, "show", "--format=%s%n", reference.commit, "--", ...(paths ?? [".", ":(exclude)docs", ":(exclude)bench"])], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 60_000 });
    if (shown.exitCode !== 0 || shown.stdoutTruncated) throw new Error(`git show ${reference.commit} failed for ${task}: exit code ${shown.exitCode}`);
    diff = shown.stdout;
  }
  return redaction.redact(diff.length > MAX_REFERENCE_CHARS ? `${diff.slice(0, MAX_REFERENCE_CHARS)}\n[reference truncated]` : diff);
}

function pairPrompt(reference: string, slotA: RunInputs, slotB: RunInputs): string {
  const change = (label: string, inputs: RunInputs) => [`## CHANGE ${label}`, inputs.diff, "", ...(inputs.handoff === undefined ? [] : [`## CHANGE ${label}: final handoff`, inputs.handoff, ""])];
  return [
    PAIR_JUDGE_INSTRUCTIONS, "",
    "## Request", slotA.request, "",
    "## Reference fix (known correct, for intent only)", reference, "",
    ...change("A", slotA),
    ...change("B", slotB),
    "Respond with only one JSON object on one line:",
    `{"correctA":"yes"|"partial"|"no","correctB":"yes"|"partial"|"no","winner":"A"|"B"|"tie","rationale":"At most three sentences naming the deciding difference."}`,
  ].join("\n");
}

/** One pairwise call: its verdict, or why it has none, and its estimated cost. */
export interface PairCall {
  readonly verdict: Verdict | null;
  readonly error: string | null;
  readonly usd: number | null;
}

/** Asks the judge which of two changes for `task` is better. A reply that does not parse is an error, not a verdict. */
export async function judgePair(judge: ChatAbJudge, task: string, redaction: Redaction, slotA: RunInputs, slotB: RunInputs): Promise<PairCall> {
  const settlement = await completeJudge(judge.model, redaction.redact(pairPrompt(await referenceFix(task, judge.run, redaction), slotA, slotB)), JUDGE_TIMEOUT_MS);
  const usd = settlement.accounting.estimatedUsd.kind === "observed" ? settlement.accounting.estimatedUsd.value : null;
  if (settlement.error !== null) return { verdict: null, error: settlement.error, usd };
  try {
    return { verdict: decodeVerdict(JSON.parse(/\{[\s\S]*\}/.exec(settlement.value)?.[0] ?? "")), error: null, usd };
  } catch (cause) {
    return { verdict: null, error: `unparsable verdict: ${cause instanceof Error ? cause.message : String(cause)}`, usd };
  }
}

/** Runs `work` over `jobs` with JUDGE_CONCURRENCY workers. */
export async function eachJudgeJob<Job>(jobs: readonly Job[], work: (job: Job) => Promise<void>): Promise<void> {
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) await work(job);
  };
  await Promise.all(Array.from({ length: JUDGE_CONCURRENCY }, () => worker()));
}
