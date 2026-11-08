import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarborBenchmark } from "../benchmarks.js";
import { isJsonMap, jsonMap, readOptionalJson, strings, text } from "./json.js";
import type { RoundTrial } from "./round-trials.js";

/** The answer-key record of a round, `<round>.answer-key.json` beside the
 *  round record: the scan's candidates and the review's verdicts. It holds
 *  trial ids, hosts, URLs, and verdict evidence, never transcript text. */
export interface AnswerKeyRecord {
  readonly round: string;
  readonly benchmark: string;
  readonly candidates: readonly AnswerKeyCandidate[];
  /** Trial id to the review's verdict. */
  readonly verdicts: Readonly<Record<string, AnswerKeyVerdict>>;
}

export interface AnswerKeyCandidate {
  readonly trial: string;
  readonly task: string;
  /** The trial's artifact directory, which the review reads. */
  readonly directory: string;
  /** Whether a URL also names one of the benchmark's own published copies. */
  readonly high: boolean;
  readonly hosts: readonly string[];
  readonly urls: readonly string[];
}

export interface AnswerKeyVerdict {
  readonly verdict: "confirmed" | "cleared";
  readonly evidence: string;
}

/** The record path of a round record path: `<dir>/<name>.answer-key.json`. */
export function answerKeyPath(roundPath: string): string {
  if (!roundPath.endsWith(".json")) throw new Error(`a round record path ends in .json: ${roundPath}`);
  return `${roundPath.slice(0, -".json".length)}.answer-key.json`;
}

function decodeRecord(value: unknown, path: string): AnswerKeyRecord {
  const record = jsonMap(value, path);
  if (!Array.isArray(record.candidates)) throw new Error(`${path}: candidates must be a list`);
  const candidates = record.candidates.map((raw, index): AnswerKeyCandidate => {
    const candidate = jsonMap(raw, `${path} candidate ${index}`);
    if (typeof candidate.high !== "boolean") throw new Error(`${path} candidate ${index}: high must be a boolean`);
    return { trial: text(candidate.trial, `${path} candidate ${index} trial`), task: text(candidate.task, `${path} candidate ${index} task`), directory: text(candidate.directory, `${path} candidate ${index} directory`), high: candidate.high, hosts: strings(candidate.hosts, `${path} candidate ${index} hosts`), urls: strings(candidate.urls, `${path} candidate ${index} urls`) };
  });
  const verdicts = Object.fromEntries(Object.entries(jsonMap(record.verdicts, `${path} verdicts`)).map(([trial, raw]): [string, AnswerKeyVerdict] => {
    const entry = jsonMap(raw, `${path} verdict of ${trial}`);
    if (entry.verdict !== "confirmed" && entry.verdict !== "cleared") throw new Error(`${path}: the verdict of ${trial} must be confirmed or cleared`);
    return [trial, { verdict: entry.verdict, evidence: text(entry.evidence, `${path} evidence of ${trial}`) }];
  }));
  return { round: text(record.round, `${path} round`), benchmark: text(record.benchmark, `${path} benchmark`), candidates, verdicts };
}

/** Reads a round's answer-key record, or undefined when the round has none. */
export async function readAnswerKey(roundPath: string): Promise<AnswerKeyRecord | undefined> {
  const path = answerKeyPath(roundPath);
  const stored = await readOptionalJson(path);
  return stored === undefined ? undefined : decodeRecord(stored, path);
}

export async function writeAnswerKey(roundPath: string, record: AnswerKeyRecord): Promise<void> {
  const path = answerKeyPath(roundPath);
  await writeFile(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

/** The ids of the trials whose answer-key verdict is confirmed. */
export function confirmedTrials(record: AnswerKeyRecord | undefined): Set<string> {
  return new Set(Object.entries(record?.verdicts ?? {}).filter(([, verdict]) => verdict.verdict === "confirmed").map(([trial]) => trial));
}

/** Merges verdicts into a round's record. A verdict for a trial that is not
 *  a candidate is refused, so a review of another round cannot land here. */
export async function recordVerdicts(roundPath: string, verdicts: Readonly<Record<string, AnswerKeyVerdict>>): Promise<AnswerKeyRecord> {
  const record = await readAnswerKey(roundPath);
  if (record === undefined) throw new Error(`no answer-key record for ${roundPath}; run scan first`);
  const candidates = new Set(record.candidates.map((candidate) => candidate.trial));
  const strangers = Object.keys(verdicts).filter((trial) => !candidates.has(trial));
  if (strangers.length > 0) throw new Error(`verdicts name trials that are not candidates of this round: ${strangers.join(", ")}`);
  const merged: AnswerKeyRecord = { ...record, verdicts: { ...record.verdicts, ...verdicts } };
  decodeRecord(merged, answerKeyPath(roundPath));
  await writeAnswerKey(roundPath, merged);
  return merged;
}

const URL_PATTERN = /https?:\/\/([A-Za-z0-9.-]+)[^\s"'\\)]*/g;
/** Hosts that can hold an answer key: code hosts, dataset hubs, archives, and search engines. */
const SUSPECT_HOST = /(github|githubusercontent|codeload|huggingface|hf\.co|gitlab|bitbucket|tbench|bing\.|duckduckgo|google\.|search\.|kaggle|sourcegraph|grep\.app|archive\.org)/i;
const URL_LIMIT = 200;
const URLS_PER_TRIAL = 40;

/** The text of every tool call of a trial: titles and raw inputs of its ACP
 *  tool-call updates, and the arguments of its trajectory's tool calls after
 *  the first step, which is the task instruction. */
async function toolCallTexts(directory: string): Promise<string[]> {
  const texts: string[] = [];
  const events = await readFile(join(directory, "agent", "acp-events.jsonl"), "utf8").catch(() => "");
  for (const line of events.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // A line that the shim cut off at its deadline holds no complete call.
      continue;
    }
    const payload = isJsonMap(event) && isJsonMap(event.payload) ? event.payload : undefined;
    const update = payload !== undefined && isJsonMap(payload.update) ? payload.update : undefined;
    if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") texts.push(`${typeof update.title === "string" ? update.title : ""} ${JSON.stringify(update.rawInput ?? {})}`);
  }
  const trajectory = await readFile(join(directory, "agent", "trajectory.json"), "utf8").catch(() => undefined);
  if (trajectory !== undefined) {
    const parsed: unknown = JSON.parse(trajectory);
    const steps = isJsonMap(parsed) && Array.isArray(parsed.steps) ? parsed.steps : [];
    for (const step of steps.slice(1)) {
      if (isJsonMap(step) && Array.isArray(step.tool_calls)) for (const call of step.tool_calls) texts.push(JSON.stringify(call));
    }
  }
  return texts;
}

/** The answer-key candidates of a round: each passing trial whose tool calls
 *  reach a suspect host. A candidate is high when one of its URLs also names
 *  one of the benchmark's `answerKeySources`. A candidate is for review, not a verdict. */
export async function scanAnswerKeys(benchmark: HarborBenchmark, trials: readonly RoundTrial[]): Promise<AnswerKeyCandidate[]> {
  const sources = benchmark.answerKeySources.map((source) => source.toLowerCase());
  const candidates: AnswerKeyCandidate[] = [];
  for (const trial of trials) {
    if (trial.standing !== "scored" || (trial.reward ?? 0) < 1 || trial.directory === undefined) continue;
    const urls = new Map<string, string>();
    for (const text of await toolCallTexts(trial.directory)) {
      for (const match of text.matchAll(URL_PATTERN)) if (SUSPECT_HOST.test(match[1]!)) urls.set(match[0].slice(0, URL_LIMIT), match[1]!);
    }
    if (urls.size === 0) continue;
    const sorted = [...urls.keys()].sort();
    candidates.push({
      trial: trial.id,
      task: trial.task,
      directory: trial.directory,
      high: sorted.some((url) => sources.some((source) => url.toLowerCase().includes(source))),
      hosts: [...new Set(urls.values())].sort(),
      urls: sorted.slice(0, URLS_PER_TRIAL),
    });
  }
  return candidates.sort((left, right) => left.trial.localeCompare(right.trial));
}
