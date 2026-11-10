#!/usr/bin/env bun

// Model A/B benchmark for one subagent persona. This is the console face of
// the shared benchmark service: it reads argv, owns one runtime generation,
// admits its matrix through the shared benchmark admission, renders the
// service's events, and nothing else.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { installModuleCatalog } from "../../src/orchestration/module-catalog.js";
import type { UsageAuthorityGeneration } from "../../src/orchestration/agent-runtime/usage-settlement.js";
import { createBenchmarkCatalog } from "../../src/orchestration/modules/development/benchmark/catalog.js";
import type {
  BenchmarkEvent,
  BenchmarkOptions,
} from "../../src/orchestration/modules/development/benchmark/persona-benchmark.js";
import { parseVariant, type VariantSpec } from "../../src/orchestration/modules/development/benchmark/variant.js";
import type { OwnedBenchmarkRuntime } from "../shared/runtime.js";
import { readJsonFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { realDirectoryUnder } from "../../src/orchestration/modules/development/benchmark/paths.js";
import { createPersonaStore } from "../../src/orchestration/modules/development/benchmark/persona-store.js";
import { runningSourceIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface CliArgs extends BenchmarkOptions {
  dryRun: boolean;
  profile?: string;
  personaDir?: string;
  resultsRoot?: string;
  reportDir?: string;
}

type CreateRuntime = (projectRoot: string, stored?: UsageAuthorityGeneration, profile?: string) => Promise<OwnedBenchmarkRuntime>;

const createRuntimeDefault: CreateRuntime = async (projectRoot, stored, profile) => {
  const { createBenchmarkRuntime } = await import("../shared/runtime.js");
  return await createBenchmarkRuntime(projectRoot, { watchConfig: true, ...(stored ? { stored } : {}), ...(profile ? { authProfile: profile } : {}) });
};

export function parseArgs(argv: readonly string[]): CliArgs {
  let persona: string | undefined;
  let repeats: number | undefined;
  let dryRun = false;
  let resumeDir: string | undefined;
  let rescoreDir: string | undefined;
  const variants: VariantSpec[] = [];
  const taskIds: string[] = [];
  let profile: string | undefined;
  let personaDir: string | undefined;
  let resultsRoot: string | undefined;
  let reportDir: string | undefined;
  let judge: VariantSpec | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--repeats") {
      const value = argv[++i];
      if (!value) throw new Error("--repeats requires a value");
      repeats = Number(value);
    } else if (arg === "--persona") {
      const value = argv[++i];
      if (!value) throw new Error("--persona requires a value");
      persona = value;
    } else if (arg === "--variant") {
      const value = argv[++i];
      if (!value) throw new Error("--variant requires a value");
      variants.push(parseVariant(value));
    } else if (arg === "--judge") {
      const value = argv[++i];
      if (!value) throw new Error("--judge requires model:effort");
      judge = parseVariant(value);
    } else if (arg === "--resume" || arg === "--rescore") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a results directory`);
      if (arg === "--resume") resumeDir = resolve(value);
      else rescoreDir = resolve(value);
    } else if (arg === "--profile" || arg === "--task") {
      throw new Error(`${arg} was replaced by ${arg === "--profile" ? "--auth-profile" : "--tasks"}`);
    } else if (arg === "--auth-profile" || arg === "--tasks" || arg === "--persona-dir" || arg === "--results-root" || arg === "--report") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--auth-profile") profile = value;
      else if (arg === "--tasks") taskIds.push(...value.split(",").map(id => id.trim()).filter(Boolean));
      else if (arg === "--persona-dir") personaDir = resolve(value);
      else if (arg === "--report") reportDir = resolve(value);
      else resultsRoot = resolve(value);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (resumeDir && rescoreDir) throw new Error("--resume and --rescore cannot be used together");
  if (reportDir && (resumeDir || rescoreDir || dryRun)) throw new Error("--report cannot be used with --resume, --rescore, or --dry-run");
  if (repeats !== undefined && (!Number.isInteger(repeats) || repeats < 1)) throw new Error("--repeats must be a positive integer");
  const resultsDir = resumeDir ?? rescoreDir;
  return {
    ...(persona === undefined ? {} : { persona }),
    variants,
    ...(repeats === undefined ? {} : { repeats }),
    operation: resumeDir ? "resume" : rescoreDir ? "rescore" : "run",
    ...(resultsDir === undefined ? {} : { resultsDir }),
    dryRun,
    ...(taskIds.length ? { taskIds } : {}),
    ...(profile === undefined ? {} : { profile }),
    ...(personaDir ? { personaDir } : {}),
    ...(resultsRoot ? { resultsRoot } : {}),
    ...(reportDir ? { reportDir } : {}),
    ...(judge ? { judge: { model: judge.model, effort: judge.effort } } : {}),
  };
}

function render(event: BenchmarkEvent): void {
  switch (event.kind) {
    case "benchmark.started":
      console.error(`Results: ${event.resultsDir} (${event.pendingCells} cell${event.pendingCells === 1 ? "" : "s"} to run)`);
      return;
    case "cell.started":
      console.error(`Running ${event.cell.variant}/${event.cell.task}/${event.cell.repeat}...`);
      return;
    case "cell.completed": {
      const acceptance = event.acceptance ? `, acceptance ${event.acceptance.passed}/${event.acceptance.total}` : "";
      const estimated = event.accounting.estimatedUsd.kind === "observed" ? `$${event.accounting.estimatedUsd.value.toFixed(4)}` : "estimated spend unavailable";
      const tokens = event.accounting.tokens.kind === "observed" ? `${event.accounting.tokens.value} tokens` : "tokens unavailable";
      console.error(`  ${event.cell.variant}/${event.cell.task}/${event.cell.repeat}: ${estimated}, ${tokens}, ${event.durationMs} ms${acceptance}`);
      return;
    }
    case "cell.failed":
      console.error(`  ${event.cell.variant}/${event.cell.task}/${event.cell.repeat} failed: ${event.message}`);
      return;
    case "scoring.started":
      console.error(`Scoring ${event.phase}...`);
      return;
    case "scoring.skipped":
      console.error(`Skipping ${event.phase} scoring: ${event.reason}`);
      return;
    case "benchmark.completed":
      console.error(`Report: ${event.reportPath}`);
      return;
    case "benchmark.cancelled":
      console.error(`Cancelled. Partial results: ${event.resultsDir}`);
      return;
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  createRuntime: CreateRuntime = createRuntimeDefault,
  projectRoot = REPO_ROOT,
): Promise<void> {
  const args = parseArgs(argv);
  const [
    { admitBenchmark, benchmarkPreflightReport, benchmarkModelSeats, personaCampaignJudge },
    { loadBenchmarkPersona, planPersonaBenchmark, runPersonaBenchmark },
  ] = await Promise.all([
    import("../../src/orchestration/modules/development/benchmark/admission.js"),
    import("../../src/orchestration/modules/development/benchmark/persona-benchmark.js"),
  ]);
  const catalog = createBenchmarkCatalog(projectRoot, {
    ...(args.personaDir ? { personaOverlayDir: args.personaDir } : {}),
    ...(args.resultsRoot ? { resultsRoot: args.resultsRoot } : {}),
  });
  if (args.reportDir) {
    const directory = await realDirectoryUnder(catalog.resultsRoot, args.reportDir, "The benchmark results directory");
    const campaign = await readJsonFile(join(directory, "campaign.json"));
    if (campaign !== undefined) await createPersonaStore({ resultsRoot: catalog.resultsRoot, directory });
    const report = await readJsonFile(join(directory, "report.md"));
    if (report === undefined) throw new Error(`No retained report at ${directory}`);
    console.log(report);
    return;
  }
  const plan = await planPersonaBenchmark(args, catalog);
  await using runtime = await createRuntime(projectRoot, undefined, args.profile);
  const { persona } = await loadBenchmarkPersona(plan, catalog, runtime.deps);
  // Preflight reports one capture. Every request resolves again from the current profile.
  const admission = await admitBenchmark({
    ...runtime.deps,
    profileId: runtime.profileId,
    authorityIncarnation: runtime.usageAuthority.authorityIncarnation,
    launcher: runtime.launcher,
    background: runtime.background,
    foregroundBashHold: runtime.foregroundBashHold,
    shell: runtime.shell,
  }, benchmarkModelSeats(plan, persona.role));
  const judge = personaCampaignJudge(admission);
  if (args.dryRun) {
    console.log(JSON.stringify(benchmarkPreflightReport(plan, admission.providerPlans), null, 2));
    return;
  }
  const controller = new AbortController();
  // An interrupt cancels the run instead of killing it mid-cell: the service
  // aborts every cell, judge call and command it owns and settles them before
  // it returns, so the results directory stays readable.
  const onInterrupt = (): void => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const outcome = await runPersonaBenchmark(plan, {
      runtime: admission.runtime,
      catalog,
      ...judge,
      onEvent: render,
      signal: controller.signal,
      sourceIdentity: await runningSourceIdentity([join(REPO_ROOT, "bench", "shared")]),
    });
    if (outcome.status === "completed") console.log(outcome.report);
    else process.exitCode = 1;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

if (import.meta.main) {
  const load = createRequire(import.meta.url);
  installModuleCatalog({
    otherModules: () => [
      ...load("../../src/orchestration/modules.js").SHIPPED_OTHER_MODULES,
      ...load("../../src/orchestration/development-modules.js").DEVELOPMENT_MODULES,
    ],
  });
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
