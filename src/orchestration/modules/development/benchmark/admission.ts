import { candidateProviderId, type AccessProviderId, type AdmittedFailoverPlan } from "../../../../infra/llm/access-provider.js";
import type { CaptureProviderConnection } from "../../../agent-runtime/factory.js";
import { createAgentJudge, type JudgeModel } from "./judge.js";
import { campaignJudges, type BenchmarkPlan } from "./persona-benchmark.js";
import type { BenchmarkRuntime } from "./persona-run.js";
import { structuredIdentity } from "./content-identity.js";
import { resolveSessionRoles } from "../../../config/session-role-resolver.js";
import { resolveCapturedRole } from "../../../config/role-resolution.js";
import type { WorkflowDeps } from "../../../workflow-host/deps.js";

/** What a benchmark launch is given: the project surface it runs against with
 *  no client factory of its own, plus the capture every client of the run is
 *  admitted from. A standalone CLI passes its whole WorkflowDeps and an
 *  embedded tool passes the parent runner's surface; both are this shape. */
export interface BenchmarkAdmissionDeps extends Omit<BenchmarkRuntime, "createAgent" | "createLLMClient"> {
  readonly captureProviderConnection: CaptureProviderConnection;
  readonly availableModels?: WorkflowDeps["availableModels"];
  readonly modelInfos?: WorkflowDeps["modelInfos"];
}

/** Which side of the matrix a planned model serves. */
type BenchmarkRole = "candidate" | "judge";

/** A solo research seat has no pair to judge and does not require judge admission.
 *  A pinned judge replaces the profile's judge role. */
export function benchmarkModelSeats(plan: BenchmarkPlan, personaRole: string): readonly BenchmarkModelSeat[] {
  return [
    ...plan.variants.map(({ model, effort }) => ({ role: "candidate" as const, roleId: personaRole, model, effort })),
    ...(campaignJudges(plan) ? [{ role: "judge" as const, ...plan.judge }] : []),
  ];
}

/** The model and effort that score one persona campaign. */
export interface JudgeSelection {
  readonly model: string;
  readonly effort: string;
}

/** The judge members of the persona benchmark's dependencies. */
interface PersonaCampaignJudge {
  readonly judge?: JudgeSelection;
  readonly createJudge: (evidenceDirectory?: string) => Promise<JudgeModel>;
}

/** Settle the judge of one persona campaign from its admission: the judge seat's
 *  resolved model and effort, which every judge call of the campaign must use.
 *
 *  Returns no selection when the plan has no judge seat or the profile serves
 *  no judge model; the benchmark service refuses to run a campaign that needs
 *  a judge without one. A judge may share a candidate's model; the dry run and
 *  the report name those candidate settings. */
export function personaCampaignJudge(admission: BenchmarkAdmission): PersonaCampaignJudge {
  const { model, effort } = admission.providerPlans.find((plan) => plan.role === "judge") ?? {};
  if (model === undefined || effort === undefined) return { createJudge: (evidenceDirectory) => admission.createJudge(undefined, undefined, undefined, evidenceDirectory) };
  return {
    judge: { model, effort },
    createJudge: (evidenceDirectory) => admission.createJudge(model, undefined, effort, evidenceDirectory, (resolved) => {
      if (resolved !== model) throw new Error(`The benchmark judge resolved to ${resolved}, not the campaign judge ${model}`);
    }),
  };
}

export interface BenchmarkModelSeat {
  readonly role: BenchmarkRole;
  readonly roleId?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** The provider decision for one model, as a launch reports it. It names no
 *  secret and no directory: the role, the model, and the candidate order the
 *  chain will try. */
export interface ProviderPlanReport {
  readonly role: BenchmarkRole;
  readonly model?: string;
  readonly effort?: string;
  readonly profileId: string;
  readonly providers: readonly AccessProviderId[];
}

export interface BenchmarkAdmission {
  readonly runtime: BenchmarkRuntime;
  readonly createJudge: (model?: string, systemPrompt?: string, effort?: string, evidenceDirectory?: string, validateModel?: (model: string) => void) => Promise<JudgeModel>;
  readonly providerPlans: readonly ProviderPlanReport[];
}

/** Redaction-safe output shared by every benchmark entry point. It contains
 * only public model, provider, fixture, and matrix identifiers. */
interface BenchmarkPreflightReport {
  readonly dryRun: true;
  readonly persona: string;
  readonly mode: BenchmarkPlan["mode"];
  readonly variants: readonly string[];
  readonly repeats: number;
  readonly tasks: readonly string[];
  readonly cells: number;
  readonly resultsDir: string;
  readonly providerPlans: readonly ProviderPlanReport[];
  /** The candidate settings (model:effort) that run on the judge's model. A
   *  judge can favor its own model, so a reader weighs those scores knowing it. */
  readonly judgeModelCandidates: readonly string[];
}

export function benchmarkPreflightReport(
  plan: BenchmarkPlan,
  providerPlans: readonly ProviderPlanReport[],
): BenchmarkPreflightReport {
  return {
    dryRun: true,
    persona: plan.persona,
    mode: plan.mode,
    variants: plan.variants.map((variant) => variant.id),
    repeats: plan.repeats,
    tasks: plan.tasks.map((task) => task.id),
    cells: plan.repeats * plan.tasks.length * plan.variants.length,
    resultsDir: plan.resultsDir,
    providerPlans,
    judgeModelCandidates: providerPlans
      .filter((candidate) => candidate.role === "candidate" && candidate.model !== undefined && candidate.model === providerPlans.find((seat) => seat.role === "judge")?.model)
      .map((candidate) => `${candidate.model}:${candidate.effort}`),
  };
}

/** Previews each seat against one captured profile. Requests capture again and resolve their authored settings. */
export async function admitBenchmark(
  deps: BenchmarkAdmissionDeps,
  seats: readonly BenchmarkModelSeat[],
): Promise<BenchmarkAdmission> {
  const capture = await deps.captureProviderConnection();
  const plans = new Map<string, AdmittedFailoverPlan>();
  const providerPlans = await Promise.all(seats.map(async ({ role, roleId = role === "judge" ? "benchmark-judge" : "workflow-agent", model, effort }): Promise<ProviderPlanReport> => {
    const roles = await resolveSessionRoles({ defaults: {}, overrides: model === undefined && effort === undefined ? {} : { [roleId]: { model, effort } } }, capture, deps.userDataRoot, [roleId]);
    const setting = roles.get(roleId)?.setting;
    const selected = await resolveCapturedRole(roleId, {
      model: setting?.model, effort: setting?.effort, provider_options: setting?.providerOptions,
    }, { selection: capture.providers.selection, connection: capture.connection, eligibility: capture.eligibility, allowTrainingRoutes: capture.runtimeConfig.allowTrainingRoutes }, deps.userDataRoot);
    if (selected.kind !== "selected") {
      return { role, profileId: capture.connection.profileId, providers: [] };
    }
    const chain = selected.plan;
    plans.set(selected.role.model, chain);
    return { role, model: selected.role.model, effort: selected.role.effort, profileId: capture.connection.profileId, providers: chain.candidates.map(candidateProviderId) };
  }));
  const admitted = capture.admit(plans);
  // Native workers compare serving policy, not process-local revisions or the inherited roles recorded per cell.
  const { revision: _revision, profileRoles: _profileRoles, ...runtimeConfig } = capture.runtimeConfig;
  const runtime: BenchmarkRuntime = {
    userDataRoot: deps.userDataRoot,
    accountHome: deps.accountHome,
    definitions: deps.definitions,
    moduleSelection: deps.moduleSelection,
    captureRuntimeConfig: deps.captureRuntimeConfig,
    runOwnedCommand: deps.runOwnedCommand,
    profileId: deps.profileId,
    authorityIncarnation: deps.authorityIncarnation,
    captureProviderConnection: deps.captureProviderConnection,
    launcher: deps.launcher,
    background: deps.background,
    foregroundBashHold: deps.foregroundBashHold,
    shell: deps.shell,
    admissionIdentity: {
      runtimeConfig: structuredIdentity(runtimeConfig),
    },
    createAgent: admitted.createAgent,
    createLLMClient: admitted.createLLMClient,
  };
  return {
    runtime,
    createJudge: async (model, systemPrompt, effort, evidenceDirectory, validateModel) => createAgentJudge({
      createAgent: admitted.createAgent,
      model,
      effort,
      captureProviderConnection: deps.captureProviderConnection,
      evidenceDirectory,
      validateModel,
      systemPrompt: systemPrompt ?? "",
      userDataRoot: deps.userDataRoot,
      accountHome: deps.accountHome,
      ...(deps.profileId ? { profileId: deps.profileId } : {}),
      ...(deps.authorityIncarnation ? { authorityIncarnation: deps.authorityIncarnation } : {}),
      runtimeSurfaces: {
        ...(deps.launcher ? { launcher: deps.launcher } : {}),
        ...(deps.background ? { background: deps.background } : {}),
        ...(deps.foregroundBashHold ? { foregroundBashHold: deps.foregroundBashHold } : {}),
        ...(deps.shell ? { shell: deps.shell } : {}),
      },
    }),
    providerPlans,
  };
}
