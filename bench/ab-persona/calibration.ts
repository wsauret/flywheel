#!/usr/bin/env bun

// Decides pass or fail of each judged-quality judge's calibration (ARCH-DIRECTORIES-026) from the committed
// calibration data and records alone: no runtime, no profile, no provider request. With --judge model:effort it
// reports that judge, and otherwise every judge with a results file. It exits 1 when a reported judge fails. With
// --sample it writes the stratified reviewer-label sample of current implementer cells and keeps each label that the
// file already holds. `bun bench/ab-persona/bench.ts --calibrate --judge model:effort` judges the controls.

// A standalone process: it loads both module registries before anything reads the catalog.
import "../../scripts/shipped-modules.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchmarkCatalog } from "../../src/orchestration/modules/development/benchmark/catalog.js";
import { judgeLabel, type RecordJudge } from "../../src/orchestration/modules/development/benchmark/records/benchmark-records.js";
import { calibrationStanding, evaluateQualityCalibration, loadQualityCalibration, sampleReviewerCells, writeReviewerLabels } from "../../src/orchestration/modules/development/benchmark/records/judge-calibration.js";
import { loadRankingInput } from "../../src/orchestration/modules/development/benchmark/persona/results-pages.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = "Usage: bun run bench:calibration [--judge model:effort | --sample]";

function parseJudge(value: string | undefined): RecordJudge {
  const separator = value?.lastIndexOf(":") ?? -1;
  if (value === undefined || separator <= 0 || separator === value.length - 1) throw new Error(`--judge needs model:effort. ${USAGE}`);
  return { model: value.slice(0, separator), effort: value.slice(separator + 1) };
}

/** Report, decide, or sample; returns the lines to print and whether the run failed. */
export async function main(argv: readonly string[] = process.argv.slice(2), projectRoot = REPO_ROOT): Promise<{ lines: string[]; failed: boolean }> {
  const [option, value, ...rest] = argv;
  const sample = option === "--sample" && value === undefined;
  if (rest.length > 0 || (option !== undefined && option !== "--judge" && !sample)) throw new Error(`Unknown option: ${argv.join(" ")}. ${USAGE}`);
  const catalog = createBenchmarkCatalog(projectRoot);
  const data = await loadQualityCalibration(catalog);
  const input = await loadRankingInput(catalog);
  if (sample) {
    const cells = sampleReviewerCells(input, "implementer", data.labels);
    const file = await writeReviewerLabels(catalog.qualityCalibrationDir, cells);
    return { lines: [`Wrote ${cells.length} sampled cells, ${cells.filter(({ findings }) => findings !== undefined).length} labeled, to ${file}.`], failed: false };
  }
  const judges = option === "--judge" ? [parseJudge(value)] : data.results.map(({ judge }) => judge);
  if (judges.length === 0) return { lines: ["No judge has calibration results; judge the controls with `bun bench/ab-persona/bench.ts --calibrate --judge model:effort`."], failed: false };
  const standings = judges.map((judge) => ({ judge, standing: calibrationStanding(evaluateQualityCalibration(data, judge, input.campaigns)) }));
  return {
    lines: [
      `${data.controls.length} controls (${data.controls.filter(({ seeded }) => seeded).length} seeded), ${data.labels.length} sampled cells for reviewer labels.`,
      ...standings.map(({ judge, standing }) => `${standing.passed ? "PASS" : "FAIL"} ${judgeLabel(judge)}: ${standing.summary}`),
    ],
    failed: standings.some(({ standing }) => !standing.passed),
  };
}

if (import.meta.main) {
  main().then(({ lines, failed }) => {
    (failed ? console.error : console.log)(lines.join("\n"));
    if (failed) process.exitCode = 1;
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
