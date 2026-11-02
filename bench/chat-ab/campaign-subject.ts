import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { OwnedCommandRunner } from "../../src/infra/owned-command.js";
import { ownedCommandRunner } from "../../src/infra/owned-command.js";
import type { LauncherScope } from "../../src/infra/process-supervisor.js";
import type { Effort } from "../../src/infra/workflow-types.js";
import { bytesIdentity, structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { canonicalModelId } from "../../src/infra/llm/model-id.js";
import { executeClaudeCodeBenchmark } from "../../src/orchestration/modules/development/benchmark/claude-code-execution.js";
import { executeHeadlessBenchmark, type HeadlessBenchmarkInput } from "../../src/orchestration/modules/development/benchmark/headless-execution.js";
import type { HeadlessBenchmarkExecution } from "../../src/orchestration/modules/development/benchmark/headless-execution-contract.js";
import { writeArtifactFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import type { CampaignExecutionOutcome, CampaignRoles, CampaignTreatmentRecord } from "./campaign-store.js";
import { campaignDesignAnswer, campaignWorkflowApproval, recordCampaignAnswer } from "./campaign-policy.js";
import { challengeConversationEvidence } from "./challenge-reply.js";
import { REPO_ROOT } from "./harness-paths.js";
import { prepareSourceTreatment, resolveSourceTreatment, validatePreparedTreatment } from "./source-treatment.js";
import type { CellAgent, CellIsolation } from "./isolation.js";
import { BUNDLED_SKILL_DIR } from "../../src/workflows/skill-source-inventory.js";
import { captureBenchmarkPipe } from "../../src/orchestration/modules/development/benchmark/artifact-capture.js";
import { campaignToolExclusionEvidence } from "./campaign-tool-evidence.js";

export type CampaignSubjectKind = "flywheel" | "claude-code";
interface SubjectSettings {
  readonly model: string;
  readonly effort: Effort;
  readonly authProfile: string;
  readonly roles?: CampaignRoles;
  readonly workflowsMode?: "on";
}
export type CampaignTreatment =
  | { readonly subject?: "flywheel"; readonly revision: string; readonly patches?: readonly string[]; readonly model?: string; readonly effort?: Effort; readonly authProfile?: string; readonly roles?: CampaignRoles; readonly disabledTools?: readonly string[] }
  | { readonly subject: "claude-code"; readonly model?: string; readonly effort?: Effort; readonly ultracode?: true };

export interface CampaignSubjectContext {
  readonly launcher: LauncherScope;
  readonly projectRoot: string;
  readonly artifactDir: string;
  readonly env: { readonly [name: string]: string | undefined };
  readonly wrapCommand: (command: readonly string[]) => readonly string[];
  readonly claudeCodeSessionId?: string;
}
export interface CampaignInvocationCapture {
  readonly executions: HeadlessBenchmarkExecution[];
  readonly questionArtifacts: Map<number, HeadlessBenchmarkExecution["artifacts"]>;
  readonly answered: Set<string>;
  approvals: number;
  challenge?: CampaignExecutionOutcome["challenge"];
  challengeReply?: HeadlessBenchmarkExecution["artifacts"][string];
}
export interface PreparedCampaignSubject {
  readonly kind: CampaignSubjectKind;
  readonly isolationAgent: CellAgent;
  readonly environment: { readonly [name: string]: string };
  confinement(hiddenTaskDirs: readonly string[]): Parameters<CellIsolation["confine"]>[0];
  preflight(context: CampaignSubjectContext): Promise<string>;
  record(id: string, settingsIdentity: string): CampaignTreatmentRecord;
  validate(): Promise<void>;
  searchEvents?(context: CampaignSubjectContext, sessionId: string | undefined, type: string, path: string): ReturnType<typeof captureCampaignEventSearch>;
  execute(context: CampaignSubjectContext, message: NonNullable<HeadlessBenchmarkInput["message"]>, capture: CampaignInvocationCapture, challenge?: string): Promise<HeadlessBenchmarkExecution>;
}

async function binaryIdentity(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

/** Claude Code's CLI takes dashed model ids rather than Flywheel's decimal canonical ids. */
function claudeCodeModelId(model: string): string {
  return canonicalModelId(model).replace(/(\d)\.(\d)/g, "$1-$2");
}

function controllerWriteDenied(): string[] {
  return [join(REPO_ROOT, "node_modules", ".cache"), join(BUNDLED_SKILL_DIR, ".locks")];
}

/** Stream one public event search into immutable artifacts before returning to cell cleanup. */
export async function captureCampaignEventSearch(input: HeadlessBenchmarkInput, sessionId: string | undefined, type: string | readonly string[], path: string) {
  const scope = input.launcher.open();
  let response: { stdout: HeadlessBenchmarkExecution["artifacts"][string]; stderr: HeadlessBenchmarkExecution["artifacts"][string] } | undefined;
  let failure: { cause: unknown } | undefined;
  try {
    const command = [...input.commandPrefix, "events", "search", ...(sessionId ? ["--session", sessionId] : []),
      ...(typeof type === "string" ? [type] : type).flatMap((value) => ["--type", value]),
      "--limit", "0", "--json", "--project-root", input.projectRoot];
    const reader = await scope.spawnOwned(input.wrapCommand ? input.wrapCommand(command) : command, {
      cwd: input.projectRoot, env: { ...input.env, FLYWHEEL_AUTH_PROFILE: input.profile },
    });
    reader.stdin?.end();
    const stop = () => { void reader.terminate().catch(() => {}); };
    const pipes = await Promise.allSettled([
      captureBenchmarkPipe(reader.stdout, path, undefined, stop),
      captureBenchmarkPipe(reader.stderr, `${path}.stderr`, undefined, stop),
    ] as const);
    const exit = await reader.exited;
    const [stdout, stderr] = pipes;
    if (exit.code !== 0 || exit.ownership !== "surrendered" || stdout.status !== "fulfilled" || stderr.status !== "fulfilled") throw new Error(`Subject ${type} capture failed`);
    response = { stdout: stdout.value, stderr: stderr.value };
  } catch (cause) {
    failure = { cause };
  }
  const closure = await scope.close();
  if (!closure.settled) throw new Error(`Subject ${type} capture ownership unsettled: ${closure.reason}`, { cause: failure?.cause });
  if (failure) throw failure.cause;
  return response!;
}

/** Resolve immutable subject identity without submitting candidate work. Preparation and execution are subject-owned. */
export async function resolveCampaignSubject(treatment: CampaignTreatment, settings: SubjectSettings, run: OwnedCommandRunner, family?: string) {
  if (treatment.subject === "claude-code") {
    const found = Bun.which("claude", { PATH: process.env.PATH });
    if (!found) throw new Error("claude-code requires claude on PATH");
    const binaryPath = await realpath(found);
    const binarySha256 = await binaryIdentity(binaryPath);
    const version = await run([binaryPath, "--version"], { cwd: REPO_ROOT });
    if (version.exitCode !== 0 || version.timedOut || version.stdoutTruncated || !version.stdout.trim()) throw new Error("Claude Code --version failed");
    const identity = { subject: "claude-code" as const, binaryPath, binarySha256, binaryVersion: version.stdout.trim(), model: claudeCodeModelId(settings.model), effort: settings.effort,
      ...(treatment.ultracode ? { ultracode: true as const } : {}) };
    return {
      kind: "claude-code" as const, identity,
      async prepare(): Promise<PreparedCampaignSubject> {
        return {
          kind: "claude-code", isolationAgent: { kind: "claude-code" }, environment: {},
          confinement: () => ({ hidden: [], own: [], readonly: [binaryPath], writeDenied: controllerWriteDenied() }),
          preflight: async () => structuredIdentity({ ...identity, ...(family ? { family } : {}) }),
          record: (id, settingsIdentity) => ({ id, ...identity, settingsIdentity }),
          async validate() {
            if (await binaryIdentity(binaryPath) !== binarySha256) throw new Error(`Claude Code binary changed during campaign: ${binaryPath}`);
          },
          async execute(context, message, capture) {
            if (typeof message !== "string") throw new Error("Claude Code accepts baseline task messages, not Flywheel inline skills");
            const execution = await executeClaudeCodeBenchmark({ ...context, sessionId: context.claudeCodeSessionId, artifactDir: join(context.artifactDir, "run-0"), binaryPath, model: identity.model, effort: settings.effort, ultracode: treatment.ultracode === true, message });
            capture.executions.push(execution);
            return execution;
          },
        };
      },
    };
  }
  const source = await resolveSourceTreatment(REPO_ROOT, treatment.revision, run, treatment.patches);
  return {
    kind: "flywheel" as const, identity: { ...source, ...(treatment.disabledTools ? { disabledTools: treatment.disabledTools } : {}) },
    async prepare(directory: string): Promise<PreparedCampaignSubject> {
      const prepared = await prepareSourceTreatment({ repoRoot: REPO_ROOT, harnessRoot: REPO_ROOT, directory, source, run });
      const input = (context: CampaignSubjectContext) => ({
        ...context, commandPrefix: [process.execPath, "--conditions=browser", join(prepared.root, "scripts/source-cli.ts")],
        profile: settings.authProfile, model: settings.model, effort: settings.effort,
        inspectRoles: true,
        disabledTools: treatment.disabledTools,
        requireWorkflowsOn: settings.workflowsMode === "on",
      });
      return {
        kind: "flywheel", isolationAgent: { kind: "flywheel", authProfile: settings.authProfile },
        environment: { FLYWHEEL_DISABLE_UPDATE_CHECK: "1", ...(settings.roles ? { FLYWHEEL_ROLES: JSON.stringify(settings.roles) } : {}) },
        confinement: (hiddenTaskDirs) => ({
          hidden: hiddenTaskDirs.map((path) => join(prepared.root, relative(REPO_ROOT, path))),
          own: [join(prepared.root, "node_modules", ".cache"), join(prepared.root, relative(REPO_ROOT, BUNDLED_SKILL_DIR), ".locks")],
          readonly: [prepared.root], writeDenied: controllerWriteDenied(),
        }),
        async preflight(context) {
          const result = await executeHeadlessBenchmark(input(context));
          if (result.outcome !== "preflight" || !result.plan || result.evidence.kind !== "observed") {
            throw new Error(`Flywheel preflight requires official JSONL v1, model.save_effort, sessionModelPlan, and events evidence (${result.reason ?? result.outcome}; artifacts ${context.artifactDir})`);
          }
          const chat = result.plan.assignments.find((row) => row.slot.kind === "role" && row.slot.roleId === "chat")!;
          return structuredIdentity({ profileId: result.plan.profile.effectiveId, model: chat.model, effort: chat.effort,
            ...(settings.roles ? { roles: settings.roles } : {}), ...(treatment.disabledTools ? { disabledTools: treatment.disabledTools } : {}), ...(settings.workflowsMode ? { workflowsMode: result.workflowsMode } : {}), ...(family ? { family } : {}) });
        },
        record: (id, settingsIdentity) => ({
          id, revision: source.revision, sourceIdentity: prepared.sourceIdentity,
          dependencyIdentity: structuredIdentity({ declarations: source.dependencyIdentity, installed: prepared.installedDependencyIdentity }),
          harnessIdentity: prepared.harnessIdentity, settingsIdentity,
          ...(settings.roles ? { roles: settings.roles } : {}),
          ...(treatment.disabledTools ? { disabledTools: treatment.disabledTools } : {}),
          ...(source.patches ? { patches: source.patches } : {}),
          ...(settings.workflowsMode ? { workflowsMode: settings.workflowsMode } : {}),
        }),
        validate: () => validatePreparedTreatment(prepared, run),
        searchEvents: (context, sessionId, type, path) => captureCampaignEventSearch(input(context), sessionId, type, path),
        async execute(context, message, capture, challenge) {
          const subject = input(context);
          const execute = async (invocation: HeadlessBenchmarkInput) => {
            let execution = await executeHeadlessBenchmark(invocation);
            if (treatment.disabledTools?.length) {
              try {
                if (execution.evidence.kind !== "observed") throw new Error("Tool exclusion request inventory is unavailable");
                const requestEvidence = execution.evidence.value;
                const audit = await captureCampaignEventSearch(invocation, undefined, ["prompt.assembled", "tool_surface.selected", "context.application.recorded", "context.transformer.applied"], join(invocation.artifactDir, "tool-surfaces.jsonl"));
                execution = { ...execution, artifacts: { ...execution.artifacts, toolSurfaces: audit.stdout, toolSurfacesStderr: audit.stderr } };
                const proof = campaignToolExclusionEvidence(await readFile(audit.stdout.path, "utf8"), requestEvidence, treatment.disabledTools);
                const path = join(invocation.artifactDir, "disabled-tools.json");
                const text = JSON.stringify(proof);
                await writeArtifactFile(path, text);
                execution = { ...execution, artifacts: { ...execution.artifacts, disabledTools: { path, sha256: bytesIdentity(text), bytes: Buffer.byteLength(text) } } };
                if (proof.violations.length) execution = { ...execution, outcome: "failed", reason: `Disabled tools were offered: ${proof.violations.map(row => `${row.sessionId}/${row.requestId}:${row.tool}`).join(", ")}` };
              } catch (error) {
                execution = { ...execution, outcome: "failed", reason: `Disabled tool exposure could not be verified from recorded requests: ${error instanceof Error ? error.message : String(error)}` };
              }
            }
            capture.executions.push(execution);
            return execution;
          };
          let result = await execute({ ...subject, message, artifactDir: join(context.artifactDir, "run-0") });
          const reader = ownedCommandRunner(context.launcher);
          let challengePosition: number | undefined;
          let challengeSession: string | undefined;
          let designApproved = false;
          const questions = async (sessionId: string) => {
            const request = await reader(subject.wrapCommand([
              ...subject.commandPrefix, "events", "search", "--session", sessionId,
              "--type", "agent_input.*", "--limit", "0", "--json", "--project-root", context.projectRoot,
            ]), { cwd: context.projectRoot, env: { ...subject.env, FLYWHEEL_AUTH_PROFILE: subject.profile } });
            const path = join(context.artifactDir, `run-${capture.executions.length - 1}`, "questions.jsonl");
            await writeArtifactFile(path, request.stdout);
            await writeArtifactFile(`${path}.stderr`, request.stderr);
            capture.questionArtifacts.set(capture.executions.length - 1, {
              questions: { path, sha256: bytesIdentity(request.stdout), bytes: Buffer.byteLength(request.stdout) },
              questionsStderr: { path: `${path}.stderr`, sha256: bytesIdentity(request.stderr), bytes: Buffer.byteLength(request.stderr) },
            });
            if (request.exitCode !== 0 || request.stdoutTruncated || request.stderrTruncated || request.timedOut) throw new Error("Subject question evidence command failed");
            return request.stdout;
          };
          if (challenge !== undefined) {
            const sessionId = result.sessionId;
            const questionAnswer = result.outcome === "input_required" && sessionId
              ? campaignDesignAnswer(await questions(sessionId), sessionId, capture.answered, challenge) : undefined;
            if (sessionId && (questionAnswer || result.outcome === "complete" || result.outcome === "incomplete")) {
              const before = await captureCampaignEventSearch(subject, sessionId, "chat.entries.appended", join(context.artifactDir, "challenge-before.jsonl"));
              capture.questionArtifacts.set(0, { ...capture.questionArtifacts.get(0), challengeBefore: before.stdout, challengeBeforeStderr: before.stderr });
              challengePosition = challengeConversationEvidence(await readFile(before.stdout.path, "utf8"), sessionId).position;
              challengeSession = sessionId;
              capture.challenge = { delivered: questionAnswer ? "revise-design" : "message" };
              if (questionAnswer) recordCampaignAnswer(capture, questionAnswer, "revise-design");
              result = await execute({
                ...subject, sessionId, artifactDir: join(context.artifactDir, `run-${capture.executions.length}`),
                ...(questionAnswer ? { questionAnswer } : { message: challenge }),
              });
            } else {
              capture.challenge = { delivered: "none", reason: result.outcome === "input_required" ? "root question is not a single design approval" : `first run ended ${result.outcome}` };
              return result;
            }
          }
          while (result.outcome === "input_required" && result.sessionId) {
            const sessionId = result.sessionId;
            const jsonl = await questions(sessionId);
            const workflowAnswer = campaignWorkflowApproval(jsonl, sessionId, capture.answered);
            const designAnswer = challengePosition !== undefined && !designApproved ? campaignDesignAnswer(jsonl, sessionId, capture.answered) : undefined;
            const questionAnswer = workflowAnswer ?? designAnswer;
            if (!questionAnswer) break;
            if (!workflowAnswer) designApproved = true;
            recordCampaignAnswer(capture, questionAnswer, "approve");
            result = await execute({ ...subject, sessionId, questionAnswer, artifactDir: join(context.artifactDir, `run-${capture.executions.length}`) });
          }
          if (challengePosition !== undefined && challengeSession) {
            const after = await captureCampaignEventSearch(subject, challengeSession, "chat.entries.appended", join(context.artifactDir, "challenge-after.jsonl"));
            const index = capture.executions.length - 1;
            capture.questionArtifacts.set(index, { ...capture.questionArtifacts.get(index), challengeAfter: after.stdout, challengeAfterStderr: after.stderr });
            const text = challengeConversationEvidence(await readFile(after.stdout.path, "utf8"), challengeSession, challengePosition).text;
            const path = join(context.artifactDir, "challenge-reply.md");
            await writeArtifactFile(path, text);
            capture.challengeReply = { path, sha256: bytesIdentity(text), bytes: Buffer.byteLength(text) };
          }
          return result;
        },
      };
    },
  };
}
