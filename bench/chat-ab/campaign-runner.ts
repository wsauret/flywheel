import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createCliLauncher } from "../../src/cli/runtime-launch.js";
import { bytesIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import type { HeadlessBenchmarkInput } from "../../src/orchestration/modules/development/benchmark/headless-execution.js";
import type { HeadlessBenchmarkExecution } from "../../src/orchestration/modules/development/benchmark/headless-execution-contract.js";
import { errorMessage } from "../../src/infra/error-message.js";
import { readJsonFile, writeArtifactFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { benchmarkInfrastructureIdentity, requireStrictBenchmarkSettlement } from "./benchmark-infrastructure.js";
import { campaignArtifactReference } from "./campaign-artifacts.js";
import { campaignHeadlessOutcome, type CampaignSettlement } from "./campaign-execution.js";
import type { CampaignCell, CampaignExecutionOutcome, CampaignManifestFields, CampaignManifest, CampaignOutcome, CampaignRoles, createCampaignLedger } from "./campaign-store.js";
import type { OwnedCommandRunner } from "../../src/infra/owned-command.js";
import type { Effort } from "../../src/infra/workflow-types.js";
import { REPO_ROOT, RESULTS_ROOT } from "./harness-paths.js";
import { resolveCampaignSubject, type CampaignInvocationCapture, type CampaignTreatment, type CampaignSubjectKind, type PreparedCampaignSubject } from "./campaign-subject.js";
import { benchmarkCommandRunner } from "./benchmark-command.js";
import { cellIsolation, inheritedCellEnvironment } from "./isolation.js";
import type { Sandbox } from "./tasks.js";

export interface CampaignRunOptions {
  action: "plan" | "setup" | "run" | "resume";
  results: string;
  reservedEvaluation: boolean;
  keepSandboxes: boolean;
  dryRun: boolean;
}

export interface CampaignDesign {
  readonly name: string;
  readonly tasks: readonly string[];
  /** Omission selects each task's original message.md. */
  readonly message?: CampaignManifestFields["message"];
  readonly challenge?: true;
  readonly repeats: number;
  readonly model: string;
  readonly effort: Effort;
  readonly authProfile: string;
  /** The role table of every Flywheel treatment that names none of its own. */
  readonly roles?: CampaignRoles;
  readonly treatments: { readonly [id: string]: string | CampaignTreatment };
}


/** Families own task identities, capture, grades, and completion authority. */
export interface CampaignFamily<Task extends { readonly id: string }, Grade extends object, Manifest extends CampaignManifest, Outcome extends CampaignOutcome> {
  readonly kind: Manifest["kind"];
  readonly workflowsMode?: "on";
  readonly environmentIdentity?: () => Promise<string>;
  readonly hiddenTaskDirs: readonly string[];
  readonly ledger: ReturnType<typeof createCampaignLedger<Manifest, Outcome>>;
  readonly requireWritable: (manifest: Manifest) => void;
  readonly requireDirectory?: (directory: string) => Promise<void>;
  readonly loadTasks: (ids: readonly string[], input: CampaignRunOptions) => Promise<readonly Task[]>;
  readonly taskIdentity: (task: Task) => Manifest["tasks"][number];
  readonly qualify: (task: Task, run: OwnedCommandRunner) => Promise<void>;
  /** The content identity a family adds to a treatment, such as its Chat arm. */
  readonly treatmentIdentity?: (id: string) => string;
  readonly manifest: (fields: CampaignManifestFields, tasks: readonly Task[]) => Manifest;
  readonly provision: (task: Task, run: OwnedCommandRunner, workspaceRoot: string, treatment: string, subject: CampaignSubjectKind) => Promise<Sandbox>;
  readonly message: (task: Task, treatment: string, subject: CampaignSubjectKind) => NonNullable<HeadlessBenchmarkInput["message"]>;
  readonly challenge?: (task: Task) => string | undefined;
  readonly emptyCapture: () => Grade;
  /** Recover only finished family artifacts. Unfinished grades remain unavailable. */
  readonly recoverCapture?: (directory: string, artifactRoot: string) => Promise<Grade>;
  readonly settle?: CampaignSettlement<Grade>;
  readonly capture: (task: Task, sandbox: Sandbox, run: OwnedCommandRunner, handoff: HeadlessBenchmarkExecution["handoff"], context: {
    readonly executions: readonly HeadlessBenchmarkExecution[];
    readonly cell: CampaignCell;
    readonly artifactRoot: string;
    readonly directory: string;
    readonly searchEvents?: (sessionId: string | undefined, type: string, path: string) => ReturnType<NonNullable<PreparedCampaignSubject["searchEvents"]>>;
  }) => Promise<{ grade: Grade; diff: string }>;
  readonly report: (directory: string) => Promise<string>;
}

/** Retain artifacts as each capture settles, so a later failure does not discard earlier references.
 * Failed subjects keep their execution evidence without invoking the family grader. */
export async function captureCampaignResult<Grade extends object>(
  directory: string, artifactRoot: string, result: HeadlessBenchmarkExecution,
  artifacts: Grade & { report: CampaignExecutionOutcome["report"]; diff: CampaignExecutionOutcome["diff"] },
  capture: () => Promise<{ grade: Grade; diff: string }>,
  capturesFailedRuns = false,
): Promise<void> {
  if (result.handoff) {
    const path = join(artifactRoot, "handoff.json");
    const text = JSON.stringify(result.handoff, null, 2);
    await writeArtifactFile(path, text);
    artifacts.report = { path: campaignArtifactReference(directory, path), sha256: bytesIdentity(text) };
  }
  // A failed run has nothing to grade, unless the family owns completion and
  // can find completed work under a failed origin, as a step under a failed Chat.
  if (result.outcome === "failed" && !capturesFailedRuns) return;
  const captured = await capture();
  Object.assign(artifacts, captured.grade);
  const path = join(artifactRoot, "diff.patch");
  await writeArtifactFile(path, captured.diff);
  artifacts.diff = { path: campaignArtifactReference(directory, path), sha256: bytesIdentity(captured.diff) };
}

/** Settle interrupted attempts once, without inferring subject completion or accounting. */
export async function recoverCampaignAttempts<Grade extends object, Manifest extends CampaignManifest, Outcome extends CampaignOutcome>(
  directory: string, manifest: Manifest,
  family: Pick<CampaignFamily<{ readonly id: string }, Grade, Manifest, Outcome>, "ledger" | "emptyCapture" | "recoverCapture" | "settle">,
) {
  const store = await family.ledger.open(directory, manifest);
  const { attempts, settled } = family.ledger.validate(manifest, await store.load());
  for (const [attemptId, attempt] of attempts) {
    if (settled.has(attemptId)) continue;
    const recovered = await family.recoverCapture?.(directory, join(directory, attempt.directory, "artifacts"));
    await store.append(family.ledger.decodeOutcome(manifest,
      campaignHeadlessOutcome(directory, attempt, [], 0, { ...family.emptyCapture(), ...recovered, report: null, diff: null }, false, new Map(), family.settle)));
  }
}

/** Execute one immutable family campaign through the published headless adapter. */
export async function runCampaign<Task extends { readonly id: string }, Grade extends object, Manifest extends CampaignManifest, Outcome extends CampaignOutcome>(
  input: CampaignRunOptions, loadDesign: () => Promise<CampaignDesign>, family: CampaignFamily<Task, Grade, Manifest, Outcome>,
): Promise<void> {
  await family.requireDirectory?.(input.results);
  if (["run", "resume"].includes(input.action) && await readJsonFile(join(input.results, "campaign.json")) !== undefined) {
    family.requireWritable((await family.ledger.open(input.results)).manifest);
  } else if (input.action === "resume") {
    await family.ledger.open(input.results);
  }
  requireStrictBenchmarkSettlement();
  const design = await loadDesign();
  const launcher = await createCliLauncher();
  try {
    const run = benchmarkCommandRunner(launcher.scope);
    const selections = await Promise.all(Object.entries(design.treatments).map(async ([id, value]) => {
      const treatment: CampaignTreatment = typeof value === "string" ? { revision: value } : value;
      const roles = treatment.subject === "claude-code" ? undefined : treatment.roles ?? design.roles;
      const settings = { model: treatment.model ?? design.model, effort: treatment.effort ?? design.effort, authProfile: treatment.subject === "claude-code" ? design.authProfile : treatment.authProfile ?? design.authProfile, ...(roles ? { roles } : {}), ...(family.workflowsMode ? { workflowsMode: family.workflowsMode } : {}) };
      return { id, ...settings, subject: await resolveCampaignSubject(treatment, settings, run, family.treatmentIdentity?.(id)) };
    }));
    const tasks = await family.loadTasks(design.tasks, input);
    const environmentIdentity = await family.environmentIdentity?.();
    if (input.action === "plan" || input.dryRun) {
      console.log(JSON.stringify({
        dryRun: true, name: design.name, ...(design.message ? { message: design.message } : {}), ...(design.challenge ? { challenge: true } : {}), model: design.model, effort: design.effort, operatorProfile: design.authProfile,
        executionProfile: design.authProfile, answers: "approve-root-workflow-launch", cells: selections.length * tasks.length * design.repeats,
        ...(family.workflowsMode ? { workflowsMode: family.workflowsMode, precondition: "Set Workflows On in account settings; every cell verifies it before task submission without changing it" } : {}),
        treatments: selections.map(({ id, subject, model, effort, authProfile, roles }) => ({ id, model, effort, authProfile: subject.kind === "claude-code" ? "Claude Code login" : authProfile, ...(roles ? { roles } : {}), ...subject.identity,
          ...(family.treatmentIdentity ? { family: family.treatmentIdentity(id) } : {}) })),
        tasks: tasks.map(family.taskIdentity),
        ...(environmentIdentity ? { environmentIdentity } : {}),
      }, null, 2));
      return;
    }
    const prepared = new Map<string, PreparedCampaignSubject>();
    for (const { id, subject } of selections) {
      console.log(`[${family.kind}] prepare ${id} ${subject.kind}`);
      prepared.set(id, await subject.prepare(join(input.results, "sources", id)));
    }
    for (const task of tasks) await family.qualify(task, run);
    const settings = new Map<string, string>();
    const isolated = async (treatment: PreparedCampaignSubject, directory: string, projectRoot: string) => {
      const confinement = treatment.confinement(family.hiddenTaskDirs);
      const claudeCodeSessionId = treatment.kind === "claude-code" ? crypto.randomUUID() : undefined;
      const isolation = await (await cellIsolation(REPO_ROOT, input.results, run, treatment.isolationAgent))
        .confine({
          ...confinement,
          hidden: [RESULTS_ROOT, input.results, ...family.hiddenTaskDirs, ...confinement.hidden],
          own: [directory, ...confinement.own],
          ...(claudeCodeSessionId ? { claudeCode: { projectRoot, sessionId: claudeCodeSessionId } } : {}),
        });
      const tmp = join(directory, "tmp");
      await mkdir(tmp, { recursive: true });
      return {
        launcher: launcher.scope,
        env: { ...inheritedCellEnvironment(process.env), HOME: isolation.accountHome, TMPDIR: tmp, TMUX_TMPDIR: tmp,
          ...treatment.environment },
        wrapCommand: (command: readonly string[]) => isolation.wrap(command),
        ...(claudeCodeSessionId ? { claudeCodeSessionId } : {}),
      };
    };
    for (const [id, treatment] of prepared) {
      const directory = join(input.results, "preflight", id, crypto.randomUUID());
      const workspaceRoot = join(directory, "workspace");
      const projectRoot = join(workspaceRoot, "project");
      await mkdir(projectRoot, { recursive: true });
      settings.set(id, await treatment.preflight({ ...await isolated(treatment, workspaceRoot, projectRoot), projectRoot, artifactDir: join(directory, "artifacts", "execution") }));
    }
    if (input.action === "setup") {
      console.log(`[${family.kind}] ${prepared.size} subjects prepared; ${tasks.length} tasks qualified; no candidate ran${family.workflowsMode ? "; Workflows On verified; keep account settings On for every cell" : ""}`);
      return;
    }
    const manifest = family.manifest({
      version: 2, name: design.name, model: design.model, effort: design.effort,
      authProfile: design.authProfile, answers: "approve-root-workflow-launch",
      ...(design.message ? { message: design.message } : {}),
      ...(design.challenge ? { challenge: true } : {}),
      infrastructureIdentity: await benchmarkInfrastructureIdentity(),
      ...(environmentIdentity ? { environmentIdentity } : {}),
      treatments: [...prepared].map(([id, treatment]) => treatment.record(id, settings.get(id)!)),
      repeats: design.repeats, createdAt: new Date().toISOString(),
    }, tasks);
    const store = await family.ledger.open(input.results, manifest);
    await recoverCampaignAttempts(input.results, manifest, family);
    const events = await store.load();
    const pending = family.ledger.pending(manifest, events);
    console.log(`[${family.kind}] ${pending.length} cells pending`);
    for (const cell of pending) {
      if (family.environmentIdentity && await family.environmentIdentity() !== environmentIdentity) throw new Error("Campaign skill catalog changed; refuse cell before model work");
      const treatment = prepared.get(cell.treatment)!;
      await treatment.validate();
      const attemptId = crypto.randomUUID();
      const directory = `cells/${cell.treatment}-${cell.task}-r${cell.repeat}-${attemptId}`;
      const attempt = { kind: "attempt" as const, attemptId, cell, at: new Date().toISOString(), directory };
      await mkdir(join(input.results, directory), { recursive: true });
      await store.append(attempt);
      console.log(`[${family.kind}] ${cell.treatment} ${cell.task} repeat ${cell.repeat}`);
      const cellRoot = join(input.results, directory);
      const workspaceRoot = join(cellRoot, "workspace");
      const artifactRoot = join(cellRoot, "artifacts");
      await mkdir(workspaceRoot, { recursive: true });
      const task = tasks.find((candidate) => candidate.id === cell.task)!;
      const executions: HeadlessBenchmarkExecution[] = [];
      const questionArtifacts = new Map<number, HeadlessBenchmarkExecution["artifacts"]>();
      const artifacts: Grade & Pick<CampaignExecutionOutcome, "report" | "diff"> = { ...family.emptyCapture(), report: null, diff: null };
      const invocation: CampaignInvocationCapture = { executions, questionArtifacts, answered: new Set(), approvals: 0, ...(design.challenge ? { challenge: { delivered: "none", reason: "cell did not reach challenge delivery" } } : {}) };
      let outcome: ReturnType<typeof campaignHeadlessOutcome>;
      let failed = false;
      let sandbox: Sandbox | undefined;
      try {
        const preparedSandbox = await family.provision(task, run, workspaceRoot, cell.treatment, treatment.kind);
        sandbox = preparedSandbox;
        const subject = { ...await isolated(treatment, workspaceRoot, preparedSandbox.dir), projectRoot: preparedSandbox.dir, artifactDir: artifactRoot };
        const result = await treatment.execute(subject, family.message(task, cell.treatment, treatment.kind), invocation, family.challenge?.(task));
        await captureCampaignResult(input.results, artifactRoot, result, artifacts,
          () => family.capture(task, preparedSandbox, run, result.handoff, {
            executions, cell, artifactRoot, directory: input.results,
            ...(treatment.searchEvents ? { searchEvents: (sessionId, type, path) => treatment.searchEvents!(subject, sessionId, type, path) } : {}),
          }), family.settle !== undefined);
      } catch (error) {
        failed = true;
        console.error(`[${family.kind}] ${cell.treatment} ${cell.task} repeat ${cell.repeat} failed: ${errorMessage(error)}`);
      } finally {
        const captured = {
          ...artifacts, ...(invocation.challenge ? { challenge: invocation.challenge } : {}),
          ...(invocation.challengeReply ? { challengeReply: {
            path: campaignArtifactReference(input.results, invocation.challengeReply.path), sha256: invocation.challengeReply.sha256,
          } } : {}),
        };
        outcome = campaignHeadlessOutcome(input.results, attempt, executions, invocation.approvals, captured, failed, questionArtifacts, family.settle);
        await store.append(family.ledger.decodeOutcome(manifest, outcome));
        if (sandbox && !input.keepSandboxes) await sandbox.dispose();
      }
      if (outcome.status === "failed") throw new Error(`Cell execution or capture failed; attempt retained in ${directory}. Resume after resolving the error.`);
    }
    console.log(await family.report(input.results));
  } finally {
    await launcher.dispose();
  }
}

