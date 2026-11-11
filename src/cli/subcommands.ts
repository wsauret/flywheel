// Single source of truth for the CLI's bare subcommands. The kernel nouns are
// the table below; every other noun comes from the installed module catalog
// through `installedCliNouns()`, so a module contributes `flywheel <noun>
// <verb>` the way it contributes tools and no module noun is typed here. The
// root-args guard (rootCliAction) and main() both resolve a name through
// `subcommandDispatch()`, so the guard and the router cannot disagree.
//
// Each dispatcher lazily imports its owner and invokes it with the args that
// follow the subcommand name, so an unused subcommand never pulls its module
// onto the startup path, and the catalog itself loads only for a name the
// kernel table does not know. Every dispatcher receives the directory
// authorities the composition root selected (ARCH-DIRECTORIES-003); a command that needs
// project state takes `projectRoot` from them and never resolves a project
// directory itself. It also receives the command's launcher context, so a
// subcommand that starts a process launches it into the one generation the
// composition root owns.

import type { StartupDirectories } from "../infra/directory-authorities.js"
import type { LauncherContext } from "../infra/process-supervisor.js"
import type { ProjectStateStandby } from "../orchestration/app-service/project-state-standby.js"
import type { FirstPartyModule, FirstPartyModuleComposition, InstalledCliNoun } from "../orchestration/modules.js"
import type { CliVerbSummary, CommandProcessResources } from "../orchestration/cli-contribution.js"
import type { AccountModuleRequest } from "../protocol/account-attach.js"

export type SubcommandDispatch = (args: readonly string[], directories: StartupDirectories, launcher: LauncherContext, resources: CommandProcessResources) => void | Promise<void>

interface Subcommands {
  [name: string]: SubcommandDispatch
}


function nounDispatch(usage: string, verbs: Readonly<Subcommands>): SubcommandDispatch {
  return async (args, directories, launcher, resources) => {
    const [verb, ...rest] = args
    const dispatch = verb === undefined ? undefined : verbs[verb]
    if (!dispatch) {
      console.error(usage)
      process.exitCode = 2
      return
    }
    await dispatch(rest, directories, launcher, resources)
  }
}

const EVENT_VERBS: Readonly<Subcommands> = {
  evidence: async (args, directories) => {
    const { runEventEvidence } = await import("./event-evidence.js")
    await runEventEvidence(args, directories.projectRoot)
  },
  search: async (args, directories) => {
    const { runEventSearch } = await import("./event-search.js")
    await runEventSearch(args, directories.projectRoot)
  },
  maintain: async (args, directories) => {
    const { runMaintain } = await import("./event-maintain.js")
    await runMaintain(args, directories.projectRoot)
  },
}

const HEADLESS_VERBS: Readonly<Subcommands> = {
  "snapshot-auth": async (args, directories, launcher) => {
    const { createKeyResolver, createOwnedCredentialCommandRunner } = await import("../infra/auth/resolve-key.js")
    const { runHeadlessSnapshotAuth, snapshotAuthProviders } = await import("./headless-snapshot-auth.js")
    await runHeadlessSnapshotAuth(args, directories, createKeyResolver(createOwnedCredentialCommandRunner(launcher.scope)), await snapshotAuthProviders(directories))
  },
}

/** A kernel noun: the verbs the root help and the generated CLI reference
 *  list, in that order, and the dispatcher that runs it. */
interface KernelNoun {
  readonly verbs: readonly CliVerbSummary[]
  readonly dispatch: SubcommandDispatch
}

interface KernelNouns {
  readonly [noun: string]: KernelNoun
}

/** The kernel nouns, in the order the root help lists them. A capability that
 *  adopts the module contract moves its noun into its descriptor and out of
 *  this table. */
export const SUBCOMMANDS: KernelNouns = {
  auth: {
    verbs: [
      { syntax: "login", description: "Choose a model provider and sign in." },
      { syntax: "login --<provider>", description: "Sign in to one provider, such as --copilot." },
      { syntax: "login --provider <id>", description: "Sign in to a [custom_providers] entry." },
      { syntax: "status", description: "Show the sign-in status of every provider." },
      { syntax: "logout", description: "Choose a provider and remove its credentials." },
      { syntax: "logout --<provider>", description: "Remove one provider's credentials." },
      { syntax: "logout --provider <id>", description: "Remove a [custom_providers] entry's credentials." },
    ],
    dispatch: async (args, directories, launcher) => {
      const { createKeyResolver, createOwnedCredentialCommandRunner } = await import("../infra/auth/resolve-key.js")
      const { openExternalUrl } = await import("../infra/open-external-url.js")
      const { promptFromReadline } = await import("./readline-prompt.js")
      const { composeRealmModuleSnapshot } = await import("../orchestration/modules.js")
      const { MODULE_IDS } = await import("../protocol/module-ids.js")
      const { AUTH_OPERATIONS, runAuth } = await import("./auth.js")
      const { createCatalogSettlement } = await import("../orchestration/auth/catalog-settlement.js")
      const resolveKey = createKeyResolver(createOwnedCredentialCommandRunner(launcher.scope))
      await runAuth([...args], directories, {
        actions: AUTH_OPERATIONS,
        composition: (moduleIds) => composeRealmModuleSnapshot({ moduleIds }),
        prompt: promptFromReadline,
        resolveKey,
        settleCatalog: createCatalogSettlement({
          userDataRoot: directories.userDataRoot,
          resolveKey,
          launcher: launcher.scope,
          moduleSelection: () => composeRealmModuleSnapshot({ moduleIds: MODULE_IDS }),
        }),
        openBrowser: (url) => openExternalUrl(launcher.scope, url),
        launcher: launcher.scope,
        log: console.log,
        // Plain text: Bun colours console.error from the state of stdout, so a
        // redirected stderr would otherwise receive escape sequences.
        error: (...values) => process.stderr.write(`${values.map(String).join(" ")}\n`),
        exit: process.exit,
      })
    },
  },
  // The entry has already opened the account log for this command
  // (`prepareCliStartup`), because a service start counts itself there. A
  // failure that throws leaves it open, so the entry's fatal path records the
  // cause in the account log before it closes it.
  serve: {
    verbs: [{ syntax: "[install|uninstall]", description: "Run or manage the account service." }],
    dispatch: async (args, directories, launcher, resources) => {
      const { Log } = await import("../infra/log.js")
      // A start pre-starts the first project's state Worker, which loads that
      // role's code while this thread loads the service's. Nothing
      // proves at this point who asked for the start: a client that finds a
      // registered service down asks its service manager, exactly as the
      // manager starts it at login, so every start pre-starts it.
      const { startsService } = await import("./serve-contract.js")
      let stateStandby: ProjectStateStandby | undefined
      if (startsService(args)) {
        const { runtimeWorkerUrl } = await import("./runtime-launch.js")
        const { startProjectStateStandby } = await import("../orchestration/app-service/project-state-standby.js")
        stateStandby = startProjectStateStandby(runtimeWorkerUrl())
      }
      try {
        const { releaseHarnessRuntimeOptions, runServe } = await import("./serve.js")
        process.exitCode = await runServe(
          args,
          directories,
          launcher,
          resources.persistentProcessManager,
          resources.allowPersistentProcesses,
          { ...releaseHarnessRuntimeOptions(process.env), ...(stateStandby === undefined ? {} : { stateStandby }) },
        )
      } finally {
        await stateStandby?.dispose()
      }
      await Log.closeGlobal()
    },
  },
  web: {
    verbs: [{ syntax: "", description: "Open this project's sessions in the local browser." }],
    dispatch: async (args, directories, launcher, resources) => {
      const { Log } = await import("../infra/log.js")
      // Diagnostics go to the project's debug log the way every attach does;
      // the terminal shows the link and nothing else.
      await Log.init({ dir: directories.projectRoot })
      const { createAccountRuntimeAttach } = await import("./runtime-attach.js")
      const { openExternalUrl } = await import("../infra/open-external-url.js")
      const { runWeb } = await import("./web.js")
      const attach = createAccountRuntimeAttach({ ...directories, allowPersistentProcesses: resources.allowPersistentProcesses })
      await runWeb(args, directories, attach, (url) => openExternalUrl(launcher.scope, url))
    },
  },
  kill: {
    verbs: [{ syntax: "[--dry-run]", description: "Stop every Flywheel process on this machine. The hard reset, for a runtime nothing else will end." }],
    dispatch: async (args, directories) => {
      const { Log } = await import("../infra/log.js")
      // The account log, where the services this command ends write theirs.
      await Log.init({ dir: directories.accountHome })
      const { runKill } = await import("./kill.js")
      process.exitCode = await runKill(args, directories)
    },
  },
  font: {
    verbs: [
      { syntax: "status", description: "Show the Monaspace Argon install status." },
      { syntax: "install", description: "Install the bundled Monaspace Argon font." },
      { syntax: "dismiss", description: "Hide the Flywheel font tip." },
      { syntax: "reset", description: "Show the Flywheel font tip again." },
    ],
    dispatch: async (args, directories, launcher) => {
      const { runFont } = await import("./font.js")
      await runFont([...args], directories, launcher.scope)
    },
  },
  events: {
    verbs: [
      { syntax: "search [pattern]", description: "Search this workspace's typed session facts." },
      { syntax: "evidence --session <id>", description: "Read durable execution evidence as JSON." },
      { syntax: "maintain", description: "Compact and maintain the workspace event store." },
    ],
    dispatch: nounDispatch("Usage: flywheel events <search|evidence|maintain> [args]", EVENT_VERBS),
  },
  update: {
    verbs: [{ syntax: "", description: "Check for a newer Flywheel and install it." }],
    dispatch: async (args, directories, launcher) => {
      const { runUpdate } = await import("./update.js")
      await runUpdate(args, directories, launcher)
    },
  },
  headless: {
    verbs: [{ syntax: "snapshot-auth --auth-profile <profile> --output <absolute-path>", description: "Export one auth profile as a one-use snapshot that a trusted headless run reads through --auth-snapshot." }],
    dispatch: nounDispatch("Usage: flywheel headless snapshot-auth --auth-profile <profile> --output <absolute-path>", HEADLESS_VERBS),
  },
}

/** The project's module selection, read the way the runtime reads it at
 *  start: the account config through the module policy, composed into the
 *  catalog snapshot the verb receives. A config the policy cannot act on
 *  selects nothing, and its reason is the line before the refusal. */
async function projectModuleSelection(directories: StartupDirectories): Promise<FirstPartyModuleComposition> {
  const { startModulePolicy } = await import("../orchestration/config/module-policy.js")
  const { composeRealmModuleSnapshot } = await import("../orchestration/modules.js")
  const started = await startModulePolicy({ userDataRoot: directories.userDataRoot })
  try {
    if (started.notice) console.error(started.notice)
    const state = started.policy.state()
    if (state.error) console.error(state.error)
    return composeRealmModuleSnapshot(state)
  } finally {
    await started.dispose()
  }
}

/** `flywheel <noun>` for a module noun: the project's selection decides once
 *  per invocation whether the owner is on, then the verb runs with the
 *  command context. A test binds a selection of its own. */
export function moduleNounDispatch(noun: InstalledCliNoun, selection: (directories: StartupDirectories) => Promise<FirstPartyModuleComposition> = projectModuleSelection): SubcommandDispatch {
  return async (args, directories, launcher, resources) => {
    const modules = await selection(directories)
    const [verb, ...rest] = args
    const dispatch = verb !== undefined && Object.hasOwn(noun.verbs, verb) ? noun.verbs[verb] : undefined
    if (!modules.enabledModuleIds.includes(noun.module) && dispatch?.runsWhileOff !== true) {
      console.error(`The ${noun.module} module is off for this project.`)
      process.exitCode = 2
      return
    }
    if (!dispatch) {
      console.error(noun.usage)
      process.exitCode = 2
      return
    }
    const accountRequest = async (request: AccountModuleRequest, onAnswer: (answer: unknown) => void): Promise<void> => {
      const { createAccountRuntimeAttach } = await import("./runtime-attach.js")
      const attach = createAccountRuntimeAttach({ ...directories, allowPersistentProcesses: resources.allowPersistentProcesses })
      try {
        await attach.ensure(() => {})
        await attach.requestModule(noun.module, request, onAnswer)
      } finally {
        attach.close()
      }
    }
    await dispatch.run(rest, { directories, launcher, resources, accountRequest, enabledModuleIds: modules.enabledModuleIds })
  }
}

/** The dispatcher for one `flywheel <name>`: a kernel noun from the table, or
 *  a module noun from the installed catalog. A flag is never a noun, so a
 *  flagged launch decides without loading the catalog. A catalog other than
 *  the shipped one is a test's. */
export async function subcommandDispatch(name: string, modules?: readonly FirstPartyModule[]): Promise<SubcommandDispatch | undefined> {
  if (Object.hasOwn(SUBCOMMANDS, name)) return SUBCOMMANDS[name]?.dispatch
  if (name.startsWith("-")) return undefined
  const { installedCliNouns } = await import("../orchestration/modules.js")
  const noun = installedCliNouns(modules).get(name)
  return noun && moduleNounDispatch(noun)
}

export async function isSubcommand(name: string, modules?: readonly FirstPartyModule[]): Promise<boolean> {
  return (await subcommandDispatch(name, modules)) !== undefined
}
