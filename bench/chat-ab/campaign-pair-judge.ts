import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Schema } from "effect";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { BenchmarkAccountingSchema } from "../../src/orchestration/modules/development/benchmark/evidence.js";
import { JudgeCallFailure, unavailableJudgeAccounting, type JudgeModel } from "../../src/orchestration/modules/development/benchmark/judge.js";
import { createJsonLinesLedger, writeArtifactFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { judgeBlocks, type BlockJudgement, type JudgeJob } from "./block-judge.js";
import type { CampaignExecutionOutcome } from "./campaign-store.js";
import type { Redaction } from "./judge-inputs.js";
import type { compareCampaignRoles } from "./campaign-role-evidence.js";
import { renderCampaignRoleChanges } from "../../src/orchestration/modules/development/benchmark/campaign-role-changes.js";
import { admitChatAbJudge, type ChatAbJudge } from "./pair-judge.js";

function judgeSchemas<Arm extends string>(arms: readonly Arm[]) {
  const Text = Schema.NonEmptyString;
  const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
  const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
  const StartSchema = Schema.Struct({ kind: Schema.Literal("pair"), id: Text, at: Text, pair: Text, identity: Hash, profileId: Text, authorityIncarnation: Text });
  const CallSchema = Schema.Struct({ kind: Schema.Literal("call"), id: Text, at: Text, pairAttempt: Text, promptHash: Hash });
  const SettlementSchema = Schema.Struct({ kind: Schema.Literal("settlement"), id: Text, at: Text, text: Schema.String, error: Schema.NullOr(Schema.String), accounting: BenchmarkAccountingSchema });
  const ArmSchema = Schema.Literals(arms);
  const Winner = Schema.NullOr(Schema.Literals([...arms, "tie" as const]));
  const Correct = Schema.Literals(["yes", "partial", "no"]);
  const OrderSchema = Schema.Struct({
    slotA: ArmSchema, winner: Winner,
    correct: Schema.NullOr(Schema.Record(ArmSchema, Correct)),
    rationale: Schema.NullOr(Schema.String), error: Schema.NullOr(Schema.String),
    refutation: Schema.NullOr(Schema.Struct({ refuted: Schema.NullOr(Schema.Boolean), reason: Schema.NullOr(Schema.String), error: Schema.NullOr(Schema.String) })),
  });
  const ResultSchema = Schema.Struct({
    kind: Schema.Literal("verdict"), at: Text, pairAttempt: Text, calls: Schema.Array(Text),
    result: Schema.Struct({
      test: Text, repeat: Count, orders: Schema.Array(OrderSchema), winner: Winner,
      sites: Schema.Record(ArmSchema, Schema.Record(Schema.String, Schema.Boolean)),
      usd: Schema.NullOr(Schema.Number),
    }),
  });
  const EventSchema = Schema.Union([StartSchema, CallSchema, SettlementSchema, ResultSchema]);
  return { StartSchema, CallSchema, SettlementSchema, ResultSchema, EventSchema };
}
const hash = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export interface CampaignJudgeOptions {
  readonly directory: string;
  readonly a: string;
  readonly b: string;
  readonly authProfile: string;
  readonly dryRun?: boolean;
  /** The completed campaign directory whose treatment b is paired with treatment a of `directory`. */
  readonly baseline?: string;
}

/** The injectable admission seam uses the same tool-free shared judge as production. */
export interface CampaignJudgeDependencies {
  readonly admit?: (authProfile: string) => Promise<ChatAbJudge>;
}

/** Shared paid-call ledger for campaign pairs. Slot ids are independent of subject kind and treatment labels. */
export async function judgeCampaignPairs<Arm extends string>(options: CampaignJudgeOptions, input: {
  readonly jobs: ReadonlyMap<string, { job: JudgeJob<Arm>; identity: string }>;
  readonly skipped: readonly { task: string; repeat: number; reason: string }[];
  readonly redaction: Redaction;
  readonly arms: readonly [Arm, Arm];
  readonly accounting: readonly CampaignExecutionOutcome["accounting"][];
  readonly roleComparisons?: readonly Awaited<ReturnType<typeof compareCampaignRoles>>[];
  /** The campaign identity of `options.baseline`. It keys a ledger apart from a same-campaign judge of the same labels. */
  readonly baselineIdentity?: string;
}, dependencies: CampaignJudgeDependencies = {}) {
  const { directory, a, b, authProfile } = options;
  const { jobs, skipped, redaction, arms } = input;
  const { StartSchema, CallSchema, SettlementSchema, ResultSchema, EventSchema } = judgeSchemas(arms);
  const key = structuredIdentity(input.baselineIdentity === undefined ? [a, b] : { a, b, baseline: input.baselineIdentity });
  const ledger = createJsonLinesLedger(async () => join(directory, `judge-${key}.jsonl`), EventSchema, "reject");
  const rows = await ledger.load();
  const starts = new Map<string, typeof StartSchema.Type>();
  const calls = new Map<string, typeof CallSchema.Type>();
  const settlements = new Map<string, typeof SettlementSchema.Type>();
  const results = new Map<string, typeof ResultSchema.Type>();
  for (const row of rows) {
    if (row.kind === "pair") {
      if (starts.has(row.id) || !jobs.has(row.pair)) throw new Error("Judge pair is unknown or duplicated");
      starts.set(row.id, row);
    } else if (row.kind === "call") {
      if (calls.has(row.id) || !starts.has(row.pairAttempt) || results.has(row.pairAttempt)) throw new Error("Judge call has no open pair attempt");
      calls.set(row.id, row);
    } else if (row.kind === "settlement") {
      if (!calls.has(row.id) || settlements.has(row.id) || results.has(calls.get(row.id)!.pairAttempt)) throw new Error("Judge settlement has no open call");
      settlements.set(row.id, row);
    } else {
      const start = starts.get(row.pairAttempt);
      const owned = [...calls.values()].filter((call) => call.pairAttempt === row.pairAttempt);
      if (!start || results.has(row.pairAttempt) || structuredIdentity(owned.map(({ id }) => id)) !== structuredIdentity(row.calls) || owned.some(({ id }) => !settlements.has(id))) throw new Error("Judge verdict lacks its earlier paid calls");
      // A previous writer's prompts and verdict semantics cannot be replayed by changed judge code.
      if (start.identity !== jobs.get(start.pair)!.identity) {
        results.set(row.pairAttempt, row);
        continue;
      }
      let cursor = 0;
      let invalidPrompt = false;
      const replay: JudgeModel = { async complete(prompt) {
        const call = owned[cursor++];
        if (!call || call.promptHash !== hash(prompt)) {
          invalidPrompt = true;
          throw new Error("Stored judge prompt does not match");
        }
        const settlement = settlements.get(call.id)!;
        if (settlement.error !== null) throw new JudgeCallFailure(settlement.accounting, settlement.error);
        return { text: settlement.text, accounting: settlement.accounting };
      } };
      const [result] = await judgeBlocks({ model: replay, [Symbol.asyncDispose]: async () => {} }, redaction, [jobs.get(start.pair)!.job], arms);
      if (invalidPrompt || cursor !== owned.length || structuredIdentity(result) !== structuredIdentity(row.result)) throw new Error("Judge verdict disagrees with paid call evidence");
      results.set(row.pairAttempt, row);
    }
  }
  // A verdict counts only for the inputs it judged. One from changed inputs, such as a changed answer or judge
  // code, stays readable history, and the pair is judged again.
  const summary = () => {
    const verdicts = new Map<string, BlockJudgement<Arm>>();
    for (const [id, row] of results) {
      const start = starts.get(id)!;
      if (row.result.winner !== null && start.identity === jobs.get(start.pair)!.identity) verdicts.set(start.pair, row.result);
    }
    const costs = [...settlements.values()].flatMap(({ accounting: { estimatedUsd } }) => estimatedUsd.kind === "observed" ? [estimatedUsd.value] : []);
    const count = (winner: Arm | "tie") => [...verdicts.values()].filter((verdict) => verdict.winner === winner).length;
    return {
      pairs: jobs.size, skipped, pending: jobs.size - verdicts.size, judged: verdicts.size,
      // Slot winners mapped to treatment ids, which stay apart when a baseline treatment shares a's label.
      summary: {
        a: { campaign: directory, treatment: a, wins: count(arms[0]) },
        b: { campaign: options.baseline ?? directory, treatment: b, wins: count(arms[1]) },
        ties: count("tie"), unjudged: jobs.size - verdicts.size,
        // Judge spend over every recorded call, retries included; null when any call's spend is unavailable.
        usd: costs.length === calls.size ? costs.reduce((total, cost) => total + cost, 0) : null,
      },
      roleComparisons: input.roleComparisons ?? [],
      roleChanges: renderCampaignRoleChanges(input.roleComparisons ?? []),
      wins: { [a]: [...verdicts.values()].filter(({ winner }) => winner === arms[0]).length, [b]: [...verdicts.values()].filter(({ winner }) => winner === arms[1]).length },
      ties: [...verdicts.values()].filter(({ winner }) => winner === "tie").length,
      taskVerdicts: [...verdicts].map(([pair, result]) => ({ pair, task: result.test, winner: result.winner })),
      unsettled: starts.size - [...results.values()].filter(({ result }) => result.winner !== null).length,
      accounting: { candidates: input.accounting, judge: [...settlements.values()].map((row) => row.accounting), unrecordedCalls: calls.size - settlements.size },
      verdicts,
      recordedJudgements: [...results].map(([id, row]) => {
        const start = starts.get(id)!;
        return { pair: start.pair, identity: start.identity, result: row.result };
      }),
    };
  };
  if (options.dryRun) {
    const { verdicts: _, ...report } = summary();
    return { ...report, authorityVerified: false };
  }
  await using judge = await (dependencies.admit ?? admitChatAbJudge)(authProfile);
  if (!judge.profileId || !judge.authorityIncarnation) throw new Error("Admitted judge has no usage authority identity");
  if ([...starts.values()].some((start) => start.profileId !== judge.profileId || start.authorityIncarnation !== judge.authorityIncarnation)) {
    throw new Error("Judge authority changed; start a new comparison directory");
  }
  const done = summary().verdicts;
  for (const [pair, { job, identity }] of jobs) {
    if (done.has(pair)) continue;
    const start: typeof StartSchema.Type = { kind: "pair", id: randomUUID(), at: new Date().toISOString(), pair, identity, profileId: judge.profileId, authorityIncarnation: judge.authorityIncarnation };
    await ledger.append(start); starts.set(start.id, start);
    const paid: string[] = [];
    let aborted = false;
    let persistenceFailure: { cause: unknown } | undefined;
    const appendEvidence = async (row: typeof CallSchema.Type | typeof SettlementSchema.Type) => {
      try { await ledger.append(row); }
      catch (cause) { persistenceFailure = { cause }; throw cause; }
    };
    const model: JudgeModel = { async complete(prompt, signal) {
      if (persistenceFailure) throw persistenceFailure.cause;
      if (aborted) throw new JudgeCallFailure(unavailableJudgeAccounting("the earlier call was aborted"), "Earlier judge call aborted");
      const call: typeof CallSchema.Type = { kind: "call", id: randomUUID(), at: new Date().toISOString(), pairAttempt: start.id, promptHash: hash(prompt) };
      await appendEvidence(call); calls.set(call.id, call); paid.push(call.id);
      let settlement: typeof SettlementSchema.Type;
      try {
        const completion = await judge.model.complete(prompt, signal);
        settlement = { kind: "settlement", id: call.id, at: new Date().toISOString(), text: completion.text, error: null, accounting: completion.accounting };
      } catch (cause) {
        settlement = { kind: "settlement", id: call.id, at: new Date().toISOString(), text: "", error: cause instanceof Error ? cause.message : String(cause), accounting: cause instanceof JudgeCallFailure ? cause.accounting : unavailableJudgeAccounting("the judge call failed before it reported usage") };
      }
      aborted ||= signal.aborted;
      await appendEvidence(settlement); settlements.set(call.id, settlement);
      if (settlement.error !== null) throw new JudgeCallFailure(settlement.accounting, settlement.error);
      return { text: settlement.text, accounting: settlement.accounting };
    } };
    const [result] = await judgeBlocks({ ...judge, model }, redaction, [job], arms);
    if (persistenceFailure) throw persistenceFailure.cause;
    if (aborted) break;
    // Decoding the new row enforces the slot-keyed maps that judgeBlocks builds with computed keys.
    const row = Schema.decodeUnknownSync(ResultSchema)({ kind: "verdict", at: new Date().toISOString(), pairAttempt: start.id, calls: paid, result: result! });
    await ledger.append(row); results.set(start.id, row);
  }
  const { verdicts: _, ...report } = summary();
  await writeArtifactFile(join(directory, `summary-${key}.json`), `${JSON.stringify(report.summary, null, 2)}\n`);
  return { ...report, authorityVerified: true };
}
