import type { StartupDirectories } from "../../../infra/directory-authorities.js"
import { createKeyResolver, createOwnedCredentialCommandRunner } from "../../../infra/auth/resolve-key.js"
import type { LauncherScope } from "../../../infra/process-supervisor.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../../infra/event-store-types.js"
import { AuthProfileManager } from "../../auth/auth-profile-manager.js"
import { captureRuntimeConfigRequest } from "../../agent-runtime/request-config.js"
import { acquireSharedProviderAvailability, disposeSharedProviderAvailability } from "../../agent-runtime/llm/shared-provider-availability.js"
import { composeRealmModuleSnapshot } from "../../modules.js"
import { installedAccessProviderIds } from "../../credential-provider-modules.js"
import { createRuntimeConfigOwner } from "../../config/runtime-config-owner.js"
import { startModulePolicy } from "../../config/policy/module-policy.js"
import { moduleRequirementsForContribution } from "../../module-requirements.js"
import { createSessionFactWriter } from "../../session/session-fact-writer.js"
import { resolveHeadlessAuthProfile, withHeadlessProfileRuntime } from "../../headless/headless-profile-runtime.js"
import { createLearningReviewExecution } from "./learning-review-runner.js"
import { createSkillCorpusCleanupState } from "./skill-corpus-cleanup-state.js"
import { createSkillCorpusCleanupRequests, requestValidSkillCorpusCleanupResponse, skillCorpusCleanupAdmission, SKILL_CORPUS_CLEANUP_CONTRACT } from "./skill-corpus-cleanup-classifier.js"
import { classifySkillCorpusCleanupWork } from "./skill-corpus-cleanup-work.js"
import { createReviewUsageAccounting } from "./learning-review.js"
import { runSkillCorpusCleanup, type SkillCorpusCleanupResult, type SkillCorpusCleanupWorkResult } from "./skill-corpus-cleanup.js"
import { createInstalledDefinitionRegistry } from "../../definition-catalog.js"

export interface SkillCorpusCleanupProjectHostInput {
  readonly directories: StartupDirectories
  readonly launcher: LauncherScope
  /** The project's store and the writer its facts and lease reach. */
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly force?: boolean
  readonly signal?: AbortSignal
}

/** Runs the bounded project cleanup in its maintenance process realm without claiming workspace-state generation ownership. */
export async function runSkillCorpusCleanupForProject(input: SkillCorpusCleanupProjectHostInput): Promise<SkillCorpusCleanupResult | { readonly kind: "refused"; readonly reason: string }> {
  const { directories, launcher, reader } = input
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, watch: false })
  const modules = await startModulePolicy({ userDataRoot: directories.userDataRoot }, runtimeConfig)
  try {
    const moduleAdmission = await modules.policy.admit({ operation: "skill corpus cleanup", required: moduleRequirementsForContribution("tools", "skill_manage") })
    if (!moduleAdmission.ok) return { kind: "refused", reason: moduleAdmission.reason }
    const moduleSelection = composeRealmModuleSnapshot(modules.policy.state())
    const definitions = createInstalledDefinitionRegistry(directories)
    const writer = createSessionFactWriter({ sessionId: "skill-cleanup", writer: input.writer })
    const state = createSkillCorpusCleanupState({ reader, writer: input.writer, ownerId: crypto.randomUUID() })
    try {
      const accounting = createReviewUsageAccounting(crypto.randomUUID(), () => {})
      return await runSkillCorpusCleanup({
        config: { projectRoot: directories.projectRoot, userDataRoot: directories.userDataRoot, registry: definitions.skills },
        state,
        record: (fact) => writer.record(fact),
        ...(input.force === true ? { force: true } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        classify: async (revision, corePackageIds, candidates, signal) => {
          const config = runtimeConfig.snapshot().config
          const authProfile = await resolveHeadlessAuthProfile(new AuthProfileManager({ userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, config: () => config }))
          const requestConfig = captureRuntimeConfigRequest(runtimeConfig.snapshot(), authProfile.id)
          const resolveKey = createKeyResolver(createOwnedCredentialCommandRunner(launcher))
          acquireSharedProviderAvailability(directories.userDataRoot, installedAccessProviderIds())
          return withHeadlessProfileRuntime({
            userDataRoot: directories.userDataRoot,
            profile: authProfile,
            moduleSelection: () => moduleSelection,
            allowTrainingRoutes: requestConfig.allowTrainingRoutes,
            resolveKey,
            captureRuntimeConfig: () => requestConfig,
            workflowPreparation: { ...directories, definitions, moduleSelection, launcher, resolveKey, capabilities: modules.policy },
            signal,
          }, async (deps) => {
            const execution = createLearningReviewExecution({
              ...directories,
              moduleSelection,
              captureProviderConnection: deps.captureProviderConnection,
              onBudgetEvent: (event) => { accounting.observe(event) },
              auditBudget: 0,
            })
            const planned = await execution.plannedAttempt()
            const cleanupAdmission = skillCorpusCleanupAdmission(planned.modelFamily, planned.contextLimit)
            const work = corePackageIds.flatMap((id) => createSkillCorpusCleanupRequests(revision, id, candidates, cleanupAdmission))
            return classifySkillCorpusCleanupWork<SkillCorpusCleanupWorkResult>(work, async (request, instruction, childSignal) => {
              const output = await requestValidSkillCorpusCleanupResponse(request, async (retryLimit) => {
                let attempts = 0
                const response = await execution.request({
                  systemPrompt: SKILL_CORPUS_CLEANUP_CONTRACT,
                  instruction,
                  signal: childSignal,
                  contextBudget: "caller-preflighted",
                  turns: "single",
                  retryLimit,
                  onAttempt: () => { attempts += 1 },
                })
                return { output: response, attempts }
              }, childSignal)
              return { request, output }
            }, signal)
          })
        },
      }).finally(() => { accounting.finish() })
    } finally {
      writer.dispose()
    }
  } finally {
    await modules.dispose()
    await runtimeConfig.dispose()
    await disposeSharedProviderAvailability()
  }
}
