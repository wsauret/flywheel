import type { StartupDirectories } from "../infra/directory-authorities.js"
import type { LauncherContext } from "../infra/process-supervisor.js"
import type { PersistentProcessManager } from "../infra/persistent-process-manager.js"
import type { AccountModuleRequest } from "../protocol/account-attach.js"

/** The process-lifetime resources a command that composes a runtime needs.
 *  Utility verbs ignore them; only a run mode reaches this far. */
export interface CommandProcessResources {
  readonly persistentProcessManager: PersistentProcessManager
  readonly allowPersistentProcesses: boolean
}

/** What one `flywheel <noun> <verb>` runs against: the directory authorities
 *  the composition root selected (ARCH-DIRECTORIES-003), the launcher generation it owns,
 *  its process resources, and the lane's account service. */
export interface CliCommandContext {
  readonly directories: StartupDirectories
  readonly launcher: LauncherContext
  readonly resources: CommandProcessResources
  /** The modules that the project's selection turns on for this invocation. */
  readonly enabledModuleIds: readonly string[]
  /** Sends `request` to the noun's module service in the lane's one account
   *  service, which holds the module's account state live, and calls
   *  `onAnswer` with each answer until the service ends the request. It
   *  finds the service as a terminal does: it starts one when none runs, and
   *  replaces a superseded one. The attach opens no project. The request
   *  ends at the service when this process exits. Rejects with the reason
   *  when no service can serve it. */
  readonly accountRequest: (request: AccountModuleRequest, onAnswer: (answer: unknown) => void) => Promise<void>
}

/** One verb as the root help and the generated CLI reference list it. */
export interface CliVerbSummary {
  /** The verb's syntax after `flywheel <noun>`. */
  readonly syntax: string
  readonly description: string
}

export interface CliVerb extends CliVerbSummary {
  /** The verb prepares an account for its module, such as a setup, so it
   *  runs while the project turns the module off. Every other verb of a
   *  module that is off is refused. */
  readonly runsWhileOff?: true
  readonly run: (args: readonly string[], context: CliCommandContext) => void | Promise<void>
}

/** One `flywheel <noun>` a module contributes; the contribution id is the
 *  noun. Composition rejects two modules that claim one noun. */
export interface CliNounContribution {
  /** The line a missing or unknown verb answers. */
  readonly usage: string
  readonly verbs: { readonly [verb: string]: CliVerb }
}
