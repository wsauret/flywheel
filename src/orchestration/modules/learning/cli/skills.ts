import { configSection } from "../../../config/config-section.js"
import { skillsConfigSection } from "../config.js"
import { errorMessage } from "../../../../infra/error-message.js"
import type { ProjectDirectories, StartupDirectories } from "../../../../infra/directory-authorities.js"
import type { LauncherScope } from "../../../../infra/process-supervisor.js"
import type { SkillFinding } from "../../../../workflows/skill-health.js"
import { withEventStore } from "../../../../infra/with-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../infra/event-store-types.js"
import { applySkillLifecycleTransitions } from "../skill-prune.js"
import { createSessionFactWriter } from "../../../session/session-fact-writer.js"
import { reconcileGlobalSkillStores } from "../global-skill-mutation.js"
import { startModulePolicy } from "../../../config/module-policy.js"
import { createRuntimeConfigOwner, type RuntimeConfigOwner } from "../../../config/runtime-config-owner.js"
import { restoreSkill } from "../skill-store.js"
import type { ProjectDefinitionRegistry } from "../../../../workflows/definition-registry.js"
import { prepareWorkspaceState } from "../../../workspace-state.js"
import { moduleRequirementsForContribution } from "../../../module-requirements.js"
import { createInstalledDefinitionRegistry } from "../../../definition-catalog.js"

/** Maintenance CLI over the managed skill library: `skills list` makes load
 * counts and dead skills visible, `skills why <name>` traces a package to the
 * sessions that loaded and wrote it, and `skills restore <name>` reverses an
 *  archive. All evidence derives from the durable workspace facts; nothing here
 *  keeps a parallel counter. */

import {
  collectSkillLoadRecords,
  collectSkillLoadStats,
  collectSkillWriteRecords,
  skillActivitySource,
} from "../skill-load-stats.js"

interface SkillsCliOptions {
  json: boolean
  positional: string[]
}

function parseArgs(args: readonly string[]): SkillsCliOptions {
  const options: SkillsCliOptions = { json: false, positional: [] }
  for (const arg of args) {
    if (arg === "--json") options.json = true
    else if (arg.startsWith("--")) throw new Error(`Unknown flag ${arg}`)
    else options.positional.push(arg)
  }
  return options
}

/** Own this project's state generation for the whole command, then hand it
 *  back however the command exits. While it is held, no other start may replace
 *  the workspace store these commands read. Named fact upgrades run here for the
 *  same reason the runtime runs them at startup: a historical fact must decode
 *  under the current schema before telemetry reads it. */
async function withProjectState<T>(directories: ProjectDirectories, use: () => Promise<T>): Promise<T> {
  const prepared = prepareWorkspaceState(directories)
  try {
    return await use()
  } finally {
    prepared.generation.release()
  }
}

/** One canonical project identity per command: the directory authorities the
 *  caller selected own the workspace store these commands read, the registry
 *  they list, and every package they write. A one-off command builds its own
 *  short-lived registry and runs no watcher, so the packages it reads are the
 *  ones installed now.
 *
 *  Read-only inspection stops here. Finishing an interrupted global skill
 *  operation is managed-learning mutation, so only a command that admits Skills
 *  plus Learning reconciles. */
function openProject(directories: ProjectDirectories): ProjectDefinitionRegistry {
  return createInstalledDefinitionRegistry(directories)
}

/** Admit one direct managed-skill mutation against current global capability
 *  configuration, then open the project it will write.
 *
 *  Undefined means refused: the reason is printed and nothing on disk changed.
 *  The obsolete Learning opt-out migrates first, so this command decides from
 *  the canonical selection whether or not the TUI has ever run. */
async function admitSkillMutation(directories: ProjectDirectories, operation: string, config?: RuntimeConfigOwner): Promise<ProjectDefinitionRegistry | undefined> {
  const started = await startModulePolicy({ userDataRoot: directories.userDataRoot }, config)
  try {
    if (started.migrationError) {
      console.error(`Cannot update global configuration: ${started.migrationError}`)
      process.exitCode = 1
      return undefined
    }
    if (started.notice) console.error(started.notice)
    const admission = await started.policy.admit({ operation, required: moduleRequirementsForContribution("tools", "skill_manage") })
    if (!admission.ok) {
      console.error(admission.reason)
      process.exitCode = 1
      return undefined
    }
    reconcileGlobalSkillStores(directories)
    return createInstalledDefinitionRegistry(directories)
  } finally {
    await started.dispose()
  }
}

function requireName(options: SkillsCliOptions): string {
  const name = options.positional[0]
  if (!name) throw new Error("A skill name is required")
  return name
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

export async function runSkillsList(args: readonly string[], directories: ProjectDirectories): Promise<void> {
  let options: SkillsCliOptions
  try {
    options = parseArgs(args)
  } catch (err) {
    console.error(errorMessage(err))
    console.error("usage: flywheel skills list [--json]")
    process.exitCode = 1
    return
  }
  await withProjectState(directories, async () => {
    const definitions = openProject(directories)
    const stats = await withEventStore(directories.projectRoot, (store) => collectSkillLoadStats(asAsyncEventReadSurface(store)))
    const rows = [...definitions.skills().skills.values()].map((skill) => {
      const usage = stats.get(skill.id)
      return {
        name: skill.id,
        root: skill.source.kind === "filesystem" ? skill.source.authority : "bundled",
        managed: skill.managed ?? null,
        loads: usage?.loads ?? 0,
        lastLoaded: usage ? isoDate(usage.lastLoadedAt) : null,
      }
    }).sort((a, b) => b.loads - a.loads || a.name.localeCompare(b.name))
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2))
      return
    }
    for (const row of rows) {
      const managed = row.managed ? ` managed:${row.managed}` : ""
      const last = row.lastLoaded ? ` last:${row.lastLoaded}` : ""
      console.log(`${row.name}  [${row.root}]${managed}  loads:${row.loads}${last}`)
    }
    if (rows.length === 0) console.log("No skills installed.")
  })
}

export async function runSkillsWhy(args: readonly string[], directories: ProjectDirectories): Promise<void> {
  let options: SkillsCliOptions
  let name: string
  try {
    options = parseArgs(args)
    name = requireName(options)
  } catch (err) {
    console.error(errorMessage(err))
    console.error("usage: flywheel skills why <name> [--json]")
    process.exitCode = 1
    return
  }
  await withProjectState(directories, async () => {
    const evidence = await withEventStore(directories.projectRoot, async (store) => ({
      loads: await collectSkillLoadRecords(asAsyncEventReadSurface(store), name),
      writes: await collectSkillWriteRecords(asAsyncEventReadSurface(store), name),
    }))
    if (options.json) {
      console.log(JSON.stringify({ name, ...evidence }, null, 2))
      return
    }
    console.log(`Skill: ${name}`)
    console.log(`Writes (${evidence.writes.length}):`)
    for (const write of evidence.writes) {
      console.log(`  ${isoDate(write.timestamp)}  ${write.action}  by ${write.origin}  session:${write.sessionId}  sha:${write.contentHash.slice(0, 12)}`)
    }
    console.log(`Loads (${evidence.loads.length}):`)
    for (const load of evidence.loads) {
      const request = load.modelRequestId ? `  request:${load.modelRequestId}` : ""
      console.log(`  ${isoDate(load.timestamp)}  session:${load.sessionId}${request}`)
    }
    if (evidence.writes.length === 0 && evidence.loads.length === 0) {
      console.log("No durable evidence for this skill in the workspace store.")
    }
  })
}

export async function runSkillsRestore(args: readonly string[], directories: ProjectDirectories): Promise<void> {
  let options: SkillsCliOptions
  let name: string
  try {
    options = parseArgs(args)
    name = requireName(options)
  } catch (err) {
    console.error(errorMessage(err))
    console.error("usage: flywheel skills restore <name>")
    process.exitCode = 1
    return
  }
  await withProjectState(directories, async () => {
    const definitions = await admitSkillMutation(directories, "skills:restore")
    if (!definitions) return
    const result = await restoreSkill(
      { projectRoot: directories.projectRoot, userDataRoot: directories.userDataRoot, registry: definitions.skills },
      { kind: "user" },
      { name },
    )
    if (result.kind === "refused") {
      console.error(result.error)
      process.exitCode = 1
      return
    }
    console.log(result.message)
  })
}

const SKILLS_CLEANUP_USAGE = "Usage: flywheel skills cleanup --force [--json]"

export async function runSkillsCleanup(args: readonly string[], directories: StartupDirectories, launcher: LauncherScope): Promise<void> {
  let json = false
  let force = false
  try {
    for (const arg of args) {
      if (arg === "--help" || arg === "-h") {
        console.log(SKILLS_CLEANUP_USAGE)
        return
      }
      if (arg === "--json") json = true
      else if (arg === "--force") force = true
      else if (arg.startsWith("--")) throw new Error(`Unknown flag ${arg}`)
      else throw new Error("skills cleanup takes no positional arguments")
    }
    if (!force) throw new Error("--force is required")
  } catch (err) {
    console.error(errorMessage(err))
    console.error(SKILLS_CLEANUP_USAGE)
    process.exitCode = 1
    return
  }

  const { runSkillCorpusCleanupForProject } = await import("../skill-corpus-cleanup-host.js")
  const result = await withEventStore(directories.projectRoot, (store) => runSkillCorpusCleanupForProject({ directories, launcher, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), force: true }))
  const report = result.kind === "completed"
    ? { outcome: result.kind, corePackages: result.corePackages, candidates: result.candidates, archived: result.archived.length }
    : result.kind === "refused" || result.kind === "campaign-deferred"
      ? { outcome: result.kind, reason: result.reason }
      : { outcome: result.kind }
  if (result.kind === "refused" || result.kind === "campaign-deferred") process.exitCode = 1
  if (json) {
    console.log(JSON.stringify(report))
    return
  }
  console.log(`Cleanup outcome: ${report.outcome}.`)
  if (result.kind === "refused" || result.kind === "campaign-deferred") console.error(result.reason)
  if (result.kind === "completed") {
    console.log(`Core packages audited: ${result.corePackages}.`)
    console.log(`Candidates classified: ${result.candidates}.`)
    console.log(`Packages archived: ${result.archived.length}.`)
  }
}

export async function runSkillsDoctor(args: readonly string[], directories: ProjectDirectories): Promise<void> {
  let json = false
  let includeUnowned = false
  let fix = false
  try {
    const filtered = args.filter((arg) => {
      if (arg === "--all") { includeUnowned = true; return false }
      if (arg === "--fix") { fix = true; return false }
      return true
    })
    const options = parseArgs(filtered)
    json = options.json
    if (options.positional.length > 0) throw new Error("skills doctor takes no positional arguments")
  } catch (err) {
    console.error(errorMessage(err))
    console.error("usage: flywheel skills doctor [--json] [--all] [--fix]")
    process.exitCode = 1
    return
  }
  await withProjectState(directories, async () => {
    const { inspectSkillLibrary, repairMovedPaths } = await import("../../../../workflows/skill-health.js")
    const definitions = openProject(directories)
    let findings = inspectSkillLibrary({ revision: definitions.skills(), directories, ...(includeUnowned ? { includeUnowned: true } : {}) })
    if (fix) {
      const { repaired, linked } = repairMovedPaths(findings, definitions.skills())
      if (linked.length > 0) {
        console.log(`Left ${linked.length} moved path(s) in linked skills; edit them where the link points:`)
        for (const entry of linked) console.log(`  ${entry.skill}/${entry.file}: ${entry.path} -> ${entry.movedTo}`)
        console.log("")
      }
      if (repaired.length > 0) {
        console.log(`Repaired ${repaired.length} moved path(s):`)
        for (const entry of repaired) console.log(`  ${entry.skill}/${entry.file}: ${entry.path} -> ${entry.movedTo}`)
        console.log("")
        definitions.reload()
        findings = inspectSkillLibrary({ revision: definitions.skills(), directories, ...(includeUnowned ? { includeUnowned: true } : {}) })
      } else if (linked.length === 0) {
        console.log("No path was confidently relocatable; nothing repaired.\n")
      }
    }
    if (json) {
      console.log(JSON.stringify(findings, null, 2))
      return
    }
    console.log(renderDoctorReport(findings, definitions.skills().skills.size))
  })
}

/** The report a reader acts on: what is broken first, what is worth a look
 *  after, and nothing at all when the library is healthy. */
function renderDoctorReport(findings: readonly SkillFinding[], skillCount: number): string {
  if (findings.length === 0) return `Checked ${skillCount} skill(s). Nothing to report.`
  const lines: string[] = []
  for (const severity of ["broken", "smell"] as const) {
    const group = findings.filter((finding) => finding.severity === severity)
    if (group.length === 0) continue
    lines.push(severity === "broken"
      ? `\nBROKEN (${group.length}) - these waste an agent's turn`
      : `\nWORTH A LOOK (${group.length}) - these may be correct as they stand`)
    const bySkill = new Map<string, SkillFinding[]>()
    for (const finding of group) bySkill.set(finding.skill, [...(bySkill.get(finding.skill) ?? []), finding])
    for (const [skill, entries] of [...bySkill].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`  ${skill}`)
      for (const entry of entries) lines.push(`    ${entry.detail}`)
    }
  }
  const broken = findings.filter((finding) => finding.severity === "broken").length
  lines.push(`\nChecked ${skillCount} skill(s): ${broken} broken, ${findings.length - broken} worth a look.`)
  return lines.join("\n")
}

export async function runSkillsMaintain(args: readonly string[], directories: StartupDirectories, launcher: LauncherScope): Promise<void> {
  let model: string | undefined
  let effort: string | undefined
  let dryRun = false
  let apply = false
  let surveyOnly = false
  let unitId: string | undefined
  try {
    const positional: string[] = []
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === "--dry-run") { dryRun = true; continue }
      else if (arg === "--apply") { apply = true; continue }
      else if (arg === "--survey-only") { surveyOnly = true; continue }
      else if (arg === "--unit") { unitId = args[++index]; if (!unitId) throw new Error("--unit needs a skill id") }
      else if (arg === "--model") { model = args[++index]; if (!model) throw new Error("--model needs a model id") }
      else if (arg === "--effort") { effort = args[++index]; if (!effort) throw new Error("--effort needs a level") }
      else if (arg?.startsWith("--")) throw new Error(`Unknown flag ${arg}`)
      else if (arg !== undefined) positional.push(arg)
    }
    if (positional.length > 0) throw new Error("skills maintain takes no positional arguments")
    if (apply && dryRun) throw new Error("--apply and --dry-run are opposites; pass one")
    if (surveyOnly && unitId !== undefined) throw new Error("--unit selects a unit to perform; --survey-only performs none")
  } catch (err) {
    console.error(errorMessage(err))
    console.error("usage: flywheel skills maintain [--apply | --dry-run] [--survey-only | --unit <id>] [--model <id> [--effort <level>]]")
    process.exitCode = 1
    return
  }
  const { runSkillMaintenanceForProject } = await import("../skill-maintenance-host.js")
  // Writing is the explicit choice: this pass rewrites durable artifacts, so a
  // bare invocation plans and reports rather than acting.
  const outcome = await runSkillMaintenanceForProject({
    directories, launcher,
    ...(apply ? {} : { dryRun: true }),
    ...(surveyOnly ? { surveyOnly: true } : {}),
    ...(unitId ? { unit: unitId } : {}),
    ...(model ? { model } : {}), ...(effort ? { effort } : {}),
  })
  if (outcome.kind === "refused") {
    console.error(outcome.reason)
    process.exitCode = 1
    return
  }
  if (outcome.kind === "skipped") {
    console.log(`Maintenance skipped: ${outcome.candidates} eligible learned skill(s). ${outcome.reason}`)
    return
  }
  if (outcome.kind === "surveyed") {
    console.log(`Surveyed ${outcome.candidates} learned skill(s) on ${outcome.model} (${outcome.bytes.toLocaleString("en-US")} bytes).`)
    if (outcome.units.length === 0) {
      console.log("No maintenance proposed.")
      return
    }
    for (const unit of outcome.units) {
      if (unit.kind === "merge") console.log(`  merge  ${unit.absorb.join(", ")} -> ${unit.into}\n           ${unit.reason}`)
      else console.log(`  repair ${unit.skill}\n           ${unit.reason}`)
    }
    console.log("\nSurvey only: nothing was written.")
    return
  }
  console.log(`Surveyed ${outcome.candidates} learned skill(s) on ${outcome.model}; ${outcome.units.length} unit(s) proposed.`)
  const done = outcome.maintenance
  if (done.kind === "nothing-to-do") {
    console.log("No maintenance proposed.")
    return
  }
  const label = done.kind === "planned" ? "would perform" : "performed"
  for (const unit of done.performed) {
    const what = unit.absorbed.length > 0 ? `${unit.absorbed.join(", ")} -> ${unit.into}` : unit.into
    console.log(`  ${label} ${unit.kind}: ${what} (body ${unit.bodyChars.toLocaleString("en-US")} chars, ${unit.references.length} reference(s))`)
    for (const dropped of unit.removed) console.log(`      dropped ${dropped.what}: ${dropped.why}`)
  }
  for (const entry of done.refused) {
    console.log(`  refused ${entry.unit}\n           ${entry.error}`)
  }
  if (done.kind === "stopped") {
    if (done.partial) {
      const partialWhat = done.partial.unit.absorbed.length > 0 ? `${done.partial.unit.absorbed.join(", ")} -> ${done.partial.unit.into}` : done.partial.unit.into
      console.log(`  partial ${done.partial.unit.kind}: ${partialWhat} (${done.partial.landed} of ${done.partial.of} write(s) landed before the stop; what landed is real)`)
    }
    console.error(apply
      ? `\nStopped after the units above: ${done.error}`
      : `\nStopped while planning, after the units above. Nothing was written.\n${done.error}`)
    process.exitCode = 1
    return
  }
  const counts = `${done.performed.length} of ${done.performed.length + done.refused.length} unit(s) usable`
  console.log(done.kind === "planned"
    ? `\n${counts}. Nothing was written. Re-run with --apply to perform them.`
    : `\n${counts}. Archived skills are recoverable with \`flywheel skills restore <name>\`.`)
}

export async function runSkillsPrune(args: readonly string[], directories: ProjectDirectories): Promise<void> {
  let dryRun = false
  try {
    const filtered = args.filter((arg) => {
      if (arg === "--dry-run") {
        dryRun = true
        return false
      }
      return true
    })
    // Parsed for rejection only: this command takes no other flag.
    parseArgs(filtered)
  } catch (err) {
    console.error(errorMessage(err))
    console.error("usage: flywheel skills prune [--dry-run]")
    process.exitCode = 1
    return
  }
  await withProjectState(directories, async () => {
    // The lifecycle windows are account configuration, so this command reads
    // the same settings the startup maintenance pass runs on. A one-off command
    // owns its reader and never watches.
    const config = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, watch: false })
    try {
      const skills = configSection(config.snapshot().config, skillsConfigSection)
      // The pruner enforces the disabled window itself; this reports it,
      // because an empty walk otherwise reads as "you have no managed skills".
      if (skills.archive_after_days === 0) {
        console.log("Skill lifecycle is off: archive_after_days is 0.")
        return
      }
      const definitions = dryRun ? openProject(directories) : await admitSkillMutation(directories, "skills:prune", config)
      if (!definitions) return
      const report = await withEventStore(directories.projectRoot, async (store) => {
        const writer = dryRun ? null : createSessionFactWriter({ sessionId: "skill-pruner", writer: asAsyncEventWriter(store) })
        try {
          return await applySkillLifecycleTransitions({
            ...await skillActivitySource(asAsyncEventReadSurface(store)),
            registry: definitions.skills,
            directories,
            staleAfterDays: skills.stale_after_days,
            archiveAfterDays: skills.archive_after_days,
            ...(dryRun ? { dryRun: true } : {}),
            ...(writer ? { record: (fact) => writer.record(fact) } : {}),
          })
        } finally {
          writer?.dispose()
        }
      })
      const label = dryRun ? "would archive" : "archived"
      console.log(`Checked ${report.checked} managed skill(s).`)
      console.log(`${label} (${report.archived.length}): ${report.archived.join(", ") || "none"}`)
      console.log(`stale (${report.stale.length}): ${report.stale.join(", ") || "none"}`)
    } finally {
      await config.dispose()
    }
  })
}
