/** Runs one maintenance pass for a project from a one-shot command.
 *
 *  The pass itself (`skill-maintenance-survey.ts` and `skill-maintenance.ts`)
 *  is pure of runtime concerns: it asks for a survey, performs the units the
 *  answer names, and applies what comes back. This module is the half that
 *  owns a real provider. Assembling it captures the account's auth the way
 *  every runtime root does, but no provider request is made until the pass
 *  asks for one, and a library with too few candidates never asks: the
 *  candidate count answers first.
 *
 *  Both halves share one captured provider admission and one isolated
 *  single-turn child each. The survey decides the units from the library's
 *  shape; each unit is then performed from the complete text of the packages
 *  it touches. The request bound is sized rather than guessed:
 *  `MAX_CANDIDATE_REQUEST_BYTES` caps what a survey or a unit may send, so a
 *  library too large to decide over at once refuses early with a reason,
 *  rather than failing on a provider's own refusal. */

import type { StartupDirectories } from "../../../infra/directory-authorities.js"
import { createKeyResolver, createOwnedCredentialCommandRunner } from "../../../infra/auth/resolve-key.js"
import type { LauncherScope } from "../../../infra/process-supervisor.js"
import { Log } from "../../../infra/log.js"
import { errorMessage } from "../../../infra/error-message.js"
import { AuthProfileManager } from "../../auth/auth-profile-manager.js"
import { captureRuntimeConfigRequest } from "../../agent-runtime/request-config.js"
import { runHeadlessBootstrap } from "../../headless/headless-bootstrap.js"
import { moduleRequirementsForContribution } from "../../module-requirements.js"
import { createSessionFactWriter } from "../../session/session-fact-writer.js"
import { resolveHeadlessAuthProfile, withHeadlessProfileRuntime } from "../../headless/headless-profile-runtime.js"
import { createLearningReviewExecution } from "./learning-review-runner.js"
import { inspectSkillLibrary } from "../../../workflows/skill-health.js"
import { eligibleLearnedSkills } from "./learned-skill-eligibility.js"
import { runSkillMaintenance, skillUnitPackages, type SkillMaintenanceResult } from "./skill-maintenance.js"
import { SKILL_MAINTENANCE_UNIT_CONTRACT } from "./skill-maintenance-unit.js"
import {
  collectSkillSurveyCandidates,
  decodeSkillMaintenanceSurvey,
  packSkillMaintenanceSurvey,
  SKILL_MAINTENANCE_SURVEY_CONTRACT,
  unitReceiver,
  type SkillMaintenanceUnit,
} from "./skill-maintenance-survey.js"

const log = Log.create({ service: "skill-maintenance-host" })

/** How much of one request the candidate packages may occupy.
 *
 *  A second bound sits below this one: `execution.request` refuses before the
 *  call when the complete prompt does not fit the model's stated context
 *  window, so nothing here can overflow a provider. This bound exists to fail
 *  earlier and say something useful, because the model's own refusal cannot
 *  distinguish "the library is too large to decide over at once" from "the
 *  child did not answer". The remaining window holds the contract, the framing,
 *  and the answer the model writes back, which is roughly the size of the
 *  packages it rewrites. */
const MAX_CANDIDATE_REQUEST_BYTES = 200_000

export interface SkillMaintenanceHostInput {
  readonly directories: StartupDirectories
  readonly launcher: LauncherScope
  readonly dryRun?: boolean
  /** Run on this model instead of the configured Learning Review role. */
  readonly model?: string
  readonly effort?: string
  readonly surveyOnly?: boolean
  /** Perform only the unit this skill receives, when the survey proposes one. */
  readonly unit?: string
}

export type SkillMaintenanceHostResult =
  | { readonly kind: "surveyed"; readonly model: string; readonly candidates: number; readonly bytes: number; readonly units: readonly SkillMaintenanceUnit[] }
  | { readonly kind: "maintained"; readonly model: string; readonly candidates: number; readonly units: readonly SkillMaintenanceUnit[]; readonly maintenance: SkillMaintenanceResult }
  | { readonly kind: "skipped"; readonly candidates: number; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }

/** Assemble a provider for this project and run one maintenance pass: survey
 *  the library's shape, then perform the units it names. */
export async function runSkillMaintenanceForProject(
  input: SkillMaintenanceHostInput,
): Promise<SkillMaintenanceHostResult> {
  const { directories } = input
  const { projectRoot, executionCwd, userDataRoot, accountHome } = directories
  return await runHeadlessBootstrap<SkillMaintenanceHostResult>({ directories, launcher: input.launcher }, async ({ capabilityPolicy, moduleSelection, definitions, runtimeConfig, eventWriter }) => {
    const admission = await capabilityPolicy.policy.admit({
      operation: "skills:maintain survey",
      required: moduleRequirementsForContribution("tools", "skill_manage"),
    })
    if (!admission.ok) return { result: { kind: "refused", reason: admission.reason } }

    const findings = inspectSkillLibrary({ revision: definitions.skills(), directories })
    const candidates = collectSkillSurveyCandidates({
      revision: definitions.skills(),
      directories,
      findings,
    })
    // Fewer than two skills cannot be merged and a single skill's repair is
    // better asked for by name, so the survey never crosses a provider for one.
    if (candidates.length < 2) return { result: { kind: "skipped", candidates: candidates.length, reason: "At least two eligible learned skills are required for a maintenance survey." } }

    try {
      const survey = packSkillMaintenanceSurvey(candidates, MAX_CANDIDATE_REQUEST_BYTES)
      const config = runtimeConfig.snapshot().config
      const authProfile = await resolveHeadlessAuthProfile(new AuthProfileManager({ userDataRoot, projectRoot, config: () => config }))
      const requestConfig = captureRuntimeConfigRequest(runtimeConfig.snapshot(), authProfile.id)
      const resolveKey = createKeyResolver(createOwnedCredentialCommandRunner(input.launcher))
      return await withHeadlessProfileRuntime({
        userDataRoot,
        profile: authProfile,
        moduleSelection,
        allowTrainingRoutes: requestConfig.allowTrainingRoutes,
        resolveKey,
        captureRuntimeConfig: () => requestConfig,
        workflowPreparation: { ...directories, definitions, moduleSelection, launcher: input.launcher, resolveKey, capabilities: capabilityPolicy.policy },
      }, async (wfDeps): Promise<{ result: SkillMaintenanceHostResult }> => {
        const execution = createLearningReviewExecution({
          model: input.model,
          effort: input.effort,
          projectRoot, userDataRoot, accountHome, executionCwd,
          moduleSelection: moduleSelection(),
          // Two audits per unit at most: the receiving package, and one support
          // file write. Units are bounded by the survey, so the budget is too.
          auditBudget: candidates.length * 2,
          captureProviderConnection: wfDeps.captureProviderConnection,
        })

        let model = (await execution.plannedAttempt()).model
        const output = await execution.request({
          systemPrompt: SKILL_MAINTENANCE_SURVEY_CONTRACT, instruction: survey.instruction, turns: "final",
          onAttempt: (attempt) => { model = attempt.model },
        })
        if (output === undefined) return { result: { kind: "refused", reason: "the survey model returned no answer" } }
        const decoded = decodeSkillMaintenanceSurvey(survey.candidates, output)
        if (decoded.kind === "refused") return { result: { kind: "refused", reason: decoded.error } }
        log.info("skill maintenance survey done", { model, candidates: candidates.length, units: decoded.units.length })

        // --unit selects by the skill that receives the unit's result, which is
        // the one name both a merge and a repair carry.
        let units = decoded.units
        if (input.unit !== undefined) {
          units = decoded.units.filter((unit) => unitReceiver(unit) === input.unit)
          if (units.length === 0) {
            const proposed = decoded.units.map(unitReceiver).join(", ") || "nothing"
            return { result: { kind: "refused", reason: `The survey proposed no unit for "${input.unit}". It proposed: ${proposed}. A unit is named by the skill that receives it.` } }
          }
        }
        if (input.surveyOnly === true || units.length === 0) {
          return { result: { kind: "surveyed", model, candidates: candidates.length, bytes: survey.instruction.length, units } }
        }

        // The eligible packages are captured once with their bytes, and each unit is
        // performed against whatever is installed when it is reached: an earlier
        // unit can have changed the package a later one touches.
        const findingsBySkill = new Map<string, readonly string[]>()
        for (const finding of findings) findingsBySkill.set(finding.skill, [...findingsBySkill.get(finding.skill) ?? [], finding.kind])
        const preparedById = () => new Map(eligibleLearnedSkills({
          revision: definitions.skills(),
          projectRoot: `${projectRoot}/.flywheel/skills`,
          reach: "project",
        }).map(({ definition, package: prepared }) => [definition.id, prepared] as const))

        const writer = createSessionFactWriter({ sessionId: "skill-maintenance", writer: eventWriter })
        try {
          const maintenance = await runSkillMaintenance({
            config: { projectRoot, userDataRoot, registry: definitions.skills },
            units,
            packagesFor: (unit) => {
              const ids = unit.kind === "merge" ? [unit.into, ...unit.absorb] : [unit.skill]
              const prepared = preparedById()
              return skillUnitPackages(definitions.skills(), ids, findingsBySkill, (id) => prepared.get(id))
            },
            maxInstructionBytes: MAX_CANDIDATE_REQUEST_BYTES,
            perform: async (request) => {
              const answer = await execution.request({ systemPrompt: SKILL_MAINTENANCE_UNIT_CONTRACT, instruction: request.instruction, turns: "final" })
              if (answer === undefined) throw new Error("the maintenance model returned no answer")
              return answer
            },
            audit: execution.onCandidate,
            record: (fact) => writer.record(fact),
            reloadRegistry: () => { definitions.reload() },
            ...(input.dryRun === true ? { dryRun: true } : {}),
          })
          return { result: { kind: "maintained", model, candidates: candidates.length, units, maintenance } }
        } finally {
          writer.dispose()
        }
      })
    } catch (error) {
      return { result: { kind: "refused", reason: errorMessage(error) } }
    }
  })
}
