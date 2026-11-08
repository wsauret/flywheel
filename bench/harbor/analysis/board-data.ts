import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { HarborBenchmark } from "../benchmarks.js";
import { finite, jsonMap, readOptionalJson, stringMap, strings, text, type JsonMap } from "./json.js";

/** The harness leaderboard's public data: its Hugging Face bucket of run
 *  records and trial facts, and the registries of its Space, whose scoring
 *  code this analysis ports. The data names harnesses; the analysis treats
 *  each name as an opaque value. */
const BUCKET = "joelniklaus/harness-leaderboard";
const SPACE = "joelniklaus/harness-leaderboard";
const HUB = "https://huggingface.co";

/** Board data is a cache, never part of the repository. */
export const BOARD_CACHE = join(homedir(), ".cache", "flywheel", "harbor-board");


/** The fields of one trial fact (`runs/<run>/<benchmark>/trials-*.jsonl`) that the board's rules read. */
export interface BoardFact {
  readonly id: string;
  readonly trial: string;
  readonly task: string;
  readonly harness: string;
  readonly runId: string;
  readonly benchmark: string;
  readonly reusedFrom: string | null;
  readonly reward: number | null;
  readonly exception: string | null;
  readonly featurebenchVerifierException: string | null;
  readonly bridgeRejection: string | null;
  readonly answerKeyReceived: boolean;
  readonly agentStarted: boolean;
  readonly agentSeconds: number | null;
  readonly meter: { readonly nCalls: number; readonly lastStatus: number | null; readonly input: number; readonly cached: number; readonly output: number } | null;
  /** The router provider that served the trial's unit, recorded since provider pools. */
  readonly provider?: string;
}

export interface BoardRun {
  readonly runId: string;
  readonly createdAt: string;
  readonly model: string;
  readonly provider: string;
  readonly stage: string;
  readonly effort: string;
  readonly harnessVersions: Readonly<Record<string, string>>;
  readonly harnessAdapters: Readonly<Record<string, string | null>>;
  readonly benchmarkSetups: Readonly<Record<string, { readonly commit?: string; readonly reference_isolation?: string } | null>>;
  readonly price: { readonly input: number; readonly cached_input: number; readonly output: number };
}

export interface InvalidRule {
  readonly harnesses?: readonly string[];
  readonly benchmarks?: readonly string[];
  readonly tasks?: readonly string[];
  readonly trials?: readonly string[];
  readonly outcome?: string;
}

/** The board's registry entry of one benchmark (Space `hlb/data/benchmarks.json`). */
interface BoardBenchmark {
  readonly commit: string;
  readonly strata: string;
  readonly subsets: Readonly<Record<string, readonly string[]>>;
  readonly taskStrata: Readonly<Record<string, string>>;
  readonly excluded: readonly string[];
  readonly unscored: boolean;
  readonly referenceIsolation?: string;
}

interface BoardHarness { readonly version: string; readonly publicVersion?: string; readonly adapter?: string; readonly publicAdapter?: string; readonly released: boolean }
interface BoardModel { readonly defaultProvider: string; readonly released: boolean; readonly admittedProviders: readonly string[] }

export interface BoardConfig {
  readonly benchmarks: Readonly<Record<string, BoardBenchmark>>;
  readonly harnesses: Readonly<Record<string, BoardHarness>>;
  readonly models: Readonly<Record<string, BoardModel>>;
  /** Adapter name to the id that a run records: `<name>@<first 12 hex of the SHA-256 of the bundle's first line>`. */
  readonly adapterIds: Readonly<Record<string, string>>;
}

/** Everything that scoring the board for one benchmark reads. */
export interface BoardInputs {
  readonly benchmark: string;
  readonly facts: readonly BoardFact[];
  readonly runs: Readonly<Record<string, BoardRun>>;
  readonly invalid: Readonly<Record<string, readonly InvalidRule[]>>;
  readonly config: BoardConfig;
  /** The published board, `index/public.json`, as the board wrote it. */
  readonly published: JsonMap;
  readonly fetchedAt: string;
}

interface BucketEntry { readonly type: string; readonly path: string; readonly xetHash?: string }

/** One fetch of one benchmark's board data, `snapshots/<board key>.json`:
 *  the ids of the immutable objects that it read, written only after every
 *  download succeeded. A load reads only the objects that its snapshot
 *  names, so a later fetch of this benchmark or another never mixes newer
 *  inputs into it, and a fetch that stops part way leaves the last snapshot
 *  whole. */
interface BoardSnapshot {
  readonly fetchedAt: string;
  readonly spaceRevision: string;
  /** Space registry name (benchmarks, harnesses, models) to object id. */
  readonly space: { readonly [name: string]: string };
  readonly adapterIds: { readonly [name: string]: string };
  /** Bucket path to object id: index/public.json, each run's run.json and invalid.json, and the benchmark's trial shards. */
  readonly files: { readonly [path: string]: string };
}

const SPACE_REGISTRIES = ["benchmarks", "harnesses", "models"];
const RUN_RECORD = /^runs\/([^/]+)\/run\.json$/;
const TRIAL_SHARD = /\/trials-[^/]+\.jsonl$/;

function snapshotPath(cache: string, boardKey: string): string {
  return join(cache, "snapshots", `${boardKey}.json`);
}

function objectPath(cache: string, id: string): string {
  return join(cache, "objects", id);
}

/** The object id of a bucket file's content hash, or undefined for an entry without one. */
function xetObject(entry: BucketEntry): string | undefined {
  if (entry.xetHash === undefined) return undefined;
  if (!/^[0-9a-f]+$/.test(entry.xetHash)) throw new Error(`the bucket entry ${entry.path} has a content hash that is not hex`);
  return `xet-${entry.xetHash}`;
}

/** Stores an object under `id`, by default its SHA-256, and returns the id. An object is never rewritten with other content. */
async function storeObject(cache: string, body: Uint8Array, id = `sha256-${createHash("sha256").update(body).digest("hex")}`): Promise<string> {
  await writeAtomic(objectPath(cache, id), body);
  return id;
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    let waitMs = 1000 * 2 ** attempt;
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
      if (response.ok) return response;
      lastError = new Error(`GET ${url}: HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
      // Hugging Face rate-limits bulk downloads with 429 and says when to retry.
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.max(waitMs, retryAfter * 1000);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(Math.min(waitMs, 120_000));
  }
  throw lastError;
}

/** Every entry directly under a bucket prefix, following the listing's pages. */
async function listBucket(prefix: string): Promise<BucketEntry[]> {
  const entries: BucketEntry[] = [];
  let url: string | undefined = `${HUB}/api/buckets/${BUCKET}/tree/${prefix}?recursive=false`;
  while (url !== undefined) {
    const response = await request(url);
    const listing: unknown = await response.json();
    if (!Array.isArray(listing)) throw new Error(`the bucket listing of ${prefix} is not a list`);
    for (const raw of listing) {
      const entry = jsonMap(raw, `bucket entry under ${prefix}`);
      entries.push({ type: text(entry.type, "entry type"), path: text(entry.path, "entry path"), ...(typeof entry.xetHash === "string" ? { xetHash: entry.xetHash } : {}) });
    }
    url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
  }
  return entries;
}

async function writeAtomic(path: string, body: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // A unique part name lets two fetches store the same object at once.
  const part = `${path}.${crypto.randomUUID()}.part`;
  await writeFile(part, body);
  await rename(part, path);
}

async function inPool<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

/** Downloads the board's data for one benchmark into `cache`: the Space's
 *  registries at its current revision with the adapter ids they imply, the
 *  published board, every run record and invalid list, and the benchmark's
 *  trial shards. A bucket file whose content hash the cache already holds
 *  is not downloaded again, so a stopped fetch resumes. The benchmark's
 *  snapshot changes only when the whole fetch succeeds. Returns the counts
 *  that it fetched. */
export async function fetchBoard(benchmark: HarborBenchmark, cache: string = BOARD_CACHE): Promise<{ runs: number; shards: number; downloaded: number }> {
  const boardKey = requireBoardKey(benchmark);
  const revision = text(jsonMap(await (await request(`${HUB}/api/spaces/${SPACE}/revision/main`)).json(), "Space revision").sha, "Space revision sha");
  const space: { [name: string]: string } = {};
  let harnesses: JsonMap = {};
  for (const name of SPACE_REGISTRIES) {
    const body = new Uint8Array(await (await request(`${HUB}/spaces/${SPACE}/resolve/${revision}/hlb/data/${name}.json`)).arrayBuffer());
    space[name] = await storeObject(cache, body);
    if (name === "harnesses") harnesses = jsonMap(jsonMap(JSON.parse(new TextDecoder().decode(body)), "harnesses.json").harnesses, "harnesses");
  }
  const adapterNames = new Set(Object.values(harnesses).flatMap((spec) => [jsonMap(spec, "harness").adapter, jsonMap(spec, "harness").public_adapter].filter((name): name is string => typeof name === "string")));
  const adapterIds: { [name: string]: string } = {};
  for (const name of [...adapterNames].sort()) {
    // The board identifies an adapter by its bundle's first line, newline included.
    const head = await (await request(`${HUB}/spaces/${SPACE}/resolve/${revision}/hlb/data/${name}.cjs`, { headers: { range: "bytes=0-65535" } })).text();
    const newline = head.indexOf("\n");
    if (newline < 0) throw new Error(`the first line of adapter ${name} is longer than 64 KiB`);
    adapterIds[name] = `${name}@${createHash("sha256").update(head.slice(0, newline + 1)).digest("hex").slice(0, 12)}`;
  }

  const wanted: BucketEntry[] = [];
  const index = await listBucket("index");
  wanted.push(...index.filter((entry) => entry.path === "index/public.json"));
  if (wanted.length === 0) throw new Error("the bucket holds no index/public.json");
  const runIds = (await listBucket("runs")).filter((entry) => entry.type === "directory").map((entry) => entry.path.split("/").at(-1)!);
  await inPool(runIds, 16, async (runId) => {
    const top = await listBucket(`runs/${runId}`);
    const files = top.filter((entry) => entry.type === "file" && (entry.path.endsWith("/run.json") || entry.path.endsWith("/invalid.json")));
    if (!files.some((entry) => entry.path.endsWith("/run.json"))) return;
    wanted.push(...files);
    if (!top.some((entry) => entry.type === "directory" && entry.path === `runs/${runId}/${boardKey}`)) return;
    wanted.push(...(await listBucket(`runs/${runId}/${boardKey}`)).filter((entry) => entry.type === "file" && TRIAL_SHARD.test(entry.path)));
  });
  const files: { [path: string]: string } = {};
  let downloaded = 0;
  await inPool(wanted, 8, async (entry) => {
    const known = xetObject(entry);
    if (known !== undefined && await Bun.file(objectPath(cache, known)).exists()) {
      files[entry.path] = known;
      return;
    }
    const body = new Uint8Array(await (await request(`${HUB}/buckets/${BUCKET}/resolve/${entry.path}`)).arrayBuffer());
    files[entry.path] = await storeObject(cache, body, known);
    downloaded += 1;
  });
  const sortedFiles = Object.fromEntries(Object.entries(files).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  const snapshot: BoardSnapshot = { fetchedAt: new Date().toISOString(), spaceRevision: revision, space, adapterIds, files: sortedFiles };
  await writeAtomic(snapshotPath(cache, boardKey), `${JSON.stringify(snapshot)}\n`);
  const paths = Object.keys(files);
  return { runs: paths.filter((path) => RUN_RECORD.test(path)).length, shards: paths.filter((path) => TRIAL_SHARD.test(path)).length, downloaded };
}

function requireBoardKey(benchmark: HarborBenchmark): string {
  if (benchmark.boardKey === undefined) throw new Error(`the harness leaderboard does not rank ${benchmark.id}`);
  return benchmark.boardKey;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function decodeFact(raw: unknown, where: string): BoardFact {
  const fact = jsonMap(raw, where);
  const meter = fact.meter === null || fact.meter === undefined ? null : jsonMap(fact.meter, `${where} meter`);
  const timing = fact.time_s === null || fact.time_s === undefined ? {} : jsonMap(fact.time_s, `${where} time_s`);
  const answerKey = fact.answer_key === null || fact.answer_key === undefined ? {} : jsonMap(fact.answer_key, `${where} answer_key`);
  return {
    id: text(fact.id, `${where} id`),
    trial: text(fact.trial, `${where} trial`),
    task: text(fact.task, `${where} task`),
    harness: text(fact.harness, `${where} harness`),
    runId: text(fact.run_id, `${where} run_id`),
    benchmark: text(fact.benchmark, `${where} benchmark`),
    reusedFrom: optionalText(fact.reused_from),
    reward: finite(fact.reward),
    exception: optionalText(fact.exception),
    featurebenchVerifierException: optionalText(fact.featurebench_verifier_exception),
    bridgeRejection: optionalText(fact.bridge_rejection),
    // `received` lists the answer-key material that reached the model; the board tests it for truth.
    answerKeyReceived: Array.isArray(answerKey.received) ? answerKey.received.length > 0 : Boolean(answerKey.received),
    agentStarted: fact.agent_started === true,
    agentSeconds: finite(timing.agent_execution),
    meter: meter === null ? null : { nCalls: finite(meter.n_calls) ?? 0, lastStatus: finite(meter.last_status), input: finite(meter.input) ?? 0, cached: finite(meter.cached) ?? 0, output: finite(meter.output) ?? 0 },
    ...(typeof fact.provider === "string" ? { provider: fact.provider } : {}),
  };
}

function decodeRule(rule: JsonMap, what: string): InvalidRule {
  const list = (key: string): { [key: string]: readonly string[] } => (rule[key] === undefined ? {} : { [key]: strings(rule[key], `${what} ${key}`) });
  return { ...list("harnesses"), ...list("benchmarks"), ...list("tasks"), ...list("trials"), ...(rule.outcome === undefined ? {} : { outcome: text(rule.outcome, `${what} outcome`) }) };
}

function decodeRun(raw: unknown, runId: string): BoardRun {
  const run = jsonMap(raw, `run ${runId}`);
  const price = jsonMap(run.price, `run ${runId} price`);
  return {
    runId,
    createdAt: typeof run.created_at === "string" ? run.created_at : "",
    model: text(run.model, `run ${runId} model`),
    provider: text(run.provider, `run ${runId} provider`),
    stage: text(run.stage, `run ${runId} stage`),
    effort: text(run.reasoning_effort, `run ${runId} reasoning_effort`),
    harnessVersions: stringMap(run.harness_versions ?? {}, `run ${runId} harness_versions`),
    harnessAdapters: Object.fromEntries(Object.entries(jsonMap(run.harness_adapters ?? {}, `run ${runId} harness_adapters`)).map(([harness, adapter]) => [harness, typeof adapter === "string" ? adapter : null])),
    benchmarkSetups: Object.fromEntries(Object.entries(jsonMap(run.benchmark_setups ?? {}, `run ${runId} benchmark_setups`)).map(([benchmark, setup]) => {
      const fields = setup === null ? {} : jsonMap(setup, `run ${runId} benchmark setup ${benchmark}`);
      return [benchmark, { ...(typeof fields.commit === "string" ? { commit: fields.commit } : {}), ...(typeof fields.reference_isolation === "string" ? { reference_isolation: fields.reference_isolation } : {}) }];
    })),
    price: { input: finite(price.input) ?? 0, cached_input: finite(price.cached_input) ?? 0, output: finite(price.output) ?? 0 },
  };
}

function decodeConfig(benchmarks: unknown, harnesses: unknown, models: unknown, adapterIds: unknown): BoardConfig {
  const decodedBenchmarks: Record<string, BoardBenchmark> = {};
  for (const [key, raw] of Object.entries(jsonMap(jsonMap(benchmarks, "benchmarks.json").benchmarks, "benchmarks"))) {
    const spec = jsonMap(raw, `benchmark ${key}`);
    const subsets = jsonMap(spec.subsets, `benchmark ${key} subsets`);
    decodedBenchmarks[key] = {
      commit: text(spec.commit, `benchmark ${key} commit`),
      strata: text(spec.strata, `benchmark ${key} strata`),
      subsets: Object.fromEntries(Object.entries(subsets).map(([stage, tasks]) => [stage, strings(tasks, `benchmark ${key} subset ${stage}`)])),
      taskStrata: stringMap(spec.task_strata ?? {}, `benchmark ${key} task_strata`),
      excluded: Array.isArray(spec.excluded) ? strings(spec.excluded, `benchmark ${key} excluded`) : Object.keys(jsonMap(spec.excluded ?? {}, `benchmark ${key} excluded`)),
      unscored: "unscored" in spec,
      // The board's code gives only FeatureBench a reference isolation (config.benchmark_setup).
      ...(key === "featurebench" ? { referenceIsolation: "fresh-verifier" } : {}),
    };
  }
  const decodedHarnesses: Record<string, BoardHarness> = {};
  for (const [key, raw] of Object.entries(jsonMap(jsonMap(harnesses, "harnesses.json").harnesses, "harnesses"))) {
    const spec = jsonMap(raw, `harness ${key}`);
    decodedHarnesses[key] = {
      version: text(spec.version, `harness ${key} version`),
      ...(typeof spec.public_version === "string" ? { publicVersion: spec.public_version } : {}),
      ...(typeof spec.adapter === "string" ? { adapter: spec.adapter } : {}),
      ...(typeof spec.public_adapter === "string" ? { publicAdapter: spec.public_adapter } : {}),
      released: spec.released !== false,
    };
  }
  const decodedModels: Record<string, BoardModel> = {};
  for (const [key, raw] of Object.entries(jsonMap(jsonMap(models, "models.json").models, "models"))) {
    const spec = jsonMap(raw, `model ${key}`);
    const reference = text(spec.default_provider, `model ${key} default_provider`);
    const equivalence = jsonMap(spec.equivalence ?? {}, `model ${key} equivalence`);
    decodedModels[key] = {
      defaultProvider: reference,
      released: Boolean(spec.released),
      admittedProviders: [reference, ...Object.entries(equivalence).filter(([provider, entry]) => provider !== reference && jsonMap(entry, `model ${key} equivalence ${provider}`).admitted === true).map(([provider]) => provider)],
    };
  }
  return { benchmarks: decodedBenchmarks, harnesses: decodedHarnesses, models: decodedModels, adapterIds: stringMap(adapterIds, "adapters.json") };
}

/** Reads the board data of the benchmark's last complete `fetchBoard`.
 *  Throws, naming the fetch command, when nothing was fetched. */
export async function loadBoard(benchmark: HarborBenchmark, cache: string = BOARD_CACHE): Promise<BoardInputs> {
  const boardKey = requireBoardKey(benchmark);
  const stored = await readOptionalJson(snapshotPath(cache, boardKey));
  if (stored === undefined) throw new Error(`no board data for ${benchmark.id}; run: bun bench/harbor/hill.ts board fetch --benchmark ${benchmark.id}`);
  const record = jsonMap(stored, "board snapshot");
  const snapshot: BoardSnapshot = { fetchedAt: text(record.fetchedAt, "snapshot fetchedAt"), spaceRevision: text(record.spaceRevision, "snapshot spaceRevision"), space: stringMap(record.space, "snapshot space"), adapterIds: stringMap(record.adapterIds, "snapshot adapterIds"), files: stringMap(record.files, "snapshot files") };
  const readObject = (id: string): Promise<string> => readFile(objectPath(cache, id), "utf8");
  const objectJson = async (id: string | undefined, what: string): Promise<unknown> => {
    if (id === undefined) throw new Error(`the ${boardKey} board snapshot holds no ${what}`);
    return JSON.parse(await readObject(id));
  };
  const runs: Record<string, BoardRun> = {};
  const invalid: Record<string, InvalidRule[]> = {};
  const facts: BoardFact[] = [];
  for (const [path, id] of Object.entries(snapshot.files)) {
    const runId = RUN_RECORD.exec(path)?.[1];
    if (runId !== undefined) {
      runs[runId] = decodeRun(await objectJson(id, path), runId);
      const rulesId = snapshot.files[`runs/${runId}/invalid.json`];
      const rules = rulesId === undefined ? null : await objectJson(rulesId, `runs/${runId}/invalid.json`);
      if (rules !== null) {
        const list = jsonMap(rules, `invalid.json of ${runId}`).rules;
        if (Array.isArray(list) && list.length > 0) invalid[runId] = list.map((rule, index) => decodeRule(jsonMap(rule, `invalid.json of ${runId} rule ${index}`), `invalid.json of ${runId} rule ${index}`));
      }
    }
    if (TRIAL_SHARD.test(path)) {
      (await readObject(id)).split("\n").forEach((line, index) => {
        if (line.trim().length > 0) facts.push(decodeFact(JSON.parse(line), `${path}:${index + 1}`));
      });
    }
  }
  const config = decodeConfig(await objectJson(snapshot.space.benchmarks, "benchmarks.json"), await objectJson(snapshot.space.harnesses, "harnesses.json"), await objectJson(snapshot.space.models, "models.json"), snapshot.adapterIds);
  if (config.benchmarks[boardKey] === undefined) throw new Error(`the board registers no benchmark ${boardKey}`);
  return { benchmark: boardKey, facts, runs, invalid, config, published: jsonMap(await objectJson(snapshot.files["index/public.json"], "index/public.json"), "public.json"), fetchedAt: snapshot.fetchedAt };
}
