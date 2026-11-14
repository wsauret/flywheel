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
  /** The persona whose benchmark records `--judge` scores, with no campaign or candidate. */
  rejudge?: string;
  /** Regrade recorded implementer cells with each task's current grader; no candidate or judge runs. */
  regrade?: boolean;
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
  let rejudge: string | undefined;
  let regrade = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--regrade") {
      regrade = true;
    } else if (arg === "--dry-run") {
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
    } else if (arg === "--auth-profile" || arg === "--tasks" || arg === "--persona-dir" || arg === "--results-root" || arg === "--report" || arg === "--rejudge") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--auth-profile") profile = value;
      else if (arg === "--rejudge") rejudge = value;
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
  if (rejudge !== undefined) {
    if (!judge) throw new Error("--rejudge requires --judge model:effort");
    const refused = [["--resume", resumeDir], ["--rescore", rescoreDir], ["--report", reportDir], ["--variant", variants[0]], ["--repeats", repeats], ["--tasks", taskIds[0]], ["--persona", persona]]
      .filter(([, value]) => value !== undefined).map(([flag]) => flag);
    if (refused.length > 0) throw new Error(`--rejudge scores the recorded cells of one persona and cannot be used with ${refused.join(", ")}`);
  }
  if (regrade && argv.length > 1) throw new Error("--regrade takes no other option");
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
    ...(rejudge === undefined ? {} : { rejudge }),
    ...(regrade ? { regrade } : {}),
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
  if (args.regrade) {
    const [{ createLauncherScope, createProcessSupervisor }, { ownedCommandRunner }, { regradeRecords }] = await Promise.all([
      import("../../src/infra/process-supervisor.js"),
      import("../../src/infra/owned-command.js"),
      import("../../src/orchestration/modules/development/benchmark/regrade.js"),
    ]);
    const supervisor = createProcessSupervisor();
    const scope = createLauncherScope(supervisor);
    try {
      const { graded, current, skipped } = await regradeRecords(catalog, ownedCommandRunner(scope));
      console.log(`Regraded ${graded} implementer cells; ${current} already had the current grade; ${skipped} skipped (task removed, or changed what the candidate answered).`);
    } finally {
      await scope.close();
      await supervisor.dispose();
    }
    return;
  }
  if (args.rejudge !== undefined) {
    await rejudge(args.rejudge, args, catalog, createRuntime, projectRoot);
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

/** Score the current, unscored record cells of `persona` with the `--judge` judge (ARCH-DIRECTORIES-020). */
async function rejudge(persona: string, args: CliArgs, catalog: ReturnType<typeof createBenchmarkCatalog>, createRuntime: CreateRuntime, projectRoot: string): Promise<void> {
  const requested = args.judge!;
  const [{ admitBenchmark, personaCampaignJudge }, { rejudgeRecords }] = await Promise.all([
    import("../../src/orchestration/modules/development/benchmark/admission.js"),
    import("../../src/orchestration/modules/development/benchmark/rejudge.js"),
  ]);
  await using owned = new AsyncDisposableStack();
  const admit = async () => {
    const runtime = owned.use(await createRuntime(projectRoot, undefined, args.profile));
    const admission = await admitBenchmark({
      ...runtime.deps,
      profileId: runtime.profileId,
      authorityIncarnation: runtime.usageAuthority.authorityIncarnation,
      launcher: runtime.launcher,
      background: runtime.background,
      foregroundBashHold: runtime.foregroundBashHold,
      shell: runtime.shell,
    }, [{ role: "judge", ...requested }]);
    const { judge, createJudge } = personaCampaignJudge(admission);
    if (judge?.model !== requested.model || judge.effort !== requested.effort) {
      throw new Error(`The judge ${requested.model}:${requested.effort} resolved to ${judge ? `${judge.model}:${judge.effort}` : "no model"} on this profile; a rejudge scores only with the named judge`);
    }
    return { admission, judge, createJudge };
  };
  const openJudge = async (evidenceDirectory: string) => {
    const { admission, createJudge } = await admit();
    return { model: await createJudge(evidenceDirectory), runOwnedCommand: admission.runtime.runOwnedCommand };
  };
  if (args.dryRun) {
    const { pending } = await rejudgeRecords({ catalog, persona, judge: requested, openJudge, dryRun: true });
    const { admission, judge } = await admit();
    console.log(JSON.stringify({ dryRun: true, rejudge: persona, judge, pendingCells: pending, providerPlans: admission.providerPlans }, null, 2));
    return;
  }
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const outcome = await rejudgeRecords({ catalog, persona, judge: requested, openJudge, signal: controller.signal });
    console.log(`Rejudged ${persona} with ${requested.model}:${requested.effort}: ${outcome.scored} scored, ${outcome.failed} failed of ${outcome.pending} pending. Judge evidence: ${outcome.evidenceDirectory}`);
    if (outcome.failed > 0 || controller.signal.aborted) process.exitCode = 1;
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
