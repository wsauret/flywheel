/** The `cli` contribution domain, proven with a module the command line has
 *  never heard of: it declares one noun, the root guard recognizes the noun
 *  from the catalog alone, dispatch hands its verb the command context, and a
 *  project whose configuration turns the module off gets one refusal line and
 *  exit code 2, with no table edit anywhere in `src/cli/`. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeModules } from "../../../src/infra/module-descriptor.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import type { LauncherContext } from "../../../src/infra/process-supervisor.js"
import { isSubcommand, moduleNounDispatch, subcommandDispatch, SUBCOMMANDS } from "../../../src/cli/subcommands.js"
import { installedCliNouns, type FirstPartyModule, type FirstPartyModuleComposition } from "../../../src/orchestration/modules.js"
import type { CliCommandContext, CommandProcessResources } from "../../../src/orchestration/cli-contribution.js"
import { testDirectories } from "../../helpers/directories.js"

const invocations: { readonly args: readonly string[]; readonly context: CliCommandContext }[] = []

const probeModule = {
  id: "probe",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "cli", id: "probe", value: {
      usage: "Usage: flywheel probe ping [args]",
      verbs: {
        ping: { syntax: "ping", description: "Answer with the arguments it was given.", run: (args, context) => { invocations.push({ args, context }) } },
        setup: { syntax: "setup", description: "Prepare an account for the module.", runsWhileOff: true, run: (args, context) => { invocations.push({ args, context }) } },
      },
    } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule

const catalog = (disabledModuleIds: readonly string[] = []): FirstPartyModuleComposition =>
  composeModules([probeModule], { disabledModuleIds })

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
    const directories = testDirectories("/scratch/probe-project")
    const modules = catalog()
    const dispatch = moduleNounDispatch(installedCliNouns([probeModule]).get("probe")!, async () => modules)

    await dispatch(["ping", "--json", "x"], directories, launcher, resources)

    expect(errors).toEqual([])
    expect(process.exitCode).toBe(originalExitCode)
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.args).toEqual(["--json", "x"])
    expect(invocations[0]?.context).toEqual({ directories, launcher, resources, accountRequest: expect.any(Function) })
  })

  it("answers a missing or unknown verb with the noun's usage and exit code 2", async () => {
    const dispatch = moduleNounDispatch(installedCliNouns([probeModule]).get("probe")!, async () => catalog())

    await dispatch([], testDirectories("/scratch/probe-project"), launcher, resources)
    await dispatch(["pong"], testDirectories("/scratch/probe-project"), launcher, resources)

    expect(errors).toEqual(["Usage: flywheel probe ping [args]", "Usage: flywheel probe ping [args]"])
    expect(process.exitCode).toBe(2)
    expect(invocations).toEqual([])
  })

  it("refuses with one line and exit code 2 when the project turns the module off", async () => {
    const dispatch = moduleNounDispatch(installedCliNouns([probeModule]).get("probe")!, async () => catalog(["probe"]))

    await dispatch(["ping"], testDirectories("/scratch/probe-project"), launcher, resources)

    expect(errors).toEqual(["The probe module is off for this project."])
    expect(process.exitCode).toBe(2)
    expect(invocations).toEqual([])
  })

  it("runs a verb that prepares an account for the module while the project turns the module off", async () => {
    const dispatch = moduleNounDispatch(installedCliNouns([probeModule]).get("probe")!, async () => catalog(["probe"]))

    await dispatch(["setup", "--home", "x"], testDirectories("/scratch/probe-project"), launcher, resources)

    expect(errors).toEqual([])
    expect(process.exitCode).toBe(originalExitCode)
    expect(invocations.map(({ args }) => args)).toEqual([["--home", "x"]])
  })
})

describe("a shipped module noun", () => {
  const created: string[] = []
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    { module: "learning", noun: "skills", verb: "list" },
    { module: "remote", noun: "remote", verb: "status" },
  ])("refuses $noun when the account config disables its $module owner", async ({ module, noun, verb }) => {
    const accountHome = mkdtempSync(join(tmpdir(), "flywheel-module-noun-"))
    created.push(accountHome)
    const userDataRoot = join(accountHome, ".flywheel")
    mkdirSync(userDataRoot, { recursive: true })
    writeFileSync(join(userDataRoot, "flywheel.toml"), `disabled_modules = ["${module}"]\n`)
    const directories = { ...testDirectories("/scratch/probe-project"), accountHome, userDataRoot }

    expect(Object.hasOwn(SUBCOMMANDS, noun)).toBe(false)
    const dispatch = await subcommandDispatch(noun)
    expect(dispatch).toBeDefined()
    await dispatch?.([verb], directories, launcher, resources)

    expect(errors).toEqual([`The ${module} module is off for this project.`])
    expect(process.exitCode).toBe(2)
  })
})
