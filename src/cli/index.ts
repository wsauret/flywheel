#!/usr/bin/env bun

import { EXECUTABLE_ROLES, internalExecutableRole, type ExecutableRole } from "../infra/executable-roles.js"

const internalRoles = {
  [EXECUTABLE_ROLES.mutationGit]: async () => {
    const { runMutationGitMain } = await import("../orchestration/agent-runtime/tools/bash-git-main.js")
    await runMutationGitMain()
  },
  [EXECUTABLE_ROLES.projectExecutor]: async () => {
    const { runProjectExecutorMain } = await import("../orchestration/app-service/project-executor-main.js")
    await runProjectExecutorMain()
  },
  [EXECUTABLE_ROLES.guardian]: async () => {
    const { runProcessGuardianMain } = await import("../infra/process-guardian.js")
    await runProcessGuardianMain()
  },
  [EXECUTABLE_ROLES.commandSupervisor]: async () => {
    const { runCommandSupervisorMain } = await import("../infra/owned-command-supervisor.js")
    await runCommandSupervisorMain(process.argv)
  },
  [EXECUTABLE_ROLES.binaryInstall]: async () => {
    const { runBinaryInstall } = await import("./binary-install.js")
    process.exit(await runBinaryInstall())
  },
} satisfies { [Role in ExecutableRole]: () => Promise<void> }

/** Selects this executable's role before loading application composition.
 * Source launchers call this entry on their own thread; packaged builds enter
 * it directly. Internal roles bypass user command parsing. Every import but
 * the role table is dynamic: a static import here loads into each guardian
 * and executor process, which then idles with modules it never runs. */
export async function runFlywheelCli(): Promise<void> {
  try {
    const role = internalExecutableRole(process.argv)
    if (role) return await internalRoles[role]()
    // Read first: the service and the terminal both name the build they run
    // by this one read of the build directory they started from.
    const { processRunningBuild } = await import("../orchestration/app-service/runtime-executable.js")
    processRunningBuild()
    const [{ startupTrace }, { rootCliAction }] = await Promise.all([import("../infra/startup-trace.js"), import("./root-args.js")])
    startupTrace("cli main")
    const action = await rootCliAction(process.argv.slice(2))
    if (action.kind === "help") {
      const { rootUsage } = await import("./root-help.js")
      process.stdout.write(`${await rootUsage()}\n`)
      return
    }
    if (action.kind === "version") {
      const [{ buildIdentityBeside, versionLine }, { readAppVersion }] = await Promise.all([import("../infra/update/build-identity.js"), import("../infra/app-version.js")])
      process.stdout.write(`${versionLine(await readAppVersion(), buildIdentityBeside(process.execPath)?.buildId)}\n`)
      return
    }
    // The startup module is light and settles the terminal's service launch
    // before command composition, the heavy import, starts loading.
    const { prepareCliStartup } = await import("./startup.js")
    const startup = await prepareCliStartup(action)
    if (!startup) return
    const endComposition = startup.timeline?.begin("client.composition")
    let runCliCommand: typeof import("./main.js").runCliCommand
    try {
      ;({ runCliCommand } = await import("./main.js"))
      endComposition?.()
    } catch (error) {
      endComposition?.("failed")
      startup.timeline?.finish("failed", error)
      throw error
    }
    startupTrace("cli main module imported")
    await runCliCommand(startup)
  } catch (err) {
    // Logging may already point to a file, so the fatal exit also names the
    // failure on stderr, where a failed start stays visible on the terminal.
    const { exitFatally } = await import("./fatal-exit.js")
    await exitFatally(err, "thrown")
  }
}

if (import.meta.main) await runFlywheelCli()
