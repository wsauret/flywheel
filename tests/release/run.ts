/**
 * Release performance tier entry point.
 *
 * Drives the installed binary through tmux, computes medians over repeated
 * runs, and asserts the budgets in budgets.json: absolute ceilings always,
 * relative tolerances when a baseline binary is given (the published `latest`,
 * measured by the same process on the same machine so runner variance cancels).
 * The two binaries take turns rep by rep, in an order that flips every rep, so
 * load that changes during the run falls on both alike.
 *
 * Each invocation selects one baseline family: published-release comparisons
 * or pinned pre-D workflow comparisons. The performance gate always runs the
 * published family and adds workflow only with FLYWHEEL_RELEASE_BASELINE_DRIVER.
 * A single --only scenario infers its family; a whole set requires --comparison.
 *
 *   bun run test:release -- --binary <installed flywheel> --binary-home <installation HOME> [--baseline <installed flywheel> --baseline-home <installation HOME>] [--set startup|release] [--out <dir>] [--work <dir>] [--comparison published|workflow] [--only <scenario>]
 *
 * Installation homes supply only immutable builds, never account state. Each scenario gets its own activated copy before measurement.
 * The stable installed launchers remain under test. A self-contained legacy baseline can have no activation in its installation HOME.
 *
 * Exit code 1 on any budget violation or candidate scenario failure. Evidence
 * (boot stderr, pane captures, metrics.json) lands in the out directory. Each
 * run's workspace is a numbered directory under the work directory (`<out>/w`
 * unless `--work` names another), so its account socket stays short; the
 * workspace of a failed run is preserved there for forensics, and the run's
 * evidence directory names it in `workspace.txt`.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { RELEASE_HARNESS_ENVIRONMENT } from "../helpers/real-process-fixture.js"
import { removeWhenReleased } from "../helpers/remove-when-released.js"
import { copyActiveBuild } from "../helpers/placed-build.js"
import { generateFixtureWorkspace, RELEASE_WORKLOAD, SCROLL_WORKLOAD } from "./fixtures/generate-store.js"
import { generateUpgradeFixture } from "./fixtures/workflow-agent-previous-shape.js"
import { releaseWorkspace } from "./lib/workspaces.js"
import { assertBudgets, assertPairedBudgets, formatViolation, median, parseBudgets, type MetricValues, type MetricPair, type BudgetViolation } from "./lib/metrics.js"
import { measuresAccountService, missingRequiredMetrics, parseScenarioSet, repRoles, scenarioPairedBudgets, scenarioRows, type MeasurementRole, type ScenarioSet, type ScenarioRow, type Comparison } from "./lib/scenario-sets.js"
import { createTimeline, type Timeline } from "./lib/timeline.js"
import { readRevisionDriver, runRevisionDriver } from "./lib/revision-driver.js"
import type { ScenarioContext } from "./scenarios/scenario-context.js"
import { runAccountServiceScenario } from "./scenarios/account-service.js"
import { runStartupScenario } from "./scenarios/startup.js"
import { missingCandidateAccountServiceEvidence, missingCandidateSessionSummaryEvidence } from "./types.js"

const REPO_ROOT = resolve(import.meta.dir, "..", "..")

interface VariantOutcome {
  metrics: MetricValues
  failures: string[]
}

let sessionCounter = 0
/** Numbers each run's workspace directory under the work directory. */
let workspaceCount = 0

interface CliArgs {
  binary: string
  binaryHome: string
  baseline?: string
  baselineHome?: string
  set: ScenarioSet
  out: string
  /** Where the numbered run workspaces live. */
  work: string
  /** One scenario by name, for iterating on it; the whole set otherwise. */
  only?: string
  comparison: Exclude<Comparison, "all">
}

/** Resolves one baseline family before creating output directories. Rejects ambiguous or empty selections. */
export function parseReleaseArgs(argv: string[]): CliArgs {
  let binary: string | undefined
  let binaryHome: string | undefined
  let baseline: string | undefined
  let baselineHome: string | undefined
  let set: ScenarioSet = "release"
  let out: string | undefined
  let work: string | undefined
  let only: string | undefined
  let comparison: Comparison = "all"
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--binary") binary = argv[++i]
    else if (argv[i] === "--binary-home") binaryHome = argv[++i]
    else if (argv[i] === "--baseline") baseline = argv[++i]
    else if (argv[i] === "--baseline-home") baselineHome = argv[++i]
    else if (argv[i] === "--set") set = parseScenarioSet(argv[++i])
    else if (argv[i] === "--out") out = argv[++i]
    else if (argv[i] === "--work") work = argv[++i]
    else if (argv[i] === "--only") only = argv[++i]
    else if (argv[i] === "--comparison") {
      const value = argv[++i]
      if (value !== "all" && value !== "published" && value !== "workflow") throw new Error("invalid --comparison")
      comparison = value
    }
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  if (!binary || !binaryHome) throw new Error("--binary and --binary-home are required")
  if (Boolean(baseline) !== Boolean(baselineHome)) throw new Error("--baseline and --baseline-home must be given together")
  const families = (["published", "workflow"] as const).filter(family =>
    (comparison === "all" || comparison === family)
    && (scenarioRows(set, undefined, only, family).length > 0
      || (family === "published" && measuresAccountService(set, "candidate") && (only === undefined || only === "account-service"))))
  if (families.length > 1) throw new Error("select one comparison family with --comparison published|workflow; perf-gate orchestrates both")
  const selected = families[0]
  if (!selected) throw new Error(`scenario ${only} is not in the selected ${set} comparison`)
  const outDir = out ? resolve(out) : mkdtempSync(join(tmpdir(), "fwrel-"))
  return {
    binary: resolve(binary),
    binaryHome: resolve(binaryHome),
    ...(baseline ? { baseline: resolve(baseline) } : {}),
    ...(baselineHome ? { baselineHome: resolve(baselineHome) } : {}),
    set,
    comparison: selected,
    ...(only ? { only } : {}),
    out: outDir,
    work: work ? resolve(work) : join(outDir, "w"),
  }
}

/** Fresh isolated workspace: the pane cwd, the binary's HOME, and the project
 *  root. The repo's flywheel.toml rides along when present, matching the e2e
 *  harness, so the binary runs the project's own configuration. `evidenceDir`
 *  names the workspace, which lives under the work directory. */
function prepareWorkspace(workRoot: string, evidenceDir: string, binaryHome: string, role: MeasurementRole): string {
  const workDir = releaseWorkspace(workRoot, workspaceCount++)
  mkdirSync(join(workDir, ".flywheel"), { recursive: true })
  writeFileSync(join(evidenceDir, "workspace.txt"), `${workDir}\n`)
  copyActiveBuild(binaryHome, workDir, role === "baseline")
  const projectToml = join(REPO_ROOT, "flywheel.toml")
  if (existsSync(projectToml)) copyFileSync(projectToml, join(workDir, ".flywheel", "flywheel.toml"))
  return workDir
}

/** The binary and installation HOME that one role measures. */
interface Variant {
  binary: string
  home: string
}

function variant(args: CliArgs, role: MeasurementRole): Variant {
  if (role === "candidate") return { binary: args.binary, home: args.binaryHome }
  if (!args.baseline || !args.baselineHome) throw new Error("the baseline role needs --baseline and --baseline-home")
  return { binary: args.baseline, home: args.baselineHome }
}

/** One run of a row by one role in a fresh workspace. `repName` is `warmup`
 *  for a discarded run, or `rep<N>`. The workspace of a failed run stays for
 *  forensics. */
async function runOnce(args: CliArgs, role: MeasurementRole, row: ScenarioRow, repName: string, timeline: Timeline): Promise<VariantOutcome> {
  const scenarioName = row.name
  const { binary, home } = variant(args, role)
  const runDir = join(args.out, role, `${scenarioName}-${repName}`)
  mkdirSync(runDir, { recursive: true })
  const repTimeline = timeline.scope(repName)
  const workDir = await repTimeline.time("workspace", () => prepareWorkspace(args.work, runDir, home, role))
  const runnerFixture = process.env.FLYWHEEL_RELEASE_RUNNER_FIXTURE
  if (scenarioName === "runner-reconciliation") {
    if (!runnerFixture) throw new Error("runner reconciliation requires its tagged fixture")
    cpSync(join(runnerFixture, ".flywheel"), join(workDir, ".flywheel"), { recursive: true })
    const identity = JSON.parse(readFileSync(join(runnerFixture, "fixture.json"), "utf8"))
    const copiedHash = createHash("sha256").update(readFileSync(join(workDir, ".flywheel", "flywheel.sqlite"))).digest("hex")
    if (copiedHash !== identity.sha256) throw new Error("runner fixture copy differs from the tagged bytes")
    writeFileSync(join(runDir, "fixture.json"), `${JSON.stringify({ ...identity, copiedHash, preparation: "one unmeasured TUI open before runner measurement on both variants" }, null, 2)}\n`)
  } else if (row.withFixture) await repTimeline.time("fixture", () => generateFixtureWorkspace(workDir,
    scenarioName === "scroll" ? SCROLL_WORKLOAD : RELEASE_WORKLOAD))
  const context: ScenarioContext = {
    measurementRole: role,
    binaryPath: binary,
    workDir,
    evidenceDir: runDir,
    tmuxServer: join(args.work, "tmux"),
    sessionName: `fwrel-${process.pid}-${sessionCounter++}`,
    environment: ISOLATED_HUB_ENVIRONMENT,
    timeline: repTimeline,
  }
  if (scenarioName === "runner-reconciliation") {
    const prepareDir = join(runDir, "prepare")
    mkdirSync(prepareDir, { recursive: true })
    const prepared = await runStartupScenario({ ...context, evidenceDir: prepareDir, sessionName: `${context.sessionName}-prepare` }, "startup.large")
    if (prepared.failures.length > 0) return { metrics: {}, failures: prepared.failures.map(failure => `unmeasured runner preparation: ${failure}`) }
  }
  const result = await repTimeline.time("scenario", () => row.run(context))
  result.failures.push(...missingRequiredMetrics(row, result.metrics, process.platform, role)
    .map(metric => `required metric ${metric} is absent or not finite`))
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`)
  console.log(`[${role}] ${scenarioName} ${repName}: ${JSON.stringify(result)}`)
  if (result.failures.length > 0) return { metrics: result.metrics, failures: result.failures.map(failure => `${scenarioName} ${repName}: ${failure}`) }
  // The tree is gone when dispose returns, and Windows still releases its
  // handles a moment later, so the removal retries within a bound.
  await repTimeline.time("cleanup", () => removeWhenReleased(workDir))
  return { metrics: result.metrics, failures: [] }
}

interface RoleOutcomes {
  candidate: VariantOutcome
  baseline: VariantOutcome
}

type RepOutcomes = Partial<RoleOutcomes>

/** One row's reps: in each rep, one run per role that measures the row, in
 *  the order `repRoles` gives, so the two binaries meet the same machine
 *  load. `warmup` adds a discarded run before each role's first rep: it pays
 *  first-touch costs (page cache, dyld and inode caches) that a user upgrading
 *  in place does not see. Those costs belong to the binary, not the scenario,
 *  so only the first row pays them; a later row's first rep may still touch a
 *  few cold code pages, and the median of three absorbs that one rep. A
 *  failure in the first rep ends the row: every later rep would repeat it,
 *  and failing fast keeps the output small. */
async function runRowReps(args: CliArgs, row: ScenarioRow, warmup: boolean, timeline: Timeline): Promise<RepOutcomes[]> {
  const reps: RepOutcomes[] = []
  for (let rep = 1; rep <= row.reps; rep++) {
    const outcomes: RepOutcomes = {}
    for (const role of repRoles(row, rep, args.baseline !== undefined)) {
      const roleTimeline = timeline.scope(`pair${rep}/${role}`)
      const discarded = warmup && rep === 1 ? await runOnce(args, role, row, "warmup", roleTimeline) : undefined
      outcomes[role] = discarded && discarded.failures.length > 0 ? { metrics: {}, failures: discarded.failures }
        : await runOnce(args, role, row, `rep${rep}`, roleTimeline)
    }
    reps.push(outcomes)
    if (rep === 1 && Object.values(outcomes).some(outcome => outcome.failures.length > 0)) break
  }
  return reps
}

/** Each metric's median over the runs that produced it. */
function medianMetrics(runs: readonly MetricValues[]): MetricValues {
  const perMetric = new Map<string, number[]>()
  for (const run of runs) for (const [metric, value] of Object.entries(run)) perMetric.set(metric, [...(perMetric.get(metric) ?? []), value])
  return Object.fromEntries([...perMetric].map(([metric, values]) => [metric, median(values)]))
}

/** Both variants bind an ephemeral hub so neither collides with the operator's
 *  own `flywheel serve` on 41000 (src/cli/serve.ts releaseHarnessRuntimeOptions).
 *  Every published baseline the gate can fetch honors this contract. Every
 *  scenario launches with this environment, so each process a scenario
 *  starts carries the release harness marker that the gate's sweeps match. */
const ISOLATED_HUB_ENVIRONMENT = {
  ...RELEASE_HARNESS_ENVIRONMENT,
  FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0",
  FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS: "1",
} as const

interface PairedEvidence {
  [scenario: string]: MetricPair[]
}

interface PublishedOutcome {
  candidate: VariantOutcome
  baseline?: VariantOutcome
  pairs: PairedEvidence
}

/** The published family. Each role's metric is the median of its successful
 *  runs, which the ceilings judge; every rep of a row in which both roles
 *  succeeded is a matched pair, which the tolerances judge. */
async function runPublished(args: CliArgs, timeline: Timeline): Promise<PublishedOutcome> {
  const roles = args.baseline === undefined ? (["candidate"] as const) : (["candidate", "baseline"] as const)
  for (const role of roles) console.log(`[${role}] measuring ${variant(args, role).binary} (${args.set} set)`)
  const outcomes: RoleOutcomes = { candidate: { metrics: {}, failures: [] }, baseline: { metrics: {}, failures: [] } }
  const pairs: PairedEvidence = {}
  for (const [index, row] of scenarioRows(args.set, undefined, args.only, "published").entries()) {
    const reps = await timeline.time(row.name, () => runRowReps(args, row, index === 0, timeline.scope(row.name)))
    for (const role of roles) {
      const runs = reps.flatMap(rep => rep[role] ?? [])
      outcomes[role].failures.push(...runs.flatMap(run => run.failures))
      Object.assign(outcomes[role].metrics, medianMetrics(runs.filter(run => run.failures.length === 0).map(run => run.metrics)))
    }
    const matched = reps.flatMap(({ candidate, baseline }) => candidate && baseline && candidate.failures.length === 0 && baseline.failures.length === 0
      ? [{ candidate: candidate.metrics, baseline: baseline.metrics }] : [])
    if (matched.length > 0) pairs[row.name] = matched
  }
  if (measuresAccountService(args.set, "candidate") && (args.only === undefined || args.only === "account-service")) {
    const scenarioName = "account-service"
    const runDir = join(args.out, "candidate", scenarioName)
    mkdirSync(runDir, { recursive: true })
    const workDir = await timeline.time("account-service-workspace", () => prepareWorkspace(args.work, runDir, args.binaryHome, "candidate"))
    const accountService = await timeline.time(scenarioName, () => runAccountServiceScenario({
      measurementRole: "candidate",
      binaryPath: args.binary,
      workDir,
      evidenceDir: runDir,
      tmuxServer: join(args.work, "tmux"),
      sessionName: `fwrel-${process.pid}-${sessionCounter++}`,
      environment: ISOLATED_HUB_ENVIRONMENT,
      timeline: timeline.scope(scenarioName),
    }))
    Object.assign(outcomes.candidate.metrics, accountService.metrics)
    outcomes.candidate.failures.push(
      ...accountService.failures.map((failure) => `${scenarioName}: ${failure}`),
      ...missingCandidateAccountServiceEvidence(accountService.metrics).map((metric) => `${scenarioName}: required candidate metric ${metric} is absent or malformed`),
    )
  }
  for (const role of roles) {
    for (const [metric, value] of Object.entries(outcomes[role].metrics)) console.log(`[${role}] ${metric} = ${value.toFixed(1)}`)
    for (const failure of outcomes[role].failures) console.log(`[${role}] FAILURE ${failure}`)
  }
  return { candidate: outcomes.candidate, ...(args.baseline === undefined ? {} : { baseline: outcomes.baseline }), pairs }
}

async function main(): Promise<void> {
  const args = parseReleaseArgs(process.argv.slice(2))
  mkdirSync(args.out, { recursive: true })
  mkdirSync(args.work, { recursive: true })
  const budgets = parseBudgets(await Bun.file(join(import.meta.dir, "budgets.json")).json())

  const timeline = createTimeline()
  if (args.comparison !== "workflow" && scenarioRows(args.set, "candidate", args.only, "published").some(row => row.name === "runner-reconciliation")) {
    const manifestPath = process.env.FLYWHEEL_RELEASE_PUBLISHED_DRIVER
    const tag = process.env.FLYWHEEL_RELEASE_PUBLISHED_TAG
    if (!manifestPath || !tag) throw new Error("runner fixture requires the published tag and revision driver")
    const manifest = readRevisionDriver(manifestPath, tag)
    const directory = mkdtempSync(join(args.work, "runner-fixture-"))
    const evidenceDir = join(args.out, "runner-fixture")
    mkdirSync(evidenceDir, { recursive: true })
    const generated = await runRevisionDriver({
      measurementRole: "baseline", binaryPath: args.baseline ?? args.binary, workDir: directory,
      evidenceDir, tmuxServer: join(args.work, "tmux"), sessionName: `fwfixture-${process.pid}`, environment: ISOLATED_HUB_ENVIRONMENT, timeline,
    }, "runner-fixture", true)
    if (generated.failures.length > 0) throw new Error(generated.failures.join("; "))
    const identity = {
      sourceRevision: manifest.sourceRevision, releaseTag: tag, driverSha256: manifest.driverSha256,
      sha256: createHash("sha256").update(readFileSync(join(directory, ".flywheel", "flywheel.sqlite"))).digest("hex"),
      workload: generated.metrics,
    }
    writeFileSync(join(directory, "fixture.json"), `${JSON.stringify(identity, null, 2)}\n`)
    writeFileSync(join(evidenceDir, "fixture.json"), `${JSON.stringify(identity, null, 2)}\n`)
    process.env.FLYWHEEL_RELEASE_RUNNER_FIXTURE = directory
  }
  const workflowRows = args.comparison === "published" ? [] : scenarioRows(args.set, "candidate", args.only, "workflow")
  if (workflowRows.length > 0 && (!args.baseline || !args.baselineHome)) throw new Error("workflow comparisons require the compatible pre-D baseline")
  if (workflowRows.some(row => row.name === "workflow-agent-upgrade")) {
    const manifestPath = process.env.FLYWHEEL_RELEASE_BASELINE_DRIVER
    if (!manifestPath) throw new Error("previous-shape generation requires FLYWHEEL_RELEASE_BASELINE_DRIVER")
    const manifest = readRevisionDriver(manifestPath)
    writeFileSync(join(args.out, "baseline-driver.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    const fixture = mkdtempSync(join(args.work, "previous-shape-"))
    await timeline.time("previous-shape-generation", () => generateUpgradeFixture(fixture, manifest.sourceRoot))
    process.env.FLYWHEEL_RELEASE_UPGRADE_FIXTURE = fixture
  }
  const writeTimings = () => {
    writeFileSync(join(args.out, "timings.json"), `${JSON.stringify(timeline.entries(), null, 2)}\n`)
    console.log(`\nwhere the time went:\n${timeline.summary()}`)
  }

  const published: PublishedOutcome = args.comparison === "workflow" ? { candidate: { metrics: {}, failures: [] }, pairs: {} }
    : await timeline.time("published", () => runPublished(args, timeline.scope("published")))
  const { candidate, baseline } = published
  if (args.comparison !== "workflow" && (args.only === undefined || args.only === "session-summary")) candidate.failures.push(...missingCandidateSessionSummaryEvidence(candidate.metrics)
    .map((metric) => `session-summary: required candidate metric ${metric} is absent or malformed`))
  if (baseline) candidate.failures.push(...baseline.failures.map(failure => `baseline: ${failure}`))
  const violations = assertBudgets(candidate.metrics, budgets, Object.values(published.pairs).flat())
  const pairedEvidence: PairedEvidence = { ...published.pairs }
  const pairedViolations: BudgetViolation[] = []
  for (const row of workflowRows) {
    const pairs: MetricPair[] = []
    pairedEvidence[row.name] = pairs
    for (const { candidate: current, baseline: previous } of await timeline.time(row.name, () => runRowReps(args, row, false, timeline.scope(row.name)))) {
      if (!current || !previous) throw new Error("missing paired outcome")
      candidate.failures.push(...current.failures, ...previous.failures.map(failure => `baseline: ${failure}`))
      const pair = { candidate: current.metrics, baseline: previous.metrics }
      pairs.push(pair)
      violations.push(...assertBudgets(current.metrics, budgets, [pair]))
    }
    try { pairedViolations.push(...assertPairedBudgets(pairs, scenarioPairedBudgets(row, budgets))) }
    catch (error) { candidate.failures.push(`${row.name}: ${String(error)}`) }
  }
  violations.push(...pairedViolations)
  writeTimings()
  const report = {
    generatedAt: new Date().toISOString(),
    binary: args.binary,
    baselineBinary: args.baseline,
    set: args.set,
    candidate: candidate.metrics,
    baseline: baseline?.metrics,
    pairedEvidence,
    violations,
    failures: candidate.failures,
  }
  writeFileSync(join(args.out, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`)

  console.log(`\nmetrics.json: ${join(args.out, "metrics.json")}`)
  for (const violation of violations) console.log(`BUDGET VIOLATION ${formatViolation(violation)}`)
  if (violations.length === 0 && candidate.failures.length === 0) {
    console.log("release performance gate: PASS")
    return
  }
  console.log(`release performance gate: FAIL (${violations.length} violations, ${candidate.failures.length} failures); evidence: ${args.out}`)
  process.exitCode = 1
}

if (import.meta.main) await main()
