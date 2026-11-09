import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isJsonMap, isMissingFile } from "./analysis/json.js";
import { harborBenchmark } from "./benchmarks.js";

/** Why a run belongs to its round: a measurement of one split, or a rerun of
 *  trials that infrastructure or a lost grader left unscored. */
export type RoundRunPurpose = "measure" | "rerun";

export interface RoundRun {
  /** The absolute path of the run's artifact directory. */
  readonly directory: string;
  readonly purpose: RoundRunPurpose;
  /** The split that a measurement run measures; absent for a rerun. */
  readonly split?: string;
}

/** What every run of one round shares, so that its pooled score measures one
 *  setup: the Flywheel commit the agent package is built from, the arm
 *  config by its repository path and digest, and the chat model and effort
 *  that the arm pins. A code or arm change starts a new round. */
export interface RoundIdentity {
  readonly sourceCommit: string;
  readonly arm: { readonly path: string; readonly sha256: string };
  readonly model: string;
  readonly effort: string;
}

/** One hill-climb round: every run whose scored attempts pool into one score
 *  of one arm on one benchmark. The benchmark's splits decide which split a
 *  task belongs to, so a rerun adds attempts to its tasks wherever they are. */
export interface Round {
  readonly name: string;
  readonly benchmark: string;
  /** Set by the round's first run. A round recorded before rounds had an
   *  identity has none, and its next run sets it. */
  readonly identity?: RoundIdentity;
  readonly runs: readonly RoundRun[];
}

/** The manifest outcomes of a run that ended before Harbor ran any trial:
 *  its snapshot export failed, or Hub refused its dry run or its launch.
 *  Such a run measured nothing, so rerun planning counts no attempt of it. */
export const UNLAUNCHED_OUTCOMES = ["snapshot_failed", "hub_dry_run_refused", "hub_launch_refused"] as const;
export type UnlaunchedOutcome = (typeof UNLAUNCHED_OUTCOMES)[number];

/** How long an append waits for another process's append to the same round. */
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 20;

/** The path of a round's record, `<jobsDirectory>/rounds/<name>.json`. */
export function roundPath(jobsDirectory: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`round name ${name} must be a lowercase slug`);
  return join(resolve(jobsDirectory), "rounds", `${name}.json`);
}

function decodeIdentity(value: unknown, fail: (problem: string) => never): RoundIdentity {
  if (!isJsonMap(value) || !isJsonMap(value.arm)) return fail("identity must be an object with an arm");
  const { sourceCommit, model, effort } = value;
  const { path, sha256 } = value.arm;
  if (typeof sourceCommit !== "string" || typeof model !== "string" || typeof effort !== "string" || typeof path !== "string" || typeof sha256 !== "string") return fail("identity needs sourceCommit, arm.path, arm.sha256, model, and effort strings");
  return { sourceCommit, arm: { path, sha256 }, model, effort };
}

function decodeRound(value: unknown, path: string): Round {
  const fail = (problem: string): never => { throw new Error(`${path}: ${problem}`); };
  if (!isJsonMap(value)) return fail("a round must be an object");
  const record = value;
  if (typeof record.name !== "string") return fail("name must be a string");
  if (typeof record.benchmark !== "string") return fail("benchmark must be a string");
  harborBenchmark(record.benchmark);
  if (!Array.isArray(record.runs)) return fail("runs must be a list");
  const runs = record.runs.map((run: unknown, index): RoundRun => {
    if (!isJsonMap(run)) return fail(`runs[${index}] must be an object`);
    const { directory, purpose, split } = run;
    if (typeof directory !== "string" || !isAbsolute(directory)) return fail(`runs[${index}].directory must be an absolute path`);
    if (purpose !== "measure" && purpose !== "rerun") return fail(`runs[${index}].purpose must be measure or rerun`);
    if (purpose === "measure" && typeof split !== "string") return fail(`runs[${index}] measures no split`);
    if (purpose === "rerun" && split !== undefined) return fail(`runs[${index}] is a rerun and names a split`);
    return { directory, purpose, ...(typeof split === "string" ? { split } : {}) };
  });
  return { name: record.name, benchmark: record.benchmark, ...(record.identity === undefined ? {} : { identity: decodeIdentity(record.identity, fail) }), runs };
}

/** Reads a round record and refuses one that is malformed or names an unknown benchmark. */
export async function readRound(path: string): Promise<Round> {
  return decodeRound(JSON.parse(await readFile(path, "utf8")), path);
}

async function readOptionalRound(path: string): Promise<Round | undefined> {
  return readRound(path).catch((error: unknown) => {
    if (isMissingFile(error)) return undefined;
    throw error;
  });
}

/** Throws, naming the recorded and the offered value, when `round` holds
 *  another benchmark or another identity. */
function refuseOtherSetup(round: Round | undefined, benchmark: string, identity: RoundIdentity): void {
  if (round === undefined) return;
  const differences: [string, string, string][] = [["", round.benchmark, benchmark]];
  if (round.identity !== undefined) {
    differences.push(["source commit ", round.identity.sourceCommit, identity.sourceCommit], ["arm sha256 ", round.identity.arm.sha256, identity.arm.sha256], ["model ", round.identity.model, identity.model], ["effort ", round.identity.effort, identity.effort]);
  }
  for (const [what, held, offered] of differences) {
    if (held !== offered) throw new Error(`round ${round.name} holds ${what}${held}, not ${offered}; a round measures one benchmark, commit, and arm, so start a new round`);
  }
}

/** Refuses, before any paid work, a run that would join a round of another
 *  benchmark or identity. A missing round admits any run. */
export async function requireRoundIdentity(jobsDirectory: string, name: string, benchmark: string, identity: RoundIdentity): Promise<void> {
  refuseOtherSetup(await readOptionalRound(roundPath(jobsDirectory, name)), benchmark, identity);
}

/** Holds `<round>.json.lock` while `work` runs. A launcher of each split can
 *  join one round at the same time, and the lock makes their
 *  read-modify-write appends take turns. */
async function withRoundLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(lock, "wx");
      await handle.close();
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() >= deadline) throw new Error(`round lock ${lock} was held for ${LOCK_WAIT_MS / 1000} seconds; if no launcher is joining the round, remove it`);
      await Bun.sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

/** Adds one run to a round, and creates the round on its first run, which
 *  sets the round's identity. A run of another benchmark or identity is
 *  refused; a round without an identity takes the run's. The record is
 *  replaced by rename under the round lock, so concurrent appends all land
 *  and a reader never sees half of it. */
export async function appendRoundRun(jobsDirectory: string, name: string, benchmark: string, run: RoundRun, identity: RoundIdentity): Promise<Round> {
  harborBenchmark(benchmark);
  const path = roundPath(jobsDirectory, name);
  await mkdir(dirname(path), { recursive: true });
  return withRoundLock(path, async () => {
    const existing = await readOptionalRound(path);
    refuseOtherSetup(existing, benchmark, identity);
    if (existing?.runs.some((recorded) => recorded.directory === run.directory)) throw new Error(`round ${name} already holds ${run.directory}`);
    const round = decodeRound({ name, benchmark, identity, runs: [...(existing?.runs ?? []), run] }, path);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(round, null, 2)}\n`);
    await rename(temporary, path);
    return round;
  });
}
