import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { completeJudge, type JudgeCallSettlement } from "../../src/orchestration/modules/development/benchmark/judge.js";
import { createJsonFile, createJsonLinesLedger, readJsonFile, writeArtifactFile, type JsonLinesLedger } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { admitChatAbJudge, eachJudgeJob } from "./pair-judge.js";

interface ScoreRun<Call> {
  readonly root: string;
  readonly reportOnly: boolean;
  readonly calls: Call[];
  readonly ledger: JsonLinesLedger<Call>;
  writeReport(report: { readonly markdown: string; readonly json: unknown }): Promise<void>;
}

/** Open a strict call ledger. Refuse identities outside the accepted list; report-only never writes. The first identity is current. */
export async function openScoreRun<Config, Call>(
  root: string, configSchema: Schema.Decoder<Config>, accepted: readonly [Config, ...Config[]],
  callSchema: Schema.Decoder<Call>, callFile: string, reportOnly: boolean,
): Promise<ScoreRun<Call>> {
  const path = join(root, "run-config.json");
  const existing = await readJsonFile(path);
  if (existing !== undefined) {
    const identity = structuredIdentity(Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" })(JSON.parse(existing)));
    if (!accepted.some(value => structuredIdentity(value) === identity)) throw new Error("Scoring identity changed; use a new score directory");
  }
  const ledger = createJsonLinesLedger(async () => join(root, callFile), callSchema, "reject");
  const calls = await ledger.load();
  if (!reportOnly) {
    await mkdir(root, { recursive: true });
    if (existing === undefined) await createJsonFile(path, `${JSON.stringify(accepted[0], null, 2)}\n`);
  }
  return {
    root, reportOnly, calls, ledger,
    async writeReport(report) {
      if (reportOnly) return;
      await writeArtifactFile(join(root, "report.md"), report.markdown);
      await writeArtifactFile(join(root, "report.json"), `${JSON.stringify(report.json, null, 2)}\n`);
    },
  };
}

/** Keep jobs without a successful call for the same identity. Failed calls remain eligible for retry. */
export function pendingScoreJobs<Job, Call extends { readonly reply: unknown | null }>(
  jobs: readonly Job[], calls: readonly Call[], jobKey: (job: Job) => string, callKey: (call: Call) => string,
): Job[] {
  const done = new Set(calls.filter(call => call.reply !== null).map(callKey));
  return jobs.filter(job => !done.has(jobKey(job)));
}

/** Admit one judge for pending jobs, parse each settlement, and retain its record and accounting before returning. */
export async function runScoreJobs<Job, Reply, Call>(
  run: ScoreRun<Call>, jobs: readonly Job[],
  options: {
    readonly authProfile: string;
    readonly validateModel: (model: string) => void;
    readonly prompt: (job: Job) => string;
    /** Decodes one reply. The job lets a decoder check the reply against the job's own inputs. */
    readonly parseReply: (text: string, job: Job) => Reply;
    readonly parseError: string;
    readonly record: (job: Job, result: { readonly reply: Reply | null; readonly error: string | null; readonly accounting: JudgeCallSettlement["accounting"] }) => Call;
  },
): Promise<void> {
  if (run.reportOnly || jobs.length === 0) return;
  await using judge = await admitChatAbJudge(options.authProfile, options.validateModel, join(run.root, "judge-requests"));
  await eachJudgeJob(jobs, async job => {
    const settlement = await completeJudge(judge.model, options.prompt(job), 600_000);
    let reply: Reply | null = null;
    let error = settlement.error;
    if (error === null) {
      try { reply = options.parseReply(settlement.value, job); } catch { error = options.parseError; }
    }
    const record = options.record(job, { reply, error, accounting: settlement.accounting });
    await run.ledger.append(record);
    run.calls.push(record);
  });
}
