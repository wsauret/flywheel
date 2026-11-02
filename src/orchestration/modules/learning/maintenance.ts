import { Log } from "../../../infra/log.js"
import { createRuntimeConfigOwner } from "../../config/runtime-config-owner.js"
import { configSection } from "../../config/config-section.js"
import { startModulePolicy } from "../../config/module-policy.js"
import { createSessionFactWriter } from "../../session/session-fact-writer.js"
import { moduleRequirementsForContribution } from "../../module-requirements.js"
import type { ModuleMaintenanceInput } from "../../module-seams.js"
import { skillsConfigSection } from "./config.js"
import { applySkillLifecycleTransitions, type SkillPruneReport } from "./skill-prune.js"
import { refreshSkillLoadStatsSnapshot, skillActivitySource } from "./skill-load-stats.js"
import { runSkillCorpusCleanupForProject } from "./skill-corpus-cleanup-host.js"
import { createInstalledDefinitionRegistry } from "../../definition-catalog.js"

const log = Log.create({ service: "runtime-maintenance" })

/** The optional corpus pass runs after core store maintenance and joins its work. */
export async function maintainSkillCorpus(input: ModuleMaintenanceInput): Promise<void> {
  input.signal.throwIfAborted()
  await runSkillCorpusCleanupForProject(input)
  log.info("startup skill corpus cleanup done")
}

/** The lifecycle half of maintenance, gated on current capability
 *  configuration.
 *
 *  Pruning archives managed skill packages, so it is managed-learning mutation
 *  and needs Skills plus Learning. This Worker is its own realm, so it migrates
 *  the obsolete Learning opt-out and admits for itself rather than trusting the
 *  host that spawned it. Retired-family pruning is core workspace upkeep and is
 *  not gated here. */
export async function maintainSkillLifecycleIfAdmitted(input: Pick<ModuleMaintenanceInput, "directories" | "reader" | "writer" | "signal">): Promise<{ readonly ran: boolean; readonly reason?: string }> {
  const { directories, signal } = input
  signal.throwIfAborted()
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, watch: false })
  let started: Awaited<ReturnType<typeof startModulePolicy>> | undefined
  try {
    started = await startModulePolicy({ userDataRoot: directories.userDataRoot }, runtimeConfig)
    if (started.migrationError) log.warn("learning capability migration failed", { error: started.migrationError })
    if (started.notice) log.warn(started.notice)
    const admission = await started.policy.admit({ operation: "skill lifecycle maintenance", required: moduleRequirementsForContribution("tools", "skill_manage") })
    if (!admission.ok) {
      log.info("startup skill lifecycle maintenance skipped", { reason: admission.reason })
      return { ran: false, reason: admission.reason }
    }
    signal.throwIfAborted()
    await maintainSkillLifecycle(input, configSection(runtimeConfig.snapshot().config, skillsConfigSection))
    return { ran: true }
  } finally {
    await started?.dispose()
    await runtimeConfig.dispose()
  }
}

async function maintainSkillLifecycle(input: Pick<ModuleMaintenanceInput, "directories" | "reader" | "writer" | "signal">, skillsConfig: typeof skillsConfigSection.schema.Type): Promise<void> {
  const { directories, reader: history, signal } = input
  log.info("startup skill lifecycle maintenance start")
  const writer = createSessionFactWriter({ sessionId: "skill-pruner", writer: input.writer })
  let report: SkillPruneReport
  try {
    signal.throwIfAborted()
    const loads = await refreshSkillLoadStatsSnapshot(history, writer, input.writer)
    signal.throwIfAborted()
    const definitions = createInstalledDefinitionRegistry(directories)
    report = await applySkillLifecycleTransitions({
      ...await skillActivitySource(history, loads),
      registry: definitions.skills,
      directories,
      signal,
      staleAfterDays: skillsConfig.stale_after_days,
      archiveAfterDays: skillsConfig.archive_after_days,
      record: (fact) => writer.record(fact),
    })
  } finally {
    writer.dispose()
  }
  log.info("startup skill lifecycle maintenance done", {
    // A zero archive window disables the pass inside the pruner, which reports
    // it as an empty walk; the setting is logged so the two are not confused.
    enabled: skillsConfig.archive_after_days !== 0,
    checked: report.checked,
    archived: report.archived.length,
    stale: report.stale.length,
  })
}
