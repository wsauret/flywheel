#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectStartupDirectories } from "../../src/infra/directory-authorities.js";
import { createBenchmarkRuntime } from "../shared/runtime.js";
import { ChatRoutingFailure, chatRoutingGuidance, runChatRoutingTask } from "../../src/orchestration/modules/development/benchmark/chat-routing-run.js";
import { completionIndex, planMatrix, runMatrix } from "../../src/orchestration/modules/development/benchmark/matrix-runner.js";
import { createRoutingRunStore, type RoutingAttemptRecord, type RoutingConfig, type RoutingRunRecord } from "../../src/orchestration/modules/development/benchmark/run-store.js";
import { parseVariant, type VariantSpec } from "../../src/orchestration/modules/development/benchmark/variant.js";
import { createBackgroundExecutionOwner } from "../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../src/orchestration/agent-runtime/background-work.js";
import { createInstalledDefinitionRegistry } from "../../src/orchestration/definition-catalog.js";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { unavailableBenchmarkAccounting } from "../../src/orchestration/modules/development/benchmark/evidence.js";
import type { UsageAuthorityGeneration } from "../../src/orchestration/agent-runtime/usage-settlement.js";
import { admitBenchmark } from "../../src/orchestration/modules/development/benchmark/admission.js";
import { RESEARCH_SNAPSHOT } from "../../src/orchestration/modules/development/benchmark/catalog.js";
import { withSnapshotWorkspace } from "../../src/orchestration/modules/development/benchmark/snapshot-workspace.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RESULTS_ROOT = join(REPO_ROOT, "bench", "results", "chat-routing");
const DEADLINE_MS = 120_000;
const SCORING_VERSION = "chat-routing-v1";
const VARIANT_CONCURRENCY = 2;
export interface RoutingFixture {
  readonly id: string;
  readonly expected: "advisor" | "no-advisor";
  readonly prompt: string;
}

export const ROUTING_FIXTURES: readonly RoutingFixture[] = [
  { id: "durable-consent-boundary", expected: "advisor", prompt: "The learning store can either keep project-local corrections automatic or ask before promoting them into the global store. Both fit the event schema, but they create different consent expectations for users. Determine the next engineering action." },
  { id: "workflow-retry-authority", expected: "advisor", prompt: "A workflow retry can derive prior execution from the conversation ledger or add a separate idempotency record. The repository invariants favor one source of truth, while crash recovery requirements appear to pull the other way. Determine how the implementation should proceed." },
  { id: "provider-capability-evidence", expected: "advisor", prompt: "Removing a provider-specific request suppression depends on behavior that source and local mocks cannot establish. A live capability probe could settle it, but it would cross an external service boundary. Determine the next engineering action." },
  { id: "uncertain-symbol-location", expected: "no-advisor", prompt: "I am not sure whether Chat assembles subagent guidance in the runner or the tool registry. Locate the owning function and cite the relevant file and lines." },
  { id: "uncertain-finished-change", expected: "no-advisor", prompt: "The timeout repair is finished, but I am not certain it preserves background ownership. Review the local implementation and focused tests, then report concrete defects with file and line references." },
  { id: "uncertain-reversible-edit", expected: "no-advisor", prompt: "It is unclear whether the benchmark label should say deadline or timeout. Apply the specified local wording change, run the focused test, and report the result; the edit is easy to reverse." },
];

interface CliArgs {
  readonly variants: readonly VariantSpec[];
  readonly repeats: number;
  readonly dryRun: boolean;
  readonly resume?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const variants: VariantSpec[] = [];
  let repeats = 1;
  let dryRun = false;
  let resume: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--variant") {
      const value = argv[++index];
      if (!value) throw new Error("--variant requires a value");
      variants.push(parseVariant(value));
    } else if (arg === "--repeats") {
      const value = argv[++index];
      if (!value) throw new Error("--repeats requires a value");
      repeats = Number(value);
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--resume") {
      const value = argv[++index];
      if (!value) throw new Error("--resume requires a results directory");
      resume = resolve(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
  if (variants.length === 0 && !resume) throw new Error("At least one --variant is required");
  const ids = variants.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate --variant IDs are not allowed");
  return { variants, repeats, dryRun, ...(resume ? { resume } : {}) };
}

export function planRoutingMatrix(args: Pick<CliArgs, "variants" | "repeats">) {
  return Array.from({ length: args.repeats }, (_, repeat) =>
    ROUTING_FIXTURES.flatMap((fixture) => args.variants.map((variant) => ({ variant: variant.id, fixture: fixture.id, repeat }))),
  ).flat();
}

export function createRoutingConfig(
  args: Pick<CliArgs, "variants" | "repeats">,
  routingGuidance: string,
  usageAuthority: UsageAuthorityGeneration,
): RoutingConfig {
  const candidates = args.variants.map(({ id, model, effort }) => ({ id, model, effort }));
  const promptInputs = ROUTING_FIXTURES.map(({ id, prompt }) => ({ id, prompt }));
  const activeProfileCandidatePlan = candidates.map(({ model, effort }) => `${model}:${effort}:chat`);
  return {
    kind: "chat-routing-config",
    fixtures: [...ROUTING_FIXTURES],
    promptIdentity: structuredIdentity(promptInputs),
    routingGuidanceIdentity: structuredIdentity(routingGuidance),
    routingGuidance,
    scoringVersion: SCORING_VERSION,
    variants: candidates,
    repeats: args.repeats,
    sourceIdentity: structuredIdentity({ promptInputs, routingGuidance, scoringVersion: SCORING_VERSION, deadlineMs: DEADLINE_MS, activeProfileCandidatePlan, snapshot: RESEARCH_SNAPSHOT }),
    activeProfileCandidatePlan,
    deadlineMs: DEADLINE_MS,
    identity: {
      profileId: usageAuthority.profileId,
      authorityIncarnation: usageAuthority.authorityIncarnation,
      contentIdentity: structuredIdentity({
        fixtures: ROUTING_FIXTURES,
        routingGuidance,
        scoringVersion: SCORING_VERSION,
        variants: candidates,
        repeats: args.repeats,
        deadlineMs: DEADLINE_MS,
      }),
    },
  };
}

function sameIdentity(left: RoutingConfig, right: RoutingConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatePersistedRows(config: RoutingConfig, rows: readonly RoutingRunRecord[], attempts: readonly RoutingAttemptRecord[]): void {
  const variants = new Map(config.variants.map((variant) => [variant.id, variant]));
  const fixtures = new Set(config.fixtures.map(({ id }) => id));
  for (const row of [...rows, ...attempts]) {
    const variant = variants.get(row.variant);
    if (!variant || !fixtures.has(row.fixture) || row.repeat < 0 || row.repeat >= config.repeats || row.model !== variant.model || row.effort !== variant.effort) {
      throw new Error("Persisted Chat routing row does not match run config");
    }
  }
}

function passed(fixture: RoutingFixture, run: RoutingRunRecord): boolean {
  if (run.outcome.kind === "invalid-dispatch") return false;
  if (fixture.expected === "advisor") return run.outcome.kind === "dispatch" && run.outcome.persona === "advisor";
  return run.outcome.kind === "no-valid-dispatch" || (run.outcome.kind === "dispatch" && run.outcome.persona !== "advisor");
}

interface RoutingCell {
  readonly seat: RoutingConfig["variants"][number];
  readonly routingFixture: RoutingConfig["fixtures"][number];
  readonly variant: string;
  readonly fixture: string;
  readonly repeat: number;
}

interface RoutingExecutionOptions {
  readonly groups: readonly (readonly RoutingCell[])[];
  readonly completed: ReadonlySet<string>;
  readonly fixtures: RoutingConfig["fixtures"];
  readonly store: import("../../src/orchestration/modules/development/benchmark/run-store.js").RoutingRunStore;
  readonly run: (cell: RoutingCell) => Promise<import("../../src/orchestration/modules/development/benchmark/chat-routing-run.js").ChatRoutingOutcome>;
}

/** Runs cells through the CLI's durable attempt, completion, and report boundary. */
export async function executeRoutingBenchmark(options: RoutingExecutionOptions): Promise<{ readonly currentExecutionFailures: number; readonly cumulativeFailedAttempts: number }> {
  const currentExecutionFailures = await runMatrix({
    concurrency: VARIANT_CONCURRENCY,
    groups: options.groups,
    completed: options.completed,
    run: options.run,
    persist: async (cell, result) => {
      const { durationMs, accounting, ...outcome } = result;
      await options.store.appendRun({ kind: "chat-routing-run", variant: cell.variant, fixture: cell.fixture, repeat: cell.repeat, model: cell.seat.model, effort: cell.seat.effort, durationMs, accounting, outcome });
    },
    onError: async (cell, error) => {
      const failure = error instanceof ChatRoutingFailure
        ? error
        : new ChatRoutingFailure({ kind: "failed", code: "unexpected-error" }, 0, unavailableBenchmarkAccounting("the candidate failed before committed usage was observed"));
      await options.store.appendAttempt({
        kind: "chat-routing-attempt", attemptId: crypto.randomUUID(), at: new Date().toISOString(),
        variant: cell.variant, fixture: cell.fixture, repeat: cell.repeat, model: cell.seat.model, effort: cell.seat.effort,
        durationMs: failure.durationMs, accounting: failure.accounting, terminal: failure.terminal,
      });
    },
  });
  const settled = await options.store.loadRuns();
  const attempts = await options.store.loadAttempts();
  const report = settled.map((run) => ({ ...run, passed: passed(options.fixtures.find((fixture) => fixture.id === run.fixture) ?? (() => { throw new Error(`Unknown fixture ${run.fixture}`); })(), run) }));
  await options.store.writeArtifact("report.json", `${JSON.stringify({ currentExecutionFailures, cumulativeFailedAttempts: attempts.length, runs: report, attempts }, null, 2)}\n`);
  return { currentExecutionFailures, cumulativeFailedAttempts: attempts.length };
}

/** Writes the fixed fatal message used by the executable boundary. */
export function writeChatRoutingFatal(write: (text: string) => void): void {
  write("Chat routing benchmark failed");
}

export interface ChatRoutingCliDeps {
  readonly createRuntime: typeof createBenchmarkRuntime;
  readonly admitModels: typeof admitBenchmark;
  readonly createStore: typeof createRoutingRunStore;
  readonly createRoutingRegistry: () => ReadonlyMap<string, import("../../src/infra/agent-definition.js").AgentDefinition>;
  readonly writeOutput: (text: string) => void;
}

const PRODUCTION_DEPS: ChatRoutingCliDeps = {
  createRuntime: createBenchmarkRuntime,
  admitModels: admitBenchmark,
  createStore: createRoutingRunStore,
  createRoutingRegistry: () => {
    const directories = selectStartupDirectories({ projectRootOption: REPO_ROOT, env: process.env, cwd: REPO_ROOT });
    const definitions = createInstalledDefinitionRegistry(directories);
    return definitions.captureRevision().personas;
  },
  writeOutput: console.log,
};

export async function main(argv: readonly string[] = process.argv.slice(2), deps: ChatRoutingCliDeps = PRODUCTION_DEPS): Promise<void> {
  const args = parseArgs(argv);
  const routingRegistry = deps.createRoutingRegistry();
  const generatedGuidance = chatRoutingGuidance(routingRegistry);
  const directory = args.resume ?? join(RESULTS_ROOT, new Date().toISOString().replaceAll(":", "-"));
  const resumedStore = args.resume ? await deps.createStore({ resultsRoot: RESULTS_ROOT, directory }) : undefined;
  const storedConfig = await resumedStore?.loadConfig();
  const identityVariants = args.variants.length === 0 && storedConfig
    ? storedConfig.variants.map(({ model, effort }) => parseVariant(`${model}:${effort}`))
    : args.variants;
  const configInputs = { variants: identityVariants, repeats: storedConfig?.repeats ?? args.repeats };
  const matrix = planRoutingMatrix(configInputs);
  if (storedConfig && !sameIdentity(storedConfig, createRoutingConfig(configInputs, generatedGuidance, storedConfig.identity))) {
    throw new Error("Resume identity does not match the current Chat routing benchmark");
  }
  let priorRuns: readonly RoutingRunRecord[] = [];
  let priorAttempts: readonly RoutingAttemptRecord[] = [];
  if (resumedStore && !args.dryRun) {
    [priorRuns, priorAttempts] = await Promise.all([resumedStore.loadRuns(), resumedStore.loadAttempts()]);
    if (storedConfig) validatePersistedRows(storedConfig, priorRuns, priorAttempts);
  }
  await using runtime = await deps.createRuntime(REPO_ROOT, storedConfig ? { stored: storedConfig.identity } : {});
  if (storedConfig) runtime.assertUsageAuthority(storedConfig.identity);
  const admission = await deps.admitModels({
    ...runtime.deps,
    profileId: runtime.profileId,
    authorityIncarnation: runtime.usageAuthority.authorityIncarnation,
    launcher: runtime.launcher,
    background: runtime.background,
    foregroundBashHold: runtime.foregroundBashHold,
    shell: runtime.shell,
  }, configInputs.variants.map((variant) => ({ role: "candidate" as const, model: variant.model })));
  if (args.dryRun) {
    deps.writeOutput(JSON.stringify({
      dryRun: true,
      repoRoot: REPO_ROOT,
      fixtures: ROUTING_FIXTURES,
      variants: configInputs.variants,
      repeats: configInputs.repeats,
      cells: matrix.length,
      matrix,
      providerPlans: admission.providerPlans,
    }, null, 2));
    return;
  }
  const freshConfig = createRoutingConfig(configInputs, generatedGuidance, runtime.usageAuthority);
  if (storedConfig && !sameIdentity(storedConfig, freshConfig)) throw new Error("Resume profile identity does not match the Chat routing campaign");
  const config = storedConfig ?? freshConfig;
  if (!resumedStore) await mkdir(RESULTS_ROOT, { recursive: true });
  const store = resumedStore ?? await deps.createStore({ resultsRoot: RESULTS_ROOT, directory }, config);
  if (!resumedStore) {
    [priorRuns, priorAttempts] = await Promise.all([store.loadRuns(), store.loadAttempts()]);
  }
  const skills = runtime.deps.definitions.skills();
  const agents = routingRegistry;
  const completed = completionIndex(priorRuns, (run) => ({ variant: run.variant, fixture: run.fixture, repeat: run.repeat }));
  const variants = config.variants;
  const fixtures = config.fixtures;
  const groups = planMatrix(variants, fixtures, config.repeats).map((group) => group.map((cell) => ({ seat: cell.variant, routingFixture: cell.fixture, variant: cell.variant.id, fixture: cell.fixture.id, repeat: cell.repeat })));

  const { currentExecutionFailures } = await executeRoutingBenchmark({
    groups,
    completed,
    fixtures,
    store,
    // Each routing turn reads the pinned research corpus, so its AGENTS.md is fixed and no live project memory enters it.
    run: (cell) => withSnapshotWorkspace(REPO_ROOT, RESEARCH_SNAPSHOT, runtime.deps.runOwnedCommand, (workspace) => {
      const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({
        kind: "chat",
        enqueueNotification: () => {},
      }));
      return runChatRoutingTask({ createAgent: admission.runtime.createAgent, closeOwnedBackground: () => background.close() }, {
        model: cell.seat.model,
        effort: cell.seat.effort,
        prompt: cell.routingFixture.prompt,
        deadlineMs: config.deadlineMs,
        workspace,
        userDataRoot: runtime.deps.userDataRoot,
        accountHome: runtime.deps.accountHome,
        agentRegistry: agents,
        skills,
        moduleSelection: runtime.deps.moduleSelection,
        runtimeSurfaces: { background, foregroundBashHold: runtime.foregroundBashHold },
      });
    }),
  });
  const report = await store.loadRuns();
  if (currentExecutionFailures > 0 || report.some((row) => !passed(fixtures.find((fixture) => fixture.id === row.fixture) ?? (() => { throw new Error(`Unknown fixture ${row.fixture}`); })(), row))) process.exitCode = 1;
}

if (import.meta.main) main().catch(() => { writeChatRoutingFatal(console.error); process.exitCode = 1; });
