/** The `cli` contribution domain, proven with a synthetic module whose noun
 *  the command line has never heard of: it declares one noun, the root guard
 *  recognizes the noun from the catalog alone, dispatch hands its verb the
 *  command context, and a project whose configuration turns the module off
 *  gets one refusal line and exit code 2, with no table edit anywhere in
 *  `src/cli/`. The module borrows a shipped module id, because the account
 *  config names modules only in the shipped vocabulary. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StartupDirectories } from "../../../src/infra/directory-authorities.js"
import { createPersistentProcessManager } from "../../../src/infra/supervision/persistent/persistent-process-manager.js"
import type { LauncherContext } from "../../../src/infra/process-supervisor.js"
import { isSubcommand, subcommandDispatch, SUBCOMMANDS, type SubcommandDispatch } from "../../../src/cli/subcommands.js"
import type { FirstPartyModule } from "../../../src/orchestration/module-contract/module-catalog.js"
import type { CliCommandContext, CommandProcessResources } from "../../../src/orchestration/module-contract/cli-contribution.js"
import { temporaryDirectories, testDirectories } from "../../helpers/directories.js"

const invocations: { readonly args: readonly string[]; readonly context: CliCommandContext }[] = []

/** The account config selects modules by the shipped vocabulary, so the
 *  synthetic module takes one of its ids. Its noun is one that no shipped
 *  module declares. */
const PROBE_ID = "papercuts"

const probeModule = {
  id: PROBE_ID,
  dependencies: [],
  contributions: [
    { domain: "cli", id: "probe", value: {
      usage: "Usage: flywheel probe ping [args]",
      verbs: {
        ping: { syntax: "ping", description: "Answer with the arguments it was given.", run: (args, context) => { invocations.push({ args, context }) } },
        setup: { syntax: "setup", description: "Prepare an account for the module.", runsWhileOff: true, run: (args, context) => { invocations.push({ args, context }) } },
      },
    } },
  ],
} as const satisfies FirstPartyModule

const accountHomes = temporaryDirectories()

/** A project whose account config turns off the modules `disabled` names. */
function projectDisabling(...disabled: string[]): StartupDirectories {
  const accountHome = accountHomes("flywheel-module-noun-")
  const userDataRoot = join(accountHome, ".flywheel")
  mkdirSync(userDataRoot, { recursive: true })
  writeFileSync(join(userDataRoot, "flywheel.toml"), `disabled_modules = [${disabled.map((id) => `"${id}"`).join(", ")}]\n`)
  return { ...testDirectories("/scratch/probe-project"), accountHome, userDataRoot }
}

/** The dispatcher of `flywheel probe` over the synthetic catalog. */
async function probeDispatch(): Promise<SubcommandDispatch> {
  return await subcommandDispatch("probe", [probeModule]) ?? expect.unreachable("the catalog declares the probe noun")
}

/** No verb under test starts a process, so every launch authority refuses. */
const noLaunch = (): Promise<never> => Promise.reject(new Error("no verb under test starts a process"))
const launcher: LauncherContext = {
  scope: { spawnOwned: noLaunch, adoptOwned: noLaunch, open: () => launcher.scope, close: noLaunch },
  guardian: { openGeneration: noLaunch, pid: noLaunch },
  startGuardian: noLaunch,
}
const resources: CommandProcessResources = { persistentProcessManager: createPersistentProcessManager({ launch: noLaunch }), allowPersistentProcesses: false }

let errors: string[] = []
const originalError = console.error
const originalExitCode = process.exitCode ?? 0

beforeEach(() => {
  process.exitCode = originalExitCode
  invocations.length = 0
  errors = []
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")) }
})

afterEach(() => {
  console.error = originalError
  process.exitCode = originalExitCode
})

describe("a synthetic module noun", () => {
  it("is recognized by the root guard from the catalog alone, and by nothing in the kernel table", async () => {
    expect(await isSubcommand("probe", [probeModule])).toBe(true)
    expect(await isSubcommand("probe")).toBe(false)
    expect(Object.hasOwn(SUBCOMMANDS, "probe")).toBe(false)
    expect(await subcommandDispatch("probe", [probeModule])).toBeDefined()
  })

  it("dispatches its verb with the command context when the project enables the module", async () => {
    const directories = projectDisabling()

    await (await probeDispatch())(["ping", "--json", "x"], directories, launcher, resources)

    expect(errors).toEqual([])
    expect(process.exitCode).toBe(originalExitCode)
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.args).toEqual(["--json", "x"])
    expect(invocations[0]?.context).toEqual({ directories, launcher, resources, accountRequest: expect.any(Function), enabledModuleIds: expect.any(Array) })
  })

  it("answers a missing or unknown verb with the noun's usage and exit code 2", async () => {
    const dispatch = await probeDispatch()

    await dispatch([], projectDisabling(), launcher, resources)
    await dispatch(["pong"], projectDisabling(), launcher, resources)

    expect(errors).toEqual(["Usage: flywheel probe ping [args]", "Usage: flywheel probe ping [args]"])
    expect(process.exitCode).toBe(2)
    expect(invocations).toEqual([])
  })

  it("refuses with one line and exit code 2 when the project turns the module off", async () => {
    await (await probeDispatch())(["ping"], projectDisabling(PROBE_ID), launcher, resources)

    expect(errors).toEqual([`The ${PROBE_ID} module is off for this project.`])
    expect(process.exitCode).toBe(2)
    expect(invocations).toEqual([])
  })

  it("runs a verb that prepares an account for the module while the project turns the module off", async () => {
    await (await probeDispatch())(["setup", "--home", "x"], projectDisabling(PROBE_ID), launcher, resources)

    expect(errors).toEqual([])
    expect(process.exitCode).toBe(originalExitCode)
    expect(invocations.map(({ args }) => args)).toEqual([["--home", "x"]])
  })
})

describe("a shipped module noun", () => {
  it.each([
    { module: "learning", noun: "skills", verb: "list" },
    { module: "remote", noun: "remote", verb: "status" },
  ])("refuses $noun when the account config disables its $module owner", async ({ module, noun, verb }) => {
    const directories = projectDisabling(module)

    expect(Object.hasOwn(SUBCOMMANDS, noun)).toBe(false)
    const dispatch = await subcommandDispatch(noun)
    expect(dispatch).toBeDefined()
    await dispatch?.([verb], directories, launcher, resources)

    expect(errors).toEqual([`The ${module} module is off for this project.`])
    expect(process.exitCode).toBe(2)
  })
})
