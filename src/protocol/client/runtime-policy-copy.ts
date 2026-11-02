import type { RuntimeModulesView } from "../module-protocol-types.js"
import type { UpdateAutoInstall } from "../update-protocol-types.js"

/** How every client words the two runtime policies an override can hold for
 *  one run: persistent processes, which a command-line flag can force on, and
 *  automatic updates, which the environment can hold off.
 *
 *  A switch for either always writes the stored setting, also while an
 *  override holds the policy: the stored setting is what the next run reads.
 *  So the words say what the write changed and what stays in force now. */

type PersistentProcesses = Pick<RuntimeModulesView["persistentProcesses"], "forcedByCli">
type AutoInstall = Pick<UpdateAutoInstall, "forcedOff">

/** The detail under the Persistent processes control while the command line
 *  forces the policy on, or undefined when nothing overrides it. */
export function persistentProcessesOverride(policy: PersistentProcesses): string | undefined {
  return policy.forcedByCli ? "On for this run by the command line. The switch sets the stored setting for future runs." : undefined
}

/** The detail under the Automatic updates control while the environment holds
 *  updates off, or undefined when nothing overrides it. */
export function autoInstallOverride(policy: AutoInstall): string | undefined {
  return policy.forcedOff ? "Off for this run by the environment. The switch sets the stored setting for future runs." : undefined
}

/** What a successful Persistent processes write changed. */
export function persistentProcessesSaved(policy: PersistentProcesses, enabled: boolean): string {
  if (enabled) return "Persistent processes enabled for future runs"
  return policy.forcedByCli ? "Persistent processes disabled for future runs; still on for this run by the command line" : "Persistent processes disabled for future runs"
}

/** What a successful Automatic updates write changed. */
export function autoInstallSaved(policy: AutoInstall, enabled: boolean): string {
  if (!enabled) return "Automatic updates disabled"
  return policy.forcedOff ? "Automatic updates enabled for future runs; still off for this run by the environment" : "Automatic updates enabled"
}
