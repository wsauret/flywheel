import type { StartupDirectories } from "../infra/directory-authorities.js"
import { errorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"

/** What every run mode that composes a runtime does before it composes one:
 *  make retired capability authorities canonical, materialize seeded config,
 *  and remove legacy machine personas before the registry reads overrides.
 *
 *  It runs before any policy or config read, so the TUI, the editor server, and
 *  a headless run all see the same canonical state rather than each racing the
 *  migration from its own start. Utility subcommands do not run it: they read
 *  what is already there and have no runtime to prepare for.
 *
 *  Every step here is non-fatal. A project that cannot be migrated still opens;
 *  it opens with a warning rather than refusing to start over state the user
 *  cannot reach to repair. */
export async function prepareProjectDefaults(directories: StartupDirectories, options: { readonly publishReferences: boolean }): Promise<void> {
  const { migrateModelAssignments, seedConfigDefaults } = await import("../orchestration/config/writer.js")
  const { migrateCapabilityModules } = await import("../orchestration/config/module-selection-writer.js")
  const migration = await migrateCapabilityModules({ userDataRoot: directories.userDataRoot })
  if (!migration.write.ok) Log.Default.warn("capability module migration failed", { error: migration.write.error.message })
  if (migration.notice) Log.Default.warn(migration.notice)
  const modelMigration = migrateModelAssignments({ userDataRoot: directories.userDataRoot })
  if (!modelMigration.ok) Log.Default.warn("model assignment migration failed", { error: modelMigration.error.message })
  try {
    const { AuthProfileManager } = await import("../orchestration/auth/auth-profile-manager.js")
    const result = await new AuthProfileManager({ userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot }).migrateProviderSettings()
    if (!result.ok) Log.Default.warn("provider settings profile migration failed", { error: result.error.message })
  } catch (err) {
    Log.Default.warn("Copilot cap profile migration failed", { error: errorMessage(err) })
  }
  const seeded = seedConfigDefaults({ userDataRoot: directories.userDataRoot })
  if (!seeded.ok) Log.Default.warn("config default seeding failed", { error: seeded.error.message })
  if (options.publishReferences) {
    const { publishBundledReferences } = await import("../workflows/definitions/installer.js")
    await publishBundledReferences(directories.userDataRoot)
  } else {
    try {
      const { removeLegacyAgentInstall } = await import("../workflows/definitions/installer.js")
      await removeLegacyAgentInstall(directories.userDataRoot)
    } catch (err) {
      Log.Default.warn("legacy persona cleanup failed", { error: errorMessage(err) })
    }
  }
}
